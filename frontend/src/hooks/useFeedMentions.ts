import { useEffect, useRef } from 'react';
import { getSocket } from '../lib/socket';
import { showNotification, showToast } from '../lib/notifications';
import { playMessageChime } from '../lib/sound';

interface MentionPayload {
  postId: string;
  commentId: string | null;
  body: string;
}

/**
 * «Вас упомянули в ленте».
 *
 * Упоминание, о котором человек узнаёт, только сам открыв ленту, — не упоминание,
 * а надежда. Живёт в App, как и уведомления о сообщениях: позвать могут в любой момент,
 * а лента при этом закрыта.
 */
export function useFeedMentions(enabled: boolean, onOpenFeed: () => void): void {
  const open = useRef(onOpenFeed);
  useEffect(() => { open.current = onOpenFeed; }, [onOpenFeed]);

  useEffect(() => {
    if (!enabled) return;
    const socket = getSocket();

    const onMention = (p: MentionPayload) => {
      const title = p.commentId ? 'Вас упомянули в обсуждении' : 'Вас упомянули в ленте';
      const body = p.body?.trim() || 'Откройте ленту компании';
      showToast({ title, body, section: 'feed' });
      showNotification(title, body, () => open.current());
      playMessageChime();
    };

    socket.on('feed.mention', onMention);
    return () => { socket.off('feed.mention', onMention); };
  }, [enabled]);
}
