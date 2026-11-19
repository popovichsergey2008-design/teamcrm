/**
 * Стикеры (#4997): чистые правила, без базы. Когда стикер — из слов человека, какой цвет — по
 * смыслу, похоже ли сообщение боту на стикер, а не на задачу.
 */
import { numeralsToDigits, pickDay, pickTime } from '../nl/event-draft';

export const STICKER_COLORS = ['yellow', 'pink', 'green', 'blue', 'lilac'] as const;
export type StickerColor = (typeof STICKER_COLORS)[number];

/** Названия цветов по умолчанию (шаг 3.2); у каждого свои — переименовываются. */
export const DEFAULT_COLOR_NAMES: Record<StickerColor, string> = {
  yellow: 'Мысль', pink: 'Срочно', green: 'Идея', blue: 'Звонок / встреча', lilac: 'Личное',
};

export const isStickerColor = (c: unknown): c is StickerColor => STICKER_COLORS.includes(c as StickerColor);

const pad = (n: number) => String(n).padStart(2, '0');
export const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const hm = (h: number, m: number) => `${pad(h)}:${pad(m)}`;
const norm = (t: string) => numeralsToDigits(t.toLowerCase().replace(/ё/g, 'е'));

export interface When { date: string | null; time: string | null }

/**
 * Дата и время из текста (шаг 1.2): «завтра», «послезавтра», дни недели, «через 2 часа»,
 * «через неделю», «25-го», «в конце месяца», «утром» (= 9:00), «вечером» (= 18:00).
 * `now` — местное время человека. Слова из текста не убираются — это делает не разбор.
 */
export function parseWhen(text: string, now: Date): When {
  const t = norm(text);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  // «через 2 часа», «через час», «через 30 минут» — дата и время сразу
  const rel = /(?:^|\s)через\s+(\d+|пол)?\s*(час|часа|часов|минут|минуту|минуты|мин)(?![а-я])/.exec(t);
  if (rel) {
    const n = rel[1] === 'пол' ? 0.5 : rel[1] ? Number(rel[1]) : 1;
    const min = /^мин/.test(rel[2]) ? n : n * 60;
    const at = new Date(now.getTime() + min * 60_000);
    return { date: ymd(at), time: hm(at.getHours(), at.getMinutes()) };
  }

  let day: Date | null = null;
  const days = /(?:^|\s)через\s+(\d+)?\s*(день|дня|дней|неделю|недели|недель)(?![а-я])/.exec(t);
  if (days) {
    const n = days[1] ? Number(days[1]) : 1;
    day = new Date(today); day.setDate(day.getDate() + (/^нед/.test(days[2]) ? 7 * n : n));
  }
  if (!day && /в\s+конце\s+месяца/.test(t)) day = new Date(today.getFullYear(), today.getMonth() + 1, 0);
  if (!day) {
    // «25-го», «25 числа»
    const nth = /(?:^|\s)(\d{1,2})(?:-?го|\s+числа)(?![а-я\d])/.exec(t);
    if (nth && Number(nth[1]) >= 1 && Number(nth[1]) <= 31) {
      day = new Date(today.getFullYear(), today.getMonth(), Number(nth[1]));
      if (day < today) day = new Date(today.getFullYear(), today.getMonth() + 1, Number(nth[1]));
    }
  }
  if (!day) day = pickDay(t, now);

  let time: string | null = null;
  const at = pickTime(t);
  if (at) time = hm(at.hour, at.minute);
  else if (/(?:^|\s)утром(?![а-я])/.test(t)) time = '09:00';
  else if (/(?:^|\s)дн[её]м(?![а-я])/.test(t)) time = '13:00';
  else if (/(?:^|\s)вечером(?![а-я])/.test(t)) time = '18:00';

  // время без дня: ещё не прошло — сегодня, прошло — завтра
  if (!day && time) {
    const [h, m] = time.split(':').map(Number);
    day = new Date(today);
    if (h * 60 + m <= now.getHours() * 60 + now.getMinutes()) day.setDate(day.getDate() + 1);
  }
  return { date: day ? ymd(day) : null, time };
}

/** Цвет по смыслу, если человек не выбрал (шаг 3.2). */
export function guessColor(text: string): StickerColor {
  const t = text.toLowerCase();
  if (/срочно|горит|asap|важно!|немедленно/.test(t)) return 'pink';
  if (/иде[яюи]|придумать|а что если|мысль на будущее/.test(t)) return 'green';
  if (/позвонить|созвон|звонок|встреч|перезвонить|набрать/.test(t)) return 'blue';
  if (/мам[аеуы]|пап[аеуы]|дет[иейям]|сын|доч|жена|муж|врач|бассейн|подарок|родител|день рождения|личное/.test(t)) return 'lilac';
  return 'yellow';
}

/**
 * Похоже на стикер, а не на задачу (шаг 2.1): «напомни…», «не забыть…», «мысль…», «идея…»,
 * «заметка…». «Поставь задачу…» — задача, даже если там есть «не забыть».
 */
export function looksLikeSticker(text: string): boolean {
  const t = text.toLowerCase().trim();
  if (/^(постав|созда|заведи|сделай)\S*\s+задач/.test(t)) return false;
  return /^(напомни|напомнить|не\s+забыть|не\s+забудь|мысль|идея|заметка|запомни|стикер)/.test(t);
}

/** Слово-команду из начала убираем: «напомни в пн продлить домен» → «в пн продлить домен». */
export function stripCommand(text: string): string {
  const s = text.trim().replace(/^(напомни(те)?(\s+мне)?|напомнить|запомни|стикер)\s*[:,—-]?\s*/i, '');
  const cut = s.replace(/^(мысль|идея|заметка)\s*[:,—-]\s*/i, '');
  const out = cut || s || text.trim();
  return out.charAt(0).toUpperCase() + out.slice(1);
}

/** Подпись когда: «пт, 20 ноября · 15:00», «сегодня», «без даты». */
export function whenLabel(w: When, now: Date): string {
  if (!w.date) return 'без даты';
  const [y, m, d] = w.date.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const diff = Math.round((dt.getTime() - today.getTime()) / 86_400_000);
  const day = diff === 0 ? 'сегодня' : diff === 1 ? 'завтра'
    : dt.toLocaleDateString('ru-RU', { weekday: 'short', day: 'numeric', month: 'long' });
  return w.time ? `${day} · ${w.time}` : day;
}
