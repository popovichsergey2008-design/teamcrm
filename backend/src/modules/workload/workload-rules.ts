import { dative, genitive, plural } from '../../common/text/ru-names';
import { band, capacityPct, LOAD_WINDOW_DAYS, LoadBreakdown, Priority, taskPoints } from '../radar/pulse-rules';

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
  /** Из чего сложились очки — показываем в предупреждении (#1553: «непонятно, как считает»). */
  breakdown?: Pick<LoadBreakdown, 'overdue' | 'inWindow' | 'moving' | 'later' | 'meetingHours' | 'reviews'>;
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
  /** «Из чего 210%»: строка разбивки нагрузки, без процентов. */
  basis: string | null;
  /**
   * Мягкая подсказка словами документа (#1525): «Обратите внимание: у Сергея на четверг
   * уже назначено 4 срочные задачи. Если поставить еще одну, возникнет перегрузка.
   * Предлагаю поставить дедлайн на пятницу 15:00 или передать задачу Константину?»
   */
  hint: string | null;
  /** Подписи кнопок: «Дедлайн на пятницу 15:00», «Передать Константину». */
  moveLabel: string | null;
  reassignLabel: string | null;
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
  const dayUrgent = (date: string) => person.tasks.filter((t) => t.deadlineAt && urgent(t.priority) && local(t.deadlineAt).date === date).length;
  const dayAll = (date: string) => person.tasks.filter((t) => t.deadlineAt && local(t.deadlineAt).date === date).length;
  const sameDayUrgent = deadlineDate ? dayUrgent(deadlineDate) : 0;
  const basis = basisText(person.breakdown);

  const reasons: string[] = [];
  const first = person.name.split(' ')[0];
  // имя — в именительном: склонять имена правилами ненадёжно («У Сергей…»)
  if (deadlineDate && sameDayUrgent >= 3) reasons.push(`${first}: ${dayWord(deadlineDate, today)} уже ${sameDayUrgent} срочные задачи.`);
  if (after > 100) reasons.push(before > 100 ? `${first} уже перегружен(а): ${before}%, с новой задачей — ${after}%.` : `${first}: новая задача поднимет загрузку до ${after}%.`);
  /*
    Предупреждаем, только если новая задача ложится в ближайшие две недели (cost > 0):
    задача со сроком через месяц сегодняшнюю загрузку не меняет.
  */
  const warn = (cost > 0 && after > 100) || (deadlineDate !== null && sameDayUrgent >= 3);
  if (!warn) {
    return {
      warn: false, level: 'ok', before, after, sameDayUrgent, reasons: [], deadlineDate, alternativeDate: null, alternatives: [], basis,
      hint: null, moveLabel: null, reassignLabel: null,
    };
  }

  /*
    Другой срок (§33; #1525 — «на пятницу 15:00» после срока «на четверг»): ближайший
    рабочий день ПОСЛЕ срока (без срока — после сегодня), где у человека не больше одной
    задачи со сроком и нет срочных. Ищем в пределах двух недель. Повтор не уводит дату
    дальше: принятый вариант экран больше не перепроверяет (решение 13.10, #1553).
  */
  const start = deadlineDate && deadlineDate > today ? deadlineDate : today;
  let alternativeDate: string | null = null;
  for (let i = 1; i <= LOAD_WINDOW_DAYS; i++) {
    const d = addDays(start, i);
    const dow = isoDowOf(d);
    if (dow === 6 || dow === 7) continue;
    if (dayAll(d) <= 1 && dayUrgent(d) === 0) { alternativeDate = d; break; }
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

  const altDay = alternativeDate ? dayWord(alternativeDate, today) : null;
  const alt = alternatives[0];
  const counted = person.breakdown ? person.breakdown.overdue + person.breakdown.inWindow + person.breakdown.moving : 0;
  return {
    warn: true, level: band(after) === 'overloaded' ? 'overloaded' : 'high', before, after, sameDayUrgent,
    reasons: [...reasons, 'Высокий риск задержки.'], deadlineDate, alternativeDate, alternatives, basis,
    hint: softHint({
      name: person.name,
      day: deadlineDate && sameDayUrgent >= 3 ? dayWord(deadlineDate, today) : null,
      sameDayUrgent, counted, alreadyOver: before > 100, altDay, altName: alt?.name ?? null,
    }),
    moveLabel: altDay ? `Дедлайн ${altDay} ${ALT_TIME}` : null,
    reassignLabel: alt ? `Передать ${dative(alt.name)}` : null,
  };
}

/** Время предложенного срока — как в документе: «на пятницу 15:00». */
export const ALT_TIME = '15:00';

/**
 * Подсказка словами документа (#1525). Имя — в родительном и дательном, день — в
 * винительном, «срочная задача / срочные задачи / срочных задач» по числу.
 * Перегруз без срочных на день — та же форма: «у Сергея уже 9 задач на эти две недели».
 */
export function softHint(i: {
  name: string; day: string | null; sameDayUrgent: number; counted: number; alreadyOver: boolean;
  altDay: string | null; altName: string | null;
}): string {
  const who = genitive(i.name);
  const load = i.day
    // «назначена 1 / 21 срочная задача», «назначено 4 срочные задачи» — сказуемое согласуем с числом
    ? `у ${who} ${i.day} уже ${plural(i.sameDayUrgent, 'назначена', 'назначено', 'назначено')} ${i.sameDayUrgent} ${plural(i.sameDayUrgent, 'срочная задача', 'срочные задачи', 'срочных задач')}`
    : i.counted > 0
      ? `у ${who} уже ${i.counted} ${plural(i.counted, 'задача', 'задачи', 'задач')} на эти две недели`
      : `у ${who} уже полная загрузка на эти две недели`;
  const risk = !i.day && i.alreadyOver
    ? 'Если поставить еще одну, перегрузка станет сильнее.'
    : 'Если поставить еще одну, возникнет перегрузка.';
  const offers = [
    i.altDay ? `поставить дедлайн ${i.altDay} ${ALT_TIME}` : null,
    i.altName ? `передать задачу ${dative(i.altName)}` : null,
  ].filter(Boolean);
  const offer = offers.length ? ` Предлагаю ${offers.join(' или ')}?` : '';
  return `Обратите внимание: ${load}. ${risk}${offer}`;
}

/** «Считаем на 2 недели: 18 просрочено, 1 со сроком, 4 в работе; не считаем 8 отложенных». */
export function basisText(b: PersonLoadNow['breakdown']): string | null {
  if (!b) return null;
  const parts: string[] = [];
  if (b.overdue) parts.push(`${b.overdue} ${plural(b.overdue, 'просрочена', 'просрочены', 'просрочено')}`);
  if (b.inWindow) parts.push(`${b.inWindow} со сроком в эти 2 недели`);
  if (b.moving) parts.push(`${b.moving} в работе без срока`);
  if (b.reviews) parts.push(`${b.reviews} ждут его проверки`);
  if (b.meetingHours) parts.push(`встречи сегодня ${b.meetingHours} ч`);
  if (!parts.length) return null;
  const tail = b.later ? ` Не считаем ${b.later} ${plural(b.later, 'задачу', 'задачи', 'задач')} без движения и без близкого срока.` : '';
  return `Считаем задачи на ближайшие 2 недели, часы не нужны: ${parts.join(', ')}.${tail}`;
}
