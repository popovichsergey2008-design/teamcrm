/**
 * Заглушки на время загрузки.
 *
 * Вместо надписи «Загружаю…»: она сообщает о процессе, но экран остаётся пустым,
 * и переход к данным выглядит рывком. Серые блоки в форме будущего содержимого
 * показывают, что именно грузится, и смена на реальные данные не дёргает вёрстку.
 */

/** Строки списка — для лент задач, встреч, чатов. */
export function SkeletonList({ rows = 4 }: { rows?: number }) {
  return (
    <div className="skeleton-list" aria-hidden="true">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="skeleton-row">
          <span className="skeleton-bar" style={{ width: `${55 + ((i * 13) % 30)}%` }} />
          <span className="skeleton-bar skeleton-bar-sm" style={{ width: `${20 + ((i * 7) % 15)}%` }} />
        </div>
      ))}
    </div>
  );
}

/** Прямоугольник произвольной высоты — для карточек и панелей. */
export function SkeletonBlock({ height = 80 }: { height?: number }) {
  return <div className="skeleton-block" style={{ height }} aria-hidden="true" />;
}

/** Колонки канбана: доска грузится колонками, и заглушка должна быть той же формы. */
export function SkeletonBoard({ columns = 3 }: { columns?: number }) {
  return (
    <div className="board-columns" aria-hidden="true">
      {Array.from({ length: columns }, (_, c) => (
        <div key={c} className="column skeleton-column">
          <span className="skeleton-bar" style={{ width: '45%', margin: '12px' }} />
          <div className="skeleton-cards">
            {Array.from({ length: 3 - (c % 2) }, (_, i) => <SkeletonBlock key={i} height={56 + ((i * 11) % 24)} />)}
          </div>
        </div>
      ))}
    </div>
  );
}
