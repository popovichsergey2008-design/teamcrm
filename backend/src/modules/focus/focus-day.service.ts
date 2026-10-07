import { Injectable } from '@nestjs/common';
import { AppException } from '../../common/http/app-exception';
import { RealtimeService } from '../realtime/realtime.service';
import { localParts } from '../assistant/ping-rules';
import { FocusDayRepository, ItemLive, ItemRow, PlanRow } from './focus-day.repository';
import { Candidate, pickTop3, SCORE_VERSION, Scored, scoreCandidate } from './rule-of-3';
import { closeDayAvailable, nextWorkStart, tomorrowOf, zonedTime } from './close-day';
import { PresenceService } from '../presence/presence.service';

export type Viewer = { tenantId: string; userId: string; role: string };

/** Статусы, после которых план считается принятым: молча его не меняем (п. 37, 75). */
const ACCEPTED = ['accepted', 'modified', 'in_progress', 'completed', 'closed'];

export const CHANGE_REASONS = ['not_relevant', 'wrong_priority', 'done', 'blocked', 'other'] as const;

/**
 * «Фокус дня» как дневной план (ТЗ-16, волна 2).
 *
 * План собирается при первом открытии за день (п. 30) — отдельной утренней очереди по
 * поясам в первой версии нет: человек, который не открыл фокус, плана и не ждёт, а
 * открывший получает его сразу, без пустого экрана до 08:30. Один план в день — по
 * уникальному ключу (организация, человек, дата), гонка двух вкладок дублей не даёт.
 *
 * Принятый план система больше не перестраивает сама: новая срочная задача приходит
 * ПРЕДЛОЖЕНИЕМ «это важнее вашего #3» (п. 38, 128), решает человек.
 */
@Injectable()
export class FocusDayService {
  constructor(
    private readonly repo: FocusDayRepository,
    private readonly realtime: RealtimeService,
    private readonly presence: PresenceService,
  ) {}

  private async context(v: Viewer, now: Date) {
    const tz = await this.repo.timezone(v.tenantId, v.userId);
    const today = localParts(now, tz).date;
    return { tz, today };
  }

  private async scored(v: Viewer, now: Date, tz: string, today: string) {
    const raw = await this.repo.candidates(v.tenantId, v.userId, today);
    return raw.map((c) => ({ ...scoreCandidate(c, now, tz), createdAt: c.createdAt }));
  }

  /** Собрать тройку в план: закрепления уже в плане остаются, их места не трогаем. */
  private async fill(v: Viewer, planId: string, scored: Scored[], keep: ItemRow[], source: 'ai' | 'legacy' = 'ai') {
    const taken = new Set(keep.map(keyOfItem));
    const free = [1, 2, 3].filter((r) => !keep.some((i) => i.rank === r));
    const pickFrom = scored.filter((c) => !taken.has(c.key));
    // Закреплённое в плане уже занимает места — добираем только оставшиеся.
    const picks = pickTop3(pickFrom).slice(0, free.length);
    for (let k = 0; k < picks.length; k++) {
      const c = picks[k];
      await this.repo.insertItem(v.tenantId, planId, {
        type: c.kind, taskId: c.taskId, approvalId: c.approvalId, rank: free[k], title: c.title,
        score: c.score, deadline: c.deadlineScore, unlock: c.unlockScore, meeting: c.meetingScore,
        base: c.baseScore, penalty: c.penalty, reasons: c.reasons,
        // «В сегодня», поставленное по-старому, — это решение человека: закрепляем (п. 123)
        source: c.pinned ? 'legacy' : source, pinned: c.pinned,
      });
    }
  }

  /** Главный экран одним запросом (п. 114–115). */
  async today(v: Viewer, now = new Date()) {
    const enabled = await this.repo.enabled(v.tenantId);
    // Новый фокус выключен — ничего не собираем: старый экран живёт как жил, а
    // планы не копятся у тех, кто их не видит.
    if (!enabled) return { enabled: false as const };
    const { tz, today } = await this.context(v, now);
    let plan = await this.repo.plan(v.tenantId, v.userId, today);
    const scored = await this.scored(v, now, tz, today);
    if (!plan) {
      const { id, created } = await this.repo.createPlan(v.tenantId, v.userId, today, tz, 'first_open', SCORE_VERSION);
      if (created) await this.fill(v, id, scored, []);
      plan = await this.repo.plan(v.tenantId, v.userId, today);
    }
    return this.aggregate(v, plan!, scored, enabled, now);
  }

