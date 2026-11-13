import { Injectable, Logger } from '@nestjs/common';
import { AppException } from '../../common/http/app-exception';
import { maskSecrets } from '../../common/secrets';
import { DbService } from '../../database/db.service';
import { AiService } from '../ai/ai.service';
import { ChatsService } from '../chats/chats.service';
import { DecisionQueueService } from '../decision-queue/decision-queue.service';
import { BATCH_SIZE, etaMinutes, waitingTitle } from '../decision-queue/decision-queue.rules';
import { can, Permission } from '../security/permissions';
import { SecurityService } from '../security/security.service';
import { TaskActivityRepository } from '../tasks/task-activity.repository';
import { assigneeOwesSql, personalDeadlineSql, stageSql } from '../tasks/responsibility';
import { acceptDelta, IndexPoint } from './pulse-index.rules';
import { PulseIndexService } from './pulse-index.service';
import {
  availableHours, forecastRange, hoursLine, isStale, LOAD_TITLE, loadLabel, messageGrounded, MsgTask, plural, showTrial,
  statusMessage, Step, topSteps, trialSteps, TrialFacts,
} from './pulse-plus.rules';
import { PulseRepository } from './pulse.repository';
import { PulseService } from './pulse.service';

type Actor = { userId: string; role: string; tenantId: string };
const D = 86_400_000;

const MSG_SYSTEM = [
  'Ты помогаешь руководителю написать сотруднику короткое дружелюбное сообщение в личный чат.',
  'Тебе дают черновик. Перепиши его живым языком на «ты», 3–8 строк, без канцелярита.',
  'Обязательно сохрани ВСЕ строки задач с номерами вида #123 ровно как в черновике и вопрос «что осталось и когда сдашь» (или «сможешь принять»).',
  'Не добавляй задач, номеров, дат и обещаний, которых нет в черновике. Ответь только текстом сообщения.',
].join(' ');

const days = (ms: number) => Math.max(0, Math.floor(ms / D));

/**
 * «Пульс команды» по ТЗ #4890: что случилось → что сделать сейчас → подробности.
 * Один запрос на экран; числа «ждут решения» и индекс — свежие (решение в Фокусе сразу
 * меняет их здесь), узкие места и нагрузка — из сводки ТЗ-19 (кэш минута).
 */
@Injectable()
export class PulsePlusService {
  private readonly log = new Logger('PulsePlus');

  constructor(
    private readonly db: DbService,
    private readonly pulse: PulseService,
    private readonly repo: PulseRepository,
    private readonly index: PulseIndexService,
    private readonly queue: DecisionQueueService,
    private readonly security: SecurityService,
    private readonly ai: AiService,
    private readonly chats: ChatsService,
    private readonly activity: TaskActivityRepository,
  ) {}

  private async need(a: Actor, p: Permission, what: string) {
    if (!can(await this.security.permissionsOf(a.tenantId, a.userId), p)) throw AppException.forbidden(what);
  }

  // ── экран ──

