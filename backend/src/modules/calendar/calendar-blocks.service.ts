import { Injectable } from '@nestjs/common';
import { AppException } from '../../common/http/app-exception';
import { CalendarBlocksRepository, BlockRow } from './calendar-blocks.repository';
import { CalendarService } from './calendar.service';
import { commonTime, findTime, planDay, zonedParts } from './find-time';
import { blockView } from './calendar-blocks.view';

/**
 * Время на задачи и запланированный фокус в календаре (#4787, п. 3, 4, 5, 12).
 *
 * Блок — в СВОЁМ расписании и ссылается на задачу, а не копирует её: нажатие открывает
 * исходную задачу, срок задачи блок не трогает. Поверх встречи поставить руками можно
 * (иногда так и задумано), но конфликт показывается; подбор окон поверх встреч не ставит.
 */
@Injectable()
export class CalendarBlocksService {
  constructor(
    private readonly repo: CalendarBlocksRepository,
    private readonly calendar: CalendarService,
  ) {}

  view(b: BlockRow) {
    return blockView(b);
  }

  async inRange(tenantId: string, userId: string, from: string, to: string) {
    return (await this.repo.inRange(tenantId, userId, from, to)).map((b) => this.view(b));
  }

  private static span(startsAt: string, endsAt: string) {
    const s = Date.parse(startsAt);
    const e = Date.parse(endsAt);
    if (Number.isNaN(s) || Number.isNaN(e) || e <= s) throw AppException.validation('Время окончания должно быть позже начала');
    if (e - s > 12 * 3600_000) throw AppException.validation('Блок не может быть длиннее 12 часов — разделите работу на подходы');
    return { startsAt: new Date(s).toISOString(), endsAt: new Date(e).toISOString() };
  }

  private async conflicts(tenantId: string, userId: string, startsAt: string, endsAt: string) {
    return (await this.repo.meetingsOverlapping(tenantId, userId, startsAt, endsAt))
      .map((m) => ({ title: m.title, startsAt: m.starts_at.toISOString(), endsAt: m.ends_at.toISOString() }));
  }

  async create(tenantId: string, userId: string, dto: {
    kind: 'task' | 'focus'; taskId?: string | null; taskIds?: string[]; title?: string | null; startsAt: string; endsAt: string;
  }) {
    const span = CalendarBlocksService.span(dto.startsAt, dto.endsAt);
    let taskId: string | null = null;
    let taskIds: string[] = [];
    if (dto.kind === 'task') {
      if (!dto.taskId) throw AppException.validation('Выберите задачу');
      const t = await this.repo.ownTask(tenantId, userId, String(dto.taskId));
      if (!t) throw AppException.forbidden('Планировать можно только свои задачи — где вы исполнитель или постановщик');
      taskId = String(t.id);
    } else {
      taskIds = [...new Set((dto.taskIds ?? []).map(String))].slice(0, 10);
      for (const id of taskIds) {
        if (!(await this.repo.ownTask(tenantId, userId, id))) throw AppException.forbidden('В фокус можно взять только свои задачи');
      }
    }
    const id = await this.repo.create(tenantId, userId, {
      kind: dto.kind, taskId, taskIds, title: dto.title?.trim().slice(0, 300) || null, ...span,
    });
    const row = await this.repo.byId(tenantId, id);
    return { block: this.view(row!), conflicts: await this.conflicts(tenantId, userId, span.startsAt, span.endsAt) };
  }

  /** Перенос блока: срок задачи не меняется (п. 3). */
  async move(tenantId: string, userId: string, id: string, dto: { startsAt: string; endsAt: string }) {
    const span = CalendarBlocksService.span(dto.startsAt, dto.endsAt);
    const row = await this.repo.byId(tenantId, id);
    if (!row || String(row.user_id) !== String(userId)) throw AppException.notFound('Блок не найден');
    await this.repo.move(tenantId, userId, id, span.startsAt, span.endsAt);
    const after = await this.repo.byId(tenantId, id);
    return { block: this.view(after!), conflicts: await this.conflicts(tenantId, userId, span.startsAt, span.endsAt) };
  }

