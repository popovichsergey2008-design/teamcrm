/**
 * Разбор надиктованной встречи: «созвон с Петром завтра в 15 на час в переговорной».
 *
 * Здесь два слоя, и оба нужны. Модель хорошо понимает формулировку человека, но
 * ошибается в арифметике дат и любит выдумывать участников. Правила ниже считают
 * время сами и пропускают только тех людей, которые есть в компании.
 *
 * Если модель недоступна (нет ключа, кончились деньги, ответила мусором), эти же
 * правила работают одни: «завтра в 15» они разберут и без ИИ. Человек, который
 * продиктовал встречу, не должен получать пустую форму из-за чужого сбоя.
 *
 * Время везде МЕСТНОЕ и в формате, который понимает поле формы: YYYY-MM-DDTHH:mm.
 * Переводить в UTC здесь нельзя: «завтра в 15:00» — это 15:00 у человека, а не на сервере.
 */

export interface EventContextUser {
  id: string;
  name: string;
}

export interface EventDraft {
  title: string;
  description: string | null;
  startsAt: string | null;
  endsAt: string | null;
  allDay: boolean;
  location: string | null;
  participantIds: string[];
}

/**
 * Граница слова для кириллицы.
 *
 * `\b` в регулярных выражениях JS считает словом только латиницу и цифры, поэтому
 * `\bзавтра\b` НЕ находит «завтра» в русском тексте — с ним правила молчали целиком.
 * Проверяем соседние символы явно.
 */
const LETTER = '[а-яa-z0-9]';
const word = (body: string, flags = 'i') => new RegExp(`(?<!${LETTER})(?:${body})(?!${LETTER})`, flags);

/** Один вид текста для всех правил: нижний регистр и «е» вместо «ё». */
const norm = (text: string) => text.toLowerCase().replace(/ё/g, 'е');

/** Встреча без явной длительности — час: столько по умолчанию ставят в любом календаре. */
const DEFAULT_MINUTES = 60;

const pad = (n: number) => String(n).padStart(2, '0');

/** Дата-время в том виде, в каком его ждёт поле формы. */
export function toLocalInput(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function parseLocalInput(v: string | null | undefined): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(String(v ?? ''));
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]));
  return Number.isNaN(d.getTime()) ? null : d;
}

const WEEKDAYS: Record<string, number> = {
  'понедельник': 1, 'вторник': 2, 'среду': 3, 'среда': 3, 'четверг': 4,
  'пятницу': 5, 'пятница': 5, 'субботу': 6, 'суббота': 6, 'воскресенье': 0,
};

const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];

/** День встречи по словам «сегодня / завтра / послезавтра / в пятницу / 15 сентября». */
function pickDay(text: string, now: Date): Date | null {
  const t = norm(text);
  const day = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  if (word('послезавтра').test(t)) { day.setDate(day.getDate() + 2); return day; }
  if (word('завтра').test(t)) { day.setDate(day.getDate() + 1); return day; }
  if (word('сегодня').test(t)) return day;

  // «в понедельник» — ближайший такой день; сегодняшний не в счёт, так говорят о будущем
  for (const [name, dow] of Object.entries(WEEKDAYS)) {
    if (word(name).test(t)) {
      const shift = ((dow - day.getDay() + 7) % 7) || 7;
      day.setDate(day.getDate() + shift);
      return day;
    }
  }

  const byName = new RegExp(`(?<!\\d)(\\d{1,2})\\s+(${MONTHS.join('|')})`, 'i').exec(t);
  if (byName) {
    const d = new Date(now.getFullYear(), MONTHS.indexOf(byName[2]), Number(byName[1]));
    if (d < day) d.setFullYear(d.getFullYear() + 1); // названная дата в прошлом — значит следующий год
    return d;
  }

  const byDigits = /(?<![\d.])(\d{1,2})[.\/](\d{1,2})(?:[.\/](\d{2,4}))?(?![\d.])/.exec(t);
  if (byDigits) {
    const year = byDigits[3]
      ? Number(byDigits[3].length === 2 ? `20${byDigits[3]}` : byDigits[3])
      : now.getFullYear();
    const d = new Date(year, Number(byDigits[2]) - 1, Number(byDigits[1]));
    if (!byDigits[3] && d < day) d.setFullYear(d.getFullYear() + 1);
    return d;
  }
  return null;
}

/** Время начала: «в 15», «в 15:30», «в 9 утра», «в 7 вечера». */
function pickTime(text: string): { hour: number; minute: number } | null {
  const m = word('в\\s+(\\d{1,2})(?:[:.](\\d{2}))?\\s*(утра|дня|вечера|ночи)?').exec(norm(text));
  if (!m) return null;
  let hour = Number(m[1]);
  const minute = m[2] ? Number(m[2]) : 0;
  if (hour > 23 || minute > 59) return null;
  const part = m[3];
  if (part === 'вечера' && hour < 12) hour += 12;
  if (part === 'дня' && hour >= 1 && hour <= 5) hour += 12;
  if (part === 'ночи' && hour === 12) hour = 0;
  // «в 3» без уточнения — это рабочие 15:00, а не ночь
  if (!part && hour >= 1 && hour <= 7) hour += 12;
  return { hour, minute };
}

