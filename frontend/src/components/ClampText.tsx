import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import './clamp-text.css';

/**
 * Текст в несколько строк с «Ещё» / «Свернуть» (#4670).
 *
 * Задачу, которую поставил агент, на телефоне нельзя было дочитать: описание
 * обрезалось на третьей-четвёртой строке многоточием, и открыть его целиком было
 * нечем. Теперь под обрезанным текстом — «Ещё». Кнопка появляется, только если
 * текст и правда не влез: короткому описанию лишняя ссылка ни к чему.
 */
export function ClampText({ children, lines = 4, className = '' }: {
  children: ReactNode;
  lines?: number;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [cut, setCut] = useState(false);

  // Обрезан ли текст — меряем в свёрнутом виде, и заново при смене ширины (поворот экрана).
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || open) return;
    const measure = () => setCut(el.scrollHeight > el.clientHeight + 1);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [open, children, lines]);

  return (
    <>
      <div
        ref={ref}
        className={`${className} clamp-text${open ? '' : ' is-clamped'}`}
        style={open ? undefined : { WebkitLineClamp: lines }}
      >
        {children}
      </div>
      {(cut || open) && (
        <button
          type="button"
          className="link-btn clamp-text-more"
          aria-expanded={open}
          onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
        >
          {open ? 'Свернуть' : 'Ещё'}
        </button>
      )}
    </>
  );
}