  async screen(a: Actor, tz: string | null) {
    await this.need(a, 'radar.view', '«Пульс команды» открыт руководству — доступ выдаёт владелец');
    const now = new Date();
    const facts = await this.trialFacts(a.tenantId);
    const decisions = await this.queue.waiting(a, now);
    if (showTrial(facts)) {
      const steps = trialSteps(facts);
      return {
        generatedAt: now.toISOString(), mode: 'trial' as const,
        trial: { steps, done: steps.filter((s) => s.done).length, trialDaysLeft: await this.trialDaysLeft(a.tenantId) },
        decisions: { count: decisions.count },
      };
    }

    const [s, idx, team, lastMove, projects, hours, people, work, meetings] = await Promise.all([
      this.pulse.summary(a, tz), this.index.index(a.tenantId), this.queue.team(a.tenantId), this.repo.projectsLastMove(a.tenantId),
      this.repo.projects(a.tenantId), this.hoursByPerson(a.tenantId), this.repo.people(a.tenantId, now, now), this.workSettings(a.tenantId),
      this.meetingHours(a.tenantId),
    ]);
    const points = idx.points;
    const teamBy = new Map(team.map((r) => [r.decider_id, r]));

    // ── п. 9: нагрузка без процентов ──
    const load = (s.workload as any[]).map((w) => {
      const reviews = teamBy.get(w.id)?.n ?? 0;
      const label = loadLabel({ reviews, active: w.active, overdue: w.overdue, points: w.points, norm: w.norm });
      const h = hours.get(w.id) ?? { total: 0, withEstimate: 0, estimated: 0 };
      const available = availableHours({ ...work, meetingHours: meetings.get(w.id) ?? 0, now });
      return {
        id: w.id, name: w.name, available: w.available, label, labelTitle: LOAD_TITLE[label],
        reviews, active: w.active, urgent: w.urgent, overdue: w.overdue, returned: w.returned, submitted: w.submitted,
        hours: { estimated: Math.round(h.estimated * 10) / 10, withEstimate: h.withEstimate, total: h.total, available, line: hoursLine({ ...h, available }) },
        points: w.points, norm: w.norm,
      };
    });
    for (const r of team) {
      if (load.some((l) => l.id === r.decider_id)) continue;
      const label = loadLabel({ reviews: r.n, active: 0, overdue: 0, points: r.n * 0.5, norm: 12 });
      const available = availableHours({ ...work, meetingHours: meetings.get(r.decider_id) ?? 0, now });
      load.push({
        id: r.decider_id, name: r.name, available: true, label, labelTitle: LOAD_TITLE[label], reviews: r.n, active: 0, urgent: 0, overdue: 0, returned: 0, submitted: 0,
        hours: { estimated: 0, withEstimate: 0, total: 0, available, line: hoursLine({ estimated: 0, withEstimate: 0, total: 0, available }) }, points: r.n * 0.5, norm: 12,
      });
    }
    const ORDER = { reviews: 0, overdue: 1, normal: 2, spare: 3 } as const;
    load.sort((x, y) => ORDER[x.label] - ORDER[y.label] || y.reviews + y.overdue - (x.reviews + x.overdue) || y.active - x.active);

    // ── п. 10: прогноз ──
    const riskOf = new Map((s.allProjects as any[]).map((p) => [p.id, p]));
    const rows: any[] = []; const stale: { id: string; name: string }[] = []; const noData: string[] = [];
    for (const p of projects) {
      if (p.open <= 0) continue;
      if (isStale({ open: p.open, weekly: p.weekly, lastMove: lastMove.get(p.id) ?? null, now })) { stale.push({ id: p.id, name: p.name }); continue; }
      const r = forecastRange({ weekly: p.weekly, remaining: p.open, now });
      if (!r) { noData.push(p.name); continue; }
      const info = riskOf.get(p.id);
      const lvl = info?.risk?.level as 'high' | 'medium' | 'low' | undefined;
      const late = p.targetDate && r.to > p.targetDate ? days(Date.parse(r.to) - Date.parse(p.targetDate)) : null;
      rows.push({
        id: p.id, name: p.name, risk: lvl === 'high' ? 'risk' : lvl === 'medium' ? 'attention' : null, riskScore: info?.risk?.score ?? 0,
        remaining: p.open, perWeek: Math.round((p.weekly.reduce((x, y) => x + y, 0) / (p.weekly.length || 1)) * 10) / 10,
        stuck: info?.stuck ?? 0, overdue: info?.overdue ?? 0, range: r, targetDate: p.targetDate, late,
      });
    }
    rows.sort((x, y) => y.riskScore - x.riskScore || y.remaining - x.remaining);

    // ── п. 7: шаги ──
    const steps = await this.steps(a, s, points, team, load, stale, people);

    // ── п. 2: «Главное — у вас» ──
    const main = await this.mainCard(a, decisions, team, points, people, steps);

    return {
      generatedAt: now.toISOString(), mode: 'full' as const,
      head: {
        score: idx.score, display: idx.display, zone: idx.zone, zoneTitle: idx.zoneTitle, headline: idx.headline, speed: idx.speed,
        trend7: idx.trend7, series: idx.series, velocity: idx.velocity, formula: idx.formula, version: idx.version,
      },
      main,
      decisions: { count: decisions.count, take: Math.min(BATCH_SIZE, decisions.count), etaMin: etaMinutes(Math.min(BATCH_SIZE, decisions.count)) },
      steps: { top: topSteps(steps.all), total: s.bottleneckTotal ?? 0, groups: steps.groups },
      load,
      forecast: { rows, stale, noData },
      can: s.can,
    };
  }

