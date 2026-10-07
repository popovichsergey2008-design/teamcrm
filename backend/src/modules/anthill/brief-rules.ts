/**
 * Личные сводки секретаря (ТЗ-18, §10.3–10.4) — правилами, без модели.
 *
 * Сводка собирается из фактов и потому всегда правдива: «2 встречи, 1 просрочка» —
 * это то, что лежит в базе, а не пересказ. Модель здесь не нужна, и без ключа ИИ
 * сводка работает так же.
 *
 * Пустых разделов не пишем; если писать не о чем вовсе — сводки нет: «у вас ничего
 * нет» каждое утро быстро учит не открывать уведомления.
 */

export interface BriefTask { id: string; title: string; projectId: string; deadlineAt?: string | Date | null }
export interface BriefMeeting { title: string; startsAt: string | Date }

export interface MorningData {
  meetings: BriefMeeting[];
  overdue: BriefTask[];
  dueToday: BriefTask[];
  blocked: BriefTask[];
  /** Ждут моего решения: согласования, сданная мне работа, просьбы о переносе срока. */
  decisions: { approvals: number; reviews: number; shifts: number };
  /** Личные чаты, где мне написали и я не прочитал: имя собеседника и сколько. */
  unreadDms: { name: string; count: number }[];
}

export interface EveningData {
  done: BriefTask[];
  shifted: number;
  blocked: BriefTask[];
  tomorrow: BriefTask[];
  meetingsTomorrow: number;
}

/** Окно отправки: с назначенной минуты и два часа после — на случай перезапуска сервера. */
export const SEND_WINDOW_MIN = 120;

/**
 * Пора ли слать. Время человека — в его поясе; уже отправленное сегодня не повторяем;
 * в выходные — только если человек сам так решил.
 */
export function briefDue(
  at: string | null, local: { hour: number; minute: number; dow: number; date: string },
  last: string | null, weekdaysOnly: boolean,
): boolean {
  if (!at) return false;
  if (last === local.date) return false;
  if (weekdaysOnly && (local.dow === 0 || local.dow === 6)) return false;
  const [h, m] = at.slice(0, 5).split(':').map(Number);
  const target = h * 60 + m;
  const now = local.hour * 60 + local.minute;
  return now >= target && now < target + SEND_WINDOW_MIN;
}

const time = (d: string | Date, tz: string) => new Date(d).toLocaleTimeString('ru-RU', { timeZone: tz, hour: '2-digit', minute: '2-digit' });

export function plural(n: number, one: string, few: string, many: string): string {
  const m10 = n % 10; const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

const list = (tasks: BriefTask[], max = 3) => {
  const shown = tasks.slice(0, max).map((t) => `#${t.id} ${clip(t.title, 70)}`).join('; ');
  return tasks.length > max ? `${shown} и ещё ${tasks.length - max}` : shown;
};
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Утренняя сводка: что сегодня. null — писать не о чем. */
export function morningText(d: MorningData, tz: string): string | null {
  const lines: string[] = [];
  if (d.meetings.length) {
    const first = d.meetings.slice(0, 4).map((m) => `${time(m.startsAt, tz)} ${clip(m.title, 50)}`).join(', ');
    lines.push(`Встречи (${d.meetings.length}): ${first}${d.meetings.length > 4 ? '…' : ''}`);
  }
  if (d.overdue.length) lines.push(`Просрочено (${d.overdue.length}): ${list(d.overdue)}`);
  if (d.dueToday.length) lines.push(`Срок сегодня (${d.dueToday.length}): ${list(d.dueToday)}`);
  if (d.blocked.length) lines.push(`С блокером (${d.blocked.length}): ${list(d.blocked)}`);
  const dec: string[] = [];
  if (d.decisions.approvals) dec.push(`${d.decisions.approvals} ${plural(d.decisions.approvals, 'согласование', 'согласования', 'согласований')}`);
  if (d.decisions.reviews) dec.push(`${d.decisions.reviews} на проверке`);
  if (d.decisions.shifts) dec.push(`${d.decisions.shifts} ${plural(d.decisions.shifts, 'просьба', 'просьбы', 'просьб')} о переносе срока`);
  if (dec.length) lines.push(`Ждут вашего решения: ${dec.join(', ')}`);
  if (d.unreadDms.length) {
    const who = d.unreadDms.slice(0, 4).map((x) => `${x.name} (${x.count})`).join(', ');
    lines.push(`Не прочитано в личных: ${who}${d.unreadDms.length > 4 ? '…' : ''}`);
  }
  return lines.length ? lines.join('\n') : null;
}

/** Итоги дня: что сделано и что завтра. null — писать не о чем. */
export function eveningText(d: EveningData): string | null {
  const lines: string[] = [];
  if (d.done.length) lines.push(`Завершено (${d.done.length}): ${list(d.done)}`);
  if (d.shifted) lines.push(`Перенесено сроков: ${d.shifted}`);
  if (d.blocked.length) lines.push(`С блокером (${d.blocked.length}): ${list(d.blocked)}`);
  const tmr: string[] = [];
  if (d.tomorrow.length) tmr.push(`${d.tomorrow.length} ${plural(d.tomorrow.length, 'задача', 'задачи', 'задач')} со сроком (${list(d.tomorrow, 2)})`);
  if (d.meetingsTomorrow) tmr.push(`${d.meetingsTomorrow} ${plural(d.meetingsTomorrow, 'встреча', 'встречи', 'встреч')}`);
  if (tmr.length) lines.push(`Завтра: ${tmr.join(', ')}`);
  return lines.length ? lines.join('\n') : null;
}
