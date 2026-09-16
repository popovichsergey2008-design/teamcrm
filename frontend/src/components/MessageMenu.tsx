import { useEffect } from 'react';
import { Icon, IconName } from './Icon';
import { placePopover } from '../lib/popover';

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
 * Высота считается по числу пунктов: меню должно раскрываться вверх, когда снизу
 * места нет, — иначе у нижних сообщений оно уезжает за край ленты.
 */
export function MessageMenu({ at, reactions, onReact, items, onClose }: {
  at: MenuAt;
  /** Быстрые реакции строкой сверху. Пустой список — строки не будет. */
  reactions?: string[];
  onReact?: (emoji: string) => void;
  items: MsgMenuItem[];
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    // Прокрутили ленту — меню осталось бы висеть в воздухе над чужой репликой.
    const away = () => onClose();
    window.addEventListener('keydown', onKey);
    window.addEventListener('scroll', away, true);
    window.addEventListener('resize', away);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', away, true);
      window.removeEventListener('resize', away);
    };
  }, [onClose]);

  const height = items.length * 34 + (reactions?.length ? 46 : 0) + 12;
  const place = placePopover({ left: at.x, top: at.y, bottom: at.y }, height, window.innerWidth, 232);

  return (
    <>
      {/* Подложка ловит щелчок мимо меню и закрывает его — как в любом контекстном меню. */}
      <span
        className="msg-ctx-veil"
        onClick={onClose}
        onContextMenu={(e) => { e.preventDefault(); onClose(); }}
      />
      <span
        className="msg-ctx"
        role="menu"
        style={{ left: place.x, top: place.y, transform: place.up ? 'translateY(-100%)' : undefined }}
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

/**
 * Долгое нажатие — правая кнопка для пальца.
 *
 * Полсекунды: меньше — меню выскакивает при обычной прокрутке, больше — человек
 * успевает решить, что не работает. Сдвинул палец — значит листает, а не зовёт меню.
 */
export function longPressProps(open: (at: MenuAt) => void) {
  let timer: number | null = null;
  let start: { x: number; y: number } | null = null;
  const stop = () => { if (timer) window.clearTimeout(timer); timer = null; start = null; };
  return {
    onTouchStart: (e: React.TouchEvent) => {
      const t = e.touches[0];
      if (!t) return;
      start = { x: t.clientX, y: t.clientY };
      timer = window.setTimeout(() => { open({ x: start!.x, y: start!.y }); stop(); }, 500);
    },
    onTouchMove: (e: React.TouchEvent) => {
      const t = e.touches[0];
      if (!t || !start) return;
      if (Math.abs(t.clientX - start.x) > 10 || Math.abs(t.clientY - start.y) > 10) stop();
    },
    onTouchEnd: stop,
    onTouchCancel: stop,
  };
}
