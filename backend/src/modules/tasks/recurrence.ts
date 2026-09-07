/**
 * Правила повтора задач.
 *
 * Вынесено отдельным модулем и под jest намеренно: календарная арифметика ошибается
 * МОЛЧА и в самых обидных местах — 31-е число в феврале, переход на летнее время,
 * «понедельник» по часовому поясу сервера вместо пояса человека. Ни одна из этих
 * ошибок не роняет запрос: задача просто появляется не в тот день или не появляется
 * вовсе, и замечают это через неделю.
 *
 * Время считаем в поясе ЧЕЛОВЕКА, а храним в UTC. Без пояса «каждый понедельник в 10»
 * превращается в «в час ночи по Москве» у любого, кто живёт не там, где сервер.
 */

export type RecurrenceFreq = 'daily' | 'weekly' | 'monthly' | 'days';

export interface RecurrenceRule {
  freq: RecurrenceFreq;
  /** Дни недели для `weekly`: 1 = понедельник … 7 = воскресенье. */
  weekdays: number[];
  /** Число месяца для `monthly`. */
  monthday: number | null;
  /** Шаг в днях для `days`. */
  intervalDays: number | null;
  /** «ЧЧ:ММ» — время срока новой задачи в поясе `tz`. */
  atTime: string;
  tz: string;
}

const FREQS: RecurrenceFreq[] = ['daily', 'weekly', 'monthly', 'days'];
/** Пояс по умолчанию: сервер стоит в Москве, и это ближе к правде, чем UTC. */
const FALLBACK_TZ = 'Europe/Moscow';
const WEEKDAY_NAMES = ['понедельник', 'вторник', 'среду', 'четверг', 'пятницу', 'субботу', 'воскресенье'];

/**
 * Привести присланное расписание к рабочему виду.
 *
 * Возвращает `null` на бессмыслице — «каждую неделю, дни не выбраны» или «каждые ноль
 * дней». Молча чинить такое нельзя: повтор, который сработает не тогда, хуже отказа,
 * потому что человек о нём уже не думает.
 */
export function normalizeRule(input: Partial<RecurrenceRule> | null | undefined): RecurrenceRule | null {
  if (!input) return null;
  const freq = FREQS.includes(input.freq as RecurrenceFreq) ? (input.freq as RecurrenceFreq) : null;
  if (!freq) return null;

  const atTime = normalizeTime(input.atTime);
  if (!atTime) return null;
  const tz = isKnownZone(input.tz) ? String(input.tz) : FALLBACK_TZ;

  if (freq === 'weekly') {
    // дубли и мусор выкидываем, порядок — с понедельника: подпись читается слева направо
    const weekdays = [...new Set((input.weekdays ?? []).map(Number).filter((d) => d >= 1 && d <= 7))].sort();
    if (!weekdays.length) return null;
    return { freq, weekdays, monthday: null, intervalDays: null, atTime, tz };
  }
  if (freq === 'monthly') {
    const monthday = Math.trunc(Number(input.monthday));
    if (!(monthday >= 1 && monthday <= 31)) return null;
    return { freq, weekdays: [], monthday, intervalDays: null, atTime, tz };
  }
  if (freq === 'days') {
    const intervalDays = Math.trunc(Number(input.intervalDays));
    // верхнюю границу ставим осознанно: «каждые 400 дней» — это не повтор, а забытая задача
    if (!(intervalDays >= 1 && intervalDays <= 365)) return null;
    return { freq, weekdays: [], monthday: null, intervalDays, atTime, tz };
  }
  return { freq: 'daily', weekdays: [], monthday: null, intervalDays: null, atTime, tz };
}

/** «ЧЧ:ММ» или null. Часы больше 23 и минуты больше 59 — это не время. */
function normalizeTime(value: unknown): string | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(value ?? '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

function isKnownZone(tz: unknown): boolean {
  if (!tz || typeof tz !== 'string') return false;
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Смещение пояса в минутах на конкретный момент.
 *
 * Именно «на момент», а не «у пояса»: в Берлине летом +2, зимой +1, и повтор,
 * посчитанный по одному из них, дважды в год уезжает на час.
 */
function offsetMinutes(date: Date, tz: string): number {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p = Object.fromEntries(fmt.formatToParts(date).map((x) => [x.type, x.value])) as Record<string, string>;
  const asUtc = Date.UTC(
    Number(p.year), Number(p.month) - 1, Number(p.day),
    Number(p.hour) % 24, Number(p.minute), Number(p.second),
  );
  return Math.round((asUtc - date.getTime()) / 60_000);
}

/** Календарная дата в поясе человека: с неё и считаем «сегодня», «понедельник», «31-е». */
function localDate(date: Date, tz: string): { y: number; m: number; d: number; minutes: number } {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  });
  const p = Object.fromEntries(fmt.formatToParts(date).map((x) => [x.type, x.value])) as Record<string, string>;
  return {
    y: Number(p.year), m: Number(p.month), d: Number(p.day),
    minutes: (Number(p.hour) % 24) * 60 + Number(p.minute),
  };
}

