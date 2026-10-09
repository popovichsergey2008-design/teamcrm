import { Injectable, Logger } from '@nestjs/common';
import { AppException } from '../../common/http/app-exception';
import { SecurityService } from '../security/security.service';
import { can, Permission } from '../security/permissions';
import { TasksService } from '../tasks/tasks.service';
import { TaskActivityRepository } from '../tasks/task-activity.repository';
import { FollowupsRepository } from '../tasks/followups.repository';
import { ForecastService } from '../forecast/forecast.service';
import { CalendarService } from '../calendar/calendar.service';
import { FeedService } from '../feed/feed.service';
import { PushService } from '../notifications/push.service';
import { TelegramMirror } from '../notifications/telegram-mirror.service';
import { RealtimeService } from '../realtime/realtime.service';
import { localParts } from '../assistant/ping-rules';
import { tomorrowOf, zonedTime } from '../focus/close-day';
import { findSlots } from '../anthill/slot-rules';
import {
  ACTIONS_FOR, ActionType, band, BOTTLENECK_TITLE, bottleneckSeverity, bottleneckType, bottleneckWhy, BottleneckType,
  capacityPct, catchUpPlan, Decision, decisionScore, DEFAULT_NORM_POINTS, delayRisk, forecast, FORECAST_VERSION,
  HEALTH_VERSION, healthComponents, healthScore, isStuck, loadPoints, pickRebalance, projectRisk, taskPoints,
  velocityDelta, verdict, victories, zone,
} from './pulse-rules';
import { OpenTaskRow, PulseRepository } from './pulse.repository';

type Actor = { userId: string; role: string; tenantId: string };
const FALLBACK_TZ = 'Europe/Moscow';
const CACHE_MS = 60_000;
/** Пауза между вопросами «как идёт работа» по одной задаче (§27). */
const NUDGE_COOLDOWN_H = 24;

/**
 * «Пульс команды» как командный центр (ТЗ-19).
 *
 * Сводка — один запрос на экран; считается правилами (pulse-rules) и кэшируется на
 * минуту: руководитель открывает экран несколько раз в день, а пересчёт тысячи задач
 * на каждое открытие ничего не добавляет. Действия — предложение → предпросмотр →
 * подтверждение → выполнение теми же сервисами, что и руками, → журнал безопасности.
 */
@Injectable()
export class PulseService {
  private readonly log = new Logger('Pulse');
  private cache = new Map<string, { at: number; value: any }>();

  constructor(
    private readonly repo: PulseRepository,
    private readonly security: SecurityService,
    private readonly tasks: TasksService,
    private readonly activity: TaskActivityRepository,
    private readonly followups: FollowupsRepository,
    private readonly forecastSvc: ForecastService,
    private readonly calendar: CalendarService,
    private readonly feed: FeedService,
    private readonly push: PushService,
    private readonly telegram: TelegramMirror,
    private readonly realtime: RealtimeService,
  ) {}

  private async perms(a: Actor) { return this.security.permissionsOf(a.tenantId, a.userId); }
  private async need(a: Actor, p: Permission, what: string) {
    if (!can(await this.perms(a), p)) throw AppException.forbidden(what);
  }

  invalidate(tenantId: string) {
    for (const k of this.cache.keys()) if (k.startsWith(`${tenantId}:`)) this.cache.delete(k);
  }

  // ── сводка ──

  async summary(a: Actor, tz: string | null) {
    await this.need(a, 'radar.view', '«Пульс команды» открыт руководству — доступ выдаёт владелец');
    const key = `${a.tenantId}:${a.userId}`;
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
    const value = await this.compute(a, tz || FALLBACK_TZ);
    this.cache.set(key, { at: Date.now(), value });
    return value;
  }