  private async aggregate(v: Viewer, plan: PlanRow, scored: (Scored & { createdAt: Date })[], enabled: boolean, now: Date) {
    const boss = v.role === 'owner' || v.role === 'manager';
    const [items, live] = await Promise.all([
      this.repo.items(plan.id),
      this.repo.live(v.tenantId, { userId: v.userId, boss }, plan.id),
    ]);
    const liveBy = new Map(live.map((l) => [String(l.item_id), l]));

    // Сделанное отмечаем сами: задачу закрыли, работу приняли, согласование решили.
    for (const i of items) {
      const l = liveBy.get(String(i.id));
      if (i.status === 'active' && l && isDone(i, l)) {
        await this.repo.setItemStatus(plan.id, i.id, 'done');
        i.status = 'done';
      }
    }
    const active = items.filter((i) => i.status === 'active');
    // Вся тройка сделана — план выполнен. Закрытый день не трогаем: «закрыт» важнее.
    if (items.length && !active.length && !plan.completed_at && ['proposed', 'accepted', 'modified', 'in_progress'].includes(plan.status)) {
      await this.repo.setPlan(plan.id, { status: 'completed' });
      plan.status = 'completed';
    }

    const inPlan = new Set(items.map(keyOfItem));
    const rest = scored.filter((c) => !inPlan.has(c.key));
    const waitingDecision = scored.filter((c) => c.kind !== 'task').length;
    const [work, workday] = await Promise.all([this.repo.workDay(v.tenantId), this.repo.workdayState(v.tenantId, v.userId)]);
    const doneTop = items.filter((i) => i.status === 'done').length;

    return {
      enabled,
      plan: {
        id: String(plan.id), date: plan.focus_date, timezone: plan.timezone, status: plan.status,
        scoreVersion: plan.score_version, acceptedAt: plan.accepted_at, completedAt: plan.completed_at,
        closedAt: plan.closed_at, feedback: plan.feedback,
      },
      top: items.map((i) => present(i, liveBy.get(String(i.id)))),
      backlogCount: rest.length,
      waitingDecision,
      criticalCandidate: this.critical(plan, items, rest),
      huddle: await this.huddle(v, plan, items, rest),
      // «Завершить день» — после всей тройки или к концу рабочего дня (п. 78–80)
      closeDay: {
        available: !plan.closed_at && closeDayAvailable(now, plan.timezone, work, doneTop, items.length),
        closedAt: plan.closed_at,
        workdayClosedUntil: workday.closedUntil,
        workEnd: work.workEnd,
      },
    };
  }

  /** Итоги дня для окна «Завершить день» (п. 81–83). */
  async closeSummary(v: Viewer, now = new Date()) {
    const plan = await this.requirePlan(v, now);
    const boss = v.role === 'owner' || v.role === 'manager';
    const [items, live] = await Promise.all([this.repo.items(plan.id), this.repo.live(v.tenantId, { userId: v.userId, boss }, plan.id)]);
    const liveBy = new Map(live.map((l) => [String(l.item_id), l]));
    const from = zonedTime(plan.focus_date, '00:00', plan.timezone);
    const to = new Date(from.getTime() + 24 * 3_600_000);
    const [stats, workday] = await Promise.all([
      this.repo.daySummary(v.tenantId, v.userId, from, to),
      this.repo.workdayState(v.tenantId, v.userId),
    ]);
    const { tz, today } = await this.context(v, now);
    const backlog = (await this.scored(v, now, tz, today)).filter((c) => !items.some((i) => keyOfItem(i) === c.key));
    return {
      topDone: items.filter((i) => i.status === 'done').length,
      topTotal: items.length,
      remaining: items.filter((i) => i.status === 'active').map((i) => present(i, liveBy.get(String(i.id)))),
      secondaryLeft: backlog.filter((c) => c.worthy).length,
      ...stats,
      quietDefault: workday.quiet,
    };
  }

