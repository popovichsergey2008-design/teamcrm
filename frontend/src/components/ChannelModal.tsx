import { useState } from 'react';
import { Icon } from './Icon';
import { PeoplePicker } from './PeoplePicker';
import { api, ApiError } from '../lib/api';
import { useEscape } from '../hooks/useEscape';
import { overlayProps } from '../lib/overlay';

/**
 * Создание канала.
 *
 * Канал отличается от группы не размером, а сроком жизни: группа заводится под
 * разговор («Сергей, Глеб, Юрий»), канал — под тему, которая переживёт состав
 * участников: #разработка, #маркетинг, #баги.
 *
 * Публичный по умолчанию НЕ ставим: раскрыть канал позже проще, чем спрятать уже
 * сказанное. Но выбор показан сразу и объяснён — иначе половина каналов окажется
 * закрытой по недосмотру, и общее знание опять не соберётся.
 */
export function ChannelModal({ meId, onClose, onCreated }: {
  meId?: string;
  onClose: () => void;
  onCreated: (chatId: string) => void;
}) {
  useEscape(onClose);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [isPrivate, setIsPrivate] = useState(false);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const create = async () => {
    const name = title.trim();
    if (!name) return setErr('Назовите канал');
    setBusy(true); setErr('');
    try {
      const chat = await api.createChannel({
        title: name,
        description: description.trim() || undefined,
        isPrivate,
        userIds: [...chosen],
      });
      onCreated(String(chat.id));
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Канал не создался');
    } finally { setBusy(false); }
  };

  return (
    <div className="drawer-overlay" {...overlayProps(onClose)}>
      <aside className="drawer" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-head">
          <h3><Icon name="hash" size={16} /> Новый канал</h3>
          <button className="drawer-close" onClick={onClose} title="Закрыть" aria-label="Закрыть">
            <Icon name="close" size={20} />
          </button>
        </div>

        <div className="field">
          <label>Название</label>
          <input
            className="input"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="разработка"
            maxLength={160}
            autoFocus
          />
        </div>
        <div className="field">
          <label>О чём канал</label>
          <input
            className="input"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Технические вопросы и релизы"
            maxLength={300}
          />
        </div>

        <div className="field">
          <label>Кто видит</label>
          <div className="channel-kind">
            <button
              className={`channel-kind-btn${isPrivate ? '' : ' active'}`}
              onClick={() => setIsPrivate(false)}
            >
              <Icon name="users" size={14} /> Публичный
              <span className="dim">виден всей компании, входят сами</span>
            </button>
            <button
              className={`channel-kind-btn${isPrivate ? ' active' : ''}`}
              onClick={() => setIsPrivate(true)}
            >
              <Icon name="lock" size={14} /> Закрытый
              <span className="dim">видят только участники, вход по приглашению</span>
            </button>
          </div>
        </div>

        {/* В публичный канал звать необязательно — люди войдут сами. Но добавить сразу
            тех, ради кого он заводится, быстрее, чем ждать, пока заметят. */}
        <div className="field">
          <label>Добавить сразу</label>
          <PeoplePicker
            exclude={meId ? [String(meId)] : []}
            chosen={chosen}
            onToggle={(id) => setChosen((prev) => {
              const next = new Set(prev);
              next.has(id) ? next.delete(id) : next.add(id);
              return next;
            })}
            onSetAll={(ids, selected) => setChosen((prev) => {
              const next = new Set(prev);
              for (const id of ids) { if (selected) next.add(id); else next.delete(id); }
              return next;
            })}
          />
        </div>

        {err && <div className="error-text">{err}</div>}
        <button className="btn btn-primary" onClick={create} disabled={busy}>
          {busy ? 'Создаю…' : 'Создать канал'}
        </button>
      </aside>
    </div>
  );
}
