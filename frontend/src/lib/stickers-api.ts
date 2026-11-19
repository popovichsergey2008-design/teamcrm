import { request } from './api';

/** Стикеры-напоминалки (#4997): листок с одной мыслью — текст, дата, время, цвет. Личные. */
export type StickerColor = 'yellow' | 'pink' | 'green' | 'blue' | 'lilac';
export const STICKER_COLORS: StickerColor[] = ['yellow', 'pink', 'green', 'blue', 'lilac'];

export interface Sticker {
  id: string; text: string; body: string | null; date: string | null; time: string | null; color: StickerColor;
  source: string; sourceRef: { chatId?: string; messageId?: string; title?: string } | null;
  doneAt: string | null; deletedAt: string | null; taskId: string | null; eventId: string | null;
  position: number; createdAt: string;
  /** Напоминание ушло, а стикер не закрыт — красная точка (шаг 6.1). */
  reminded?: boolean;
}
export interface StickerBoard { items: Sticker[]; today: string; colors: { key: StickerColor; name: string }[] }

export const stickersApi = {
  board: () => request<StickerBoard>('GET', '/stickers'),
  archive: (kind: 'done' | 'trash') => request<Sticker[]>('GET', `/stickers/archive?kind=${kind}`),
  day: (date?: string) => request<{ date: string; items: Sticker[]; overdue: Sticker[] }>('GET', `/stickers/day${date ? `?date=${date}` : ''}`),
  parse: (text: string) => request<{ date: string | null; time: string | null; label: string; color: StickerColor }>('POST', '/stickers/parse', { text }),
  create: (p: { text: string; date?: string | null; time?: string | null; color?: StickerColor; source?: string; sourceRef?: Record<string, unknown>; fallback?: 'today' | 'none' }) =>
    request<Sticker>('POST', '/stickers', p),
  update: (id: string, p: { text?: string; date?: string | null; time?: string | null; color?: StickerColor; position?: number; taskId?: string | null; eventId?: string | null }) =>
    request<Sticker>('PATCH', `/stickers/${id}`, p),
  mark: (ids: string[], action: 'done' | 'undone' | 'delete' | 'restore') =>
    request<{ changed: number }>('POST', '/stickers/mark', { ids, action }),
  snooze: (id: string, minutes: number) => request<{ snoozed: number }>('POST', `/stickers/${id}/snooze`, { minutes }),
  overdueToToday: () => request<{ moved: number }>('POST', '/stickers/overdue-to-today', {}),
  colors: (names: Record<string, string>) => request<{ key: StickerColor; name: string }[]>('PUT', '/stickers/colors', { names }),
};

/** Событие «открыть быстрый стикер» — с любой страницы (кнопка в меню, Alt+N, меню сообщения). */
export const STICKER_NEW = 'qevo:sticker-new';
export function openQuickSticker(prefill?: { text?: string; sourceRef?: Record<string, unknown>; source?: string }): void {
  window.dispatchEvent(new CustomEvent(STICKER_NEW, { detail: prefill ?? {} }));
}
/** Доска и блоки стикеров перечитывают себя, когда стикер создан или изменён где-то ещё. */
export const STICKERS_CHANGED = 'qevo:stickers-changed';
export const stickersChanged = () => window.dispatchEvent(new Event(STICKERS_CHANGED));

// ── даты ───────────────────────────────────────────────────────────────────────

const pad = (n: number) => String(n).padStart(2, '0');
export const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const parseYmd = (s: string) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
export const addDays = (s: string, n: number) => { const d = parseYmd(s); d.setDate(d.getDate() + n); return ymd(d); };
/** Ближайший такой день недели после сегодня (1 — пн … 5 — пт). */
export function nextWeekday(today: string, dow: number): string {
  const d = parseYmd(today);
  const shift = ((dow - d.getDay() + 7) % 7) || 7;
  d.setDate(d.getDate() + shift);
  return ymd(d);
}
const WD = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
export const weekdayShort = (s: string) => WD[parseYmd(s).getDay()];
/** «пт, 20 ноября». */
export const dayLabel = (s: string) => parseYmd(s).toLocaleDateString('ru-RU', { weekday: 'short', day: 'numeric', month: 'long' });
/** «20 ноября». */
export const dayMonth = (s: string) => parseYmd(s).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });

/*
  «Сделать задачей» (пункт 7.1): окно постановки задачи общее, задачу создаёт оно. Запоминаем,
  из какого стикера пришли, — когда задача создана, стикер становится «Готово» со ссылкой на неё.
*/
let pendingSticker: string | null = null;
export const setPendingStickerTask = (id: string | null) => { pendingSticker = id; };
export async function stickerTaskCreated(taskId: string): Promise<void> {
  const id = pendingSticker;
  pendingSticker = null;
  if (!id) return;
  await stickersApi.update(id, { taskId }).catch(() => undefined);
  await stickersApi.mark([id], 'done').catch(() => undefined);
  stickersChanged();
}

/** QEVO Bot — панелью справа, поверх текущей страницы, без перехода (шаг 0.3). */
export const BOT_PANEL_OPEN = 'qevo:bot-panel';
export const openBotPanel = () => window.dispatchEvent(new Event(BOT_PANEL_OPEN));
