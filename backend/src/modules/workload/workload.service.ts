import { Injectable, Logger } from '@nestjs/common';
import { AppException } from '../../common/http/app-exception';
import { DbService } from '../../database/db.service';
import { localParts } from '../assistant/ping-rules';
import { tomorrowOf, zonedTime } from '../focus/close-day';
import { ProactiveService } from '../proactive/proactive.service';
import { ProactiveRepository } from '../proactive/proactive.repository';
import { fingerprint } from '../proactive/proactive-rules';
import { DEFAULT_NORM_POINTS, loadPoints, Priority } from '../radar/pulse-rules';
import { PulseRepository } from '../radar/pulse.repository';
import { SecurityService } from '../security/security.service';
import { addDays, assess, Assessment, dayWord } from './workload-rules';

export interface GuardInput {
  assigneeId: string;
  projectId: string;
  priority?: string | null;
  deadlineAt?: string | Date | null;
  directions?: string[];
  title?: string;
}

const PRIORITIES: Priority[] = ['low', 'normal', 'high', 'urgent'];

/**
 * Страж нагрузки (ТЗ-21, этап 3). Проверка ДО создания задачи (§28) во всех способах
 * постановки: окно задачи и быстрая команда спрашивают человека сразу; фоновые пути
 * (разбор переписки, встречи, пакет) ставят задачу и кладут в ящик карточку «перенести /
 * передать / оставить» тому, кто ставил. Не запрет (§31): человек может оставить —
 * это пишется в журнал (§34).
 */
@Injectable()
export class WorkloadGuardService {
  private readonly log = new Logger('WorkloadGuard');

  constructor(
    private readonly db: DbService,
    private readonly pulse: PulseRepository,
    private readonly proactive: ProactiveService,
    private readonly proactiveRepo: ProactiveRepository,
    private readonly security: SecurityService,
  ) {}

  private async enabled(tenantId: string): Promise<boolean> {
    const s = await this.proactiveRepo.tenantSettings(tenantId);
    return s.enabled && s.workloadGuard;
  }

  private async tz(tenantId: string): Promise<string> {
    const row = await this.db.one<{ tz: string | null }>(`SELECT timezone AS tz FROM tenants WHERE id=$1`, [tenantId]);
    return row?.tz || 'Europe/Moscow';
  }

  /** Оценка — той же арифметикой, что «Пульс»: задачи, проверки, встречи сегодня. */
  async assess(tenantId: string, input: GuardInput): Promise<(Assessment & { assigneeName: string; deadlineWord: string | null }) | null> {
    const tz = await this.tz(tenantId);
    const now = new Date();
    const today = localParts(now, tz).date;
    const [tasks, people, members, project] = await Promise.all([
      this.pulse.openTasks(tenantId),
      this.pulse.people(tenantId, zonedTime(today, '00:00', tz), zonedTime(tomorrowOf(now, tz), '00:00', tz)),
      this.pulse.projectMembers(tenantId),
      this.db.one<{ visibility: string; owner_user_id: string | null }>(`SELECT visibility, owner_user_id::text FROM projects WHERE tenant_id=$1 AND id=$2`, [tenantId, input.projectId]),
    ]);
    const reviewsOf = new Map<string, number>();
    for (const t of tasks) if (t.inReview && t.createdBy && t.createdBy !== t.assigneeId) reviewsOf.set(t.createdBy, (reviewsOf.get(t.createdBy) ?? 0) + 1);
    const breakdownOf = (id: string, meetingHours: number) => loadPoints({
      tasks: tasks.filter((t) => t.assigneeId === id && !t.inReview),
      reviewsWaiting: reviewsOf.get(id) ?? 0, meetingHoursToday: Math.round(meetingHours * 10) / 10,
    }, now);
    const loadOf = (id: string, meetingHours: number) => breakdownOf(id, meetingHours).points;
    const me = people.find((p) => p.id === String(input.assigneeId));
    if (!me) return null;
    const allowed = project?.visibility === 'members'
      ? new Set([...(members.get(String(input.projectId)) ?? new Set<string>()), ...(project.owner_user_id ? [String(project.owner_user_id)] : [])])
      : null;
    const priority = (PRIORITIES.includes(input.priority as Priority) ? input.priority : 'normal') as Priority;
    const deadlineAt = input.deadlineAt ? new Date(input.deadlineAt) : null;
    const local = (d: Date) => { const l = localParts(d, tz); return { date: l.date, isoDow: l.dow === 0 ? 7 : l.dow }; };
    const a = assess(
      {
        id: me.id, name: me.name, points: loadOf(me.id, me.meetingHours), norm: me.norm ?? DEFAULT_NORM_POINTS,
        breakdown: breakdownOf(me.id, me.meetingHours),
        tasks: tasks.filter((t) => t.assigneeId === me.id && !t.inReview).map((t) => ({ priority: t.priority, deadlineAt: t.deadlineAt })),
      },
      { priority, deadlineAt, directions: input.directions ?? [], allowed },
      people.filter((p) => p.role !== 'client').map((p) => ({
        id: p.id, name: p.name, points: loadOf(p.id, p.meetingHours), norm: p.norm ?? DEFAULT_NORM_POINTS,
        skills: p.skills ?? [], canReceive: p.canReceive, available: p.available,
      })),
      now, local,
    );
    return { ...a, assigneeName: me.name, deadlineWord: a.deadlineDate ? dayWord(a.deadlineDate, today) : null };
  }