/** Длительность: «на час», «на полтора часа», «на 30 минут», «на 2 часа». */
function pickDuration(text: string): number | null {
  const t = norm(text);
  if (word('на\\s+полтора\\s+часа').test(t)) return 90;
  if (word('на\\s+полчаса').test(t)) return 30;
  const hours = word('на\\s+(\\d{1,2})\\s*(?:час|часа|часов)').exec(t);
  if (hours) return Number(hours[1]) * 60;
  if (word('на\\s+час').test(t)) return 60;
  const minutes = word('на\\s+(\\d{1,3})\\s*(?:минут|минуты|мин)').exec(t);
  if (minutes) return Number(minutes[1]);
  return null;
}

/** Место: «в переговорной», «в офисе», «у клиента». Созвон местом не считаем. */
function pickLocation(text: string): string | null {
  const m = word('(?:в|у)\\s+(?:переговорной|офисе|кабинете|клиента)(?:\\s+[а-я0-9-]+)?').exec(norm(text));
  return m ? m[0].trim().slice(0, 255) : null;
}

/**
 * Кого позвали. Ищем по имени и по фамилии отдельно: на слух чаще звучит одно из них,
 * и «с Петром» должно находить Петра Иванова. Падежи режем по основе — «Петром»,
 * «Петра» и «Пётр» дают одинаковое начало слова.
 */
export function matchPeople(text: string, users: EventContextUser[]): { ids: string[] } {
  const t = norm(text);
  const ids: string[] = [];
  for (const u of users) {
    const parts = norm(u.name).split(/\s+/).filter((p) => p.length >= 3);
    const hit = parts.some((p) => {
      const stem = p.slice(0, Math.max(3, p.length - 2)); // «иванов» → «иван»
      // до четырёх букв окончания: «Иванов» в творительном даёт «Ивановым» — это плюс четыре
      return word(`${stem}[а-я]{0,4}`).test(t);
    });
    if (hit) ids.push(String(u.id));
  }
  return { ids: [...new Set(ids)] };
}

/** Название встречи: убираем служебную обёртку, остальное — как сказал человек. */
export function cleanTitle(text: string): string {
  const cut = (body: string) => word(body, 'gi');
  let t = text.trim()
    .replace(/^(?:поставь|постав|создай|назначь|запланируй|добавь|запиши)\s+(?:встречу|событие|созвон|звонок)?\s*/i, '')
    .replace(/^(?:встреча|событие|созвон)\s*[:—-]\s*/i, '');

  // хвост со временем и длительностью в названии не нужен — он уже стал полями
  t = t.replace(cut('сегодня|завтра|послезавтра'), ' ')
    .replace(cut('в\\s+\\d{1,2}(?:[:.]\\d{2})?\\s*(?:утра|дня|вечера|ночи)?'), ' ')
    .replace(cut('на\\s+(?:полтора\\s+часа|полчаса|час|\\d{1,3}\\s*(?:час|часа|часов|минут|минуты|мин))'), ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const clean = t.replace(/^[,\s—-]+|[,\s—-]+$/g, '');
  return (clean || text.trim()).slice(0, 255);
}

/**
 * Собрать черновик из текста и (необязательно) ответа модели.
 *
 * Модель уточняет название, описание и место; время и участников считаем сами —
 * в них она ошибается чаще всего, а цена ошибки здесь наглядная: встреча не в тот день.
 */
export function buildEventDraft(
  text: string,
  now: Date,
  users: EventContextUser[],
  model?: { title?: unknown; description?: unknown; location?: unknown; allDay?: unknown } | null,
): EventDraft {
  const t = norm(text);
  const allDay = word('весь\\s+день|целый\\s+день').test(t) || model?.allDay === true;
  const day = pickDay(text, now);
  const time = pickTime(text);
  const duration = pickDuration(text) ?? DEFAULT_MINUTES;

  let startsAt: string | null = null;
  let endsAt: string | null = null;
  if (day || time) {
    const start = day ? new Date(day) : new Date(now.getFullYear(), now.getMonth(), now.getDate());
    if (time) start.setHours(time.hour, time.minute, 0, 0);
    else if (allDay) start.setHours(0, 0, 0, 0);
    else start.setHours(10, 0, 0, 0); // день назвали, час — нет: ставим начало рабочего дня
    // названное время уже прошло сегодня — человек имел в виду завтра
    if (!day && start.getTime() < now.getTime()) start.setDate(start.getDate() + 1);

    const end = allDay
      ? new Date(start.getFullYear(), start.getMonth(), start.getDate(), 23, 59)
      : new Date(start.getTime() + duration * 60_000);
    startsAt = toLocalInput(start);
    endsAt = toLocalInput(end);
  }

  const people = matchPeople(text, users);
  const modelTitle = typeof model?.title === 'string' ? model.title.trim() : '';
  const modelLocation = typeof model?.location === 'string' ? model.location.trim() : '';

  return {
    title: (modelTitle || cleanTitle(text)).slice(0, 255),
    description: typeof model?.description === 'string' && model.description.trim()
      ? model.description.trim().slice(0, 4000)
      : null,
    startsAt,
    endsAt,
    allDay,
    location: (modelLocation || pickLocation(text) || '').slice(0, 255) || null,
    participantIds: people.ids,
  };
}
