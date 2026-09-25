import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { Icon } from './Icon';
import { QUICK_REACTIONS } from '../lib/emoji';
import { focusPaletteSearch, hidePalette, showPalette } from '../lib/emoji-palette';
import { placePopover } from '../lib/popover';
import { PHONE_MAX_PX } from '../hooks/useMediaQuery';

/**
 * Палитра эмодзи: полный набор Unicode (просьба заказчика — «как в Slack, чтобы был
 * полный комплект»).
 *
 * Сами знаки рисует готовая библиотека emoji-mart, и живёт эта палитра НЕ здесь:
 * она одна на весь сеанс и лежит в `lib/emoji-palette` (почему так — там же). Этот
 * компонент отвечает за три вещи: посчитать, куда её поставить, закрыть по щелчку
 * мимо и по Escape, и показать запасной ряд, если набор не догрузился.
 */
export function EmojiPicker({ at, onPick, onClose }: {
  /** Откуда открыли: координаты на экране (как у меню сообщения). */
  at: { x: number; y: number };
  onPick: (emoji: string) => void;
  onClose: () => void;
}) {
  const [failed, setFailed] = useState(false);

  /*
    Обработчики приходят новыми на каждую перерисовку родителя (набор текста в поле
    ввода перерисовывает всю страницу чатов). Если положить их в зависимости эффекта,
    палитра будет открываться заново на каждую букву и терять введённый поиск, поэтому
    храним их в ссылке, а эффект запускаем ровно один раз.
  */
  const handlers = useRef({ onPick, onClose });
  handlers.current = { onPick, onClose };

  /*
    Размер палитры постоянный: всплывашка, меняющая высоту по ходу поиска, читается
    как поломка. Но на телефоне окно уже палитры, поэтому размер ещё и ужимается по
    экрану — иначе правый край уезжает за пределы видимого.
  */
  const width = Math.min(352, window.innerWidth - 16);
  const height = Math.min(420, window.innerHeight - 16);
  const place = placePopover({ left: at.x, top: at.y, bottom: at.y }, height, window.innerWidth, width, window.innerHeight);
  const spot = useRef({ ...place, width, height });
  spot.current = { ...place, width, height };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') handlers.current.onClose(); };
    /*
      Слушаем на перехвате: поле поиска внутри палитры само обрабатывает Escape
      (очищает запрос) и дальше событие не пускает. Без перехвата палитра переставала
      закрываться с клавиатуры — а курсор в этом поле стоит сразу после открытия.
    */
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  useEffect(() => {
    let dead = false;
    const { x, y, up, width: w, height: h } = spot.current;

    void showPalette({ x, y, up, width: w, height: h }, (emoji) => {
      handlers.current.onPick(emoji);
      handlers.current.onClose();
    }).then((ok) => {
      if (dead) return;
      if (!ok) { setFailed(true); return; }
      /*
        Курсор в поиск — СЛЕДУЮЩИМ кадром и только на большом экране: установка курсора
        заставляет браузер пересчитать раскладку всей страницы, и палитра ровно на
        столько позже появляется. Сначала показываем, потом ставим курсор.

        На телефоне не ставим вовсе: там курсор поднимает клавиатуру, а она закрывает
        половину палитры — её открыли, чтобы выбрать знак глазами.
      */
      if (window.innerWidth > PHONE_MAX_PX) requestAnimationFrame(focusPaletteSearch);
    });

    return () => { dead = true; hidePalette(); };
  }, []);

  return (
    <>
      <span className="msg-ctx-veil" onClick={onClose} onContextMenu={(e) => { e.preventDefault(); onClose(); }} />
      {failed && (
        <div
          className="emoji-pop"
          role="dialog"
          aria-label="Выбор эмодзи"
          style={{
            left: place.x,
            top: place.y,
            transform: place.up ? 'translateY(-100%)' : undefined,
          } as CSSProperties}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="emoji-fallback">
            <div className="dim emoji-empty">
              <Icon name="alert" size={14} /> Полный набор не загрузился — вот частые:
            </div>
            <div className="emoji-grid">
              {QUICK_REACTIONS.map((e) => (
                <button key={e} className="emoji-btn" onClick={() => { onPick(e); onClose(); }}>
                  {e}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
