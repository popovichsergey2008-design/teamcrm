import { useEffect, useState } from 'react';
import { EmptyState } from './EmptyState';
import { Icon } from './Icon';
import { SkeletonList } from './Skeleton';
import { api } from '../lib/api';
import { useEscape } from '../hooks/useEscape';
import { overlayProps } from '../lib/overlay';

/** Лента импортированного из Битрикса проекта (read-only архив; чата пока нет). */
export function ImportedFeedPanel({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  useEscape(onClose); // закрытие с клавиатуры, а не только крестиком
  const [messages, setMessages] = useState<any[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    api.bitrixMessages(projectId).then(setMessages).catch(() => setMessages([])).finally(() => setLoaded(true));
  }, [projectId]);

  return (
    <div className="drawer-overlay" {...overlayProps(onClose)}>
      <aside className="drawer" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-head"><h3>Лента (импорт из Битрикса)</h3><button className="btn btn-ghost btn-sm" onClick={onClose} title="Закрыть"><Icon name="close" /></button></div>
        <div className="dim" style={{ fontSize: 12, marginBottom: 8 }}>Сообщения проекта, перенесённые из Битрикса. Только для чтения — при появлении чата станут его историей.</div>
        {!loaded && <SkeletonList rows={4} />}
        {loaded && messages.length === 0 && (
          <EmptyState compact icon="inbox" title="Лента пуста" hint="В этом проекте не было сообщений на момент импорта." />
        )}
        {messages.map((m) => (
          <div key={m.id} className="comment">
            <div className="comment-head dim">
              {m.author_name || m.author_label || '—'} · {m.posted_at ? new Date(m.posted_at).toLocaleString('ru-RU') : ''}
            </div>
            <div style={{ whiteSpace: 'pre-wrap' }}>{m.body}</div>
          </div>
        ))}
      </aside>
    </div>
  );
}