  private async steps(a: Actor, s: any, points: IndexPoint[], team: Awaited<ReturnType<DecisionQueueService['team']>>, load: any[], stale: { id: string; name: string }[], people: { id: string; name: string; role: string; canReceive: boolean; available: boolean }[]) {
    const all: Step[] = [];
    const bn = (s.allBottlenecks ?? []) as any[];
    const now = Date.now();
    // просрочки по людям → одно сообщение
    const overdue = new Map<string, { name: string; ids: string[]; maxDays: number }>();
    for (const b of bn) {
      if (b.type !== 'OVERDUE' || !b.assigneeId) continue;
      const g = overdue.get(b.assigneeId) ?? { name: b.assignee ?? '', ids: [] as string[], maxDays: 0 };
      g.ids.push(b.taskId);
      if (b.dueAt) g.maxDays = Math.max(g.maxDays, days(now - Date.parse(b.dueAt)));
      overdue.set(b.assigneeId, g);
    }
    for (const [uid, g] of overdue) {
      const n = g.ids.length;
      all.push({
        kind: 'nudge', key: `nudge:${uid}`, userId: uid, userName: g.name, taskIds: g.ids,
        title: `Спросить статус по ${n} ${plural(n, 'просрочке', 'просрочкам', 'просрочкам')} — ${g.name}`,
        detail: `одним сообщением · текст готов · самая старая просрочена на ${g.maxDays} дн.`,
        effect: this.index.effect(points, { overdue: -n }), button: 'Подготовить',
      });
    }
    // очередь проверки у другого человека → напомнить одним сообщением
    for (const r of team) {
      if (r.decider_id === a.userId || r.n < 3) continue;
      all.push({
        kind: 'remind_review', key: `review:${r.decider_id}`, userId: r.decider_id, userName: r.name,
        title: `Напомнить о ${r.n} ${plural(r.n, 'проверке', 'проверках', 'проверках')} — ${r.name}`,
        detail: `одним сообщением · самая старая ждёт ${days(now - new Date(r.oldest).getTime())} дн.`,
        effect: this.index.effect(points, acceptDelta(Math.min(BATCH_SIZE, r.n))), button: 'Подготовить',
      });
    }
    // проекты без движения → закрыть или оживить
    if (stale.length) {
      const imp = await this.staleImpact(a.tenantId, stale.map((p) => p.id));
      all.push({
        kind: 'stale', key: 'stale', projectIds: stale.map((p) => p.id),
        title: `Закрыть или оживить ${stale.length} ${plural(stale.length, 'проект', 'проекта', 'проектов')} без движения 4+ недели`,
        detail: stale.slice(0, 6).map((p) => p.name).join(', ') + (stale.length > 6 ? ` и ещё ${stale.length - 6}` : ''),
        effect: this.index.effect(points, { open: -imp.open, overdue: -imp.overdue, review: -imp.review, noAssignee: -imp.noAssignee }), button: 'Разобрать',
      });
    }
    // перегруженный → передать срочные тому, у кого запас
    const busy = load.filter((l) => (l.label === 'overdue' || l.points > l.norm) && l.active > 0).sort((x, y) => y.points - x.points)[0];
    const spare = load.filter((l) => l.label === 'spare' && l.available && l.id !== busy?.id)
      .filter((l) => people.find((p) => p.id === l.id)?.canReceive !== false).sort((x, y) => x.active - y.active)[0];
    if (busy && spare) {
      const urgent = await this.db.many<{ id: string }>(
        `SELECT t.id::text FROM tasks t JOIN projects p ON p.id = t.project_id AND p.status <> 'archived' AND NOT p.is_demo
          WHERE t.tenant_id = $1 AND t.assignee_id = $2 AND t.closed_at IS NULL AND t.deleted_at IS NULL AND ${assigneeOwesSql('t')}
            AND t.priority IN ('urgent', 'high')
            AND (p.visibility <> 'members' OR EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id = p.id AND pm.user_id = $3))
          ORDER BY ${personalDeadlineSql('t')} ASC NULLS LAST LIMIT 3`, [a.tenantId, busy.id, spare.id]);
      if (urgent.length) {
        const k = urgent.length;
        all.push({
          kind: 'balance', key: `balance:${busy.id}`, userId: busy.id, userName: busy.name, toId: spare.id, toName: spare.name, taskIds: urgent.map((u) => u.id),
          title: `Передать ${k} ${plural(k, 'срочную задачу', 'срочные задачи', 'срочных задач')}: ${busy.name} → ${spare.name}`,
          detail: 'предпросмотр до/после · сроки не меняются',
          effect: this.index.effect(points, { excess: -Math.min(k, Math.max(0, busy.active - 12)) }), button: 'Посмотреть',
        });
      }
    }
    // без исполнителя → назначить
    const noAssignee = bn.filter((b) => b.type === 'NO_ASSIGNEE');
    if (noAssignee.length) {
      const n = noAssignee.length;
      all.push({
        kind: 'assign', key: 'assign', taskIds: noAssignee.map((b) => b.taskId),
        title: `Назначить исполнителей на ${n} ${plural(n, 'задачу', 'задачи', 'задач')}`,
        detail: noAssignee.slice(0, 3).map((b) => `#${b.taskId} ${String(b.title).slice(0, 40)}`).join(' · '),
        effect: this.index.effect(points, { noAssignee: -n }), button: 'Назначить',
      });
    }

    // «Показать все» — сгруппированы по людям, у группы одна главная кнопка
    const groups = new Map<string, { key: string; userId: string | null; name: string; items: any[]; stepKey: string | null }>();
    for (const b of bn) {
      const uid = b.type === 'WAITING_REVIEW' ? (b.reviewerId ?? null) : (b.assigneeId ?? null);
      const name = b.type === 'WAITING_REVIEW' ? (b.reviewer ?? 'Проверяющий не указан') : (b.assignee ?? 'Без исполнителя');
      const key = uid ?? `none:${b.type === 'NO_ASSIGNEE' ? 'assign' : name}`;
      const g = groups.get(key) ?? { key, userId: uid, name, items: [] as any[], stepKey: null };
      if (g.items.length < 60) g.items.push({ taskId: b.taskId, title: b.title, typeTitle: b.typeTitle, why: b.why, projectId: b.projectId, projectName: b.projectName, type: b.type });
      groups.set(key, g);
    }
    const byKey = new Map(all.map((x) => [x.key, x]));
    const list = [...groups.values()].map((g) => {
      const step = g.userId
        ? (g.userId === a.userId ? null : byKey.get(`nudge:${g.userId}`) ?? byKey.get(`review:${g.userId}`) ?? null)
        : g.key === 'none:assign' ? byKey.get('assign') ?? null : null;
      return { ...g, me: g.userId === a.userId, stepKey: step?.key ?? null, count: g.items.length };
    }).sort((x, y) => y.count - x.count);
    return { all, groups: list };
  }