  private async compute(a: Actor, tz: string) {
    const now = new Date();
    const today = localParts(now, tz).date;
    const dayFrom = zonedTime(today, '00:00', tz);
    const dayTo = zonedTime(tomorrowOf(now, tz), '00:00', tz);
    const [tasks, people, stats, projects, decisionsRaw, dismissed] = await Promise.all([
      this.repo.openTasks(a.tenantId), this.repo.people(a.tenantId, dayFrom, dayTo), this.repo.stats(a.tenantId),
      this.repo.projects(a.tenantId), this.repo.decisions(a.tenantId, a.userId), this.repo.dismissed(a.tenantId),
    ]);

    // загрузка
    const byAssignee = new Map<string, OpenTaskRow[]>();
    for (const t of tasks) if (t.assigneeId) (byAssignee.get(t.assigneeId) ?? byAssignee.set(t.assigneeId, []).get(t.assigneeId)!).push(t);
    const reviewsOf = new Map<string, number>();
    for (const t of tasks) if (t.inReview && t.createdBy && t.createdBy !== t.assigneeId) reviewsOf.set(t.createdBy, (reviewsOf.get(t.createdBy) ?? 0) + 1);
    const workload = people.map((p) => {
      const mine = byAssignee.get(p.id) ?? [];
      const l = loadPoints({ tasks: mine.filter((t) => !t.inReview), reviewsWaiting: reviewsOf.get(p.id) ?? 0, meetingHoursToday: Math.round(p.meetingHours * 10) / 10 }, now);
      const norm = p.norm ?? DEFAULT_NORM_POINTS;
      const pct = capacityPct(l.points, norm);
      return { id: p.id, name: p.name, pct, band: band(pct), norm, risk: delayRisk(pct, l.overdue), available: p.available, ...l };
    }).sort((x, y) => y.pct - x.pct);
    const overloaded = new Set(workload.filter((w) => w.pct > 100).map((w) => w.id));

    // затыки
    const bottlenecks = tasks.map((t) => {
      const type = bottleneckType(t, now, overloaded);
      if (!type || dismissed.has(`bottleneck:${t.id}`)) return null;
      return {
        taskId: t.id, title: t.title, projectId: t.projectId, projectName: t.projectName, assignee: t.assigneeName,
        type, typeTitle: BOTTLENECK_TITLE[type], why: bottleneckWhy(t, type, now), actions: ACTIONS_FOR[type],
        severity: bottleneckSeverity(t, type, now), priority: t.priority,
      };
    }).filter((x): x is NonNullable<typeof x> => !!x).sort((x, y) => y.severity - x.severity);

    // решения руководителя
    const D = (r: any, kind: Decision['kind'], extra: Partial<Decision> = {}): Decision => ({
      kind, id: `${kind}:${r.id}`, title: r.title, who: r.who ?? null, since: new Date(r.since ?? now), dueAt: r.dueAt ? new Date(r.dueAt) : null,
      taskId: r.taskId ?? null, projectId: r.projectId ?? null, clientId: null, urgent: r.priority === 'urgent' || r.priority === 'high', ...extra,
    });
    const decisions: Decision[] = [
      ...decisionsRaw.approvals.map((r) => D(r, 'approval')),
      ...decisionsRaw.reviews.map((r) => D(r, 'review')),
      ...decisionsRaw.shifts.map((r) => D(r, 'deadline_shift')),
      ...decisionsRaw.clients.map((r) => D(r, 'client', { clientId: r.id })),
      ...decisionsRaw.drafts.map((r) => D({ ...r, title: `${r.title} — черновиков задач: ${r.n}` }, 'meeting')),
      ...tasks.filter((t) => !t.assigneeId && now.getTime() - t.createdAt.getTime() > 86_400_000)
        .map((t) => D({ id: t.id, title: t.title, since: t.createdAt, dueAt: t.deadlineAt, taskId: t.id, projectId: t.projectId, priority: t.priority }, 'no_assignee')),
      ...tasks.filter((t) => t.isBlocked)
        .map((t) => D({ id: t.id, title: t.title, who: t.assigneeName, since: t.lastMove, dueAt: t.deadlineAt, taskId: t.id, projectId: t.projectId, priority: t.priority }, 'blocked')),
    ].filter((d) => !dismissed.has(`decision:${d.id}`))
      .map((d) => ({ ...d, score: decisionScore(d, now) }))
      .sort((x, y) => y.score - x.score);

    // проекты: прогноз и риск
    const overdueBy = new Map<string, number>(); const stuckBy = new Map<string, number>(); const onOver = new Map<string, number>();
    for (const t of tasks) {
      if (t.deadlineAt && t.deadlineAt < now) overdueBy.set(t.projectId, (overdueBy.get(t.projectId) ?? 0) + 1);
      if (isStuck(t, now)) stuckBy.set(t.projectId, (stuckBy.get(t.projectId) ?? 0) + 1);
      if (t.assigneeId && overloaded.has(t.assigneeId)) onOver.set(t.projectId, (onOver.get(t.projectId) ?? 0) + 1);
    }
    const projectViews = projects.filter((p) => p.open > 0 || p.weekly.some((x) => x > 0)).map((p) => {
      const f = forecast({ remaining: p.open, weekly: p.weekly, planDate: p.targetDate ? new Date(`${p.targetDate}T18:00:00Z`) : null, now });
      const risk = projectRisk({
        open: p.open, overdue: overdueBy.get(p.id) ?? 0, stuck: stuckBy.get(p.id) ?? 0, delayDays: f.delayDays,
        onOverloaded: p.open ? (onOver.get(p.id) ?? 0) / p.open : 0, last7: p.weekly[3], prev7: p.weekly[2],
      });
      const projTasks = tasks.filter((t) => t.projectId === p.id);
      const blockers = bottlenecks.filter((b) => b.projectId === p.id).slice(0, 3).map((b) => ({ id: b.taskId, title: b.title }));
      const factors: string[] = [];
      if ((overdueBy.get(p.id) ?? 0) > 0) factors.push(`просрочено: ${overdueBy.get(p.id)}`);
      if ((stuckBy.get(p.id) ?? 0) > 0) factors.push(`без движения: ${stuckBy.get(p.id)}`);
      const inReview = projTasks.filter((t) => t.inReview).length;
      if (inReview) factors.push(`ждут проверки: ${inReview}`);
      factors.push(`темп ${f.perWeek} задач в неделю`);
      return {
        id: p.id, name: p.name, targetDate: p.targetDate, open: p.open, progress: p.total ? Math.round((p.closed / p.total) * 100) : 0,
        overdue: overdueBy.get(p.id) ?? 0, stuck: stuckBy.get(p.id) ?? 0, risk,
        forecast: { ...f, date: f.date ? f.date.toISOString().slice(0, 10) : null, factors, version: FORECAST_VERSION },
        catchUp: catchUpPlan(f, {
          topBlockers: blockers, noAssignee: projTasks.filter((t) => !t.assigneeId).slice(0, 2).map((t) => ({ id: t.id, title: t.title })),
          lowPriority: projTasks.filter((t) => t.priority === 'low').length,
        }),
      };
    });
    const projectRisks = projectViews.filter((p) => !dismissed.has(`project:${p.id}`)).sort((x, y) => y.risk.score - x.risk.score);
    for (const p of projectViews) {
      void this.repo.saveForecast(a.tenantId, {
        projectId: p.id, planDate: p.targetDate, predicted: p.forecast.date ? new Date(p.forecast.date) : null,
        confidence: p.forecast.confidence, remaining: p.open, version: FORECAST_VERSION,
      }).catch(() => undefined);
    }

    // здоровье
    const withDeadline = tasks.filter((t) => t.deadlineAt);
    const overdueTasks = withDeadline.filter((t) => t.deadlineAt! < now);
    const components = healthComponents({
      closed30: stats.closed30, created30: stats.created30, open: tasks.length, withDeadline: withDeadline.length,
      overdue: overdueTasks.length,
      criticalOverdue: overdueTasks.filter((t) => t.priority === 'high' || t.priority === 'urgent').length,
      avgOverdueDays: overdueTasks.length ? overdueTasks.reduce((s, t) => s + (now.getTime() - t.deadlineAt!.getTime()) / 86_400_000, 0) / overdueTasks.length : 0,
      stuck: tasks.filter((t) => isStuck(t, now)).length,
      reviewStuck: tasks.filter((t) => t.inReview && isStuck(t, now)).length,
      noAssignee: tasks.filter((t) => !t.assigneeId).length,
      people: workload.filter((w) => w.active > 0 || w.pct > 0),
      last7: stats.last7, prev7: stats.prev7,
    });
    const score = healthScore(components);
    const vDelta = velocityDelta(stats.last7, stats.prev7);
    const stuckGroups = new Map<string, number>();
    for (const b of bottlenecks) if (b.assignee && (b.type === 'NO_ACTIVITY' || b.type === 'WAITING_REVIEW' || b.type === 'ASSIGNEE_OVERLOADED')) stuckGroups.set(b.assignee, (stuckGroups.get(b.assignee) ?? 0) + 1);
    const topGroup = [...stuckGroups.entries()].sort((x, y) => y[1] - x[1])[0];
    const v = verdict({
      score, components, velocityDelta: vDelta, last7: stats.last7,
      topBottleneck: bottlenecks[0] ? { id: bottlenecks[0].taskId, title: bottlenecks[0].title, why: bottlenecks[0].why } : null,
      stuckByColumn: topGroup ? { assignee: topGroup[0], count: topGroup[1] } : null,
      overloaded: workload.filter((w) => w.pct > 100).map((w) => ({ name: w.name, pct: w.pct })),
      decisions: decisions.length,
      lateProjects: projectViews.filter((p) => p.forecast.delayDays && p.forecast.delayDays > 0).map((p) => ({ name: p.name, delayDays: p.forecast.delayDays! })),
    });

    const completed = projects.filter((p) => p.open === 0 && p.weekly[3] > 0).map((p) => p.name);
    const wins = victories({ last7: stats.last7, prev7: stats.prev7, completedProjects: completed, bestWeek: stats.last7 > stats.bestPrev });

    return {
      generatedAt: now.toISOString(),
      health: { score, zone: zone(score), components, version: HEALTH_VERSION },
      verdict: {
        ...v,
        sources: { projects: projectViews.length, tasks: tasks.length, stuck: bottlenecks.length, people: workload.length, last7: stats.last7, prev7: stats.prev7 },
      },
      decisions: decisions.slice(0, 30).map((d) => ({ ...d, since: d.since.toISOString(), dueAt: d.dueAt?.toISOString() ?? null })),
      bottlenecks: bottlenecks.slice(0, 30),
      workload: workload.filter((w) => w.active > 0 || w.meetingHours > 0 || w.reviews > 0),
      velocity: { last7: stats.last7, prev7: stats.prev7, delta: vDelta, label: 'закрытых задач за 7 дней' },
      victories: wins,
      projects: projectRisks.slice(0, 5),
      allProjects: projectViews.map((p) => ({ id: p.id, name: p.name, targetDate: p.targetDate, forecast: p.forecast, catchUp: p.catchUp, open: p.open })),
      can: await this.perms(a).then((p) => ({
        act: can(p, 'radar.execute_actions'), rebalance: can(p, 'radar.rebalance'), publish: can(p, 'radar.publish_news'),
        editNorms: a.role === 'owner',
      })),
    };
  }