  /**
   * Завершить день (п. 82–87). Хвосты НЕ получают «на завтра» скопом (п. 84): всё
   * возвращается в общий список, утром тройка соберётся заново; «закрепить на
   * завтра» — только то, что человек выбрал сам, и только своя задача.
   */
  async close(v: Viewer, input: { tomorrow: string[]; quiet: boolean }, now = new Date()) {
    const plan = await this.requirePlan(v, now);
    const items = await this.repo.items(plan.id);
    const date = tomorrowOf(now, plan.timezone);
    for (const id of input.tomorrow) {
      const it = items.find((i) => String(i.id) === String(id));
      if (it?.task_id && it.item_type === 'task') await this.repo.pinTomorrow(v.tenantId, v.userId, it.task_id, date);
    }
    await this.repo.closePlan(plan.id);
    const work = await this.repo.workDay(v.tenantId);
    await this.repo.setWorkday(v.tenantId, v.userId, nextWorkStart(now, plan.timezone, work), input.quiet);
    this.presence.changed(v.tenantId, v.userId);
    // телефон и вторая вкладка узнают сразу и тоже затихают (п. 134)
    this.realtime.emitToUsers(v.tenantId, [v.userId], 'workday.closed', {});
    this.changed(v);
    return this.today(v, now);
  }

  /** «Я ещё поработаю» — день снова открыт, тишина снимается (п. 87). */
  async reopen(v: Viewer, now = new Date()) {
    await this.repo.setWorkday(v.tenantId, v.userId, null);
    this.presence.changed(v.tenantId, v.userId);
    this.realtime.emitToUsers(v.tenantId, [v.userId], 'workday.closed', {});
    this.changed(v);
    return this.today(v, now);
  }

  /**
   * «Появилась новая критичная задача — она может заменить #3» (п. 38, 128).
   *
   * Только для принятого плана (непринятый проще пересчитать), только то, что
   * появилось ПОСЛЕ сборки плана, и только если оно весомее слабейшего в тройке.
   * От чего человек уже отказался, второй раз не предлагаем.
   */
  private critical(plan: PlanRow, items: ItemRow[], rest: (Scored & { createdAt: Date })[]) {
    if (!ACCEPTED.includes(plan.status) || plan.closed_at) return null;
    const active = items.filter((i) => i.status === 'active');
    const weakest = active.length < 3 ? null : active.reduce((a, b) => (Number(a.priority_score) <= Number(b.priority_score) ? a : b));
    const dismissed = new Set(plan.dismissed ?? []);
    const fresh = rest
      // поручения со встреч предлагает блок «созвон → фокус», не дублируем
      .filter((c) => !c.meetingId)
      .filter((c) => c.worthy && !dismissed.has(c.key) && new Date(c.createdAt).getTime() > new Date(plan.created_at).getTime())
      .filter((c) => c.priority === 'urgent' || c.deadlineScore >= 95 || c.meetingScore >= 85)
      .filter((c) => !weakest || c.score > Number(weakest.priority_score))
      .sort((a, b) => b.score - a.score)[0];
    if (!fresh) return null;
    return {
      key: fresh.key, kind: fresh.kind, taskId: fresh.taskId, approvalId: fresh.approvalId,
      title: fresh.title, projectName: fresh.projectName, reasons: fresh.reasons, score: fresh.score,
      replaceRank: weakest ? weakest.rank : ([1, 2, 3].find((r) => !active.some((i) => i.rank === r)) ?? 3),
    };
  }