  private async mainCard(a: Actor, mine: Awaited<ReturnType<DecisionQueueService['waiting']>>, team: Awaited<ReturnType<DecisionQueueService['team']>>,
    points: IndexPoint[], people: { id: string; name: string; role: string; available: boolean }[], steps: { all: Step[] }) {
    const top = team[0];
    const queueOf = (id: string) => team.find((r) => r.decider_id === id)?.n ?? 0;
    const pickHelper = (fromId: string) => people
      .filter((p) => p.id !== fromId && p.available && (p.role === 'owner' || p.role === 'manager'))
      .sort((x, y) => queueOf(x.id) - queueOf(y.id) || x.name.localeCompare(y.name, 'ru'))[0] ?? null;
    const projectsText = (names: string[], total: number) => {
      if (!total) return '';
      const shown = names.slice(0, 2).filter(Boolean);
      return total === 1 && shown[0] ? `проект ${shown[0]}` : `${total} ${plural(total, 'проект', 'проекта', 'проектов')}${shown.length ? ` (${shown.join(', ')}${total > shown.length ? '…' : ''})` : ''}`;
    };
    const consequence = (peopleN: number, projText: string, oldest: number) =>
      `Из-за этого ${peopleN ? `ждут ${peopleN} ${plural(peopleN, 'человек', 'человека', 'человек')}` : 'ждёт работа'}${projText ? ` и ${projText}` : ''}. Самая старая — ${oldest} ${plural(oldest, 'день', 'дня', 'дней')}.`;

    if (mine.count > 0 && (!top || top.decider_id === a.userId || mine.count >= top.n)) {
      const take = Math.min(BATCH_SIZE, mine.count);
      const helper = pickHelper(a.userId);
      return {
        kind: 'me' as const, title: waitingTitle(mine.count), count: mine.count,
        consequence: consequence(mine.people, projectsText(mine.projects, mine.projects.length), mine.oldestDays),
        cost: { minutes: etaMinutes(take), take }, effect: this.index.effect(points, acceptDelta(take)),
        handoff: helper && mine.reviews > 1 ? { fromId: a.userId, toId: helper.id, toName: helper.name, count: Math.min(BATCH_SIZE, Math.ceil(mine.reviews / 2)) } : null,
        who: null,
      };
    }
    if (top && top.n >= 3) {
      const take = Math.min(BATCH_SIZE, top.n);
      const helper = pickHelper(top.decider_id);
      const oldest = days(Date.now() - new Date(top.oldest).getTime());
      return {
        kind: 'other' as const, title: `${top.name}: ${top.n} ${plural(top.n, 'задача ждёт', 'задачи ждут', 'задач ждут')} проверки`, count: top.n,
        consequence: consequence(top.people, projectsText(top.project_names ?? [], top.projects), oldest),
        cost: { minutes: etaMinutes(take), take }, effect: this.index.effect(points, acceptDelta(take)),
        handoff: helper ? { fromId: top.decider_id, toId: helper.id, toName: helper.name, count: Math.min(BATCH_SIZE, Math.ceil(top.n / 2)) } : null,
        who: { id: top.decider_id, name: top.name },
      };
    }
    const step = topSteps(steps.all, 1)[0];
    if (step) return { kind: 'step' as const, title: step.title, consequence: step.detail, count: step.taskIds?.length ?? step.projectIds?.length ?? 0, cost: null, effect: step.effect, handoff: null, who: null, step };
    return { kind: 'none' as const, title: 'Главного затыка нет', consequence: 'Проверки не копятся, просрочек и стоящих проектов нет.', count: 0, cost: null, effect: 0, handoff: null, who: null };
  }