  // ── действия (§47) ──

  /** Предпросмотр: что произойдёт, с кем и почему — запись предложения, без изменений. */
  async preview(a: Actor, i: { type: ActionType | 'PUBLISH_NEWS'; taskId?: string; toUserId?: string; date?: string; text?: string }) {
    const tz = FALLBACK_TZ;
    if (i.type === 'PUBLISH_NEWS') {
      await this.need(a, 'radar.publish_news', 'Публиковать победы может руководство');
      const text = String(i.text ?? '').trim();
      if (text.length < 5) throw AppException.validation('Пустую победу не публикуем');
      const p = await this.repo.createProposal({ tenantId: a.tenantId, actorId: a.userId, sourceType: 'victory', sourceId: null, actionType: 'PUBLISH_NEWS', payload: { text }, preview: `Пост в «Новости»:\n${text}`, reason: null });
      return { id: p!.id, preview: `Пост в «Новости»:\n${text}` };
    }
    await this.need(a, 'radar.execute_actions', 'Действовать из «Пульса» может руководство');
    const t = (await this.repo.openTasks(a.tenantId)).find((x) => x.id === String(i.taskId));
    if (!t) throw AppException.notFound('Задача не найдена или уже закрыта');
    let preview = ''; let payload: Record<string, unknown> = { taskId: t.id };
    switch (i.type) {
      case 'TASK_NUDGE': {
        if (!t.assigneeId) throw AppException.conflict('У задачи нет исполнителя — спросить некого');
        const last = await this.repo.lastNudge(t.id);
        if (last && Date.now() - last.getTime() < NUDGE_COOLDOWN_H * 3_600_000) {
          throw AppException.conflict(`По этой задаче уже спрашивали ${last.toLocaleString('ru-RU', { timeZone: tz, day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })} — дайте человеку ответить`);
        }
        preview = `Спросить ${t.assigneeName}:\n«По задаче «${t.title}» давно не было обновлений. Какой сейчас статус?»\nВарианты ответа: успеваю · есть блокер · нужен перенос.`;
        payload = { ...payload, userId: t.assigneeId };
        break;
      }
      case 'REVIEW_REMINDER': {
        if (!t.createdBy) throw AppException.conflict('У задачи нет постановщика');
        preview = `Напомнить ${t.createdByName ?? 'постановщику'}: задача #${t.id} «${t.title}» ждёт проверки.`;
        payload = { ...payload, userId: t.createdBy };
        break;
      }
      case 'TASK_REASSIGN': {
        const people = await this.repo.people(a.tenantId, new Date(), new Date());
        const to = people.find((p) => p.id === String(i.toUserId));
        if (!to) throw AppException.validation('Выберите, кому передать');
        preview = `Задача #${t.id} «${t.title}»\n${t.assigneeName ?? 'без исполнителя'} → ${to.name}`;
        payload = { ...payload, toUserId: to.id, toName: to.name };
        break;
      }
      case 'TASK_RESCHEDULE': {
        const d = new Date(String(i.date ?? ''));
        if (Number.isNaN(d.getTime()) || d.getTime() < Date.now()) throw AppException.validation('Новый срок — в будущем');
        preview = `Задача #${t.id} «${t.title}»\nСрок: ${t.deadlineAt ? t.deadlineAt.toLocaleDateString('ru-RU') : 'не задан'} → ${d.toLocaleDateString('ru-RU')}`;
        payload = { ...payload, deadline: d.toISOString(), prev: t.deadlineAt?.toISOString() ?? null };
        break;
      }
      case 'TASK_CREATE_MEETING': {
        const ids = [a.userId, t.assigneeId, t.createdBy].filter((x): x is string => !!x);
        const uniq = [...new Set(ids)];
        const from = new Date();
        const to = new Date(Date.now() + 3 * 86_400_000);
        const [{ busy }, work] = await Promise.all([this.calendar.busy(a.tenantId, uniq, from.toISOString(), to.toISOString()), this.calendar.work(a.tenantId)]);
        const all = Object.values(busy).flat().map((b) => ({ start: new Date(b.startsAt), end: new Date(b.endsAt), kind: b.kind }));
        const slot = findSlots({ from, to, durationMin: 30, busy: all, work, tz, now: from, max: 1 })[0];
        if (!slot) throw AppException.conflict('В ближайшие три рабочих дня нет общего окна на 30 минут');
        preview = `Созвон «Разбор: #${t.id} ${t.title}»\n${slot.start.toLocaleString('ru-RU', { timeZone: tz, weekday: 'short', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })}, 30 минут\nУчастники: ${[t.assigneeName, t.createdByName].filter(Boolean).join(', ') || 'только вы'}`;
        payload = { ...payload, start: slot.start.toISOString(), end: slot.end.toISOString(), participants: uniq.filter((x) => x !== a.userId), title: `Разбор: #${t.id} ${t.title}` };
        break;
      }
      case 'TASK_FOCUS': {
        preview = `Добавить #${t.id} «${t.title}» в ваш «Фокус дня» на сегодня.`;
        break;
      }
      default: throw AppException.validation('Неизвестное действие');
    }
    const p = await this.repo.createProposal({ tenantId: a.tenantId, actorId: a.userId, sourceType: 'bottleneck', sourceId: t.id, actionType: i.type, payload, preview, reason: null });
    void this.security.record({ tenantId: a.tenantId, actorId: a.userId, event: 'radar.action.proposed', resourceType: 'task', resourceId: t.id, metadata: { type: i.type } }).catch(() => undefined);
    return { id: p!.id, preview };
  }

