/**
 * Одно состояние человека из нескольких источников (ТЗ-16, волна 1).
 *
 * Раньше «чем занят человек» жило в двух местах, и каждый экран склеивал их сам:
 * фокус (`user_focus`: глубокая работа, созвон, перерыв, работа над задачей — с
 * временем окончания) и ручной статус Chat Bar (`users.presence_status`: занят,
 * отошёл). Плюс «в сети» по сокетам и «на созвоне» по живым комнатам. Здесь — одно
 * правило, по которому из всего этого получается ОДИН ответ на вопрос «можно ли к
 * нему сейчас».
 *
 * Приоритет (ТЗ, п. 64) — от того, что точнее всего говорит «не отвлекать»:
 *   созвон → глубокий фокус → не беспокоить → перерыв → день закрыт → свободен → не в сети.
 * Созвон первым: человек в разговоре, даже если до этого включил фокус.
 *
 * Функция чистая: время передаётся снаружи, истёкшее «до 16:00» в 16:00 перестаёт
 * действовать само, без расписания, которое может не отработать.
 */

export type PresenceStatus =
  | 'in_meeting'
  | 'deep_focus'
  | 'do_not_disturb'
  | 'break'
  | 'workday_closed'
  | 'available'
  | 'offline';

export type PresenceSource = 'meeting' | 'focus' | 'manual' | 'workday' | 'system';

export interface PresenceInput {
  online: boolean;
  /** в живой комнате созвона прямо сейчас */
  inCall: boolean;
  /** строка user_focus, если есть */
  focus: { kind: string; note: string | null; taskId: string | null; until: Date | string | null } | null;
  /** ручной статус Chat Bar */
  manual: 'busy' | 'away' | null;
  /** идущая сессия глубокой работы (волна 4) */
  session?: { id: string; taskId: string | null; plannedEndAt: Date | string } | null;
  /** день закрыт до этого момента (волна 7) */
  workdayClosedUntil?: Date | string | null;
}

export interface Presence {
  status: PresenceStatus;
  source: PresenceSource;
  /** до какого времени держится (если известно) */
  until: string | null;
  /** над какой задачей — название раскрывается только тем, кому задача видна */
  taskId: string | null;
  /** подпись, которую человек написал о себе сам («Готовлю отчёт») */
  note: string | null;
  focusSessionId: string | null;
  online: boolean;
}

const iso = (v: Date | string | null | undefined): string | null =>
  v == null ? null : (v instanceof Date ? v.toISOString() : new Date(v).toISOString());

const alive = (until: Date | string | null | undefined, now: Date): boolean =>
  until == null || new Date(until).getTime() > now.getTime();

export function resolvePresence(input: PresenceInput, now: Date = new Date()): Presence {
  const base = { focusSessionId: null as string | null, online: input.online };
  const focus = input.focus && alive(input.focus.until, now) ? input.focus : null;
  const session = input.session && new Date(input.session.plannedEndAt).getTime() > now.getTime() ? input.session : null;

  if (input.inCall) {
    return { ...base, status: 'in_meeting', source: 'meeting', until: null, taskId: null, note: null };
  }
  // «Созвон» руками (без комнаты: телефон, встреча вживую) — тот же смысл.
  if (focus?.kind === 'call') {
    return { ...base, status: 'in_meeting', source: 'manual', until: iso(focus.until), taskId: null, note: focus.note };
  }
  if (session) {
    return {
      ...base, status: 'deep_focus', source: 'focus', until: iso(session.plannedEndAt),
      taskId: session.taskId, note: null, focusSessionId: session.id,
    };
  }
  if (focus?.kind === 'deep') {
    return { ...base, status: 'deep_focus', source: 'manual', until: iso(focus.until), taskId: focus.taskId, note: focus.note };
  }
  if (input.manual === 'busy') {
    return { ...base, status: 'do_not_disturb', source: 'manual', until: null, taskId: null, note: null };
  }
  if (focus?.kind === 'break') {
    return { ...base, status: 'break', source: 'manual', until: iso(focus.until), taskId: null, note: focus.note };
  }
  if (input.manual === 'away') {
    return { ...base, status: 'break', source: 'manual', until: null, taskId: null, note: null };
  }
  if (input.workdayClosedUntil && alive(input.workdayClosedUntil, now)) {
    return { ...base, status: 'workday_closed', source: 'workday', until: iso(input.workdayClosedUntil), taskId: null, note: null };
  }
  // Фокус «быстрые задачи» и «работаю над задачей» — человек доступен, просто видно, чем занят.
  const busyWith = focus && (focus.kind === 'quick' || focus.kind === 'task') ? focus : null;
  if (input.online) {
    return {
      ...base, status: 'available', source: busyWith ? 'focus' : 'system',
      until: iso(busyWith?.until), taskId: busyWith?.taskId ?? null, note: busyWith?.note ?? null,
    };
  }
  return { ...base, status: 'offline', source: 'system', until: null, taskId: null, note: null };
}

/** Порядок групп в «Команда сейчас» (ТЗ, п. 66): сначала те, кого лучше не трогать. */
export const PRESENCE_ORDER: PresenceStatus[] = [
  'deep_focus', 'in_meeting', 'do_not_disturb', 'available', 'break', 'workday_closed', 'offline',
];