  // ── п. 3: паспорта чисел Пульса ──

  async passport(a: Actor, metric: string) {
    await this.need(a, 'radar.view', 'Нет доступа к «Пульсу»');
    const now = new Date();
    if (metric === 'decisions') return this.queue.passport(a);
    if (metric === 'index') {
      const idx = await this.index.index(a.tenantId);
      return {
        metric, title: `Индекс здоровья ${idx.display} из 100 — ${idx.zoneTitle}`, value: idx.display,
        what: 'Пять частей с прежними весами: закрываем столько, сколько приходит (25%), сроки (20%), движение задач (20%), загрузка (20%), скорость (15%). Каждая часть — 40% уровня и 60% динамики к собственной базе команды.',
        period: 'Сейчас; тренд — за 7 дней, график — 8 недель по той же формуле', scope: 'Все проекты команды, кроме архивных и демо',
        updatedAt: now.toISOString(),
        related: [{ label: 'за 7 дней', value: `${idx.trend7 >= 0 ? '+' : ''}${idx.trend7}` }, { label: 'закрыто за 7 дней', value: idx.velocity.last7 }, { label: 'неделей раньше', value: idx.velocity.prev7 }],
        list: null,
      };
    }
    if (metric === 'team_review') {
      const team = await this.queue.team(a.tenantId);
      const total = await this.queue.teamTotal(a.tenantId);
      return {
        metric, title: `У команды на проверке: ${total}`, value: total,
        what: 'Открытые задачи на проверке, тестировании или приёмке во всех проектах (без «ждём клиента»).',
        period: 'Сейчас', scope: 'Вся команда', updatedAt: now.toISOString(),
        related: team.slice(0, 4).map((r) => ({ label: `проверяет ${r.name}`, value: r.n })), list: null,
      };
    }
    if (metric === 'bottlenecks') {
      const s = await this.pulse.summary(a, null);
      return {
        metric, title: `Узких мест: ${s.bottleneckTotal ?? 0}`, value: s.bottleneckTotal ?? 0,
        what: 'Задачи без исполнителя дольше суток, просроченные в работе, ждущие проверки дольше нормы или с прошедшим сроком, с блокером, без движения дольше нормы по приоритету.',
        period: 'Сейчас', scope: 'Все проекты команды, кроме архивных и демо; отмеченное «Это не проблема» скрыто на неделю', updatedAt: now.toISOString(),
        related: [], list: null,
      };
    }
    throw AppException.validation('Неизвестное число');
  }

  // ── п. 8: одно сообщение на группу задач ──