  async remove(tenantId: string, userId: string, id: string) {
    const row = await this.repo.byId(tenantId, id);
    if (!row || String(row.user_id) !== String(userId)) throw AppException.notFound('Блок не найден');
    await this.repo.remove(tenantId, userId, id);
    return { ok: true };
  }

  async ofTask(tenantId: string, userId: string, taskId: string) {
    return (await this.repo.ofTask(tenantId, userId, taskId)).map((b) => this.view(b));
  }

  /** «Задачи для планирования» (п. 4): название, номер, проект, срок, длительность. */
  async toPlan(tenantId: string, userId: string) {
    return (await this.repo.toPlan(tenantId, userId)).map((t) => ({
      id: String(t.id),
      title: t.title,
      projectId: String(t.project_id),
      projectName: t.project_name,
      deadlineAt: t.deadline_at ? t.deadline_at.toISOString() : null,
      priority: t.priority,
      estimateMin: t.estimate_hours ? Math.round(Number(t.estimate_hours) * 60) : null,
      plannedMin: Math.round(Number(t.planned_min) || 0),
    }));
  }

  /**
   * «Найти время» (п. 5): варианты в рабочих часах человека, не поверх встреч и не за срок.
   * Блок появляется только когда человек выбрал вариант — здесь ничего не создаётся.
   */
  async findTime(tenantId: string, userId: string, q: { taskId?: string; minutes?: number; before?: string; exceptBlockId?: string }) {
    let deadline: number | null = null;
    let minutes = Number(q.minutes) || 0;
    if (q.taskId) {
      const t = await this.repo.ownTask(tenantId, userId, String(q.taskId));
      if (!t) throw AppException.forbidden('Планировать можно только свои задачи');
      deadline = t.deadline_at ? t.deadline_at.getTime() : null;
      if (!minutes && t.estimate_hours) minutes = Math.round(Number(t.estimate_hours) * 60);
    }
    if (q.before) {
      const b = Date.parse(q.before);
      if (!Number.isNaN(b)) deadline = deadline == null ? b : Math.min(deadline, b);
    }
    if (!minutes) minutes = 60;
    const now = Date.now();
    const horizon = 14;
    const to = new Date((deadline ?? now + horizon * 86_400_000) + 86_400_000).toISOString();
    const [busyRows, work, timeZone] = await Promise.all([
      this.repo.busyOfMe(tenantId, userId, new Date(now).toISOString(), to, q.exceptBlockId),
      this.calendar.work(tenantId),
      this.repo.timezoneOf(tenantId, userId),
    ]);
    const res = findTime({
      now, minutes, deadline, timeZone, horizonDays: horizon,
      busy: busyRows.map((r) => ({ start: r.starts_at.getTime(), end: r.ends_at.getTime() })),
      work: { workStart: work.workStart, workEnd: work.workEnd, weekendDays: work.weekendDays, holidays: work.holidays },
    });
    return { minutes, deadlineAt: deadline ? new Date(deadline).toISOString() : null, timeZone, ...res };
  }

