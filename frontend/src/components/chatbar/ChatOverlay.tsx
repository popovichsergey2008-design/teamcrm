import { useEffect, useRef, useState } from 'react';
import { ChatsPage } from '../../pages/ChatsPage';
import { useEscape } from '../../hooks/useEscape';
import { TaskConversation } from '../chat/TaskConversation';

const MIN_W = 360;
const MAX_W = 900;

/**
 * Окно чата поверх CRM (ТЗ-5, этап 1).
 *
 * Слайдер справа: страница под ним остаётся — доска, карточка задачи, календарь.
 * Внутри — тот же `ChatsPage` в режиме `overlay`: лента, композер, ветка, всё, что
 * есть в разделе. Ширину можно потянуть за левый край, она запоминается на сервере
 * вместе с остальными настройками интерфейса.
 */
export function ChatOverlay({ chatId, width, onWidth, onClose, onCall, inCall, onActiveChat, context }: {
  /** Обычный чат — номер; чат задачи — `task:<номер>` (ТЗ-5, этап 3, адаптер). */
  chatId: string;
  width: number;
  onWidth: (w: number) => void;
  onClose: () => void;
  onCall: Parameters<typeof ChatsPage>[0]['onCall'];
  inCall?: boolean;
  onActiveChat?: (chatId: string | null) => void;
  /** Где сейчас человек: задача или проект под окном — их можно отправить в чат одной кнопкой. */
  context?: { taskId?: string; projectId?: string };
}) {
  useEscape(onClose);
  const [drag, setDrag] = useState<{ startX: number; startW: number } | null>(null);
  const live = useRef(width);

  useEffect(() => {
    if (!drag) return;
    const move = (e: MouseEvent) => {
      live.current = Math.min(MAX_W, Math.max(MIN_W, drag.startW + (drag.startX - e.clientX)));
      document.documentElement.style.setProperty('--chat-overlay-w', `${live.current}px`);
    };
    const up = () => { setDrag(null); onWidth(live.current); };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    return () => {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
  }, [drag, onWidth]);

  useEffect(() => {
    document.documentElement.style.setProperty('--chat-overlay-w', `${Math.min(MAX_W, Math.max(MIN_W, width))}px`);
  }, [width]);

  return (
    <div className="chat-overlay" role="dialog" aria-label="Чат">
      <div
        className="chat-overlay-grip"
        onMouseDown={(e) => { e.preventDefault(); setDrag({ startX: e.clientX, startW: live.current }); }}
        title="Потяните, чтобы изменить ширину"
      />
      {chatId.startsWith('task:') ? (
        <TaskConversation taskId={chatId.slice(5)} onClose={onClose} />
      ) : (
        <ChatsPage
          mode="overlay"
          initialChatId={chatId}
          onClose={onClose}
          onCall={onCall}
          inCall={inCall}
          onActiveChat={onActiveChat}
          context={context}
        />
      )}
    </div>
  );
}