  private async groupTasks(a: Actor, kind: 'overdue' | 'review', userId: string, taskIds?: string[]): Promise<MsgTask[]> {
    const ids = (taskIds ?? []).map(String).filter((x) => /^\d+$/.test(x)).slice(0, 50);
    if (kind === 'review') {
      const rows = await this.db.many<{ id: string; title: string; since: Date }>(
        `SELECT t.id::text, t.title, COALESCE(t.submitted_at, t.updated_at) AS since FROM tasks t
           JOIN projects p ON p.id = t.project_id AND p.status <> 'archived' AND NOT p.is_demo
          WHERE t.tenant_id = $1 AND t.closed_at IS NULL AND t.deleted_at IS NULL AND COALESCE(t.reviewer_id, t.created_by) = $2
            AND ${stageSql('t')} IN ('testing', 'review', 'approval') AND (t.assignee_id IS NULL OR t.assignee_id <> $2)
            AND (cardinality($3::bigint[]) = 0 OR t.id = ANY($3::bigint[]))
          ORDER BY since ASC LIMIT 30`, [a.tenantId, userId, ids]);
      return rows.map((r) => ({ id: r.id, title: r.title, days: days(Date.now() - new Date(r.since).getTime()) }));
    }
    const rows = await this.db.many<{ id: string; title: string; due: Date }>(
      `SELECT t.id::text, t.title, ${personalDeadlineSql('t')} AS due FROM tasks t
         JOIN projects p ON p.id = t.project_id AND p.status <> 'archived' AND NOT p.is_demo
        WHERE t.tenant_id = $1 AND t.assignee_id = $2 AND t.closed_at IS NULL AND t.deleted_at IS NULL
          AND ${assigneeOwesSql('t')} AND ${personalDeadlineSql('t')} < now()
          AND (cardinality($3::bigint[]) = 0 OR t.id = ANY($3::bigint[]))
        ORDER BY due ASC LIMIT 30`, [a.tenantId, userId, ids]);
    return rows.map((r) => ({ id: r.id, title: r.title, days: days(Date.now() - new Date(r.due).getTime()) }));
  }

  /** Готовый текст (ИИ или правила) — ничего не отправляет. */
  async prepareMessage(a: Actor, i: { userId: string; kind: 'overdue' | 'review'; taskIds?: string[] }) {
    await this.need(a, 'radar.execute_actions', 'Писать из «Пульса» может руководство');
    const u = await this.db.one<{ id: string; name: string }>(
      `SELECT id::text, full_name AS name FROM users WHERE tenant_id = $1 AND id = $2 AND is_active`, [a.tenantId, i.userId]);
    if (!u) throw AppException.notFound('Сотрудник не найден');
    if (u.id === a.userId) throw AppException.validation('Себе сообщение не нужно — откройте разбор в Фокусе');
    const tasks = await this.groupTasks(a, i.kind, u.id, i.taskIds);
    if (!tasks.length) throw AppException.conflict('Задач в этой группе уже нет — список обновился');
    const all = await this.groupTasks(a, i.kind, u.id);
    const draft = statusMessage({ name: u.name, kind: i.kind, tasks });
    let text = draft; let source: 'ai' | 'rules' = 'rules';
    if (await this.ai.hasModel(a.tenantId).catch(() => false)) {
      try {
        const raw = (await this.ai.generate(a.tenantId, MSG_SYSTEM, maskSecrets(draft), 'pulse_message')).trim();
        if (messageGrounded(raw, tasks.map((t) => t.id))) { text = raw; source = 'ai'; }
      } catch (e) { this.log.warn(`текст сообщения: ${(e as Error).message}`); }
    }
    return { recipient: { id: u.id, name: u.name }, kind: i.kind, tasks, available: all, text, source };
  }

  /**
   * Отправить — только по нажатию «Отправить» (п. 8): от имени руководителя в личный чат
   * Qevo; у каждой задачи группы в истории — «запрошен статус».
   */
  async sendMessage(a: Actor, i: { userId: string; kind: 'overdue' | 'review'; taskIds: string[]; text: string }) {
    await this.need(a, 'radar.execute_actions', 'Писать из «Пульса» может руководство');
    const text = String(i.text ?? '').trim();
    if (text.length < 5) throw AppException.validation('Пустое сообщение не отправляем');
    const tasks = await this.groupTasks(a, i.kind, String(i.userId), i.taskIds);
    if (!tasks.length) throw AppException.conflict('Задач в группе уже нет');
    const dm = await this.chats.openDm(a.tenantId, a.userId, String(i.userId));
    await this.chats.send(a.tenantId, String(dm.id), { userId: a.userId, role: a.role }, text.slice(0, 4000), null);
    for (const t of tasks) {
      await this.activity.log(a.tenantId, t.id, a.userId, 'status_requested', { chatId: String(dm.id), kind: i.kind, to: String(i.userId) });
      if (i.kind === 'overdue') await this.repo.nudged(a.tenantId, t.id, a.userId).catch(() => undefined);
    }
    void this.repo.event(a.tenantId, a.userId, 'action', `message:${i.kind}`).catch(() => undefined);
    this.pulse.invalidate(a.tenantId);
    return { chatId: String(dm.id), marked: tasks.length };
  }

  // ── п. 2: «Передать часть» ──