  /**
   * «Помоги спланировать день» (п. 14): выбранные задачи — в свободные окна дня.
   * Только предложение: в календарь оно попадает по «Применить план».
   */
  async planDay(tenantId: string, userId: string, dto: { date?: string; items: { taskId: string; minutes?: number }[] }) {
    const [work, timeZone] = await Promise.all([this.calendar.work(tenantId), this.repo.timezoneOf(tenantId, userId)]);
    const date = /^\d{4}-\d{2}-\d{2}$/.test(dto.date ?? '') ? dto.date! : zonedParts(Date.now(), timeZone).date;
    const items: { id: string; minutes: number; title: string }[] = [];
    for (const it of (dto.items ?? []).slice(0, 20)) {
      const t = await this.repo.ownTask(tenantId, userId, String(it.taskId));
      if (!t) throw AppException.forbidden('Планировать можно только свои задачи');
      const est = t.estimate_hours ? Math.round(Number(t.estimate_hours) * 60) : 0;
      items.push({ id: String(t.id), title: t.title, minutes: Math.max(5, Math.min(480, Math.round(Number(it.minutes) || est || 60))) });
    }
    const dayFrom = new Date(Date.parse(`${date}T00:00:00Z`) - 86_400_000).toISOString();
    const dayTo = new Date(Date.parse(`${date}T00:00:00Z`) + 2 * 86_400_000).toISOString();
    const busyRows = await this.repo.busyOfMe(tenantId, userId, dayFrom, dayTo);
    const res = planDay({
      now: Date.now(), date, timeZone, items,
      busy: busyRows.map((r) => ({ start: r.starts_at.getTime(), end: r.ends_at.getTime() })),
      work: { workStart: work.workStart, workEnd: work.workEnd, weekendDays: work.weekendDays, holidays: work.holidays },
    });
    const title = new Map(items.map((i) => [i.id, i.title]));
    const meetings = (await this.repo.meetingsOverlapping(tenantId, userId, dayFrom, dayTo))
      .filter((m) => zonedParts(m.starts_at.getTime(), timeZone).date === date)
      .map((m) => ({ title: m.title, startsAt: m.starts_at.toISOString(), endsAt: m.ends_at.toISOString() }));
    return {
      date, timeZone, needMin: res.needMin, freeMin: res.freeMin, message: res.message, meetings,
      plan: res.plan.map((p) => ({ taskId: p.id, title: title.get(p.id) ?? '', startsAt: p.startsAt, endsAt: p.endsAt })),
      unplaced: res.unplaced.map((id) => ({ taskId: id, title: title.get(id) ?? '' })),
    };
  }

  /** «Применить план»: блоки по предложению, тем же правилом, что и вручную. */
  async applyPlan(tenantId: string, userId: string, plan: { taskId: string; startsAt: string; endsAt: string }[]) {
    const created = [];
    for (const p of (plan ?? []).slice(0, 20)) {
      created.push((await this.create(tenantId, userId, { kind: 'task', taskId: p.taskId, startsAt: p.startsAt, endsAt: p.endsAt })).block);
    }
    return { created };
  }

  /**
   * Общее время (#4787, п. 15): свободны все обязательные, лучше — и необязательные.
   * О чужих встречах — только «занят», без названий.
   */
  async commonTime(tenantId: string, userId: string, dto: { participantIds: string[]; optionalIds?: string[]; minutes: number }) {
    const req = [...new Set([String(userId), ...(dto.participantIds ?? []).map(String)])].slice(0, 30);
    const opt = [...new Set((dto.optionalIds ?? []).map(String))].filter((x) => !req.includes(x)).slice(0, 30);
    const minutes = Math.max(5, Math.min(480, Math.round(Number(dto.minutes) || 30)));
    const from = new Date().toISOString();
    const to = new Date(Date.now() + 15 * 86_400_000).toISOString();
    const [busy, work, timeZone] = await Promise.all([
      this.calendar.busy(tenantId, [...req, ...opt], from, to),
      this.calendar.work(tenantId),
      this.repo.timezoneOf(tenantId, userId),
    ]);
    const mine = (await this.repo.busyOfMe(tenantId, userId, from, to)).map((r) => ({ start: r.starts_at.getTime(), end: r.ends_at.getTime() }));
    const of = (id: string) => (busy.busy[id] ?? []).filter((b) => b.kind !== 'all_day')
      .map((b) => ({ start: new Date(b.startsAt).getTime(), end: new Date(b.endsAt).getTime() }));
    const options = commonTime({
      now: Date.now(), minutes, timeZone, days: 10, limit: 5,
      required: Object.fromEntries(req.map((id) => [id, id === String(userId) ? [...of(id), ...mine] : of(id)])),
      optional: Object.fromEntries(opt.map((id) => [id, of(id)])),
      work: { workStart: work.workStart, workEnd: work.workEnd, weekendDays: work.weekendDays, holidays: work.holidays },
    });
    return { minutes, timeZone, options };
  }
}
