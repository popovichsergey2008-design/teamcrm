import { useCallback, useEffect, useState } from 'react';
import { Avatar } from '../components/Avatar';
import { EmptyState } from '../components/EmptyState';
import { Icon } from '../components/Icon';
import { SkeletonList } from '../components/Skeleton';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../state/auth';

interface Post {
  id: string;
  authorId: string;
  authorName: string | null;
  authorAvatar: string | null;
  body: string;
  isAnnouncement: boolean;
  isPinned: boolean;
  activeUntil: string | null;
  createdAt: string;
  isRead: boolean;
  reads: number;
  comments: number;
  groups: string[];
  canManage: boolean;
}

interface Comment {
  id: string;
  fullName: string | null;
  avatarUrl: string | null;
  body: string;
  createdAt: string;
}

const when = (iso: string) => {
  const d = new Date(iso);
  const today = new Date().toDateString() === d.toDateString();
  return today
    ? d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
};

/**
 * Лента компании: сообщения и объявления.
 *
 * Чаты закрывают общение, но не закрывают объявление — сообщение, которое обязаны
 * прочитать все и автор должен видеть поимённо, кто прочитал. В чате такое тонет за
 * полчаса, и «поднимать наверх» приходится руками.
 */
export function FeedPage() {
  const { user } = useAuth();
  const canAnnounce = user?.role === 'owner' || user?.role === 'manager';
  const [items, setItems] = useState<Post[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [err, setErr] = useState('');
  const [body, setBody] = useState('');
  const [asAnnouncement, setAsAnnouncement] = useState(false);
  const [activeUntil, setActiveUntil] = useState('');
  const [groups, setGroups] = useState<{ id: string; name: string }[]>([]);
  const [groupIds, setGroupIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(
    () => api.feedList()
      .then((r) => setItems(r.items))
      .catch((e) => setErr(e instanceof ApiError ? e.message : 'Не удалось загрузить ленту'))
      .finally(() => setLoaded(true)),
    [],
  );

  useEffect(() => { void reload(); }, [reload]);
  useEffect(() => { api.listGroups().then(setGroups).catch(() => undefined); }, []);

  const publish = async () => {
    if (!body.trim()) return;
    setBusy(true);
    setErr('');
    try {
      await api.feedCreate({
        body: body.trim(),
        isAnnouncement: asAnnouncement,
        activeUntil: asAnnouncement && activeUntil ? new Date(activeUntil).toISOString() : undefined,
        groupIds,
      });
      setBody('');
      setAsAnnouncement(false);
      setActiveUntil('');
      setGroupIds([]);
      await reload();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Не удалось опубликовать');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page feed-page">
      <div className="page-head"><h2>Лента компании</h2></div>

      <div className="card feed-composer">
        <textarea
          className="input"
          rows={3}
          placeholder={asAnnouncement ? 'Что важно знать всем?' : 'Написать всей компании…'}
          value={body}
          onChange={(e) => setBody(e.target.value)}
        />

        <div className="feed-composer-row">
          {canAnnounce && (
            <label className="feed-flag" title="Объявление подсвечивается и требует подтверждения прочтения">
              <input type="checkbox" checked={asAnnouncement} onChange={(e) => setAsAnnouncement(e.target.checked)} />
              <Icon name="alert" size={14} /> Объявление
            </label>
          )}
          {/* Адресаты: пусто — всей компании. Так проще всего, а отделы выбирают, когда
              сообщение действительно касается только их. */}
          {groups.length > 0 && (
            <select
              className="input feed-groups"
              value=""
              onChange={(e) => {
                const id = e.target.value;
                if (id && !groupIds.includes(id)) setGroupIds([...groupIds, id]);
              }}
            >
              <option value="">Кому: всей компании</option>
              {groups.filter((g) => !groupIds.includes(String(g.id))).map((g) => (
                <option key={g.id} value={g.id}>{g.name}</option>
              ))}
            </select>
          )}
          {asAnnouncement && (
            <input
              className="input feed-until"
              type="date"
              value={activeUntil}
              onChange={(e) => setActiveUntil(e.target.value)}
              title="До какого числа объявление действует. Пусто — бессрочно"
            />
          )}
          <button className="btn btn-primary btn-sm" onClick={publish} disabled={busy || !body.trim()}>
            {busy ? 'Публикую…' : 'Опубликовать'}
          </button>
        </div>

        {groupIds.length > 0 && (
          <div className="feed-chosen">
            {groupIds.map((id) => (
              <button key={id} className="feed-chip" onClick={() => setGroupIds(groupIds.filter((x) => x !== id))}>
                {groups.find((g) => String(g.id) === id)?.name ?? id} <Icon name="close" size={11} />
              </button>
            ))}
          </div>
        )}
      </div>

      {err && <div className="error-text">{err}</div>}
      {!loaded && <SkeletonList rows={4} />}
      {loaded && items.length === 0 && (
        <EmptyState
          icon="chat"
          title="В ленте пока пусто"
          hint="Здесь живут сообщения всей компании и объявления, которые нужно прочитать каждому."
        />
      )}

      <div className="feed-list">
        {items.map((p) => <PostCard key={p.id} post={p} onChanged={reload} />)}
      </div>
    </div>
  );
}

function PostCard({ post, onChanged }: { post: Post; onChanged: () => void }) {
  const [comments, setComments] = useState<Comment[] | null>(null);
  const [text, setText] = useState('');
  const [readers, setReaders] = useState<{ read: { fullName: string }[]; pending: { fullName: string }[] } | null>(null);

  const openComments = async () => {
    if (comments) return setComments(null);
    setComments(await api.feedComments(post.id).catch(() => []));
  };

  const send = async () => {
    if (!text.trim()) return;
    setComments(await api.feedComment(post.id, text.trim()).catch(() => comments ?? []));
    setText('');
    onChanged();
  };

  const confirmRead = async () => {
    await api.feedRead(post.id).catch(() => undefined);
    onChanged();
  };

  const showReaders = async () => {
    if (readers) return setReaders(null);
    setReaders(await api.feedReaders(post.id).catch(() => null));
  };

  return (
    <article className={`card feed-post ${post.isAnnouncement ? 'announcement' : ''} ${post.isPinned ? 'pinned' : ''}`}>
      <header className="feed-post-head">
        <Avatar path={post.authorAvatar} fallback={post.authorName?.[0]?.toUpperCase() ?? '?'} className="avatar-sm" />
        <span className="feed-author">{post.authorName ?? 'Сотрудник'}</span>
        <span className="dim feed-time">{when(post.createdAt)}</span>
        {post.isPinned && <Icon name="flag" size={13} />}
        {post.isAnnouncement && <span className="feed-badge">объявление</span>}
        {post.groups.length > 0 && <span className="dim feed-time">· {post.groups.join(', ')}</span>}
        <span className="feed-post-actions">
          {post.canManage && (
            <>
              <button className="btn btn-ghost btn-sm" onClick={() => api.feedPin(post.id, !post.isPinned).then(onChanged)}>
                {post.isPinned ? 'Открепить' : 'Закрепить'}
              </button>
              <button className="btn btn-ghost btn-sm" onClick={() => {
                if (window.confirm('Удалить сообщение из ленты?')) api.feedDelete(post.id).then(onChanged);
              }}>
                <Icon name="trash" size={13} />
              </button>
            </>
          )}
        </span>
      </header>

      <div className="feed-body">{post.body}</div>

      <footer className="feed-post-foot">
        {/* Подтверждение прочтения — суть объявления: автор должен видеть, кто прочитал */}
        {post.isAnnouncement && !post.isRead && (
          <button className="btn btn-primary btn-sm" onClick={confirmRead}>
            <Icon name="check" size={14} /> Прочитал
          </button>
        )}
        {post.isAnnouncement && post.isRead && <span className="dim"><Icon name="check" size={13} /> вы прочитали</span>}
        {post.isAnnouncement && (
          <button className="btn btn-ghost btn-sm" onClick={showReaders}>
            Прочитали: {post.reads}
          </button>
        )}
        <button className="btn btn-ghost btn-sm" onClick={openComments}>
          <Icon name="chat" size={14} /> Комментарии{post.comments ? ` · ${post.comments}` : ''}
        </button>
      </footer>

      {readers && (
        <div className="feed-readers">
          <div><b>Прочитали:</b> {readers.read.map((r) => r.fullName).join(', ') || '—'}</div>
          <div className="dim"><b>Ещё нет:</b> {readers.pending.map((r) => r.fullName).join(', ') || '—'}</div>
        </div>
      )}

      {comments && (
        <div className="feed-comments">
          {comments.map((c) => (
            <div key={c.id} className="feed-comment">
              <Avatar path={c.avatarUrl} fallback={c.fullName?.[0]?.toUpperCase() ?? '?'} className="avatar-sm" />
              <div>
                <div className="feed-comment-head">
                  <b>{c.fullName}</b> <span className="dim feed-time">{when(c.createdAt)}</span>
                </div>
                <div>{c.body}</div>
              </div>
            </div>
          ))}
          <div className="feed-comment-new">
            <input
              className="input"
              placeholder="Ответить…"
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && send()}
            />
            <button className="btn btn-sm" onClick={send} disabled={!text.trim()}>Отправить</button>
          </div>
        </div>
      )}
    </article>
  );
}
