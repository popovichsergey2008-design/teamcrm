/*
  Догрузка переписки после обрыва связи (#4634) — чистая логика без React и сети,
  чтобы её можно было проверить в `npm run check`.
*/

interface Msg { id: string | number; created_at: string }

/**
 * Свежий хвост ленты поверх того, что уже на экране, — без дублей и без дыр.
 *
 * Хвост с сервера главнее: в нём учтены правки и удаления, пропущенные за обрыв.
 * Старше его начала оставляем подгруженное прокруткой вверх. Новее его конца —
 * то, что успело прийти по сокету, пока ходили за хвостом. Если с экраном хвост
 * не пересёкся (пропущено больше страницы), берём только хвост: склейка дала бы
 * ленту с дырой посередине.
 */
export function mergeTail<T extends Msg>(prev: T[], fresh: T[]): T[] {
  if (!fresh.length || !prev.length) return fresh.length ? fresh : prev;
  const ids = new Set(fresh.map((m) => String(m.id)));
  const t = (m: T) => new Date(m.created_at).getTime();
  const first = t(fresh[0]);
  const last = t(fresh[fresh.length - 1]);
  const overlap = prev.some((m) => ids.has(String(m.id)) || t(m) >= first);
  const older = overlap ? prev.filter((m) => t(m) < first && !ids.has(String(m.id))) : [];
  const newer = prev.filter((m) => t(m) > last && !ids.has(String(m.id)));
  return [...older, ...fresh, ...newer];
}
