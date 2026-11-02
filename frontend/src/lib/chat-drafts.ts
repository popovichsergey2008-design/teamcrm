/**
 * Черновики переписки — локально и по чатам (ТЗ-9, волна 6).
 *
 * Правило пакета: текст сообщения не теряется при уходе в фон, закрытии окна и
 * потере сети. Раньше один общий черновик жил в памяти страницы: переключился на
 * другой чат — унёс текст с собой, перезагрузил — потерял. Теперь черновик свой у
 * каждого чата и лежит в localStorage; отправил — стёрся.
 *
 * Ключ чата — строка: `chat:12`, `task:1315`, `thread:88`. Держим не больше
 * пятидесяти: чаты, в которые не пишут месяцами, черновиков не заслуживают.
 */
const KEY = 'teamcrm.chat-drafts';
const MAX = 50;

type Store = Pick<Storage, 'getItem' | 'setItem'>;

function readAll(storage: Store): Record<string, string> {
  try {
    const raw = storage.getItem(KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch { return {}; }
}

/** Черновики поменялись — раздел «Черновики» в сайдбаре (#4715) перечитывает список. */
export const CHAT_DRAFT_CHANGED = 'teamcrm:chat-draft';

function writeAll(storage: Store, map: Record<string, string>): void {
  try { storage.setItem(KEY, JSON.stringify(map)); } catch { /* приватный режим — черновик проживёт до перезагрузки */ }
  try { window.dispatchEvent(new Event(CHAT_DRAFT_CHANGED)); } catch { /* вне браузера (тесты) */ }
}

/** Все черновики переписки, свежие первыми: ключ (`chat:12`, `task:1315`, `thread:88`) и текст. */
export function listChatDrafts(storage: Store = localStorage): { key: string; text: string }[] {
  return Object.entries(readAll(storage)).reverse().map(([key, text]) => ({ key, text }));
}

export function readDraft(key: string, storage: Store = localStorage): string {
  return readAll(storage)[key] ?? '';
}

export function writeDraft(key: string, text: string, storage: Store = localStorage): void {
  const map = readAll(storage);
  if (!text.trim()) { delete map[key]; writeAll(storage, map); return; }
  delete map[key]; // переставляем в конец: последний тронутый — последний в списке
  map[key] = text;
  const keys = Object.keys(map);
  for (const old of keys.slice(0, Math.max(0, keys.length - MAX))) delete map[old];
  writeAll(storage, map);
}

export function clearDraft(key: string, storage: Store = localStorage): void {
  writeDraft(key, '', storage);
}