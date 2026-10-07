import { plural } from './brief-rules';

/**
 * Справка перед встречей и аудит недели (ТЗ-18, §7.3–7.4) — правилами.
 *
 * Справка — из фактов: кто будет, с каким клиентом, чем кончилась прошлая встреча
 * этой серии, что просрочено и не решено между участниками. Нет фактов — нет и
 * справки: «у вас встреча» без содержания человек и так видит в календаре.
 */

export interface MeetingBriefData {
  title: string;
  startsAt: Date;
  participants: string[];
  client: string | null;
  description: string | null;
  decisions: string[];
  overdue: { title: string; assignee: string | null; days: number }[];
  approvals: { subject: string; author: string | null; approver: string | null }[];
  review: { title: string; assignee: string | null; reviewer: string | null }[];
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export function meetingBriefText(d: MeetingBriefData, minutesLeft: number): string | null {
  const facts: string[] = [];
  if (d.client) facts.push(`Клиент: ${d.client}`);
  if (d.description?.trim()) facts.push(`Цель: ${clip(d.description.trim().replace(/\s+/g, ' '), 200)}`);
  if (d.decisions.length) facts.push(`Прошлый раз решили: ${d.decisions.map((x) => clip(x, 90)).join('; ')}`);
  if (d.overdue.length) {
    facts.push(`Просрочено у участников: ${d.overdue.map((t) => `${clip(t.title, 60)}${t.assignee ? ` (${t.assignee}, ${t.days} дн.)` : ''}`).join('; ')}`);
  }
  if (d.review.length) facts.push(`Ждёт проверки: ${d.review.map((t) => clip(t.title, 60)).join('; ')}`);
  if (d.approvals.length) facts.push(`Не согласовано: ${d.approvals.map((a) => clip(a.subject, 60)).join('; ')}`);
  if (!facts.length) return null;
  const head = `Через ${minutesLeft} ${plural(minutesLeft, 'минуту', 'минуты', 'минут')} — «${clip(d.title, 80)}»`
    + (d.participants.length ? `. Участники: ${d.participants.slice(0, 8).join(', ')}${d.participants.length > 8 ? '…' : ''}` : '');
  return `${head}\n${facts.join('\n')}`;
}

export interface WeekAuditData {
  /** Рабочих часов в неделе по календарю компании (до сегодняшнего дня включительно). */
  workHours: number;
  meetingMinutes: number;
  deepMinutes: number;
  trackedMinutes: number;
  closed: number;
  overdueNow: number;
}

const hours = (min: number) => {
  const h = min / 60;
  return h >= 10 ? `${Math.round(h)} ч` : `${Math.round(h * 10) / 10} ч`.replace('.', ',');
};

/**
 * Куда ушла неделя (§7.4). Доля встреч — от рабочего времени, а не от суток; советы —
 * только по порогам, которые легко проверить: больше 40% во встречах, меньше 4 часов
 * глубокой работы.
 */
export function weekAuditText(d: WeekAuditData): string | null {
  if (!d.meetingMinutes && !d.deepMinutes && !d.trackedMinutes && !d.closed) return null;
  const share = d.workHours > 0 ? Math.round((d.meetingMinutes / 60 / d.workHours) * 100) : 0;
  const lines = [
    `Встречи: ${hours(d.meetingMinutes)}${d.workHours ? ` (${share}% рабочего времени)` : ''}`,
    `Глубокая работа: ${hours(d.deepMinutes)}`,
  ];
  if (d.trackedMinutes) lines.push(`Учтено в трекере: ${hours(d.trackedMinutes)}`);
  lines.push(`Закрыто задач: ${d.closed}${d.overdueNow ? `, просрочено сейчас: ${d.overdueNow}` : ''}`);
  const advice: string[] = [];
  if (share > 40) advice.push('встречи заняли больше 40% недели — посмотрите, какие можно сократить или провести без вас');
  if (d.deepMinutes < 4 * 60) advice.push('на глубокую работу ушло меньше 4 часов — попробуйте закрепить фокус-блоки в календаре');
  if (d.overdueNow >= 3) advice.push('просрочек накопилось — разберите их в понедельник первым делом: перенести, передать или снять');
  if (advice.length) lines.push(`Совет: ${advice.join('; ')}.`);
  return lines.join('\n');
}
