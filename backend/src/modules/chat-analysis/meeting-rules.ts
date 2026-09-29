/**
 * Встречи из переписки (ТЗ-12, разд. 5.6, 34–37).
 *
 * «Давайте завтра в 15:00 созвонимся по интеграции» — договорённость, которую потом
 * кто-то должен перенести в календарь руками, и обычно не переносит. Агент делает это
 * за человека, но по тем же правилам, что и с задачами: основание, а не догадка.
 *
 *   * Встреча готова, только когда названы И дата, И время. Названа одна дата — бот
 *     спрашивает время (разд. 35); не названа и дата — это не договорённость, а
 *     намерение («надо бы как-нибудь созвониться»).
 *   * Участники — те, кто договаривался, и те, кого назвали по имени (разд. 36). Всю
 *     команду проекта не зовём никогда: приглашение приходит письмом, и двадцать писем
 *     о чужом созвоне — худшая реклама функции.
 *   * Организатор — автор предложения, а не нажавший кнопку: он предложил, ему и вести.
 *
 * Ставит встречу в календарь только человек, даже в режиме автосоздания (разд. 16:
 * Meetings — ASK): приглашение уходит людям письмом, и отозвать письмо нельзя.
 *
 * Чистые функции; проверяются юнит-тестом рядом.
 */

/** Сколько длится встреча, если в разговоре не сказали. Полчаса — обычный созвон. */
export const MEETING_DEFAULT_MIN = 30;
const MEETING_MIN = 15;
const MEETING_MAX = 240;
/** Потолок приглашённых: больше — это уже не договорённость в чате, а собрание. */
export const MEETING_MAX_PEOPLE = 15;
/** Ниже этой уверенности в самом намерении встречу не предлагаем готовой. */
export const MEETING_MIN_INTENT = 0.9;

/** Длительность из ответа модели — в разумных границах; мусор — полчаса. */
export function durationOf(v: unknown): number {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n) || n <= 0) return MEETING_DEFAULT_MIN;
  return Math.min(MEETING_MAX, Math.max(MEETING_MIN, n));
}

/** Дата без времени: «YYYY-MM-DD» не раньше сегодняшней (сегодня — в поясе организации). */
export function meetingDateOf(v: unknown, today: string): string | null {
  const s = String(v ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  return s >= today ? s : null;
}

/**
 * Кого звать.
 *
 * Организатор — первый, дальше названные по имени, дальше остальные, кто участвовал
 * в договорённости. Бот (пустой автор) участником не бывает. Порядок важен: при
 * срезе по потолку отсекаются самые косвенные участники, а не организатор.
 */
export function meetingParticipants(o: {
  organizerId: string | null;
  named: string[];
  authors: (string | null)[];
}): string[] {
  const out: string[] = [];
  for (const id of [o.organizerId, ...o.named, ...o.authors]) {
    if (id && !out.includes(String(id))) out.push(String(id));
  }
  return out.slice(0, MEETING_MAX_PEOPLE);
}

/**
 * Состояние наблюдения о встрече.
 *
 * `ready` — осталось нажать «поставить»; `needs_clarification` — есть дата, нет времени,
 * и об этом можно спросить; `detected` — договорённости нет или она отменена.
 */
export function meetingReadiness(o: {
  intent: number;
  meetingAt: Date | null;
  meetingDate: string | null;
  participants: string[];
  cancelled: boolean;
  now: Date;
}): 'ready' | 'needs_clarification' | 'detected' {
  if (o.cancelled || o.intent < MEETING_MIN_INTENT) return 'detected';
  // Встреча с самим собой — это напоминание, а не созвон.
  if (o.participants.length < 2) return 'detected';
  if (o.meetingAt && o.meetingAt.getTime() > o.now.getTime()) return 'ready';
  if (o.meetingDate) return 'needs_clarification';
  return 'detected';
}

/**
 * Время из ответа человека: «14:00», «в 15», «к 9.30», «в 3 дня».
 *
 * Голое число без «в»/«к» и без минут не берём: «30» в ответе — это скорее число
 * месяца, чем время. Названо два разных времени — не выбираем.
 */
export function parseTimeAnswer(text: string): string | null {
  const found = new Set<string>();
  const t = String(text ?? '').toLowerCase();
  const push = (h: number, m: number, tail: string) => {
    let hh = h;
    if (/^\s*(дня|вечера)/.test(tail) && hh < 12) hh += 12;
    if (hh > 23 || m > 59) return;
    found.add(`${String(hh).padStart(2, '0')}:${String(m).padStart(2, '0')}`);
  };
  // Хвост («дня», «вечера») смотрим вперёд, не съедая: иначе «в 14 или в 16» теряет второе.
  for (const x of t.matchAll(/(?<!\d)(\d{1,2})[:.](\d{2})(?!\d)(?=(.{0,8}))/g)) push(Number(x[1]), Number(x[2]), x[3]);
  for (const x of t.matchAll(/(?<![а-яa-z0-9])(?:в|к)\s+(\d{1,2})(?![\d:.])(?=(.{0,8}))/g)) push(Number(x[1]), 0, x[2]);
  for (const x of t.matchAll(/(?<![\d:.])(\d{1,2})\s*(?:час|ч(?![а-я]))(?=(.{0,12}))/g)) {
    push(Number(x[1]), 0, x[2].replace(/^[а-я]*/, ''));
  }
  return found.size === 1 ? [...found][0] : null;
}

/** «30 сентября» для даты «2026-09-30» — дата местная, пояс здесь не нужен. */
export function dayLabel(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', timeZone: 'UTC' });
}

/** Вопрос о времени — организатору, одним сообщением, с примером ответа. */
export function meetingAskText(o: { who: string | null; title: string; date: string }): string {
  return [
    `${o.who ? `${o.who}, ` : ''}во сколько поставить встречу «${o.title}» на ${dayLabel(o.date)}?`,
    'Ответьте временем, например «14:00» или «в 15».',
    'Спрошу один раз: если сейчас не до этого, просто не отвечайте.',
  ].join('\n');
}

/** Описание события: откуда оно, чтобы через неделю не гадать, кто и зачем его поставил. */
export function meetingDescription(o: { chat: string | null; quote: string | null; details: string }): string {
  return [
    o.details.trim(),
    `Договорённость в чате${o.chat ? ` «${o.chat}»` : ''}.`,
    o.quote ? `«${o.quote.trim().slice(0, 300)}»` : '',
  ].filter(Boolean).join('\n');
}
