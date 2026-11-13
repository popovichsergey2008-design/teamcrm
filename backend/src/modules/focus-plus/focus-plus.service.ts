import { Injectable, Logger } from '@nestjs/common';
import { AppException } from '../../common/http/app-exception';
import { DbService } from '../../database/db.service';
import { AiService } from '../ai/ai.service';
import { CalendarBlocksService } from '../calendar/calendar-blocks.service';
import { zonedParts, zonedToUtc } from '../calendar/find-time';
import { CalendarPlusService } from '../calendar-plus/calendar-plus.service';
import { weekFree } from '../calendar-plus/week-plan';
import { FocusDayService } from '../focus/focus-day.service';
import { dayPlan, hours, reviewsMinutes, shortTitle } from './day-plan';

type Viewer = { tenantId: string; userId: string; role: string };
const MIN = 60_000;
const DAY = 86_400_000;

interface TopItem {
  id: string; rank: number; kind: 'task' | 'review' | 'approval'; status: string; taskId: string | null; title: string | null;
  projectId: string | null; projectName: string | null; deadlineAt: string | null; estimateMin: number | null;
  checklistTotal: number; checklistDone: number; calendarBlock: { startsAt: string; endsAt: string } | null;
  reasons: string[]; pinned?: boolean; about?: string | null;
}

const ESTIMATE_SYSTEM = 'Оцени, сколько минут чистой работы займёт задача у опытного исполнителя. Ответь одним числом минут (от 15 до 480), без слов.';

/**
 * «Фокус дня» #4891, волна 1: план по часам, ёмкость дня, честный бриф, главная карточка
 * с одной кнопкой, проверки одним блоком, быстрые дела, перегруз и просрочки. Ничего не
 * меняется без нажатия: «Применить», «Принять план», «верно».
 */
@Injectable()
export class FocusPlusService {
  private readonly log = new Logger('FocusPlus');

  constructor(
    private readonly db: DbService,
    private readonly focus: FocusDayService,
    private readonly cal: CalendarPlusService,
    private readonly blocks: CalendarBlocksService,
    private readonly ai: AiService,
  ) {}

  private async ctx(v: Viewer) {
    const prefs = await this.cal.prefs(v.tenantId, v.userId);
    const tz = prefs.timeZone;
    const now = Date.now();
    const today = zonedParts(now, tz).date;
    return { prefs, tz, now, today };
  }

