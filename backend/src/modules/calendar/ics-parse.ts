/**
 * Разбор чужого календаря в формате iCalendar (RFC 5545).
 *
 * Нужен ровно для одного: человек даёт нам «секретный адрес в формате iCal» из своего
 * Google-календаря, и мы показываем его встречи рядом с нашими. Без OAuth, без
 * согласия администратора домена, без проверки приложения Google — сегодня, а не
 * через месяц переписки.
 *
 * Формат придирчив, и каждая мелочь ломает разбор молча — календарь просто окажется
 * пустым. Поэтому здесь и проверяется то, на чём спотыкаются все:
 *  - строки СКЛАДЫВАЮТСЯ: длинная строка разрезана и продолжена строкой, начинающейся
 *    с пробела. Без склейки название встречи обрывается на середине;
 *  - у даты три разных вида: `20260908` (весь день), `20260908T090000Z` (UTC) и
 *    `TZID=Europe/Moscow:20260908T120000` (местное время в названной зоне). Последний
 *    Google отдаёт чаще всего, и считать его UTC — значит сдвинуть день на три часа;
 *  - повторяющиеся встречи приходят ОДНОЙ записью с правилом RRULE. Не развернув его,
 *    мы потеряем ежедневную планёрку во все дни, кроме первого.
 */

export interface ExternalEvent {
  uid: string;
  title: string;
  location: string | null;
  startsAt: Date;
  endsAt: Date;
  allDay: boolean;
}

interface RawEvent {
  props: Map<string, { params: Record<string, string>; value: string }>;
  exdates: Date[];
}

/** Максимум развёрнутых повторов на одну запись: защита от «каждый день до 2099 года». */
const MAX_OCCURRENCES = 400;

/**
 * Склейка строк.
 *
 * По стандарту продолжение строки начинается с пробела или табуляции. Клиенты режут
 * строки по 75 октетов, и внутри разреза оказывается что угодно — в том числе
 * середина русского слова.
 */
export function unfold(text: string): string[] {
  const lines = String(text ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const out: string[] = [];
  for (const line of lines) {
    if ((line.startsWith(' ') || line.startsWith('\t')) && out.length) {
      out[out.length - 1] += line.slice(1);
    } else {
      out.push(line);
    }
  }
  return out;
}

/** Экранирование по стандарту: `\n` — перевод строки, `\,` и `\;` — сами символы. */
function unescapeIcs(v: string): string {
  return v
    .replace(/\\n/gi, '\n')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\\\/g, '\\');
}

/** `DTSTART;TZID=Europe/Moscow:20260908T120000` → имя, параметры, значение. */
function parseLine(line: string): { name: string; params: Record<string, string>; value: string } | null {
  const at = line.indexOf(':');
  if (at < 0) return null;
  const head = line.slice(0, at);
  const value = line.slice(at + 1);
  const [name, ...rest] = head.split(';');
  const params: Record<string, string> = {};
  for (const p of rest) {
    const eq = p.indexOf('=');
    if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, '');
  }
  return { name: name.toUpperCase(), params, value };
}

/**
 * Смещение названной зоны в минутах на конкретный момент.
 *
 * Именно «на момент»: в Берлине летом +2, зимой +1, и встреча, посчитанная по одному
 * из них, дважды в год уезжает на час.
 */
function offsetMinutes(date: Date, tz: string): number {
  try {
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
  } catch {
    return 0; // незнакомая зона — считаем по UTC, это честнее выдуманного сдвига
  }
}

/** Значение даты/времени → момент. Понимает все три вида, которые встречаются на практике. */
export function parseIcsDate(value: string, params: Record<string, string> = {}): Date | null {
  const v = String(value ?? '').trim();
  const dateOnly = /^(\d{4})(\d{2})(\d{2})$/.exec(v);
  if (dateOnly) {
    return new Date(Date.UTC(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3])));
  }
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/.exec(v);
  if (!m) return null;
  const [, y, mo, d, hh, mm, ss, z] = m;
  const naive = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(hh), Number(mm), Number(ss));
  if (z) return new Date(naive);

  const tz = params.TZID;
  if (!tz) return new Date(naive); // без зоны считаем UTC: гадать нечем
  // местное время в названной зоне: вычитаем смещение, уточняя его по первому приближению
  const first = offsetMinutes(new Date(naive), tz);
  let ms = naive - first * 60_000;
  const second = offsetMinutes(new Date(ms), tz);
  if (second !== first) ms = naive - second * 60_000;
  return new Date(ms);
}

const DAY_MS = 24 * 3600_000;
const BYDAY_INDEX: Record<string, number> = { MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6, SU: 0 };

/**
 * Развернуть правило повтора в моменты внутри окна.
 *
 * Понимаем то, чем пользуются в жизни: ежедневно, по дням недели, ежемесячно и
 * ежегодно, с шагом, ограничением по числу или по дате. Более редкое (BYSETPOS,
 * BYMONTHDAY со списком, исключения по времени) не выдумываем: такая встреча приедет
 * одним первым разом — это честнее, чем показать её не в те дни.
 */
