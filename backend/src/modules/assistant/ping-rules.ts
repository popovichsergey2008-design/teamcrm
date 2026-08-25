/**
 * Правила смарт-пингов: о чём ассистент напоминает, кому и когда молчит.
 *
 * Вынесено из планировщика чистыми функциями по одной причине: это единственное
 * место в ассистенте, которое разговаривает с людьми от лица системы. Ошибка здесь
 * выглядит не как «сломалось», а как «система пишет ерунду ночью» — и лечится
 * выключением ассистента целиком. Поэтому и формулировки, и тихие часы проверяются
 * тестами, а не глазами.
 */

export type PingKind = 'overdue' | 'due_soon' | 'stuck_review' | 'silent';

/** Кандидат из базы: задача, у которой есть повод для напоминания. */
export interface PingCandidate {
  kind: PingKind;
  userId: string;
  taskId: string;
  title: string;
  projectName: string | null;
  /** Часы: просрочки, до срока или без движения — смотря по поводу. */
  hours: number;
  /** Пояс получателя из профиля. Пустой — считаем по московскому времени. */
  timezone: string | null;
}

export interface WorkHours {
  /** «09:00» */
  workStart: string;
  /** «18:00» */
  workEnd: string;
  /** 0 — воскресенье, 6 — суббота */
  weekendDays: number[];
  /** «2026-01-01» */
  holidays: string[];
}

/** Пояс по умолчанию: сервер стоит в Москве, и это ближе к правде, чем UTC. */
const FALLBACK_TZ = 'Europe/Moscow';

/** Местное время получателя: пинг в три часа ночи — худшая услуга, чем молчание. */
export function localParts(now: Date, timezone: string | null): { hour: number; minute: number; dow: number; date: string } {
  const tz = timezone || FALLBACK_TZ;
  const read = (zone: string) => {
    const fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: zone, hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', weekday: 'short',
    });
    const parts = Object.fromEntries(fmt.formatToParts(now).map((p) => [p.type, p.value]));
    const dows: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    return {
      // «24» вместо «00» встречается в старых движках Intl — приводим сами
      hour: Number(parts.hour) % 24,
      minute: Number(parts.minute),
      dow: dows[String(parts.weekday)] ?? 1,
      date: `${parts.year}-${parts.month}-${parts.day}`,
    };
  };
  try {
    return read(tz);
  } catch {
    // человек выбрал пояс, которого движок не знает, — молчать из-за этого не станем
    return read(FALLBACK_TZ);
  }
}

/**
 * Можно ли писать прямо сейчас.
 *
 * Тихие часы — не украшение: напоминание в выходной или ночью человек не выполнит,
 * зато запомнит. Считаем по ЕГО поясу и по рабочему календарю компании.
 */
export function withinWorkHours(now: Date, timezone: string | null, work: WorkHours): boolean {
  const { hour, minute, dow, date } = localParts(now, timezone);
  if (work.weekendDays.includes(dow)) return false;
  if (work.holidays.includes(date)) return false;
  // в минутах, а не в часах: рабочий день начинается и в 9:30, и заканчивается в 17:45
  const at = hour * 60 + minute;
  return at >= toMinutes(work.workStart) && at < toMinutes(work.workEnd);
}

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':');
  return Number(h) * 60 + Number(m || 0);
}

/** Через сколько часов «сколько-то дней»: «3 дня» читается лучше, чем «74 часа». */
export function humanHours(hours: number): string {
  const h = Math.round(hours);
  if (h < 24) return `${h} ч`;
  const days = Math.round(h / 24);
  const tail = days % 10;
  const teen = days % 100 >= 11 && days % 100 <= 14;
  const word = !teen && tail === 1 ? 'день' : !teen && tail >= 2 && tail <= 4 ? 'дня' : 'дней';
  return `${days} ${word}`;
}

/**
 * Текст напоминания.
 *
 * Пишем фактом, а не побуждением: «срок вчера» человек проверит, «поторопитесь!»
 * — проигнорирует. И всегда называем задачу: напоминание без названия заставляет
 * идти искать, о чём речь, — а это ровно та работа, которую мы и хотели снять.
 */
export function pingText(c: PingCandidate): string {
  const where = c.projectName ? ` (${c.projectName})` : '';
  switch (c.kind) {
    case 'overdue':
      return `Срок прошёл ${humanHours(c.hours)} назад: «${c.title}»${where}`;
    case 'due_soon':
      return `Срок через ${humanHours(c.hours)}: «${c.title}»${where}`;
    case 'stuck_review':
      return `Ждёт вашей проверки ${humanHours(c.hours)}: «${c.title}»${where}`;
    case 'silent':
      return `Без движения ${humanHours(c.hours)}: «${c.title}»${where}. Что со статусом?`;
  }
}

/**
 * Ключ повтора: один повод по одной задаче — раз в сутки.
 *
 * Дата берётся местная у получателя: иначе у людей в разных поясах сутки кончались бы
 * в чужую полночь, и кому-то приходило бы по два напоминания подряд.
 */
export function dedupKey(c: PingCandidate, now: Date): string {
  return `${c.kind}:${c.taskId}:${localParts(now, c.timezone).date}`;
}