  async handoffPreview(a: Actor, i: { fromId: string; toId?: string | null; count?: number }) {
    await this.need(a, 'radar.execute_actions', 'Передавать проверки может руководство');
    const team = await this.queue.team(a.tenantId);
    const fromRow = team.find((r) => r.decider_id === String(i.fromId));
    if (!fromRow) throw AppException.conflict('У этого человека нет задач на проверке');
    const people = await this.repo.people(a.tenantId, new Date(), new Date());
    const queueOf = (id: string) => team.find((r) => r.decider_id === id)?.n ?? 0;
    const to = i.toId
      ? people.find((p) => p.id === String(i.toId))
      : people.filter((p) => p.id !== fromRow.decider_id && p.available && (p.role === 'owner' || p.role === 'manager')).sort((x, y) => queueOf(x.id) - queueOf(y.id))[0];
    if (!to || to.id === fromRow.decider_id) throw AppException.validation('Выберите, кому передать');
    const n = Math.max(1, Math.min(BATCH_SIZE * 3, i.count ?? Math.min(BATCH_SIZE, Math.ceil(fromRow.n / 2))));
    const tasks = await this.db.many<{ id: string; title: string; since: Date }>(
      `SELECT t.id::text, t.title, COALESCE(t.submitted_at, t.updated_at) AS since FROM tasks t
         JOIN projects p ON p.id = t.project_id AND p.status <> 'archived' AND NOT p.is_demo
        WHERE t.tenant_id = $1 AND t.closed_at IS NULL AND t.deleted_at IS NULL AND COALESCE(t.reviewer_id, t.created_by) = $2
          AND ${stageSql('t')} IN ('testing', 'review', 'approval') AND (t.assignee_id IS NULL OR t.assignee_id <> $2)
          AND (t.assignee_id IS NULL OR t.assignee_id <> $3)
        ORDER BY since ASC LIMIT $4`, [a.tenantId, fromRow.decider_id, to.id, n]);
    if (!tasks.length) throw AppException.conflict('Передавать нечего');
    const preview = `Проверяющий у ${tasks.length} ${plural(tasks.length, 'задачи', 'задач', 'задач')}: ${fromRow.name} → ${to.name}\n`
      + tasks.map((t) => `#${t.id} «${t.title}»`).join('\n');
    const p = await this.repo.createProposal({
      tenantId: a.tenantId, actorId: a.userId, sourceType: 'review_queue', sourceId: fromRow.decider_id, actionType: 'HANDOFF_REVIEW',
      payload: { fromId: fromRow.decider_id, toId: to.id, toName: to.name, taskIds: tasks.map((t) => t.id) }, preview, reason: null,
    });
    return {
      id: p!.id, preview, from: { id: fromRow.decider_id, name: fromRow.name }, to: { id: to.id, name: to.name },
      tasks: tasks.map((t) => ({ id: t.id, title: t.title, days: days(Date.now() - new Date(t.since).getTime()) })),
      before: { from: fromRow.n, to: queueOf(to.id) }, after: { from: fromRow.n - tasks.length, to: queueOf(to.id) + tasks.length },
      candidates: people.filter((x) => x.id !== fromRow.decider_id && x.available).map((x) => ({ id: x.id, name: x.name, queue: queueOf(x.id) })),
    };
  }

  // ── п. 11, 12 и метрики ──

  async trialFacts(tenantId: string): Promise<TrialFacts> {
    const r = await this.db.one<{ colleagues: number; invites: number; with_deadline: number; reviewer_set: boolean; closed: number }>(
      `SELECT GREATEST(0, (SELECT count(*) FROM users u JOIN roles r ON r.id = u.role_id WHERE u.tenant_id = $1 AND u.is_active AND r.code <> 'client') - 1)::int AS colleagues,
              (SELECT count(*) FROM invites WHERE tenant_id = $1 AND accepted_at IS NULL AND expires_at > now())::int AS invites,
              (SELECT count(*) FROM tasks t JOIN projects p ON p.id = t.project_id AND NOT p.is_demo
                WHERE t.tenant_id = $1 AND t.deleted_at IS NULL AND t.deadline_at IS NOT NULL)::int AS with_deadline,
              EXISTS (SELECT 1 FROM tasks t JOIN projects p ON p.id = t.project_id AND NOT p.is_demo
                       WHERE t.tenant_id = $1 AND t.deleted_at IS NULL AND (t.reviewer_id IS NOT NULL OR t.first_submitted_at IS NOT NULL)) AS reviewer_set,
              (SELECT count(*) FROM tasks t JOIN projects p ON p.id = t.project_id AND NOT p.is_demo
                WHERE t.tenant_id = $1 AND t.deleted_at IS NULL AND t.closed_at IS NOT NULL)::int AS closed`,
      [tenantId]);
    return {
      colleagues: r?.colleagues ?? 0, invites: r?.invites ?? 0, tasksWithDeadline: r?.with_deadline ?? 0,
      reviewerSet: !!r?.reviewer_set, closed: r?.closed ?? 0,
    };
  }