  async reject(a: Actor, id: string) {
    const p = await this.repo.proposal(a.tenantId, a.userId, id);
    if (!p) throw AppException.notFound('Предложение не найдено');
    if (p.status === 'proposed') await this.repo.finishProposal(id, 'rejected');
    return { status: 'rejected' };
  }

  async confirm(a: Actor, id: string) {
    const p = await this.repo.proposal(a.tenantId, a.userId, id);
    if (!p) throw AppException.notFound('Предложение не найдено');
    if (!(await this.repo.claimProposal(id))) throw AppException.conflict('Предложение уже обработано или устарело — откройте его заново');
    const x = p.payload_json ?? {};
    try {
      let text = 'Готово.';
      switch (p.action_type) {
        case 'PUBLISH_NEWS':
          await this.need(a, 'radar.publish_news', 'Публиковать победы может руководство');
          await this.feed.create(a.tenantId, { userId: a.userId, role: a.role }, { body: String(x.text) });
          text = 'Победа опубликована в «Новостях».';
          break;
        case 'TASK_NUDGE':
          await this.nudge(a, String(x.taskId), String(x.userId));
          text = 'Вопрос отправлен исполнителю — ответ появится в задаче.';
          break;
        case 'REVIEW_REMINDER':
          await this.notify(a.tenantId, String(x.userId), 'radar.review', 'Ждёт вашей проверки', p.preview, String(x.taskId));
          text = 'Напоминание о проверке отправлено.';
          break;
        case 'TASK_REASSIGN':
          await this.need(a, 'task.assign', 'Нет права назначать исполнителя');
          await this.tasks.update(a.tenantId, String(x.taskId), { assigneeId: String(x.toUserId) } as any, a.userId);
          text = `Задача передана: ${x.toName}.`;
          break;
        case 'TASK_RESCHEDULE':
          await this.need(a, 'task.edit', 'Нет права менять задачу');
          await this.forecastSvc.setEstimateDeadline(a.tenantId, String(x.taskId), { deadline: String(x.deadline) });
          await this.activity.log(a.tenantId, String(x.taskId), a.userId, 'deadline_shifted', { to: x.deadline, via: 'pulse' });
          text = 'Срок перенесён.';
          break;
        case 'TASK_CREATE_MEETING':
          await this.calendar.create(a.tenantId, { userId: a.userId, role: a.role }, {
            title: String(x.title).slice(0, 255), startsAt: String(x.start), endsAt: String(x.end),
            participantIds: (x.participants as string[]) ?? [], scope: 'personal', isCall: true,
          } as any);
          text = 'Созвон поставлен, участникам ушло приглашение.';
          break;
        case 'TASK_FOCUS':
          await this.tasks.setFocusDate(a.tenantId, String(x.taskId), a.userId, new Date().toISOString().slice(0, 10));
          text = 'Задача добавлена в ваш «Фокус дня».';
          break;
        case 'REBALANCE': {
          await this.need(a, 'radar.rebalance', 'Перераспределять нагрузку может руководство');
          await this.need(a, 'task.assign', 'Нет права назначать исполнителя');
          let done = 0;
          for (const m of (x.moves as { taskId: string; toId: string }[]) ?? []) {
            try { await this.tasks.update(a.tenantId, m.taskId, { assigneeId: m.toId } as any, a.userId); done += 1; } catch (e) { this.log.warn(`перенос #${m.taskId}: ${(e as Error).message}`); }
          }
          void this.security.record({ tenantId: a.tenantId, actorId: a.userId, event: 'radar.rebalance.executed', metadata: { moves: x.moves } }).catch(() => undefined);
          text = `Передано задач: ${done}.`;
          break;
        }
        default: throw new Error('Неизвестное действие');
      }
      await this.repo.finishProposal(id, 'completed');
      void this.security.record({ tenantId: a.tenantId, actorId: a.userId, event: 'radar.action.executed', resourceType: 'radar_action', resourceId: id, metadata: { type: p.action_type } }).catch(() => undefined);
      this.invalidate(a.tenantId);
      this.realtime.emitToUsers(a.tenantId, [a.userId], 'radar.changed', { action: p.action_type });
      return { status: 'completed', text };
    } catch (e) {
      const msg = (e as Error).message;
      await this.repo.finishProposal(id, 'failed', msg);
      void this.security.record({ tenantId: a.tenantId, actorId: a.userId, event: 'radar.action.failed', resourceType: 'radar_action', resourceId: id, metadata: { type: p.action_type, error: msg } }).catch(() => undefined);
      throw e instanceof AppException ? e : AppException.conflict(`Не получилось: ${msg}`);
    }
  }

