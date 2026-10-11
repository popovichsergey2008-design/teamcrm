import { band, capacityPct, Priority, taskPoints } from '../radar/pulse-rules';

/**
 * Страж нагрузки (ТЗ-21, §26–34) — правила без базы.
 *
 * Считает ровно той арифметикой, что «Пульс команды» (решение 11.10: при постановке —
 * очки «Пульса»; старая проверка в часах при смене исполнителя остаётся как была).
 * Не запрещает — предупреждает и предлагает: другой срок, другого человека, оставить.
 */

export interface PersonLoadNow {
  id: string;
  name: string;
  points: number;
  norm: number;
  /** Открытые задачи человека: приоритет и срок — для плотности дня. */
  tasks: { priority: Priority; deadlineAt: Date | null }[];
}

export interface CandidateNow {
  id: string; name: string; points: number; norm: number;
  skills: string[]; canReceive: boolean; available: boolean;
}

export interface NewTask {
  priority: Priority;
  deadlineAt: Date | null;
  directions: string[];
  /** Кому открыт проект; null — всем сотрудникам. */
  allowed: Set<string> | null;
}

export interface Assessment {
  warn: boolean;
  level: 'ok' | 'high' | 'overloaded';
  before: number;
  after: number;
  /** Срочных и высоких задач у человека на тот же день, что срок новой. */
  sameDayUrgent: number;
  reasons: string[];
  /** Местная дата срока, ГГГГ-ММ-ДД, — для подписи «на четверг». */
  deadlineDate: string | null;
  alternativeDate: string | null;
  alternatives: { id: string; name: string; after: number }[];
}

/** Местная дата момента — переводчик даётся снаружи (пояс человека). */
export type LocalDate = (d: Date) => { date: string; isoDow: number };

const urgent = (p: Priority) => p === 'urgent' || p === 'high';

export function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function isoDowOf(date: string): number {
  const dow = new Date(`${date}T00:00:00Z`).getUTCDay();
  return dow === 0 ? 7 : dow;
}

const DOW_ACC = ['', 'понедельник', 'вторник', 'среду', 'четверг', 'пятницу', 'субботу', 'воскресенье'];

/** «на четверг» / «на 21.10» — по-человечески о дне срока. */
export function dayWord(date: string, today: string): string {
  if (date === today) return 'на сегодня';
  if (date === addDays(today, 1)) return 'на завтра';
  const diff = (new Date(`${date}T00:00:00Z`).getTime() - new Date(`${today}T00:00:00Z`).getTime()) / 86_400_000;
  if (diff > 0 && diff < 7) return `на ${DOW_ACC[isoDowOf(date)]}`;
  return `на ${date.slice(8, 10)}.${date.slice(5, 7)}`;
}

/**
 * Оценить постановку. Предупреждаем (§30), если после задачи нагрузка выше 100%, или
 * человек уже перегружен, или на тот же день у него уже 3+ срочные/высокие задачи.
 */
export function assess(
  person: PersonLoadNow, task: NewTask, candidates: CandidateNow[], now: Date, local: LocalDate,
): Assessment {
  const cost = taskPoints({ priority: task.priority, deadlineAt: task.deadlineAt }, now);
  const before = capacityPct(person.points, person.norm);
  const after = capacityPct(person.points + cost, person.norm);
  const today = local(now).date;
  const deadlineDate = task.deadlineAt ? local(task.deadlineAt).date : null;
  const dayLoad = (date: string) => person.tasks.filter((t) => t.deadlineAt && urgent(t.priority) && local(t.deadlineAt).date === date).length;
  const sameDayUrgent = deadlineDate ? dayLoad(deadlineDate) : 0;

  const reasons: string[] = [];
  const first = person.name.split(' ')[0];
  // имя — в именительном: склонять имена правилами ненадёжно («У Сергей…»)
  if (deadlineDate && sameDayUrgent >= 3) reasons.push(`${first}: ${dayWord(deadlineDate, today)} уже ${sameDayUrgent} срочные задачи.`);
  if (after > 100) reasons.push(before > 100 ? `${first} уже перегружен(а): ${before}%, с новой задачей — ${after}%.` : `${first}: новая задача поднимет загрузку до ${after}%.`);
  const warn = after > 100 || (deadlineDate !== null && sameDayUrgent >= 3);
  if (!warn) {
    return { warn: false, level: 'ok', before, after, sameDayUrgent, reasons: [], deadlineDate, alternativeDate: null, alternatives: [] };
  }

  // Другой срок (§33): ближайший рабочий день после исходного, где у человека меньше двух срочных.
  let alternativeDate: string | null = null;
  const start = deadlineDate && deadlineDate > today ? deadlineDate : today;
  for (let i = 1; i <= 10; i++) {
    const d = addDays(start, i);
    const dow = isoDowOf(d);
    if (dow === 6 || dow === 7) continue;
    if (dayLoad(d) < 2) { alternativeDate = d; break; }
  }

  // Другой человек (§32): только тем, кто может получать задачи, не в отпуске, видит
  // проект, работает по направлению задачи — и у кого после неё будет не выше 85%.
  const alternatives = candidates
    .filter((c) => c.id !== person.id && c.canReceive && c.available)
    .filter((c) => !task.allowed || task.allowed.has(c.id))
    .filter((c) => !task.directions.length || task.directions.some((d) => c.skills.includes(d)))
    .map((c) => ({ id: c.id, name: c.name, after: capacityPct(c.points + cost, c.norm) }))
    .filter((c) => c.after <= 85)
    .sort((a, b) => a.after - b.after)
    .slice(0, 3);

  return {
    warn: true, level: band(after) === 'overloaded' ? 'overloaded' : 'high', before, after, sameDayUrgent,
    reasons: [...reasons, 'Высокий риск задержки.'], deadlineDate, alternativeDate, alternatives,
  };
}
