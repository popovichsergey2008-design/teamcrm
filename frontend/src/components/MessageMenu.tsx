import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Icon, IconName } from './Icon';

/** Пункт меню сообщения. `danger` — красный: удаление ни с чем не спутаешь. */
export interface MsgMenuItem {
  label: string;
  icon: IconName;
  danger?: boolean;
  onClick: () => void;
}

/** Где открыть меню: координаты курсора (или пальца) в окне. */
export interface MenuAt { x: number; y: number }

/**
 * Меню сообщения по ПРАВОЙ КНОПКЕ — как в Telegram.
 *
 * Заказчик попросил «один в один»: никаких троеточий под каждым сообщением, меню
 * вызывается правой кнопкой и раскрывается у курсора, а сверху — строка реакций.
 * Три значка под каждой репликой занимали место каждый день ради нажатия раз в
 * неделю; меню же появляется ровно тогда, когда его позвали.
 *
 * На касании правой кнопки нет — там меню открывается долгим нажатием (см. useLongPress
 * ниже): всё, что доступно мышью, обязано быть доступно пальцем.
 *
 * Место меню считается по его НАСТОЯЩЕМУ размеру (задача #1491). Раньше высота
 * бралась «по 34 точки на пункт», а на телефоне пункт почти вдвое выше: меню у
 * сообщения в середине экрана вылезало и за верх (реакции уходили под вырез камеры),
 * и за низ. Теперь меню сначала рисуется невидимым, измеряется и встаёт в видимую
 * часть экрана с учётом выреза и системных панелей; не влезает целиком — внутри
 * появляется прокрутка, но за край оно не уходит никогда.
 */

const EDGE = 8;
const GAP = 6;

/** Отступы системных панелей и выреза камеры: CSS их знает, JS — нет. Меряем пробником. */
function safeInsets(): { top: number; bottom: number } {
  const probe = document.createElement('div');
  probe.style.cssText = 'position:fixed;visibility:hidden;pointer-events:none;padding-top:var(--safe-top,0px);padding-bottom:var(--safe-bottom,0px)';
  document.body.appendChild(probe);
  const cs = getComputedStyle(probe);
  const r = { top: parseFloat(cs.paddingTop) || 0, bottom: parseFloat(cs.paddingBottom) || 0 };
  probe.remove();
  return r;
}

interface Placed { x: number; y: number; maxH: number | null }

/**
 * Куда поставить меню размером w×h, открытое в точке (ax, ay): под точкой, если влезает,
 * иначе над ней, иначе — сдвинуть так, чтобы целиком было в видимой части.
 */
export function placeMenu(
  ax: number, ay: number, w: number, h: number,
  vw: number, vh: number, insets: { top: number; bottom: number },
): Placed {
  const minY = insets.top + EDGE;
  const maxY = vh - insets.bottom - EDGE;
  const room = maxY - minY;
  const x = Math.max(EDGE, Math.min(ax, vw - w - EDGE));
  if (h >= room) return { x, y: minY, maxH: room }; // выше экрана — прокрутка внутри
  let y = ay + GAP;                                   // под пальцем
  if (y + h > maxY) y = ay - GAP - h;                 // не влезает — над ним
  y = Math.max(minY, Math.min(y, maxY - h));          // и в любом случае — в пределах экрана
  return { x, y, maxH: null };
}
export function MessageMenu({ at, reactions, onReact, onMoreEmoji, items, onClose }: {
  at: MenuAt;
  /** Быстрые реакции строкой сверху. Пустой список — строки не будет. */
  reactions?: string[];
  onReact?: (emoji: string) => void;
  /**
   * «Ещё» — вся палитра эмодзи.
   *
   * Шесть быстрых закрывают девять случаев из десяти, но заказчик справедливо просил
   * «как в Slack»: остальное должно быть в одном нажатии, а не отсутствовать вовсе.
   */
  onMoreEmoji?: (at: MenuAt) => void;
  items: MsgMenuItem[];
  onClose: () => void;
}) {
  /*
    Первые мгновения после открытия меню «глухое» (задача #1443, вторая попытка).

    На Android долгое нажатие само рождает системное contextmenu — примерно через
    0,5–0,6 с после касания. Меню к этому моменту уже открыто нашим таймером, и событие
    приходит в подложку, которая меню закрывала: со стороны «окно моментально пропадает».
    Туда же — прокрутка: подсветка открытого сообщения может чуть сдвинуть ленту в тот же
    миг. Поэтому эхо долгого нажатия и дрожь ленты в первые 900 мс не закрывают меню;
    обычное касание мимо меню закрывает его как прежде.
  */
  const openedAt = useRef(Date.now());
  const settling = () => Date.now() - openedAt.current < 900;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    // Прокрутили ленту — меню осталось бы висеть в воздухе над чужой репликой.
    const away = () => { if (!settling()) onClose(); };
    window.addEventListener('keydown', onKey);
    window.addEventListener('scroll', away, true);
    window.addEventListener('resize', away);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', away, true);
      window.removeEventListener('resize', away);
    };
  }, [onClose]);

  // Сначала рисуем невидимым там, где позвали, меряем — и ставим так, чтобы влезло целиком.
  const box = useRef<HTMLSpanElement | null>(null);
  const [place, setPlace] = useState<Placed | null>(null);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const vv = window.visualViewport;
    const vh = vv?.height ?? window.innerHeight;
    const vw = vv?.width ?? window.innerWidth;
    setPlace(placeMenu(at.x, at.y, el.offsetWidth, el.scrollHeight, vw, vh, safeInsets()));
  }, [at.x, at.y, items.length]);

  return (
    <>
      {/* Подложка ловит щелчок мимо меню и закрывает его — как в любом контекстном меню. */}
      <span
        className="msg-ctx-veil"
        onClick={() => { if (!settling()) onClose(); }}
        onContextMenu={(e) => { e.preventDefault(); if (!settling()) onClose(); }}
      />
      <span
        ref={box}
        className="msg-ctx"
        role="menu"
        style={place
          ? { left: place.x, top: place.y, maxHeight: place.maxH ?? undefined, overflowY: place.maxH ? 'auto' : undefined }
          : { left: at.x, top: at.y, visibility: 'hidden' }}
        onClick={(e) => e.stopPropagation()}
      >
        {!!reactions?.length && onReact && (
          <span className="msg-ctx-react">
            {reactions.map((emoji) => (
              <button
                key={emoji}
                className="react-pop-btn"
                onClick={() => { onReact(emoji); onClose(); }}
                title={`Поставить ${emoji}`}
              >
                {emoji}
              </button>
            ))}
            {onMoreEmoji && (
              <button
                className="react-pop-btn react-pop-more"
                onClick={(e) => {
                  const r = e.currentTarget.getBoundingClientRect();
                  onClose();
                  onMoreEmoji({ x: r.left, y: r.bottom + 4 });
                }}
                title="Все эмодзи"
                aria-label="Все эмодзи"
              >
                <Icon name="plus" size={14} />
              </button>
            )}
          </span>
        )}
        {items.map((it) => (
          <button
            key={it.label}
            className={`msg-menu-item${it.danger ? ' msg-menu-danger' : ''}`}
            role="menuitem"
            onClick={() => { onClose(); it.onClick(); }}
          >
            <Icon name={it.icon} size={14} /> {it.label}
          </button>
        ))}
      </span>
    </>
  );
}

