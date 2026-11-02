import { useEffect, useState } from 'react';
import { Icon } from './Icon';
import { useAuth } from '../state/auth';
import { FAVORITES_CHANGED, initFavorites, isFavorite, toggleFavorite, touchFavorite, type Favorite } from '../lib/favorites';

/** Звёздочка «В избранное» (#4713): у карточки задачи и у проекта; список — в сайдбаре. */
export function FavoriteStar({ kind, id, title, projectId, className = 'ui-btn ui-btn-ghost ui-btn-sm' }: Favorite & { className?: string }) {
  const { user } = useAuth();
  initFavorites(user?.uiPrefs);
  const [on, setOn] = useState(() => isFavorite(kind, id));
  useEffect(() => {
    const sync = () => setOn(isFavorite(kind, id));
    sync();
    window.addEventListener(FAVORITES_CHANGED, sync);
    return () => window.removeEventListener(FAVORITES_CHANGED, sync);
  }, [kind, id]);
  // переименовали — подпись в сайдбаре догонит при открытии
  useEffect(() => { if (title) touchFavorite(kind, id, title); }, [kind, id, title]);
  const label = on ? 'Убрать из избранного' : 'В избранное';
  return (
    <button
      type="button"
      className={className}
      aria-pressed={on}
      title={label}
      aria-label={label}
      onClick={() => setOn(toggleFavorite({ kind, id: String(id), title, projectId }))}
      style={on ? { color: 'var(--warn, #c98a00)' } : undefined}
    >
      <Icon name="star" size={15} />
    </button>
  );
}