  /** Экран целиком из одного набора данных на одно время (п. 2): план, ёмкость, бриф, счётчики. */
  async day(v: Viewer) {
    const { prefs, tz, now, today } = await this.ctx(v);
    const t = await this.focus.today(v) as unknown as {
      enabled: boolean; top: TopItem[]; waitingDecision: number; waitingReview?: number; backlogCount: number;
      plan: { status: string; date: string }; closeDay: { available: boolean; workdayClosedUntil: string | null };
    };
    if (!t.enabled) return { enabled: false as const };
    const [y, m, d] = today.split('-').map(Number);
    const dow = zonedParts(now, tz).weekday;
    const dayOff = prefs.company.weekendDays.includes(dow);
    const dayStart = zonedToUtc(y, m, d, 0, 0, tz);
    const { input } = await this.cal.weekData(v.tenantId, { userId: v.userId, role: v.role }, dayStart, dayStart + DAY);
    const top = [...t.top].sort((a, b) => a.rank - b.rank);
    const notes = await this.notes(v, top.map((i) => i.taskId).filter((x): x is string => !!x));
    // #4890, п. 13: то же число, что в Пульсе и брифинге (отложенные согласования уже вычтены в очереди)
    const decisions = t.waitingDecision;
    const topTaskIds = new Set(top.map((i) => i.taskId).filter(Boolean) as string[]);
    const otherBlocks = input.blocks
      .filter((b) => !(b.kind === 'task' && top.some((i) => i.calendarBlock && Date.parse(i.calendarBlock.startsAt) === b.start)))
      .map((b) => ({ start: b.start, end: b.end }));
    const plan = dayPlan({
      now, date: today, timeZone: tz, workStart: prefs.workStart, workEnd: prefs.workEnd,
      lunchStart: prefs.lunchStart, lunchEnd: prefs.lunchEnd,
      meetings: input.meetings.map((x) => ({ title: x.title, start: x.start, end: x.end })),
      otherBlocks,
      items: top.map((i) => ({
        id: i.id, taskId: i.taskId, title: shortTitle(i.title ?? ''), kind: i.kind, rank: i.rank, done: i.status === 'done',
        estimateMin: i.estimateMin ?? (i.taskId ? notes.get(i.taskId)?.ai_estimate_min ?? null : null),
        block: i.calendarBlock ? { start: Date.parse(i.calendarBlock.startsAt), end: Date.parse(i.calendarBlock.endsAt) } : null,
      })),
      reviews: decisions,
    });
    const workEndMs = zonedToUtc(y, m, d, ...this.hm(prefs.workEnd), tz);
    const accepted = t.plan.status !== 'proposed';
    const phase = now >= workEndMs ? 'evening' : accepted ? 'day' : 'morning';
    const yesterday = await this.yesterday(v, today);
    const mission = top.find((i) => i.status !== 'done' && i.kind === 'task') ?? top.find((i) => i.status !== 'done');
    const reviewsSlot = plan.timeline.find((s) => s.kind === 'reviews');
    const tf = (ms: number) => new Date(ms).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', timeZone: tz });
    // #4891, п. 10: «Завтра начните с…», записанное вечером, — первой строкой брифа
    const startWith = (await this.db.one<{ text: string }>(
      `SELECT text FROM focus_start_with WHERE user_id = $1 AND focus_date = $2::date`, [v.userId, today]))?.text ?? null;
    // п. 11: новый человек — пустой Фокус и ни одного прошлого плана с делами
    const firstDay = !top.length && !(await this.db.one<{ x: number }>(
      `SELECT 1 AS x FROM focus_day_items i JOIN focus_day_plans p ON p.id = i.plan_id
        WHERE p.tenant_id = $1 AND p.user_id = $2 AND p.focus_date < $3::date LIMIT 1`, [v.tenantId, v.userId, today]));
    const brief = [
      startWith ? `Вы просили начать с: ${startWith.replace(/[.\s]+$/, '')}.` : '',
      `Сегодня ${hours(Math.max(0, plan.availableMin))} на задачи.`,
      mission ? `Начните с «${shortTitle(mission.title ?? '')}» — это главный результат дня.` : 'Главный результат дня не выбран — выберите задачу.',
      // #4890, п. 13: то же число, что в счётчике и в Пульсе
      decisions ? `Ждут вашего решения: ${decisions} — разбор ≈ ${reviewsMinutes(Math.min(decisions, 10))} мин на ${Math.min(decisions, 10)}${reviewsSlot ? `, блок в ${tf(reviewsSlot.start)}` : ''}.` : '',
    ].filter(Boolean).join(' ');
    // что не вошло: задачи без окна и просроченные вне плана
    const overdue = (await this.overdueOutside(v, [...topTaskIds])).map((o) => ({ ...o, title: shortTitle(o.title) }));
    const overload = plan.overloadMin > 0 ? await this.overloadSuggestion(v, top, prefs, tz) : null;
    const next = await this.nextWorkday(prefs.company.weekendDays, today, tz);
    return {
      enabled: true as const,
      updatedAt: new Date(now).toISOString(),
      phase, dayOff, nextWorkday: next, firstDay, startWith,
      date: today, timeZone: tz,
      workStart: prefs.workStart, workEnd: prefs.workEnd,
      capacity: {
        workMin: plan.workMin, meetingMin: plan.meetingMin, availableMin: plan.availableMin,
        plannedMin: plan.plannedMin, reviewsMin: plan.reviewsMin, reserveMin: plan.reserveMin, overloadMin: plan.overloadMin,
      },
      timeline: plan.timeline.map((s) => ({ ...s, startsAt: new Date(s.start).toISOString(), endsAt: new Date(s.end).toISOString() })),
      brief: { yesterday: yesterday.line, text: brief },
      decisions, waitingReview: t.waitingReview ?? 0,
      why: top.filter((i) => i.status !== 'done').map((i) => ({
        rank: i.rank, title: shortTitle(i.title ?? ''), reasons: i.reasons.slice(0, 3),
        deadline: i.deadlineAt ? `срок из задачи #${i.taskId}: ${new Date(i.deadlineAt).toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', timeZone: tz })} (${tz === 'Europe/Moscow' ? 'МСК' : tz})` : 'срока у задачи нет',
      })),
      notIncluded: [
        ...plan.unplaced.map((id) => ({ title: shortTitle(top.find((i) => i.id === id)?.title ?? ''), why: 'не поместилось в свободное время дня' })),
        ...overdue.map((o) => ({ title: o.title, why: `просрочено ${o.days} дн. — не в тройке` })),
      ],
      overload, overdue,
      main: mission ? this.mainCard(mission, top, notes.get(mission.taskId ?? '')) : null,
      progress: { done: top.filter((i) => i.status === 'done').length, total: top.length, deepMin: await this.deepToday(v, dayStart) },
    };
  }