/*
  Состояние долгого нажатия — ОДНО на приложение, а не по сообщению.

  Обработчики пересоздаются на каждой перерисовке (их раздаёт функция, которую зовут
  прямо в разметке), а открытие меню перерисовку как раз и вызывает. Пока переменные
  жили внутри замыкания, после открытия менялись местами старый и новый набор
  обработчиков: отпускание пальца приходило уже в новый, где «мы открыли меню» не
  записано. Палец одновременно держат только один раз, так что общего состояния хватает.
*/
let pressTimer: number | null = null;
let pressStart: { x: number; y: number } | null = null;
let pressOpened = false;
/** Сообщение под пальцем: подсвечиваем сразу, не дожидаясь меню. */
let pressEl: HTMLElement | null = null;

function stopPress(): void {
  if (pressTimer) window.clearTimeout(pressTimer);
  pressTimer = null;
  pressStart = null;
  pressEl?.classList.remove('is-pressing');
  pressEl = null;
}

/** Сколько держать палец. 350 мс — как в мессенджерах: меньше путается с прокруткой. */
const PRESS_MS = 350;
/** Дрожание пальца — не прокрутка: до стольких точек сдвига меню всё ещё откроется. */
const PRESS_SLOP = 14;

/**
 * Долгое нажатие — правая кнопка для пальца.
 *
 * Задача #1443 («выделяется с долгой задержкой и не всегда»): на Android долгое нажатие
 * на текст сначала запускает СИСТЕМНОЕ выделение текста, и WebView обрывает касание
 * (touchcancel) — наш таймер гас, меню не открывалось, а иногда приходило позже через
 * системный contextmenu. Поэтому на сенсорных экранах выделение текста в пузыре
 * выключено стилем (скопировать можно пунктом меню «Копировать текст»), таймер короче,
 * а пузырь подсвечивается сразу — видно, что нажатие принято.
 * Сдвинул палец дальше допуска — значит листает, а не зовёт меню.
 */
export function longPressProps(open: (at: MenuAt) => void) {
  return {
    onTouchStart: (e: React.TouchEvent) => {
      const t = e.touches[0];
      if (!t) return;
      stopPress();
      pressOpened = false;
      pressStart = { x: t.clientX, y: t.clientY };
      pressEl = e.currentTarget as HTMLElement;
      pressEl.classList.add('is-pressing');
      pressTimer = window.setTimeout(() => {
        pressOpened = true;
        open({ x: pressStart!.x, y: pressStart!.y });
        navigator.vibrate?.(10); // лёгкий отклик, как у системного меню
        stopPress();
      }, PRESS_MS);
    },
    onTouchMove: (e: React.TouchEvent) => {
      const t = e.touches[0];
      if (!t || !pressStart) return;
      if (Math.abs(t.clientX - pressStart.x) > PRESS_SLOP || Math.abs(t.clientY - pressStart.y) > PRESS_SLOP) stopPress();
    },
    onTouchEnd: (e: React.TouchEvent) => {
      /*
        Меню уже открыто, палец подняли — гасим «призрачный» щелчок.

        После касания браузер шлёт в ту же точку обычный щелчок. Меню к этому моменту
        уже нарисовано, под пальцем оказывается его подложка — и меню закрывалось ровно
        в тот миг, когда человек его увидел. Со стороны это и выглядело как «нажатие на
        сообщение перестало работать»: окно мелькало и пропадало.
      */
      if (pressOpened) {
        e.preventDefault();
        pressOpened = false;
      }
      stopPress();
    },
    onTouchCancel: () => { pressOpened = false; stopPress(); },
  };
}