  /**
   * Созвон → фокус (п. 71–77). После встречи у человека появились поручения — показываем
   * их по встречам: одно — «важнее вашего #3?», несколько — «3 новых действия, 1 срочное».
   * Задачи создаёт прежний разбор встреч; здесь только предложение, и принятый план
   * без согласия не меняется (п. 75). Отказ («В список») запоминается на встречу.
   */
  private async huddle(v: Viewer, plan: PlanRow, items: ItemRow[], rest: (Scored & { createdAt: Date })[]) {
    if (plan.closed_at) return [];
    const dismissed = new Set(plan.dismissed ?? []);
    const active = items.filter((i) => i.status === 'active');
    const weakest = active.length < 3 ? null : active.reduce((a, b) => (Number(a.priority_score) <= Number(b.priority_score) ? a : b));
    const freeRank = [1, 2, 3].find((r) => !active.some((i) => i.rank === r)) ?? null;
    const byMeeting = new Map<string, { meetingId: string; title: string; items: (Scored & { createdAt: Date })[] }>();
    for (const c of rest) {
      if (!c.meetingId || dismissed.has(`huddle:${c.meetingId}`) || dismissed.has(c.key)) continue;
      const g = byMeeting.get(c.meetingId) ?? { meetingId: c.meetingId, title: c.meetingTitle ?? 'Созвон', items: [] };
      g.items.push(c);
      byMeeting.set(c.meetingId, g);
    }
    const drafts = await this.repo.pendingMeetingDrafts(v.tenantId, v.userId).catch(() => []);
    for (const d of drafts) {
      const id = String(d.meeting_id);
      if (dismissed.has(`huddle:${id}`)) continue;
      if (!byMeeting.has(id)) byMeeting.set(id, { meetingId: id, title: d.title, items: [] });
    }
    return [...byMeeting.values()].map((g) => {
      const sorted = [...g.items].sort((a, b) => b.score - a.score);
      const top = sorted[0];
      const urgent = sorted.filter((c) => c.priority === 'urgent' || c.deadlineScore >= 95).length;
      return {
        meetingId: g.meetingId,
        title: g.title,
        urgent,
        regular: sorted.length - urgent,
        pendingDrafts: Number(drafts.find((d) => String(d.meeting_id) === g.meetingId)?.n ?? 0),
        items: sorted.slice(0, 10).map((c) => ({
          key: c.key, taskId: c.taskId, title: c.title, deadlineAt: c.deadlineAt, priority: c.priority,
          reasons: c.reasons, score: c.score,
        })),
        // одно поручение весомее слабейшего в тройке — предлагаем поставить его на это место
        suggestRank: top && (freeRank ?? (weakest && top.score > Number(weakest.priority_score) ? weakest.rank : null)),
      };
    });
  }

  /** Остальные действия по очкам — раскрываются по нажатию (п. 39, 143). */
  async backlog(v: Viewer, now = new Date()) {
    const { tz, today } = await this.context(v, now);
    const plan = await this.repo.plan(v.tenantId, v.userId, today);
    const inPlan = new Set(plan ? (await this.repo.items(plan.id)).map(keyOfItem) : []);
    const scored = await this.scored(v, now, tz, today);
    return scored
      .filter((c) => !inPlan.has(c.key))
      .sort((a, b) => b.score - a.score)
      .slice(0, 100)
      .map((c) => ({
        key: c.key, kind: c.kind, taskId: c.taskId, approvalId: c.approvalId, title: c.title,
        projectName: c.projectName, deadlineAt: c.deadlineAt, priority: c.priority,
        score: c.score, reasons: c.reasons, blocked: c.isBlocked,
      }));
  }

  private async requirePlan(v: Viewer, now: Date) {
    const { today } = await this.context(v, now);
    const plan = await this.repo.plan(v.tenantId, v.userId, today);
    if (!plan) throw AppException.notFound('План на сегодня ещё не собран — откройте «Фокус дня»');
    return plan;
  }

  private changed(v: Viewer) {
    // второе устройство человека перечитает план (п. 133)
    this.realtime.emitToUsers(v.tenantId, [v.userId], 'focus.day.updated', {});
  }

  async accept(v: Viewer, now = new Date()) {
    const plan = await this.requirePlan(v, now);
    if (plan.status === 'proposed' || plan.status === 'modified') {
      await this.repo.setPlan(plan.id, { status: plan.status === 'modified' ? 'modified' : 'accepted', accepted: true });
    }
    this.changed(v);
    return this.today(v, now);
  }

  /**
   * «Пересчитать» — пока план не принят. Принятый план целиком не перестраиваем
   * (п. 37): только замены по одной, которые человек делает сам.
   */
  async recalculate(v: Viewer, now = new Date()) {
    const plan = await this.requirePlan(v, now);
    if (ACCEPTED.includes(plan.status) && plan.status !== 'modified') {
      throw AppException.conflict('План уже принят — меняйте задачи по одной');
    }
    const { tz, today } = await this.context(v, now);
    await this.repo.dropUnpinned(plan.id);
    const keep = (await this.repo.items(plan.id)).filter((i) => i.status === 'active' || i.status === 'done');
    await this.fill(v, plan.id, await this.scored(v, now, tz, today), keep);
    await this.repo.setPlan(plan.id, { source: 'recalc' });
    this.changed(v);
    return this.today(v, now);
  }

