import { useEffect } from 'react';
import { getSocket } from '../lib/socket';
import { showNotification, showToast } from '../lib/notifications';
import { flashTab } from '../lib/tab-alert';
import { playMessageChime } from '../lib/sound';
import { openSupport } from '../components/support/SupportDock';

interface QueuePayload {
  conversationId: string;
  /** Человек позвал специалиста — единственный повод сказать об очереди вслух. */
  waiting?: boolean;
  subject?: string | null;
  userName?: string | null;
  orgName?: string | null;
}

interface MessagePayload {
  conversationId: string;
  kind?: 'user' | 'agent' | 'ai' | 'system';
  authorId?: string | null;
  subject?: string | null;
  preview?: string | null;
}

interface CallPayload {
  conversationId: string;
  /** Кто просит: о своей же просьбе специалисту напоминать незачем. */
  byRole?: 'user' | 'agent';
}

/**
 * Новости консоли техотдела.
 *
 * На поддомене консоли не живёт ничего из CRM — ни звонков коллег, ни чатов, ни
 * пингов секретаря. Но и молчать консоль не может: специалист, который узнаёт о
 * новом обращении, только сам обновив очередь, — не дежурный, а зритель. Три
 * повода, и только они: человек позвал специалиста, клиент ответил в разговоре,
 * который ведёт этот специалист, клиент просит созвон. Щелчок по всплывашке
 * открывает сам разговор.
 */
export function useConsoleAlerts(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;
    const socket = getSocket();

    const who = (p: { userName?: string | null; orgName?: string | null }) =>
      [p.userName, p.orgName].filter(Boolean).join(' · ');

    /*
      Одно событие может прийти дважды: дежурному — как дежурному и как ведущему
      разговор. Две одинаковые всплывашки подряд читаются как два обращения.
    */
    const seen = new Map<string, number>();
    const fresh = (key: string) => {
      const now = Date.now();
      const last = seen.get(key) ?? 0;
      seen.set(key, now);
      return now - last > 2000;
    };

    const onQueue = (p: QueuePayload) => {
      // снятие, возврат в очередь, закрытие — очередь обновится сама, без шума
      if (!p?.waiting || !fresh(`queue:${p.conversationId}`)) return;
      const title = 'Ждут специалиста';
      const body = [who(p), p.subject].filter(Boolean).join(' — ') || 'Новое обращение';
      showToast({ title, body, section: 'support', conversationId: p.conversationId });
      showNotification(title, body, () => openSupport(p.conversationId));
      flashTab('Ждут специалиста');
      playMessageChime();
    };

    const onMessage = (p: MessagePayload) => {
      // О своих словах и словах помощника не сообщают: специалист их и так видит.
      if (p?.kind !== 'user') return;
      const title = 'Клиент ответил';
      const body = p.preview?.trim() || p.subject || 'Откройте обращение';
      showToast({ title, body, section: 'support', conversationId: p.conversationId });
      showNotification(title, body, () => openSupport(p.conversationId));
      flashTab('Клиент ответил');
      playMessageChime();
    };

    const onCall = (p: CallPayload) => {
      if (p?.byRole !== 'user' || !fresh(`call:${p.conversationId}`)) return;
      const title = 'Клиент просит созвон';
      const body = 'Откройте обращение: «Присоединиться» или «Сейчас неудобно»';
      showToast({ title, body, section: 'support', conversationId: p?.conversationId });
      showNotification(title, body, () => openSupport(p?.conversationId));
      flashTab('Просят созвон');
      playMessageChime();
    };

    socket.on('support.queue.changed', onQueue);
    socket.on('support.message.created', onMessage);
    socket.on('support.call.requested', onCall);
    return () => {
      socket.off('support.queue.changed', onQueue);
      socket.off('support.message.created', onMessage);
      socket.off('support.call.requested', onCall);
    };
  }, [enabled]);
}