  private hm(s: string): [number, number] { const [h, m] = s.split(':').map(Number); return [h || 0, m || 0]; }

  /** Главная карточка (п. 3): следующий шаг — из чек-листа или записанного; ничего не выдумываем. */
  private mainCard(i: TopItem, top: TopItem[], note?: NoteRow) {
    return {
      itemId: i.id, taskId: i.taskId, projectId: i.projectId, projectName: i.projectName, title: i.title, kind: i.kind,
      position: top.filter((x) => x.kind !== 'approval').indexOf(i) + 1 || i.rank, of: top.length,
      deadlineAt: i.deadlineAt,
      nextStep: note?.next_step ?? null,
      result: note?.result ?? null,
      estimate: i.estimateMin != null ? { minutes: i.estimateMin, source: 'task' as const }
        : note?.ai_estimate_min != null ? { minutes: note.ai_estimate_min, source: 'ai' as const } : null,
    };
  }

  private async notes(v: Viewer, taskIds: string[]) {
    if (!taskIds.length) return new Map<string, NoteRow>();
    const rows = await this.db.many<NoteRow>(
      `SELECT task_id::text, next_step, result, ai_estimate_min, steps_done FROM task_focus_notes WHERE user_id = $1 AND task_id = ANY($2::bigint[])`,
      [v.userId, taskIds]);
    return new Map(rows.map((r) => [r.task_id, r]));
  }

  /** «Вчера: готово 2 из 3 · «Макет» перенесён на сегодня». */
  private async yesterday(v: Viewer, today: string) {
    const prev = new Date(Date.parse(`${today}T12:00:00Z`) - DAY).toISOString().slice(0, 10);
    const rows = await this.db.many<{ status: string; title: string; task_id: string | null; again: boolean }>(
      `SELECT i.status, i.title_snapshot AS title, i.task_id::text,
              EXISTS (SELECT 1 FROM focus_day_items j JOIN focus_day_plans q ON q.id = j.plan_id
                       WHERE q.user_id = p.user_id AND q.focus_date = $3::date AND j.task_id = i.task_id) AS again
         FROM focus_day_items i JOIN focus_day_plans p ON p.id = i.plan_id
        WHERE p.tenant_id = $1 AND p.user_id = $2 AND p.focus_date = $4::date AND i.status IN ('active','done')`,
      [v.tenantId, v.userId, today, prev]);
    if (!rows.length) return { line: null as string | null };
    const done = rows.filter((r) => r.status === 'done').length;
    const carried = rows.filter((r) => r.status !== 'done' && r.again).map((r) => `«${shortTitle(r.title, 40)}»`);
    return { line: `Вчера: готово ${done} из ${rows.length}${carried.length ? ` · ${carried.slice(0, 2).join(', ')} ${carried.length === 1 ? 'перенесён' : 'перенесены'} на сегодня` : ''}` };
  }

  private async deepToday(v: Viewer, dayStart: number) {
    const r = await this.db.one<{ min: number }>(
      `SELECT COALESCE(sum(EXTRACT(EPOCH FROM (COALESCE(ended_at, LEAST(now(), planned_end_at)) - started_at)) / 60), 0)::int AS min
         FROM focus_sessions WHERE tenant_id = $1 AND user_id = $2 AND started_at >= $3::timestamptz`,
      [v.tenantId, v.userId, new Date(dayStart).toISOString()]).catch(() => null);
    return Number(r?.min ?? 0);
  }