  /**
   * Добавить действие в тройку: на свободное место или вместо элемента на `rank`.
   * Добавлять можно только своё — то, что есть среди кандидатов человека.
   */
  async add(v: Viewer, input: { key: string; rank?: number; reason?: string }, now = new Date()) {
    const plan = await this.requirePlan(v, now);
    const { tz, today } = await this.context(v, now);
    const scored = await this.scored(v, now, tz, today);
    const c = scored.find((x) => x.key === input.key);
    if (!c) throw AppException.validation('Это действие нельзя добавить в ваш фокус');
    const items = await this.repo.items(plan.id);
    if (items.some((i) => keyOfItem(i) === c.key && i.status === 'active')) {
      throw AppException.conflict('Это уже в вашем фокусе');
    }
    const active = items.filter((i) => i.status === 'active');
    let rank = input.rank && [1, 2, 3].includes(input.rank) ? input.rank : [1, 2, 3].find((r) => !items.some((i) => i.rank === r && i.status === 'active'));
    if (!rank) throw AppException.conflict('В фокусе уже три действия — замените одно из них');
    const occupant = active.find((i) => i.rank === rank);
    if (occupant) {
      const reason = (CHANGE_REASONS as readonly string[]).includes(input.reason ?? '') ? input.reason! : null;
      await this.repo.setItemStatus(plan.id, occupant.id, 'replaced', reason);
    }
    // Место сделанного тоже можно занять: «главная миссия завершена — добавить ещё» (п. 129).
    const doneOnRank = items.find((i) => i.rank === rank && i.status === 'done');
    if (doneOnRank && !occupant) {
      const freeRank = [1, 2, 3].find((r) => !items.some((i) => i.rank === r));
      if (freeRank) rank = freeRank;
    }
    await this.repo.insertItem(v.tenantId, plan.id, {
      type: c.kind, taskId: c.taskId, approvalId: c.approvalId, rank, title: c.title,
      score: c.score, deadline: c.deadlineScore, unlock: c.unlockScore, meeting: c.meetingScore,
      base: c.baseScore, penalty: c.penalty, reasons: c.reasons, source: 'user', pinned: true,
    });
    await this.touched(plan);
    this.changed(v);
    return this.today(v, now);
  }

  async remove(v: Viewer, itemId: string, reason: string | undefined, now = new Date()) {
    const plan = await this.requirePlan(v, now);
    const r = (CHANGE_REASONS as readonly string[]).includes(reason ?? '') ? reason! : null;
    if (!(await this.repo.setItemStatus(plan.id, itemId, 'removed', r))) throw AppException.notFound('Такого действия в плане нет');
    await this.touched(plan);
    this.changed(v);
    return this.today(v, now);
  }

  async pin(v: Viewer, itemId: string, pinned: boolean, now = new Date()) {
    const plan = await this.requirePlan(v, now);
    if (!(await this.repo.setPinned(plan.id, itemId, pinned))) throw AppException.notFound('Такого действия в плане нет');
    this.changed(v);
    return this.today(v, now);
  }

  /** Новый порядок: первое — главная миссия. Ровно те элементы, что в плане. */
  async reorder(v: Viewer, ids: string[], now = new Date()) {
    const plan = await this.requirePlan(v, now);
    const items = (await this.repo.items(plan.id)).filter((i) => i.status === 'active' || i.status === 'done');
    const known = new Set(items.map((i) => String(i.id)));
    const order = ids.map(String).filter((id) => known.has(id));
    if (order.length !== items.length || new Set(order).size !== order.length || order.length > 3) {
      throw AppException.validation('Порядок должен содержать все действия плана по одному разу');
    }
    await this.repo.reorder(plan.id, order);
    await this.touched(plan);
    this.changed(v);
    return this.today(v, now);
  }

