import { useEffect, useRef } from 'react';
import { getSocket } from '../lib/socket';
import { showNotification, showToast } from '../lib/notifications';
import { notifyPingArrived } from '../components/AssistantPings';

interface PingPayload {
  id: string;
  text: string;
  taskId: string | null;
}

/**
 * Напоминание ассистента в открытом приложении.
 *
 * Тихо класть его в «Фокус дня» мало: человек сидит в задаче или в чатах и увидит
 * напоминание в лучшем случае завтра — а напоминают именно о том, что уже стоит.
 * Поэтому всплывающее уведомление и обновление блока в «Фокусе» без перезагрузки.
 */
export function useAssistantPings(enabled: boolean, onOpenFocus: () => void): void {
  const open = useRef(onOpenFocus);
  useEffect(() => { open.current = onOpenFocus; }, [onOpenFocus]);

  useEffect(() => {
    if (!enabled) return;
    const socket = getSocket();

    const onPing = (p: PingPayload) => {
      showToast({ title: 'Секретарь напоминает', body: p.text, section: 'focus' });
      showNotification('Секретарь напоминает', p.text, () => open.current());
      notifyPingArrived();
      // без звука: напоминание о просроченной задаче — не срочный вызов, а фон
    };

    socket.on('assistant.ping', onPing);
    return () => { socket.off('assistant.ping', onPing); };
  }, [enabled]);
}