  private async overdueOutside(v: Viewer, inPlan: string[]) {
    return this.db.many<{ id: string; title: string; days: number; estimate_min: number | null; project_id: string }>(
      `SELECT t.id::text, t.title, floor(EXTRACT(EPOCH FROM now() - t.deadline_at) / 86400)::int AS days,
              CASE WHEN t.estimate_hours IS NOT NULL THEN round(t.estimate_hours * 60)::int END AS estimate_min, t.project_id::text
         FROM tasks t
        WHERE t.tenant_id = $1 AND t.assignee_id = $2 AND t.deleted_at IS NULL AND t.closed_at IS NULL
          AND t.deadline_at < now() AND NOT (t.id = ANY($3::bigint[]))
          AND NOT EXISTS (SELECT 1 FROM calendar_blocks b WHERE b.task_id = t.id AND b.ends_at > now())
        ORDER BY t.deadline_at LIMIT 10`,
      [v.tenantId, v.userId, inPlan]);
  }

  private async nextWorkday(weekend: number[], today: string, tz: string) {
    for (let i = 1; i <= 7; i++) {
      const d = new Date(Date.parse(`${today}T12:00:00Z`) + i * DAY);
      if (!weekend.includes(d.getUTCDay())) return { date: d.toISOString().slice(0, 10), label: d.toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long', timeZone: tz }) };
    }
    return null;
  }

  /** Перегруз (п. 1а): одно конкретное предложение — какую задачу и на какой день, где есть место. */
  private async overloadSuggestion(v: Viewer, top: TopItem[], prefs: { workStart: string; workEnd: string; lunchStart: string | null; lunchEnd: string | null; company: { weekendDays: number[] } }, tz: string) {
    const cand = [...top].filter((i) => i.status !== 'done' && i.kind === 'task' && !i.pinned && i.taskId).sort((a, b) => b.rank - a.rank)[0];
    if (!cand) return null;
    const minutes = cand.estimateMin ?? 60;
    const slot = await this.freeSlotAhead(v, minutes, prefs, tz, 1);
    if (!slot) return null;
    return {
      itemId: cand.id, taskId: cand.taskId, title: shortTitle(cand.title ?? ''), minutes,
      startsAt: new Date(slot.start).toISOString(), endsAt: new Date(slot.start + minutes * MIN).toISOString(),
      label: new Date(slot.start).toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long', timeZone: tz }),
    };
  }

  /** Ближайшее окно нужной длины, начиная со дня +fromDays, в рабочих часах человека. */
  private async freeSlotAhead(v: Viewer, minutes: number, prefs: { workStart: string; workEnd: string; lunchStart: string | null; lunchEnd: string | null; company: { weekendDays: number[] } }, tz: string, fromDays: number, taken: { start: number; end: number }[] = []) {
    const today = zonedParts(Date.now(), tz).date;
    const [y, m, d] = today.split('-').map(Number);
    const from = zonedToUtc(y, m, d, 0, 0, tz) + fromDays * DAY;
    const to = from + 10 * DAY;
    const { input } = await this.cal.weekData(v.tenantId, { userId: v.userId, role: v.role }, from, to);
    const free = weekFree({
      now: Date.now(), from, to, timeZone: tz,
      work: { workStart: prefs.workStart, workEnd: prefs.workEnd, weekendDays: prefs.company.weekendDays, holidays: [] },
      lunch: prefs.lunchStart && prefs.lunchEnd ? { start: prefs.lunchStart, end: prefs.lunchEnd } : null,
      busy: [...input.meetings.map((x) => ({ start: x.start, end: x.end })), ...input.blocks.map((b) => ({ start: b.start, end: b.end })), ...taken],
    });
    return free.find((f) => f.end - f.start >= minutes * MIN) ?? null;
  }

  /** «Перенести на <день>» — блок на тот день и задача уходит из плана; срок не меняется. */
  async applyOverload(v: Viewer) {
    const d = await this.day(v);
    if (!d.enabled || !d.overload) throw AppException.conflict('Перегруза уже нет');
    const o = d.overload;
    await this.blocks.create(v.tenantId, v.userId, { kind: 'task', taskId: o.taskId!, startsAt: o.startsAt, endsAt: o.endsAt });
    await this.focus.remove(v, o.itemId, 'other');
    return this.day(v);
  }

  /** «Всё равно оставить» — принять план, который не помещается в день (п. 1а). */
  async acceptAnyway(v: Viewer) {
    await this.db.query(
      `UPDATE focus_day_plans SET overload_accepted = TRUE WHERE tenant_id = $1 AND user_id = $2 AND focus_date = $3::date`,
      [v.tenantId, v.userId, (await this.ctx(v)).today]);
    await this.focus.accept(v);
    return this.day(v);
  }

  /** «Принять план»: при перегрузе — только через «Всё равно оставить». */
  async accept(v: Viewer) {
    const d = await this.day(v);
    if (d.enabled && d.capacity.overloadMin > 0) {
      throw AppException.conflict(`День перегружен на ${hours(d.capacity.overloadMin)} — перенесите задачу или нажмите «Всё равно оставить»`);
    }
    await this.focus.accept(v);
    return this.day(v);
  }

  /** «Разложить по дням» (п. 1а): каждой просроченной — ближайший свободный день. Предпросмотр. */
  async overduePreview(v: Viewer) {
    const { prefs, tz } = await this.ctx(v);
    const d = await this.day(v);
    if (!d.enabled) return { placements: [] };
    const taken: { start: number; end: number }[] = [];
    const placements = [];
    for (const o of d.overdue) {
      const min = o.estimate_min ?? 60;
      const slot = await this.freeSlotAhead(v, min, prefs, tz, 1, taken);
      if (!slot) continue;
      taken.push({ start: slot.start, end: slot.start + min * MIN });
      placements.push({
        taskId: o.id, title: o.title, startsAt: new Date(slot.start).toISOString(), endsAt: new Date(slot.start + min * MIN).toISOString(),
        label: `${new Date(slot.start).toLocaleDateString('ru-RU', { weekday: 'short', day: 'numeric', month: 'short', timeZone: tz })} ${new Date(slot.start).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', timeZone: tz })}`,
      });
    }
    return { placements };
  }

  async overdueApply(v: Viewer, placements: { taskId: string; startsAt: string; endsAt: string }[]) {
    let n = 0;
    for (const p of placements.slice(0, 10)) {
      await this.blocks.create(v.tenantId, v.userId, { kind: 'task', taskId: p.taskId, startsAt: p.startsAt, endsAt: p.endsAt });
      n++;
    }
    return { planned: n };
  }

  // ---------- оценка, шаг, результат (п. 3) ----------

  private async ownTask(v: Viewer, taskId: string) {
    const t = await this.db.one<{ id: string; title: string; description: string | null; estimate_hours: string | null; checklist: number }>(
      `SELECT t.id::text, t.title, t.description, t.estimate_hours::text,
              (SELECT count(*)::int FROM task_checklist_items c WHERE c.task_id = t.id) AS checklist
         FROM tasks t WHERE t.tenant_id = $1 AND t.id = $2 AND t.deleted_at IS NULL
          AND (t.assignee_id = $3 OR t.created_by = $3 OR $4::boolean)`,
      [v.tenantId, taskId, v.userId, v.role === 'owner' || v.role === 'manager']);
    if (!t) throw AppException.notFound('Задача не найдена');
    return t;
  }

  /** Оценка от ИИ, если её нет: «≈ 2 ч · предложил ИИ». Без модели — по чек-листу, честно «≈». */
  async suggestEstimate(v: Viewer, taskId: string) {
    const t = await this.ownTask(v, taskId);
    if (t.estimate_hours) return { minutes: Math.round(Number(t.estimate_hours) * 60), source: 'task' };
    let minutes: number | null = null;
    let source = 'ai';
    try {
      const raw = await this.ai.generate(v.tenantId, ESTIMATE_SYSTEM, `${t.title}\n${(t.description ?? '').slice(0, 1500)}`, 'focus_estimate');
      const n = Number(String(raw).match(/\d{1,3}/)?.[0]);
      if (n >= 10 && n <= 480) minutes = Math.round(n / 15) * 15 || 15;
    } catch (e) { this.log.warn(`оценка ${taskId}: ${(e as Error).message}`); }
    if (minutes == null) { minutes = Math.max(30, Math.min(240, t.checklist ? t.checklist * 20 : 60)); source = 'rules'; }
    await this.db.query(
      `INSERT INTO task_focus_notes (task_id, user_id, tenant_id, ai_estimate_min) VALUES ($1, $2, $3, $4)
       ON CONFLICT (task_id, user_id) DO UPDATE SET ai_estimate_min = EXCLUDED.ai_estimate_min, updated_at = now()`,
      [taskId, v.userId, v.tenantId, minutes]);
    return { minutes, source };
  }

  /** «верно / изменить»: подтверждённая оценка записывается в задачу. */
  async confirmEstimate(v: Viewer, taskId: string, minutes: number) {
    await this.ownTask(v, taskId);
    const m = Math.max(5, Math.min(2400, Math.round(minutes)));
    await this.db.query(`UPDATE tasks SET estimate_hours = $3, updated_at = now() WHERE tenant_id = $1 AND id = $2`, [v.tenantId, taskId, Math.round(m / 6) / 10]);
    return { minutes: m };
  }

  /** Следующий шаг и результат — то, что записал человек (или «Записать шаг и выйти»). */
  async saveNote(v: Viewer, taskId: string, dto: { nextStep?: string | null; result?: string | null; stepDone?: string | null }) {
    await this.ownTask(v, taskId);
    await this.db.query(
      `INSERT INTO task_focus_notes (task_id, user_id, tenant_id, next_step, result, steps_done)
       VALUES ($1, $2, $3, $4, $5, CASE WHEN $6::text IS NULL THEN '{}'::text[] ELSE ARRAY[$6::text] END)
       ON CONFLICT (task_id, user_id) DO UPDATE SET
         next_step = CASE WHEN $7::boolean THEN EXCLUDED.next_step ELSE task_focus_notes.next_step END,
         result = CASE WHEN $8::boolean THEN EXCLUDED.result ELSE task_focus_notes.result END,
         steps_done = CASE WHEN $6::text IS NULL THEN task_focus_notes.steps_done ELSE (task_focus_notes.steps_done || ARRAY[$6::text])[GREATEST(1, cardinality(task_focus_notes.steps_done) - 8):] END,
         updated_at = now()`,
      [taskId, v.userId, v.tenantId, dto.nextStep?.trim().slice(0, 500) || null, dto.result?.trim().slice(0, 500) || null,
        dto.stepDone?.trim().slice(0, 300) || null, dto.nextStep !== undefined, dto.result !== undefined]);
    return this.note(v, taskId);
  }

  /** Шаг для фокус-сессии: записанный, иначе — первый невыполненный пункт чек-листа. */
  async note(v: Viewer, taskId: string) {
    const n = (await this.notes(v, [taskId])).get(taskId);
    const check = await this.db.one<{ text: string }>(
      `SELECT text FROM task_checklist_items WHERE task_id = $1 AND NOT is_done ORDER BY position, id LIMIT 1`, [taskId]);
    return {
      nextStep: n?.next_step ?? check?.text ?? null, nextStepSource: n?.next_step ? 'saved' : check ? 'checklist' : null,
      result: n?.result ?? null, stepsDone: n?.steps_done ?? [], aiEstimateMin: n?.ai_estimate_min ?? null,
    };
  }

  // ---------- проверки и быстрые дела (п. 4) ----------

  async snooze(v: Viewer, key: string, until: string, remind: boolean) {
    const at = Date.parse(until);
    if (Number.isNaN(at) || at < Date.now()) throw AppException.validation('Выберите дату в будущем');
    await this.db.query(
      `INSERT INTO focus_snoozes (user_id, tenant_id, item_key, until, remind) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (user_id, item_key) DO UPDATE SET until = EXCLUDED.until, remind = EXCLUDED.remind`,
      [v.userId, v.tenantId, key.slice(0, 80), new Date(at).toISOString(), remind]);
    return { snoozed: key };
  }

  snoozedKeys(v: Viewer) {
    return this.db.many<{ item_key: string; until: Date }>(`SELECT item_key, until FROM focus_snoozes WHERE user_id = $1 AND until > now()`, [v.userId]);
  }

  /** После фокуса (п. 6): что сделано, сколько в фокусе, «1 из 3», кто получил уведомление, что дальше. */
  async afterDone(v: Viewer, taskId: string | null, sessionMin: number) {
    const d = await this.day(v);
    if (!d.enabled) return null;
    const who = taskId ? await this.db.one<{ name: string | null }>(
      `SELECT u.full_name AS name FROM tasks t JOIN users u ON u.id = t.created_by WHERE t.id = $1 AND t.created_by <> $2`, [taskId, v.userId]) : null;
    return {
      minutes: sessionMin, progress: d.progress, deepMin: d.progress.deepMin,
      notified: who?.name ?? null,
      next: d.main && d.main.taskId !== taskId ? { itemId: d.main.itemId, taskId: d.main.taskId, title: d.main.title } : null,
    };
  }

  static reviewsMinutes = reviewsMinutes;
}

interface NoteRow { task_id: string; next_step: string | null; result: string | null; ai_estimate_min: number | null; steps_done: string[] }
