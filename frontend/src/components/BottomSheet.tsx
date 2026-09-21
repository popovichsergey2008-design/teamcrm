import { ReactNode } from 'react';
import { useEscape } from '../hooks/useEscape';
import { overlayProps } from '../lib/overlay';

/**
 * Нижний лист (ТЗ-9, волна 5): быстрые действия на телефоне.
 *
 * Меню на компьютере выпадает у курсора; на телефоне курсора нет, а большой палец
 * внизу. Лист выезжает снизу, действия — крупными строками, закрывается щелчком мимо,
 * свайпом не заморачиваемся: Esc и подложка покрывают всё. На широком экране тот же
 * лист стоит по центру как обычное окно — одна разметка на обе раскладки.
 */
export function BottomSheet({ title, onClose, children }: { title?: string; onClose: () => void; children: ReactNode }) {
  useEscape(onClose);
  return (
    <div className="sheet-overlay" {...overlayProps(onClose)}>
      <div className="sheet" role="dialog" aria-modal="true" aria-label={title ?? 'Действия'} onClick={(e) => e.stopPropagation()}>
        <span className="sheet-grip" aria-hidden="true" />
        {title && <div className="sheet-title">{title}</div>}
        {children}
      </div>
    </div>
  );
}

/** Строка действия в листе: значок, подпись, крупная цель под палец. */
export function SheetAction({ icon, label, hint, danger, onClick }: {
  icon?: ReactNode; label: string; hint?: string; danger?: boolean; onClick: () => void;
}) {
  return (
    <button className={`sheet-action${danger ? ' sheet-danger' : ''}`} onClick={onClick}>
      {icon && <span className="sheet-action-icon">{icon}</span>}
      <span className="sheet-action-text">
        <span>{label}</span>
        {hint && <span className="dim sheet-action-hint">{hint}</span>}
      </span>
    </button>
  );
}