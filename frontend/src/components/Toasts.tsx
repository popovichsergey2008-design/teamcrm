import { useEffect, useState } from 'react';
import { Icon } from './Icon';
import { TOAST_EVENT, ToastPayload } from '../lib/notifications';

interface Toast extends ToastPayload { id: number }
const LIFETIME_MS = 6000;
const SAVED_LIFETIME_MS = 2500;
const MAX_VISIBLE = 3;

/**
 * Всплывающие уведомления о новых сообщениях.
 *
 * Раньше о сообщении сообщал только счётчик в шапке и системное уведомление
 * браузера — а его разрешение обычно не выдают, и человек не узнавал ни о чём.
 * Это видно всегда: клик открывает чаты.
 */
export function Toasts({ onOpenChat, onOpenFeed, onOpenFocus, onOpenMeetings, onOpenSupport, onOpenInbox, onOpenUpdate }: {
  onOpenChat: (chatId?: string) => void;
  onOpenFeed?: () => void;
  onOpenFocus?: () => void;
  onOpenMeetings?: () => void;
  /** Служба заботы: щелчок открывает разговор — в консоли это единственный вид новостей. */
  onOpenSupport?: (conversationId?: string) => void;
  /** Ящик уведомлений оболочки: перейти по пути и отметить прочитанным. */
  onOpenInbox?: (id?: string, path?: string) => void;
  /** Доступно обновление приложения: скачать. */
  onOpenUpdate?: () => void;
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
      // «Сохранено» гаснет быстрее: это ответ на действие, а не новость, ради
      // которой стоит держать место на экране шесть секунд.
      const life = item.kind === 'saved' ? SAVED_LIFETIME_MS : LIFETIME_MS;
      setTimeout(() => setItems((prev) => prev.filter((t) => t.id !== item.id)), life);
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
          className={`toast${t.kind === 'saved' ? ' toast-saved' : ''}`}
          onClick={() => {
            // «Сохранено» никуда не ведёт: щелчок просто убирает её с глаз.
            if (t.kind === 'saved') { setItems((prev) => prev.filter((x) => x.id !== t.id)); return; }
            if (t.section === 'feed') onOpenFeed?.();
            else if (t.section === 'focus') onOpenFocus?.();
            else if (t.section === 'meetings') onOpenMeetings?.();
            else if (t.section === 'support') onOpenSupport?.(t.conversationId);
            else if (t.section === 'inbox') onOpenInbox?.(t.inboxId, t.inboxPath);
            else if (t.section === 'update') onOpenUpdate?.();
            else onOpenChat(t.chatId);
            setItems((prev) => prev.filter((x) => x.id !== t.id));
          }}
          title={t.kind === 'saved' ? 'Скрыть'
            : t.section === 'feed' ? 'Открыть ленту'
            : t.section === 'focus' ? 'Открыть фокус дня'
              : t.section === 'meetings' ? 'Открыть встречи'
                : t.section === 'support' ? 'Открыть обращение'
                  : t.section === 'inbox' ? 'Открыть'
                    : t.section === 'update' ? 'Скачать обновление' : 'Открыть чаты'}
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
            onClick={(e) => { e.stopPropagation(); setItems((prev) => prev.filter((x) => x.id !== t.id)); }}
          >
            <Icon name="close" size={13} />
          </span>
        </button>
      ))}
    </div>
  );
}
