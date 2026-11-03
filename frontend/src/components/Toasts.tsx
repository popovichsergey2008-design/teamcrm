import { useEffect, useRef, useState } from 'react';
import { Icon } from './Icon';
import { TOAST_EVENT, ToastPayload } from '../lib/notifications';

interface Toast extends ToastPayload { id: number }
// #4710: на секунду дольше — заказчик не успевал прочитать
const LIFETIME_MS = 7000;
const SAVED_LIFETIME_MS = 2500;
/** Убрали мышь с всплывашки, которую читали, — ещё столько, чтобы дочитать. */
const AFTER_HOVER_MS = 3000;
const MAX_VISIBLE = 3;
const MAX_MISSED = 20;

/**
 * Всплывающие уведомления о новых сообщениях.
 *
 * Раньше о сообщении сообщал только счётчик в шапке и системное уведомление
 * браузера — а его разрешение обычно не выдают, и человек не узнавал ни о чём.
 * Это видно всегда: клик открывает чат с сообщением.
 *
 * #4710: исчезнувшее не пропадает — оно уходит в «Пропущенные» (строка внизу справа),
 * оттуда его можно открыть. Пока мышь на всплывашке, она не гаснет.
 */
export function Toasts({ onOpenChat, onOpenFeed, onOpenFocus, onOpenMeetings, onOpenSupport, onOpenInbox }: {
  onOpenChat: (chatId?: string, threadId?: string) => void;
  onOpenFeed?: () => void;
  onOpenFocus?: () => void;
  onOpenMeetings?: () => void;
  /** Служба заботы: щелчок открывает разговор — в консоли это единственный вид новостей. */
  onOpenSupport?: (conversationId?: string) => void;
  /** Ящик уведомлений оболочки: перейти по пути и отметить прочитанным. */
  onOpenInbox?: (id?: string, path?: string) => void;
}) {
  const [items, setItems] = useState<Toast[]>([]);
  const [missed, setMissed] = useState<Toast[]>([]);
  const [missedOpen, setMissedOpen] = useState(false);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  /** Погасла сама — не прочитана: новость уходит в «Пропущенные», «Сохранено» — просто исчезает. */
  const expire = (t: Toast) => {
    timers.current.delete(t.id);
    setItems((prev) => prev.filter((x) => x.id !== t.id));
    if (t.kind !== 'saved') setMissed((prev) => [t, ...prev.filter((x) => x.id !== t.id)].slice(0, MAX_MISSED));
  };
  const arm = (t: Toast, ms: number) => {
    clearTimeout(timers.current.get(t.id));
    timers.current.set(t.id, setTimeout(() => expire(t), ms));
  };
  const drop = (id: number) => {
    clearTimeout(timers.current.get(id));
    timers.current.delete(id);
    setItems((prev) => prev.filter((x) => x.id !== id));
    setMissed((prev) => prev.filter((x) => x.id !== id));
  };

  useEffect(() => {
    let seq = 0;
    const all = timers.current;
    const onToast = (e: Event) => {
      const detail = (e as CustomEvent<ToastPayload>).detail;
      if (!detail) return;
      const item: Toast = { ...detail, id: ++seq };
      // копить бесконечно нельзя: при активной переписке экран заполнится целиком;
      // вытесненная — тоже не прочитана, ей место в «Пропущенных»
      setItems((prev) => {
        const next = [...prev, item];
        for (const old of next.slice(0, -MAX_VISIBLE)) { clearTimeout(all.get(old.id)); queueMicrotask(() => expire(old)); }
        return next.slice(-MAX_VISIBLE);
      });
      // «Сохранено» гаснет быстрее: это ответ на действие, а не новость, ради
      // которой стоит держать место на экране.
      arm(item, item.kind === 'saved' ? SAVED_LIFETIME_MS : LIFETIME_MS);
    };
    window.addEventListener(TOAST_EVENT, onToast);
    return () => {
      window.removeEventListener(TOAST_EVENT, onToast);
      for (const t of all.values()) clearTimeout(t);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const open = (t: Toast) => {
    drop(t.id);
    // «Сохранено» никуда не ведёт: щелчок просто убирает её с глаз.
    if (t.kind === 'saved') return;
    if (t.section === 'feed') onOpenFeed?.();
    else if (t.section === 'focus') onOpenFocus?.();
    else if (t.section === 'meetings') onOpenMeetings?.();
    else if (t.section === 'support') onOpenSupport?.(t.conversationId);
    else if (t.section === 'inbox') onOpenInbox?.(t.inboxId, t.inboxPath);
    else onOpenChat(t.chatId, t.threadId);
    if (missed.length <= 1) setMissedOpen(false);
  };

  const card = (t: Toast, live: boolean) => (
    <button
      key={t.id}
      className={`toast${t.kind === 'saved' ? ' toast-saved' : ''}`}
      onClick={() => open(t)}
      // читают — не гасим; ушли — даём дочитать
      onMouseEnter={live ? () => clearTimeout(timers.current.get(t.id)) : undefined}
      onMouseLeave={live ? () => arm(t, t.kind === 'saved' ? SAVED_LIFETIME_MS : AFTER_HOVER_MS) : undefined}
      title={t.kind === 'saved' ? 'Скрыть'
        : t.section === 'feed' ? 'Открыть ленту'
        : t.section === 'focus' ? 'Открыть фокус дня'
          : t.section === 'meetings' ? 'Открыть встречи'
            : t.section === 'support' ? 'Открыть обращение'
              : t.section === 'inbox' ? 'Открыть'
                : 'Открыть сообщение'}
    >
      <Icon
        name={t.kind === 'saved' ? 'check' : t.section === 'support' ? 'support' : t.section === 'chat' || !t.section ? 'chat' : 'bell'}
        size={16}
      />
      <span className="toast-text">
        <span className="toast-title">{t.title}</span>
        <span className="toast-body">{t.body}</span>
      </span>
      <span
        className="toast-close"
        role="button"
        aria-label="Скрыть"
        onClick={(e) => { e.stopPropagation(); drop(t.id); }}
      >
        <Icon name="close" size={13} />
      </span>
    </button>
  );

  if (!items.length && !missed.length) return null;
  return (
    <div className="toasts" style={missedOpen ? { maxHeight: 'calc(100vh - 32px)', overflowY: 'auto' } : undefined}>
      {missedOpen && missed.map((t) => card(t, false))}
      {missed.length > 0 && (
        <button className="toast" onClick={() => setMissedOpen((v) => !v)} aria-expanded={missedOpen} title={missedOpen ? 'Свернуть' : 'Показать, что пришло, пока вас не было'}>
          <Icon name="bell" size={16} />
          <span className="toast-text">
            <span className="toast-title">Пропущенные уведомления · {missed.length}</span>
            <span className="toast-body">{missedOpen ? 'Свернуть' : 'Нажмите, чтобы посмотреть'}</span>
          </span>
          <span
            className="toast-close"
            role="button"
            aria-label="Очистить пропущенные"
            title="Очистить"
            onClick={(e) => { e.stopPropagation(); setMissed([]); setMissedOpen(false); }}
          >
            <Icon name="close" size={13} />
          </span>
        </button>
      )}
      {items.map((t) => card(t, true))}
    </div>
  );
}
