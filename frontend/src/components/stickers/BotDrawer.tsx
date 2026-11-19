import { useEffect } from 'react';
import { AnthillPanel } from '../anthill/AnthillPanel';
import { navigate } from '../../lib/router';
import './bot-drawer.css';

/**
 * QEVO Bot справа, поверх текущей страницы (#4997, шаг 0.3): открыл кнопкой вверху меню —
 * спросил, создал стикер или задачу — закрыл, страница под ним никуда не уходила.
 * «Во весь экран» — тот же разговор в разделе чатов.
 */
export function BotDrawer({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [onClose]);
  return (
    <div className="botd-veil" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <aside className="botd" aria-label="QEVO Bot">
        <AnthillPanel onClose={onClose} onFullscreen={() => { onClose(); navigate({ section: 'chat', chatId: 'anthill' }); }} />
      </aside>
    </div>
  );
}
