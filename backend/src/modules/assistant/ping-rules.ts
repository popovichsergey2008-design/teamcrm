/**
 * Правила смарт-пингов: о чём ассистент напоминает, кому и когда молчит.
 *
 * Вынесено из планировщика чистыми функциями по одной причине: это единственное
 * место в ассистенте, которое разговаривает с людьми от лица системы. Ошибка здесь
 * выглядит не как «сломалось», а как «система пишет ерунду ночью» — и лечится
 * выключением ассистента целиком. Поэтому и формулировки, и тихие часы проверяются
 * тестами, а не глазами.
 */

export type PingKind =
  | 'overdue' | 'due_soon' | 'stuck_review' | 'silent'
  // Оборванные нитки: не про задачу, а про начатый и не законченный разговор.
  // Забываются они чаще сроков — о сроке хотя бы напоминает календарь.
  | 'approval_stuck' | 'mention_silent';

/**
 * Поводы, которые терпят до утра, и повод, который не терпит.
 *
 * Просрочка, зависшая проверка и молчащая задача копятся днями — их место в утренней
 * сводке. «Срок сегодня» — единственное, что имеет смысл сказать в момент, когда это
 * ещё можно успеть сделать.
 */
export const INSTANT_KINDS: PingKind[] = ['due_soon'];

/** Кандидат из базы: то, о чём есть повод напомнить. */
export interface PingCandidate {
  kind: PingKind;
  userId: string;
  /** Задача, если повод про неё: у согласования и упоминания задачи может не быть. */
  taskId: string | null;
  /** То, о чём речь: задача, согласование или упоминание. По нему и строится ключ. */
  subjectId: string;
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

/**
 * Приветствие по местному времени получателя.
 *
 * Сводку человек чаще всего читает утром, но не всегда: кто-то открывает CRM после
 * обеда, кто-то работает вечером. «Доброе утро» в семь вечера читается как машинная
 * рассылка — а мы весь смысл сводки строим на том, что это разговор.
 */
export function greetingFor(now: Date, timezone: string | null): string {
  const { hour } = localParts(now, timezone);
  if (hour < 12) return 'Доброе утро';
  if (hour < 18) return 'Добрый день';
  return 'Добрый вечер';
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
    case 'approval_stuck':
      return `Ждёт вашего решения ${humanHours(c.hours)}: «${c.title}»`;
    case 'mention_silent':
      return `Вас позвали ${humanHours(c.hours)} назад и ждут ответа: «${c.title}»`;
  }
}

/**
 * Ключ повода: одна строка на «этот повод по этой задаче» — навсегда, без даты.
 *
 * Раньше в ключ входила дата, и каждое утро повод заводился заново: человек получал
 * «срок прошёл» по одной и той же задаче каждый день, пока её не закроют. Теперь
 * строка одна, а частоту повторов решает `repeatDue`.
 */
export function pingKey(c: Pick<PingCandidate, 'kind' | 'subjectId'>): string {
  return `${c.kind}:${c.subjectId}`;
}

/** Ключ сводки: одна на человека в день, дата — местная у него. */
export function digestKey(userId: string, now: Date, timezone: string | null): string {
  return `digest:${userId}:${localParts(now, timezone).date}`;
}

/**
 * Паузы между повторами одного повода, в днях.
 *
 * Первое напоминание — сразу, второе — через день, дальше всё реже. Смысл в том, что
 * человек уже знает: если он не двигает задачу третью неделю, это не забывчивость,
 * а решение. Напоминать о нём ежедневно — спорить с чужим решением голосом системы.
 */
const REPEAT_DAYS = [0, 1, 3, 7, 14];

/** Пора ли напомнить снова: повод не менялся, но и не решён. */
export function repeatDue(repeats: number, lastSentAt: Date | null, now: Date): boolean {
  if (!lastSentAt) return true;
  // Сказали один раз — ждём день; два — три дня; и так до потолка в две недели.
  const wait = REPEAT_DAYS[Math.min(Math.max(repeats, 0), REPEAT_DAYS.length - 1)];
  const passed = (now.getTime() - lastSentAt.getTime()) / 86_400_000;
  return passed >= wait;
}

const DIGEST_TITLE: Record<PingKind, string> = {
  overdue: 'Просрочено',
  due_soon: 'Срок сегодня',
  stuck_review: 'Ждёт вашей проверки',
  approval_stuck: 'Ждёт вашего решения',
  mention_silent: 'Вас позвали и ждут',
  silent: 'Без движения',
};

/**
 * Утренняя сводка: всё, что накопилось, одним сообщением.
 *
 * Порядок — по срочности, а не по алфавиту: первым идёт то, что уже сорвано.
 * Больше трёх задач в строке не перечисляем — сводку читают за десять секунд,
 * и длинный список превращает её в ту же простыню, от которой уходим.
 */
export function digestText(items: PingCandidate[], greeting = 'Доброе утро'): string {
  // Порядок — по тому, кого держит промедление: сорванный срок, потом чужое ожидание
  // вашего ответа, и только потом собственные молчащие задачи.
  const order: PingKind[] = ['overdue', 'due_soon', 'approval_stuck', 'mention_silent', 'stuck_review', 'silent'];
  const lines: string[] = [];
  for (const kind of order) {
    const group = items.filter((i) => i.kind === kind);
    if (!group.length) continue;
    const shown = group.slice(0, 3).map((i) => `«${i.title}»`).join(', ');
    const rest = group.length > 3 ? ` и ещё ${group.length - 3}` : '';
    lines.push(`${DIGEST_TITLE[kind]} (${group.length}): ${shown}${rest}`);
  }
  if (!lines.length) return '';
  const body = lines.map((l) => `• ${l}`).join('\n');
  return `${greeting}! Коротко о делах:\n${body}`;
}