  /** Вопрос «как идёт работа»: если у задачи есть срок — с кнопками ответа в карточке задачи. */
  private async nudge(a: Actor, taskId: string, userId: string) {
    const t = (await this.repo.openTasks(a.tenantId)).find((x) => x.id === taskId);
    if (!t) throw new Error('Задача уже закрыта');
    const text = `По задаче «${t.title}» давно не было обновлений. Какой сейчас статус? Ответьте в задаче: успеваю · есть блокер · нужен перенос.`;
    if (t.deadlineAt) {
      const pingId = await this.followups.addPing({ tenantId: a.tenantId, userId, taskId, text, dedupKey: `pulse:${taskId}:${Date.now()}` });
      await this.followups.remember(a.tenantId, taskId, userId, t.deadlineAt.toISOString(), pingId).catch(() => false);
    }
    await this.repo.nudged(a.tenantId, taskId, a.userId);
    await this.notify(a.tenantId, userId, 'radar.nudge', 'Как идёт работа?', text, taskId, t.projectId);
  }

  private async notify(tenantId: string, userId: string, eventKey: string, title: string, body: string, taskId: string, projectId?: string) {
    const path = projectId ? `/projects/${projectId}/task/${taskId}` : '/focus';
    await this.push.personal({ tenantId, userId, eventKey, title, body, path });
    await this.telegram.push(tenantId, userId, `${title}\n\n${body}`).catch(() => false);
  }

