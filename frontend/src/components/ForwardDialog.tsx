import { useEffect, useMemo, useState } from 'react';
import { Icon } from './Icon';
import { api, ApiError } from '../lib/api';
import { useEscape } from '../hooks/useEscape';
import { overlayProps } from '../lib/overlay';

/**
 * Куда переслать сообщение (просьба заказчика: «кнопка пересылки, как в Telegram»).
 *
 * Раньше чужие слова переносили руками: выделить, скопировать, перейти, вставить — и
 * потерять по дороге и вложения, и автора. Здесь выбирают чат, и сообщение уходит
 * целиком, с подписью «Переслано от …».
 *
 * Список — те же чаты, что в разделе: показываем их все с поиском, потому что
 * пересылают обычно в тот чат, который в списке далеко не первый.
 */
export function ForwardDialog({ chatId, messageId, preview, onClose, onDone }: {
  chatId: string;
  messageId: string;
  /** Что именно пересылают — видно перед выбором: чтобы не отправить не то. */
  preview: string;
  onClose: () => void;
  onDone: (toChatId: string, title: string) => void;
}) {
  useEscape(onClose);
  const [chats, setChats] = useState<{ id: string; title: string; kind: string }[]>([]);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');

  useEffect(() => {
    api.listChats()
      .then((r) => setChats((r.items ?? r ?? []).map((c: any) => ({
        id: String(c.id), title: String(c.title ?? c.peer_name ?? 'Без названия'), kind: String(c.kind ?? 'group'),
      }))))
      .catch((e) => setErr(e instanceof ApiError ? e.message : 'Список чатов не загрузился'));
  }, []);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return chats
      .filter((c) => String(c.id) !== String(chatId))
      .filter((c) => !q || c.title.toLowerCase().includes(q));
  }, [chats, query, chatId]);

  const send = async (to: { id: string; title: string }) => {
    setBusy(to.id); setErr('');
    try {
      await api.forwardMessage(chatId, messageId, to.id);
      onDone(to.id, to.title);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Не удалось переслать');
    } finally { setBusy(''); }
  };

  return (
    <div className="modal-overlay" {...overlayProps(onClose)}>
      <div className="modal-card forward-card" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-head">
          <h3><Icon name="reply" size={16} /> Переслать сообщение</h3>
          <button className="drawer-close" onClick={onClose} title="Закрыть" aria-label="Закрыть">
            <Icon name="close" size={20} />
          </button>
        </div>

        {/* Что пересылаем: без этого легко отправить соседнюю реплику. */}
        <div className="msg-quote-src">«{preview.slice(0, 200)}»</div>

        <input
          className="input input-sm"
          placeholder="Поиск чата…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />

        {err && <div className="error-text">{err}</div>}

        <div className="forward-list">
          {visible.map((c) => (
            <button key={c.id} className="forward-item" disabled={!!busy} onClick={() => void send(c)}>
              <Icon name={c.kind === 'dm' ? 'user' : c.kind === 'project' ? 'board' : 'hash'} size={14} />
              <span className="forward-item-title">{c.title}</span>
              {busy === c.id && <span className="dim">отправляю…</span>}
            </button>
          ))}
          {!visible.length && <div className="dim">Ничего не нашлось</div>}
        </div>
      </div>
    </div>
  );
}