  /** Кто сейчас выше нормы — той же арифметикой «Пульса» (для утреннего брифа руководителя). */
  async overloaded(tenantId: string): Promise<string[]> {
    const tz = await this.tz(tenantId);
    const now = new Date();
    const today = localParts(now, tz).date;
    const [tasks, people] = await Promise.all([
      this.pulse.openTasks(tenantId),
      this.pulse.people(tenantId, zonedTime(today, '00:00', tz), zonedTime(tomorrowOf(now, tz), '00:00', tz)),
    ]);
    const reviewsOf = new Map<string, number>();
    for (const t of tasks) if (t.inReview && t.createdBy && t.createdBy !== t.assigneeId) reviewsOf.set(t.createdBy, (reviewsOf.get(t.createdBy) ?? 0) + 1);
    return people
      .filter((p) => p.role !== 'client')
      .filter((p) => loadPoints({
        tasks: tasks.filter((t) => t.assigneeId === p.id && !t.inReview),
        reviewsWaiting: reviewsOf.get(p.id) ?? 0, meetingHoursToday: Math.round(p.meetingHours * 10) / 10,
      }, now).points > (p.norm ?? DEFAULT_NORM_POINTS))
      .map((p) => p.name);
  }

  /** Местное время для альтернативного срока: 15:00 предложенного дня (§30). */
  async alternativeDeadline(tenantId: string, date: string): Promise<string> {
    return zonedTime(date, '15:00', await this.tz(tenantId)).toISOString();
  }

  /**
   * Проверка до создания (§28). Перегруз и не подтверждено — отказ с подробностями: экран
   * показывает предупреждение и варианты; «Оставить как есть» повторяет запрос с
   * подтверждением, и решение пишется в журнал (§34).
   */
  async guard(actor: { tenantId: string; userId: string }, input: GuardInput, confirmed: boolean): Promise<void> {
    if (!input.assigneeId || !input.projectId) return;
    if (!(await this.enabled(actor.tenantId).catch(() => false))) return;
    const a = await this.assess(actor.tenantId, input).catch((e) => { this.log.warn(`оценка: ${(e as Error).message}`); return null; });
    if (!a?.warn) return;
    if (confirmed) {
      void this.security.record({
        tenantId: actor.tenantId, actorId: actor.userId, event: 'workload.override', resourceType: 'user', resourceId: String(input.assigneeId),
        metadata: { before: a.before, after: a.after, sameDayUrgent: a.sameDayUrgent, title: input.title ?? null },
      }).catch(() => undefined);
      return;
    }
    const alternativeDeadline = a.alternativeDate ? await this.alternativeDeadline(actor.tenantId, a.alternativeDate) : null;
    throw new AppException('CONFLICT', a.reasons.join(' '), {
      workload: { ...a, alternativeDeadline, assigneeId: String(input.assigneeId) },
    });
  }

  /**
   * Фоновые пути: задача уже поставлена (разбор переписки, встреча, пакет) — спросить
   * некого, поэтому карточка в ящик тому, кто ставил.
   */
  async afterCreate(actor: { tenantId: string; userId: string } | null, task: {
    id: string; title: string; project_id: string; assignee_id: string | null; priority: string | null; deadline_at: Date | string | null; directions?: string[];
  }): Promise<void> {
    try {
      if (!actor || !task.assignee_id || String(task.assignee_id) === String(actor.userId)) return;
      if (!(await this.enabled(actor.tenantId))) return;
      const a = await this.assess(actor.tenantId, {
        assigneeId: String(task.assignee_id), projectId: String(task.project_id), priority: task.priority,
        deadlineAt: task.deadline_at, directions: task.directions ?? [],
      });
      if (!a?.warn) return;
      const alt = a.alternatives[0];
      const altDeadline = a.alternativeDate ? await this.alternativeDeadline(actor.tenantId, a.alternativeDate) : null;
      const altDay = a.alternativeDate ? dayWord(a.alternativeDate, localParts(new Date(), await this.tz(actor.tenantId)).date) : null;
      await this.proactive.propose({
        tenantId: actor.tenantId, userId: actor.userId, skill: 'workload', kind: `user:${task.assignee_id}`,
        sourceType: 'task', sourceId: String(task.id), sourceAt: new Date(),
        sourceLabel: `Задача #${task.id} «${task.title}»`, sourceLink: `/projects/${task.project_id}/task/${task.id}`,
        title: `${a.assigneeName}: риск перегруза (${a.after}%)`,
        summary: a.reasons.join(' '),
        why: 'Задача уже поставлена из разговора или встречи — решите, оставить ли её так.',
        recommend: [altDay ? `перенести срок ${altDay}` : null, alt ? `передать ${alt.name} (станет ${alt.after}%)` : null].filter(Boolean).join(' или ') || 'оставить как есть',
        effect: 'Изменится срок или исполнитель задачи; исполнитель получит уведомление, как при обычной правке.',
        priority: a.level === 'overloaded' ? 1 : 2,
        confidence: 0.9,
        actions: [
          ...(altDeadline ? [{ key: 'move_deadline', label: altDay ? `Срок ${altDay.replace(/^на /, 'на ')}` : 'Перенести срок', risk: 'high_write', primary: true }] : []),
          ...(alt ? [{ key: 'reassign', label: `Передать: ${alt.name}`, risk: 'high_write' }] : []),
          { key: 'keep', label: 'Оставить', risk: 'low_write' },
        ],
        payload: { taskId: String(task.id), alternativeDeadline: altDeadline, alternativeAssignee: alt?.id ?? null, before: a.before, after: a.after },
        fingerprint: fingerprint({ skill: 'workload', sourceType: 'task', sourceId: String(task.id) }),
        expiresAt: new Date(Date.now() + 3 * 24 * 3600_000),
      });
    } catch (e) {
      this.log.warn(`после создания #${task.id}: ${(e as Error).message}`);
    }
  }

  static addDays = addDays;
}