  // ── балансировка (§34–36) ──

  async rebalancePreview(a: Actor, fromUserId: string) {
    await this.need(a, 'radar.rebalance', 'Перераспределять нагрузку может руководство');
    const now = new Date();
    const [tasks, people, members] = await Promise.all([
      this.repo.openTasks(a.tenantId), this.repo.people(a.tenantId, now, new Date(now.getTime() + 86_400_000)), this.repo.projectMembers(a.tenantId),
    ]);
    const reviewsOf = new Map<string, number>();
    for (const t of tasks) if (t.inReview && t.createdBy && t.createdBy !== t.assigneeId) reviewsOf.set(t.createdBy, (reviewsOf.get(t.createdBy) ?? 0) + 1);
    const cands = people.map((p) => {
      const mine = tasks.filter((t) => t.assigneeId === p.id && !t.inReview);
      const l = loadPoints({ tasks: mine, reviewsWaiting: reviewsOf.get(p.id) ?? 0, meetingHoursToday: 0 }, now);
      return { id: p.id, name: p.name, points: l.points, norm: p.norm ?? DEFAULT_NORM_POINTS, skills: p.skills, canReceive: p.canReceive, available: p.available, role: p.role };
    });
    const from = cands.find((c) => c.id === String(fromUserId));
    if (!from) throw AppException.notFound('Сотрудник не найден');
    const movable = tasks.filter((t) => t.assigneeId === from.id).map((t) => ({
      id: t.id, title: t.title, priority: t.priority, deadlineAt: t.deadlineAt, inReview: t.inReview, directions: t.directions,
      // проект «только для своих»: участники + руководство
      allowed: t.projectVisibility === 'members'
        ? new Set([...(members.get(t.projectId) ?? []), ...cands.filter((c) => c.role === 'owner' || c.role === 'manager').map((c) => c.id)])
        : null,
    }));
    const r = pickRebalance({ id: from.id, name: from.name, points: from.points, norm: from.norm }, movable, cands, now);
    if (!r.moves.length) return { id: null, moves: [], before: r.before, after: r.after, loads: [], note: 'Подходящих получателей нет: остальные загружены или не работают в этих направлениях.' };
    const loads = Object.entries(r.loads).map(([id, v]) => ({ id, name: cands.find((c) => c.id === id)?.name ?? id, ...v }));
    const preview = r.moves.map((m) => `#${m.taskId} «${m.title}»: ${from.name} → ${m.toName}`).join('\n') + `\nНагрузка ${from.name}: ${r.before}% → ${r.after}%`;
    const p = await this.repo.createProposal({ tenantId: a.tenantId, actorId: a.userId, sourceType: 'workload', sourceId: from.id, actionType: 'REBALANCE', payload: { moves: r.moves.map((m) => ({ taskId: m.taskId, toId: m.toId })) }, preview, reason: null });
    return { id: p!.id, moves: r.moves, before: r.before, after: r.after, loads, fromName: from.name, cost: r.moves.map((m) => taskPoints(movable.find((t) => t.id === m.taskId)!, now)) };
  }