  /** «Не сейчас» на предложение заменить #3 — больше этого не предлагаем. */
  async dismiss(v: Viewer, key: string, now = new Date()) {
    const plan = await this.requirePlan(v, now);
    await this.repo.dismiss(plan.id, key.slice(0, 40));
    this.changed(v);
    return this.today(v, now);
  }

  /** «Полезный план?» 👍 / 👎 (п. 121). */
  async feedback(v: Viewer, value: 1 | -1, now = new Date()) {
    const plan = await this.requirePlan(v, now);
    await this.repo.setPlan(plan.id, { feedback: value });
    return { ok: true };
  }

  /** Человек поправил предложенный план — это «принят с изменениями» (п. 10). */
  private async touched(plan: PlanRow) {
    if (plan.status === 'proposed' || plan.status === 'accepted') {
      await this.repo.setPlan(plan.id, { status: 'modified', accepted: true });
    }
  }

  async setEnabled(tenantId: string, on: boolean) {
    await this.repo.setEnabled(tenantId, on);
    return { enabled: on };
  }

  /** Включён ли новый фокус и как он работает — для руководства (п. 119–120). */
  async settings(tenantId: string, days = 14) {
    const [enabled, m] = await Promise.all([this.repo.enabled(tenantId), this.repo.metrics(tenantId, days)]);
    const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 100) : null);
    const n = (k: string) => Number(m?.[k] ?? 0);
    return {
      enabled,
      days,
      plans: n('plans'),
      people: n('people'),
      // принят как есть — главный сигнал, что тройка угадана
      acceptedAsIs: pct(n('accepted_as_is'), n('plans')),
      corrected: pct(n('corrected'), n('plans')),
      rank1Kept: pct(n('rank1_kept'), n('rank1_total')),
      wrongPriority: n('wrong_priority'),
      topCompletion: pct(n('top_done'), n('top_total')),
      deepStart: pct(n('plans_with_focus'), n('plans')),
      deepCompletion: pct(n('sessions_done'), n('sessions')),
      sessions: n('sessions'),
      closeDay: pct(n('closed'), n('plans')),
      huddleInFocus: n('huddle_in_focus'),
      thumbsUp: n('thumbs_up'),
      thumbsDown: n('thumbs_down'),
    };
  }
}

function keyOfItem(i: Pick<ItemRow, 'item_type' | 'task_id' | 'approval_id'>): string {
  return i.item_type === 'approval' ? `approval:${i.approval_id}` : `${i.item_type}:${i.task_id}`;
}

function isDone(i: ItemRow, l: ItemLive): boolean {
  if (i.item_type === 'approval') return l.approval_pending === false;
  if (l.gone) return false;
  if (l.closed) return true;
  // проверку «сделали», когда задача ушла из колонки проверки (приняли или вернули)
  if (i.item_type === 'review') return l.in_review === false;
  return false;
}

function present(i: ItemRow, l: ItemLive | undefined) {
  const gone = !!l?.gone;
  return {
    id: String(i.id),
    rank: i.rank,
    kind: i.item_type,
    status: i.status,
    taskId: gone ? null : i.task_id,
    approvalId: i.approval_id,
    projectId: l?.project_id ? String(l.project_id) : null,
    // Доступ пропал или задачу удалили — старое название не показываем (п. 130–131).
    title: gone ? null : i.item_type === 'review' && l?.task_title ? `Проверить и принять: ${l.task_title}`
      : i.item_type === 'approval' && l?.approval_subject ? `Согласовать: ${l.approval_subject}`
      : l?.task_title ?? i.title_snapshot,
    unavailable: gone,
    projectName: gone ? null : l?.project_name ?? null,
    deadlineAt: gone ? null : l?.deadline_at ?? null,
    priority: gone ? null : l?.priority ?? null,
    assigneeName: gone ? null : l?.assignee_name ?? null,
    checklistTotal: l?.checklist_total ?? 0,
    checklistDone: l?.checklist_done ?? 0,
    reasons: gone ? [] : i.reasons,
    score: Number(i.priority_score),
    parts: {
      deadline: Number(i.deadline_score), unlock: Number(i.unlock_score), meeting: Number(i.meeting_score),
      base: Number(i.base_priority_score), penalty: Number(i.penalty),
    },
    pinned: i.pinned_by_user,
    source: i.source,
  };
}

export type { Candidate };