export function expandRrule(start: Date, rule: string, from: Date, to: Date): Date[] {
  const parts: Record<string, string> = {};
  for (const kv of String(rule ?? '').split(';')) {
    const eq = kv.indexOf('=');
    if (eq > 0) parts[kv.slice(0, eq).toUpperCase()] = kv.slice(eq + 1);
  }
  const freq = (parts.FREQ ?? '').toUpperCase();
  if (!['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].includes(freq)) return [start];

  const interval = Math.max(1, Number(parts.INTERVAL ?? 1) || 1);
  const count = parts.COUNT ? Number(parts.COUNT) : null;
  const until = parts.UNTIL ? parseIcsDate(parts.UNTIL) : null;
  const byDay = (parts.BYDAY ?? '').split(',').map((d) => BYDAY_INDEX[d.trim().toUpperCase().slice(-2)]).filter((n) => n !== undefined);

  const out: Date[] = [];
  const limit = until && until.getTime() < to.getTime() ? until.getTime() : to.getTime();
  let made = 0;

  const push = (d: Date) => {
    if (d.getTime() > limit) return false;
    if (d.getTime() >= from.getTime()) out.push(new Date(d));
    made++;
    return !(count && made >= count) && out.length < MAX_OCCURRENCES;
  };

  if (freq === 'WEEKLY' && byDay.length) {
    // «каждый вторник и четверг»: идём по неделям и внутри недели — по выбранным дням
    const weekStart = new Date(start.getTime());
    weekStart.setUTCDate(weekStart.getUTCDate() - ((weekStart.getUTCDay() + 6) % 7));
    for (let w = 0; w < 520; w++) {
      const base = new Date(weekStart.getTime() + w * interval * 7 * DAY_MS);
      if (base.getTime() > limit + 7 * DAY_MS) break;
      for (let i = 0; i < 7; i++) {
        const day = new Date(base.getTime() + i * DAY_MS);
        if (!byDay.includes(day.getUTCDay())) continue;
        if (day.getTime() < start.getTime()) continue;
        const at = new Date(day.getTime());
        at.setUTCHours(start.getUTCHours(), start.getUTCMinutes(), start.getUTCSeconds(), 0);
        if (!push(at)) return out;
      }
    }
    return out;
  }

  const step = (n: number): Date => {
    const d = new Date(start.getTime());
    if (freq === 'DAILY') d.setUTCDate(d.getUTCDate() + n * interval);
    else if (freq === 'WEEKLY') d.setUTCDate(d.getUTCDate() + n * interval * 7);
    else if (freq === 'MONTHLY') d.setUTCMonth(d.getUTCMonth() + n * interval);
    else d.setUTCFullYear(d.getUTCFullYear() + n * interval);
    return d;
  };
  for (let n = 0; n < 2000; n++) {
    const at = step(n);
    if (at.getTime() > limit) break;
    if (!push(at)) break;
  }
  return out;
}

/**
 * Разобрать календарь целиком.
 *
 * Отменённые встречи (`STATUS:CANCELLED`) пропускаем: их в календаре быть не должно.
 * Окно обязательно — без него ежедневная встреча «до 2099 года» развернулась бы в
 * тридцать тысяч записей.
 */
export function parseIcs(text: string, from: Date, to: Date): ExternalEvent[] {
  const lines = unfold(text);
  const events: ExternalEvent[] = [];
  let current: RawEvent | null = null;

  for (const line of lines) {
    if (line.startsWith('BEGIN:VEVENT')) { current = { props: new Map(), exdates: [] }; continue; }
    if (line.startsWith('END:VEVENT')) {
      if (current) events.push(...buildEvents(current, from, to));
      current = null;
      continue;
    }
    if (!current) continue;
    const parsed = parseLine(line);
    if (!parsed) continue;
    if (parsed.name === 'EXDATE') {
      for (const v of parsed.value.split(',')) {
        const d = parseIcsDate(v, parsed.params);
        if (d) current.exdates.push(d);
      }
      continue;
    }
    if (!current.props.has(parsed.name)) current.props.set(parsed.name, { params: parsed.params, value: parsed.value });
  }
  return events;
}

function buildEvents(raw: RawEvent, from: Date, to: Date): ExternalEvent[] {
  const get = (name: string) => raw.props.get(name);
  if ((get('STATUS')?.value ?? '').toUpperCase() === 'CANCELLED') return [];

  const dtStart = get('DTSTART');
  if (!dtStart) return [];
  const start = parseIcsDate(dtStart.value, dtStart.params);
  if (!start) return [];

  const allDay = (dtStart.params.VALUE ?? '').toUpperCase() === 'DATE' || /^\d{8}$/.test(dtStart.value.trim());
  const dtEnd = get('DTEND');
  const end = dtEnd ? parseIcsDate(dtEnd.value, dtEnd.params) : null;
  // без конца встреча длится час, а «весь день» — сутки: так поступают все клиенты
  const duration = end ? end.getTime() - start.getTime() : (allDay ? DAY_MS : 3600_000);

  const uid = (get('UID')?.value ?? '').trim() || `${start.toISOString()}-${(get('SUMMARY')?.value ?? '').slice(0, 40)}`;
  const title = unescapeIcs(get('SUMMARY')?.value ?? '').trim() || 'Без названия';
  const location = unescapeIcs(get('LOCATION')?.value ?? '').trim() || null;

  const rrule = get('RRULE')?.value;
  const starts = rrule ? expandRrule(start, rrule, from, to) : [start];
  const skip = new Set(raw.exdates.map((d) => d.getTime()));

  return starts
    .filter((s) => !skip.has(s.getTime()))
    .filter((s) => s.getTime() + duration >= from.getTime() && s.getTime() <= to.getTime())
    .map((s) => ({
      // у повторов один UID на все разы — добавляем время, иначе они затрут друг друга
      uid: starts.length > 1 ? `${uid}:${s.toISOString()}` : uid,
      title,
      location,
      startsAt: s,
      endsAt: new Date(s.getTime() + duration),
      allDay,
    }));
}
