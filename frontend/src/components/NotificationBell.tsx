import { useEffect, useRef, useState } from 'react';
import { Icon } from './Icon';
import { badgeText, openNotificationCenter } from '../lib/notification-center';

type Count = { n: number; decisions: number; tip: string };
type Pos = { x: number; y: number };

/** #4929: куда человек перетащил колокольчик — у него в браузере, чтобы место не прыгало. */
const POS_KEY = 'qevo.bell.pos';
const SIZE = 36;
const loadPos = (): Pos | null => {
  try { const p = JSON.parse(localStorage.getItem(POS_KEY) ?? 'null'); return p && Number.isFinite(p.x) && Number.isFinite(p.y) ? p : null; } catch { return null; }
};
/** В пределах окна: после поворота телефона или смены окна значок не уходит за край. */
const clamp = (p: Pos): Pos => ({
  x: Math.min(Math.max(4, p.x), Math.max(4, window.innerWidth - SIZE - 4)),
  y: Math.min(Math.max(4, p.y), Math.max(4, window.innerHeight - SIZE - 4)),
});

/**
 * Колокольчик в шапке телефона: ведёт во «Входящие» (#4807) и показывает ТО ЖЕ число,
 * что пункт «Входящие» в меню, — непрочитанное важное и решения, которые ждут вас.
 *
 * До 10.11 число бралось из старого центра уведомлений, где считались и обычные
 * сообщения чатов: в шапке горело «7», а во «Входящих» — «1». Число считает меню
 * (Sidebar) и сообщает сюда событием `qevo:inbox-count`; жёлтое — если ждут решения.
 *
 * #4929: плавающий значок можно перетащить — он закрывал кнопку отправки в чате. Короткое
 * нажатие открывает «Входящие», перетаскивание — только двигает; место запоминается.
 */
export function NotificationBell({ className }: { className: string }) {
  const [c, setC] = useState<Count | null>(() => (window as Window & { __qevoInbox?: Count }).__qevoInbox ?? null);
  const floating = className.includes('notif-bell-float');
  const [pos, setPos] = useState<Pos | null>(() => (floating ? loadPos() : null));
  const drag = useRef<{ dx: number; dy: number; sx: number; sy: number; moved: boolean } | null>(null);
  const justDragged = useRef(false);
  useEffect(() => {
    const on = (e: Event) => setC((e as CustomEvent<Count>).detail);
    window.addEventListener('qevo:inbox-count', on);
    return () => window.removeEventListener('qevo:inbox-count', on);
  }, []);
  useEffect(() => {
    if (!floating) return;
    const fit = () => setPos((p) => (p ? clamp(p) : p));
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, [floating]);
  const n = c?.n ?? 0;
  const label = n > 0 ? `Входящие: ${c?.tip || `непрочитанных ${n}`}` : 'Входящие';
  return (
    <button
      className={`notif-bell ${className}`}
      title={floating ? `${label} · можно перетащить` : label}
      aria-label={label}
      style={floating && pos ? { left: pos.x, top: pos.y, right: 'auto', bottom: 'auto', touchAction: 'none' } : floating ? { touchAction: 'none' } : undefined}
      onClick={() => { if (justDragged.current) { justDragged.current = false; return; } openNotificationCenter(); }}
      onPointerDown={floating ? (e) => {
        const r = e.currentTarget.getBoundingClientRect();
        drag.current = { dx: e.clientX - r.left, dy: e.clientY - r.top, sx: e.clientX, sy: e.clientY, moved: false };
        e.currentTarget.setPointerCapture(e.pointerId);
      } : undefined}
      onPointerMove={floating ? (e) => {
        const d = drag.current;
        if (!d) return;
        // до 6 точек — это нажатие, а не перетаскивание: дрожь пальца не двигает значок
        if (!d.moved && Math.hypot(e.clientX - d.sx, e.clientY - d.sy) < 6) return;
        d.moved = true;
        setPos(clamp({ x: e.clientX - d.dx, y: e.clientY - d.dy }));
      } : undefined}
      onPointerUp={floating ? () => {
        const d = drag.current;
        drag.current = null;
        if (!d?.moved) return;
        justDragged.current = true;
        setPos((p) => { if (p) { try { localStorage.setItem(POS_KEY, JSON.stringify(p)); } catch { /* без хранилища — до перезагрузки */ } } return p; });
      } : undefined}
      onPointerCancel={() => { drag.current = null; }}
    >
      <Icon name="bell" size={18} />
      {n > 0 && <span className={`notif-bell-badge${c?.decisions ? ' is-warn' : ''}`} aria-hidden="true">{badgeText(n)}</span>}
    </button>
  );
}