/**
 * Местные дата и время → момент в UTC.
 *
 * Смещение берём дважды: первое приближение может попасть в другую половину года
 * (переход на летнее время), и тогда пересчитываем по уточнённому моменту.
 */
function zonedToUtc(y: number, m: number, d: number, atTime: string, tz: string): Date {
  const [hh, mm] = atTime.split(':').map(Number);
  const naive = Date.UTC(y, m - 1, d, hh, mm, 0, 0);
  const first = offsetMinutes(new Date(naive), tz);
  let ms = naive - first * 60_000;
  const second = offsetMinutes(new Date(ms), tz);
  if (second !== first) ms = naive - second * 60_000;
  return new Date(ms);
}

/** Сколько дней в месяце — чтобы 31-е в феврале съезжало на последний день, а не пропадало. */
function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** День недели календарной даты: 1 = понедельник … 7 = воскресенье. */
export function weekdayOf(y: number, m: number, d: number): number {
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0 = воскресенье
  return dow === 0 ? 7 : dow;
}

function addDays(y: number, m: number, d: number, n: number): { y: number; m: number; d: number } {
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

/**
 * Ближайшее срабатывание СТРОГО ПОСЛЕ `after`.
 *
 * Перебираем календарные дни в поясе человека, а не считаем формулой: с формулой
 * приходится отдельно помнить про короткие месяцы, високосный год и перевод часов,
 * и каждая из этих поправок — отдельная тихая ошибка. Дней в году всего 366,
 * перебор ничего не стоит.
 */
export function nextRun(rule: RecurrenceRule, after: Date): Date {
  const tz = rule.tz || FALLBACK_TZ;
  const start = localDate(after, tz);

  if (rule.freq === 'days') {
    // «каждые N дней» отсчитываются от прошлого срабатывания, а не от начала месяца:
    // человек имеет в виду «раз в N дней с этого дня»
    const step = Math.max(1, rule.intervalDays ?? 1);
    const at = addDays(start.y, start.m, start.d, step);
    return zonedToUtc(at.y, at.m, at.d, rule.atTime, tz);
  }

  for (let i = 0; i <= 400; i++) {
    const day = addDays(start.y, start.m, start.d, i);
    if (!dayMatches(rule, day)) continue;
    const when = zonedToUtc(day.y, day.m, day.d, rule.atTime, tz);
    // сегодняшний день годится, только если время ещё не прошло
    if (when.getTime() > after.getTime()) return when;
  }
  // сюда не попасть ни при каком корректном правиле; отвечаем завтрашним днём,
  // а не исключением: молчаливая остановка повтора хуже сдвига на день
  const fallback = addDays(start.y, start.m, start.d, 1);
  return zonedToUtc(fallback.y, fallback.m, fallback.d, rule.atTime, tz);
}

function dayMatches(rule: RecurrenceRule, day: { y: number; m: number; d: number }): boolean {
  switch (rule.freq) {
    case 'daily':
      return true;
    case 'weekly':
      return rule.weekdays.includes(weekdayOf(day.y, day.m, day.d));
    case 'monthly': {
      const want = rule.monthday ?? 1;
      const last = daysInMonth(day.y, day.m);
      // 31-е число в коротком месяце — последний день, а не пропуск месяца
      return day.d === Math.min(want, last);
    }
    default:
      return false;
  }
}

/** Подпись человеку: «каждый понедельник в 10:00». Её же видит и планировщик в логе. */
export function describeRule(rule: RecurrenceRule): string {
  const at = ` в ${rule.atTime}`;
  switch (rule.freq) {
    case 'daily':
      return `каждый день${at}`;
    case 'weekly': {
      const days = rule.weekdays.map((d) => WEEKDAY_NAMES[d - 1]).join(', ');
      return `каждую неделю: ${days}${at}`;
    }
    case 'monthly':
      return `каждое ${rule.monthday}-е число${at}`;
    default: {
      const n = rule.intervalDays ?? 1;
      const word = n === 1 ? 'день' : n < 5 ? 'дня' : 'дней';
      return `каждые ${n} ${word}${at}`;
    }
  }
}
