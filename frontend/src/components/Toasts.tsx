import { useEffect, useState } from 'react';
import { Icon } from './Icon';
import { TOAST_EVENT, ToastPayload } from '../lib/notifications';

interface Toast extends ToastPayload { id: number }
const LIFETIME_MS = 6000;
const MAX_VISIBLE = 3;

/**
 * Всплывающие уведомления о новых сообщениях.
 *
 * Раньше о сообщении сообщал только счётчик в шапке и системное уведомление
 * браузера — а его разрешение обычно не выдают, и человек не узнавал ни о чём.
 * Это видно всегда: клик открывает чаты.
 */
export function Toasts({ onOpenChat, onOpenFeed, onOpenFocus }: {
  onOpenChat: (chatId?: string) => void;
  onOpenFeed?: () => void;
  onOpenFocus?: () => void;
}) {
  const [items, setItems] = useState<Toast[]>([]);

  useEffect(() => {
    let seq = 0;
    const onToast = (e: Event) => {
      const detail = (e as CustomEvent<ToastPayload>).detail;
      if (!detail) return;
      const item: Toast = { ...detail, id: ++seq };
      // копить бесконечно нельзя: при активной переписке экран заполнится целиком
      setItems((prev) => [...prev, item].slice(-MAX_VISIBLE));
      setTimeout(() => setItems((prev) => prev.filter((t) => t.id !== item.id)), LIFETIME_MS);
    };
    window.addEventListener(TOAST_EVENT, onToast);
    return () => window.removeEventListener(TOAST_EVENT, onToast);
  }, []);

  if (!items.length) return null;
  return (
    <div className="toasts">
      {items.map((t) => (
        <button
          key={t.id}
          className="toast"
          onClick={() => {
            if (t.section === 'feed') onOpenFeed?.();
            else if (t.section === 'focus') onOpenFocus?.();
            else onOpenChat(t.chatId);
            setItems((prev) => prev.filter((x) => x.id !== t.id));
          }}
          title={t.section === 'feed' ? 'Открыть ленту' : t.section === 'focus' ? 'Открыть фокус дня' : 'Открыть чаты'}
        >
          <Icon name={t.section === 'chat' || !t.section ? 'chat' : 'bell'} size={16} />
          <span className="toast-text">
            <span className="toast-title">{t.title}</span>
            <span className="toast-body">{t.body}</span>
          </span>
          <span
            className="toast-close"
            role="button"
            aria-label="Скрыть"
            onClick={(e) => { e.stopPropagation(); setItems((prev) => prev.filter((x) => x.id !== t.id)); }}
          >
            <Icon name="close" size={13} />
          </span>
        </button>
      ))}
    </div>
  );
}