  private async trialDaysLeft(tenantId: string): Promise<number | null> {
    const r = await this.db.one<{ ends: Date | null; status: string | null }>(
      `SELECT trial_ends_at AS ends, status FROM tenant_subscriptions WHERE tenant_id = $1`, [tenantId]).catch(() => null);
    if (!r?.ends || (r.status && r.status.toUpperCase() !== 'TRIAL')) return null;
    return Math.max(0, Math.ceil((new Date(r.ends).getTime() - Date.now()) / D));
  }

  async event(a: Actor, kind: string, ref: string | null) {
    await this.repo.event(a.tenantId, a.userId, kind, ref);
    return { ok: true };
  }

  // ── выборки ──

  /** Задачи на ближайшую неделю (просроченные, со сроком в 7 днях, без срока) и их оценки — для вкладки «По часам». */
  private async hoursByPerson(tenantId: string) {
    const rows = await this.db.many<{ id: string; total: number; with_est: number; est: number }>(
      `SELECT t.assignee_id::text AS id, count(*)::int AS total, count(t.estimate_hours)::int AS with_est,
              COALESCE(sum(t.estimate_hours), 0)::float AS est
         FROM tasks t JOIN projects p ON p.id = t.project_id AND p.status <> 'archived' AND NOT p.is_demo
        WHERE t.tenant_id = $1 AND t.assignee_id IS NOT NULL AND t.closed_at IS NULL AND t.deleted_at IS NULL
          AND ${assigneeOwesSql('t')}
          AND (${personalDeadlineSql('t')} IS NULL OR ${personalDeadlineSql('t')} < now() + interval '7 days')
        GROUP BY t.assignee_id`, [tenantId]);
    return new Map(rows.map((r) => [r.id, { total: r.total, withEstimate: r.with_est, estimated: Number(r.est) }]));
  }

  private async meetingHours(tenantId: string) {
    const rows = await this.db.many<{ id: string; h: number }>(
      `SELECT cp.user_id::text AS id,
              COALESCE(sum(EXTRACT(EPOCH FROM (LEAST(e.ends_at, now() + interval '7 days') - GREATEST(e.starts_at, now()))) / 3600), 0)::float AS h
         FROM calendar_events e JOIN calendar_participants cp ON cp.event_id = e.id
        WHERE e.tenant_id = $1 AND NOT e.all_day AND cp.status <> 'declined'
          AND e.starts_at < now() + interval '7 days' AND e.ends_at > now()
        GROUP BY cp.user_id`, [tenantId]);
    return new Map(rows.map((r) => [r.id, Number(r.h)]));
  }

  private async workSettings(tenantId: string) {
    const r = await this.db.one<{ work_start: string; work_end: string; weekend_days: number[] }>(
      `SELECT work_start::text, work_end::text, weekend_days FROM org_work_settings WHERE tenant_id = $1`, [tenantId]);
    return { workStart: (r?.work_start ?? '09:00').slice(0, 5), workEnd: (r?.work_end ?? '18:30').slice(0, 5), weekendDays: (r?.weekend_days ?? [0, 6]).map(Number) };
  }

  /** Что уйдёт из величин индекса, если стоящие проекты закрыть. */
  private async staleImpact(tenantId: string, projectIds: string[]) {
    const r = await this.db.one<{ open: number; overdue: number; review: number; no_assignee: number }>(
      `SELECT count(*)::int AS open,
              count(*) FILTER (WHERE ${stageSql('t')} = 'work' AND t.deadline_at < now())::int AS overdue,
              count(*) FILTER (WHERE ${stageSql('t')} IN ('testing', 'review', 'approval'))::int AS review,
              count(*) FILTER (WHERE t.assignee_id IS NULL)::int AS no_assignee
         FROM tasks t WHERE t.tenant_id = $1 AND t.project_id = ANY($2::bigint[]) AND t.closed_at IS NULL AND t.deleted_at IS NULL`,
      [tenantId, projectIds]);
    return { open: r?.open ?? 0, overdue: r?.overdue ?? 0, review: r?.review ?? 0, noAssignee: r?.no_assignee ?? 0 };
  }
}
