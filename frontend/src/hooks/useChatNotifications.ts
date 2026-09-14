import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import { getSocket } from '../lib/socket';
import { CHATS_CHANGED, setTitleUnread, showNotification, showToast } from '../lib/notifications';
import { playMessageChime } from '../lib/sound';

/**
 * Непрочитанные сообщения на уровне всего приложения.
 *
 * Живёт в App, а не на странице чатов: иначе о сообщении узнавали бы, только пока
 * раздел «Чаты» открыт, — то есть ровно тогда, когда уведомление и не нужно.
 *
 * @param meId кто я — о собственных сообщениях не уведомляем
 * @param openChatId чат, открытый прямо сейчас — по нему уведомление не показываем
 */
export function useChatNotifications(enabled: boolean, meId: string | null, openChatId: string | null, onOpenChats: () => void) {
  const [unread, setUnread] = useState(0);
  /** Режим уведомлений по чатам — из списка: тихие чаты не звучат и не считаются в панели. */
  const modes = useRef<Map<string, string>>(new Map());
  // в колбэке сокета нужны свежие значения, но пересоздавать подписку на каждый чат не хочется
  const openRef = useRef(openChatId);
  const meRef = useRef(meId);
  const openChats = useRef(onOpenChats);
  useEffect(() => { openRef.current = openChatId; }, [openChatId]);
  useEffect(() => { meRef.current = meId; }, [meId]);
  useEffect(() => { openChats.current = onOpenChats; }, [onOpenChats]);

  const refresh = useCallback(async () => {
    if (!enabled) return;
    try {
      const chats = await api.listChats();
      modes.current = new Map(chats.map((c: any) => [String(c.id), String(c.notify ?? 'all')]));
      // «none» — тихий чат: непрочитанное у него своё, а панель молчит
      setUnread(chats.reduce((sum: number, c: any) => sum + (c.notify === 'none' ? 0 : (Number(c.unread) || 0)), 0));
    } catch { /* сеть моргнула — счётчик обновится следующим событием */ }
  }, [enabled]);

  useEffect(() => {
    if (!enabled) { setUnread(0); setTitleUnread(0); return; }
    refresh();

    const socket = getSocket();
    const onMessage = (p: { chatId: string; message: { author_id: string | null; author_name: string | null; body: string; file_name?: string | null }; mentionIds?: string[] }) => {
      refresh();
      const m = p.message;
      // Настройка чата: «выключено» — тишина, «только упоминания» — звучит, лишь если позвали меня.
      const mode = modes.current.get(String(p.chatId)) ?? 'all';
      if (mode === 'none') return;
      if (mode === 'mentions' && !(p.mentionIds ?? []).map(String).includes(String(meRef.current ?? ''))) return;
      if (!m.author_id) return; // системные строки — не сообщение, тревожить нечем
      /*
        Своё сообщение уведомлением не возвращается.
        
        Событие приходит всем участникам чата, отправителю в том числе, и проверки
        «чат открыт» не хватало: стоило после отправки уйти в другую вкладку или
        свернуть окно (`document.hidden`), и человек получал звонок о собственном
        сообщении.
      */
      if (meRef.current && String(m.author_id) === String(meRef.current)) return;
      if (String(p.chatId) === String(openRef.current) && !document.hidden) return;
      const title = m.author_name ?? 'Новое сообщение';
      const body = m.body?.trim() || (m.file_name ? `Файл: ${m.file_name}` : 'Вложение');
      // Показываем сразу двумя способами: системное уведомление видно и при свёрнутом
      // окне, но требует разрешения; своё — работает всегда, пока вкладка открыта.
      showNotification(title, body, () => openChats.current());
      showToast({ title, body, chatId: String(p.chatId) });
      playMessageChime();
    };

    socket.on('chat.message', onMessage);
    socket.on('chat.created', refresh);
    socket.on('chat.removed', refresh);
    window.addEventListener(CHATS_CHANGED, refresh);
    // страховка на случай пропущенного события: раз в минуту сверяемся с сервером
    const timer = setInterval(refresh, 60_000);

    return () => {
      socket.off('chat.message', onMessage);
      socket.off('chat.created', refresh);
      socket.off('chat.removed', refresh);
      window.removeEventListener(CHATS_CHANGED, refresh);
      clearInterval(timer);
    };
  }, [enabled, refresh]);

  useEffect(() => { setTitleUnread(unread); }, [unread]);
  // уходя со страницы, возвращаем обычный заголовок
  useEffect(() => () => setTitleUnread(0), []);

  return { unread, refresh };
}
