import { api } from './api';

/**
 * Избранное (#4713): проекты и задачи, к которым человек возвращается каждый день.
 *
 * Хранится в личных настройках (ui_prefs.favorites) — на сервере, а не в браузере:
 * открыл CRM на другом компьютере или в приложении — избранное то же. Название
 * запоминаем вместе с номером, чтобы список в сайдбаре рисовался без запросов;
 * переименовали — обновится при следующем открытии карточки.
 */
export interface Favorite { kind: 'project' | 'task'; id: string; title: string; projectId?: string }

export const FAVORITES_CHANGED = 'qevo:favorites';
/** Больше не держим: избранное — короткий список, а не второй реестр. */
const MAX = 40;

let list: Favorite[] = [];
let loaded = false;

const same = (a: Favorite, kind: Favorite['kind'], id: string) => a.kind === kind && String(a.id) === String(id);

/** Первое значение — из настроек, пришедших со входом. */
export function initFavorites(prefs: unknown): void {
  if (loaded) return;
  const raw = (prefs as { favorites?: unknown } | null)?.favorites;
  list = Array.isArray(raw) ? (raw as Favorite[]).filter((f) => f && (f.kind === 'project' || f.kind === 'task') && f.id).slice(0, MAX) : [];
  loaded = true;
}

export const favorites = (): Favorite[] => list;
export const isFavorite = (kind: Favorite['kind'], id: string): boolean => list.some((f) => same(f, kind, id));

function save(next: Favorite[]) {
  list = next;
  window.dispatchEvent(new Event(FAVORITES_CHANGED));
  // только свой ключ: остальные настройки пишут другие места (меню, Chat Bar, обучение)
  void api.saveUiPrefs({ favorites: next }).catch(() => undefined);
}

export function toggleFavorite(f: Favorite): boolean {
  if (isFavorite(f.kind, f.id)) { save(list.filter((x) => !same(x, f.kind, f.id))); return false; }
  save([{ ...f, id: String(f.id), title: f.title.slice(0, 120) }, ...list].slice(0, MAX));
  return true;
}

/** Название поменялось (открыли карточку) — поправить подпись в списке, если она в избранном. */
export function touchFavorite(kind: Favorite['kind'], id: string, title: string): void {
  const f = list.find((x) => same(x, kind, id));
  if (f && title && f.title !== title) save(list.map((x) => (same(x, kind, id) ? { ...x, title: title.slice(0, 120) } : x)));
}
