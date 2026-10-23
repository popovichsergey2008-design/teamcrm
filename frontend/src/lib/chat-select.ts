/**
 * Выделение нескольких сообщений в чате (#4640, «как в Telegram»).
 *
 * Чистые функции, без React: порядок, права и текст для буфера — ровно то, что
 * ошибается молча (переслали вразнобой, удалили чужое, скопировали без автора).
 * Проверки — в scripts/logic-check.mjs.
 */
export interface SelMsg {
  id: string | number;
  created_at: string;
  author_id?: string | number | null;
  author_name?: string | null;
  guest_name?: string | null;
  is_ai?: boolean | null;
  body?: string | null;
  file_name?: string | null;
  files?: { name?: string | null }[] | null;
  forwarded_author?: string | null;
}

/** Щелчок по сообщению: было — снять, не было — добавить. Пустой выбор — выход из режима (null). */
export function toggleSel(sel: string[] | null, id: string): string[] | null {
  const cur = sel ?? [];
  const next = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id];
  return next.length ? next : null;
}

/** Shift+щелчок: всё от прошлого щелчка до этого — в порядке ленты, к уже выбранному. */
export function rangeSel(sel: string[] | null, feed: string[], anchor: string | null, id: string): string[] | null {
  const a = anchor ? feed.indexOf(anchor) : -1;
  const b = feed.indexOf(id);
  if (a < 0 || b < 0) return toggleSel(sel, id);
  const span = feed.slice(Math.min(a, b), Math.max(a, b) + 1);
  return [...new Set([...(sel ?? []), ...span])];
}

/** Выбранные — в порядке времени, а не щелчков: так их и пересылают, и копируют. */
export function orderedSel<T extends SelMsg>(messages: T[], sel: string[]): T[] {
  const ids = new Set(sel);
  return messages
    .filter((m) => ids.has(String(m.id)))
    .sort((x, y) => (Date.parse(x.created_at) - Date.parse(y.created_at)) || (Number(x.id) - Number(y.id)));
}