  // ── мелкое ──

  async feedback(a: Actor, kind: string, ref: string, reason: string) {
    await this.need(a, 'radar.view', 'Нет доступа к «Пульсу»');
    await this.repo.feedback(a.tenantId, a.userId, kind, ref, reason);
    this.invalidate(a.tenantId);
    return { ok: true };
  }

  async setTargetDate(a: Actor, projectId: string, date: string | null) {
    await this.need(a, 'project.edit', 'Нет права менять проект');
    if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw AppException.validation('Дата — ГГГГ-ММ-ДД');
    if (!(await this.repo.setTargetDate(a.tenantId, projectId, date))) throw AppException.notFound('Проект не найден');
    this.invalidate(a.tenantId);
    return { targetDate: date };
  }

  async setNorm(a: Actor, userId: string, norm: number | null) {
    if (a.role !== 'owner') throw AppException.forbidden('Норму нагрузки меняет владелец');
    const n = norm === null ? null : Math.round(Number(norm));
    if (n !== null && (!Number.isFinite(n) || n < 2 || n > 60)) throw AppException.validation('Норма — от 2 до 60 очков');
    if (!(await this.repo.setNorm(a.tenantId, userId, n))) throw AppException.notFound('Сотрудник не найден');
    this.invalidate(a.tenantId);
    return { norm: n ?? DEFAULT_NORM_POINTS };
  }
}

export type { BottleneckType };
