import { useCallback, useEffect, useState } from 'react';
import { Avatar } from '../../components/Avatar';
import { Icon } from '../../components/Icon';
import { Lightbox } from '../../components/Lightbox';
import { MentionField } from '../../components/MentionField';
import { confirmAction } from '../../components/ui/dialog';
import { useEscape } from '../../hooks/useEscape';
import { api, ApiError, NewsComment, NewsPost } from '../../lib/api';
import { MentionUser, stillMentioned } from '../../lib/mentions';
import { overlayProps } from '../../lib/overlay';
import { initialsOf } from '../../lib/initials';
import { navigate, parsePath } from '../../lib/router';
import { PollBlock, Reactions } from './PostCard';
import { audienceLabel, badgeEmoji, Body, downloadFile, fileSize, isMedia, NewsImage, TYPE_META, until, when } from './shared';

/**
 * Пост целиком — окном поверх ленты: полный текст, медиа, файлы, кто ознакомился,
 * кто как голосовал (в открытом опросе), обсуждение. Правка — на месте.
 */
export function PostModal({ post: initial, team, onClose, onUpdated, onDeleted }: {
  post: NewsPost;
  team: MentionUser[];
  onClose: () => void;
  onUpdated: (p: NewsPost) => void;
  onDeleted: (id: string) => void;
}) {
  useEscape(onClose);
  const [post, setPost] = useState(initial);
  useEffect(() => setPost(initial), [initial]);
  const update = (p: NewsPost) => { setPost(p); onUpdated(p); };
  const meta = TYPE_META[post.type] ?? TYPE_META.manual;
  const media = post.files.filter(isMedia);
  const docs = post.files.filter((f) => !isMedia(f));
  const [preview, setPreview] = useState<{ url: string; name: string; mime: string } | null>(null);
  const [err, setErr] = useState('');

  // ── правка ──
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(post.title ?? '');
  const [body, setBody] = useState(post.body);
  const save = async () => {
    setErr('');
    try {
      update(await api.feedUpdate(post.id, { title: title.trim() || undefined, body: body.trim() }));
      setEditing(false);
    } catch (e) { setErr(e instanceof ApiError ? e.message : 'Не сохранилось'); }
  };

  // ── кто ознакомился / кто как голосовал ──
  const [readers, setReaders] = useState<Awaited<ReturnType<typeof api.feedReaders>> | null>(null);
  const [voters, setVoters] = useState<Awaited<ReturnType<typeof api.feedVoters>> | null>(null);

  // ── обсуждение ──
  const [comments, setComments] = useState<NewsComment[] | null>(null);
  const [more, setMore] = useState(0);
  const [text, setText] = useState('');
  const [mentionIds, setMentionIds] = useState<string[]>([]);
  const loadComments = useCallback(async () => {
    const r = await api.feedComments(post.id).catch(() => ({ items: [], total: 0, hasMore: false }));
    setComments(r.items);
    setMore(r.hasMore ? r.total - r.items.length : 0);
  }, [post.id]);
  useEffect(() => { void loadComments(); }, [loadComments, post.comments]);
  const loadEarlier = async () => {
    const first = comments?.[0]?.id;
    if (!first) return;
    const r = await api.feedComments(post.id, first).catch(() => ({ items: [], total: 0, hasMore: false }));
    setComments([...r.items, ...(comments ?? [])]);
    setMore(r.hasMore ? r.total - r.items.length - (comments?.length ?? 0) : 0);
  };
  const send = async () => {
    if (!text.trim()) return;
    setErr('');
    try {
      const r = await api.feedComment(post.id, text.trim(), stillMentioned(mentionIds, text, team));
      setComments(r.items);
      setMore(r.hasMore ? r.total - r.items.length : 0);
      setText('');
      setMentionIds([]);
      update({ ...post, comments: r.total, acked: post.requiresAck ? true : post.acked });
    } catch (e) { setErr(e instanceof ApiError ? e.message : 'Не отправилось'); }
  };

  const remove = async () => {
    if (!(await confirmAction({ title: 'Удалить из «Новостей»?', description: 'Пост исчезнет у всех.', confirmLabel: 'Удалить', danger: true }))) return;
    try { await api.feedDelete(post.id); onDeleted(post.id); onClose(); }
    catch (e) { setErr(e instanceof ApiError ? e.message : 'Не удалось удалить'); }
  };
  const pin = async () => {
    setErr('');
    try { await api.feedPin(post.id, !post.isPinned); update({ ...post, isPinned: !post.isPinned }); }
    catch (e) { setErr(e instanceof ApiError ? e.message : 'Не получилось'); }
  };
  const closePoll = async () => {
    try { update(await api.feedClosePoll(post.id)); } catch (e) { setErr(e instanceof ApiError ? e.message : 'Не получилось'); }
  };

  const who = audienceLabel(post);

  return (
    <div className="modal-overlay" {...overlayProps(onClose)}>
      <article className={`modal-card feed-post feed-post-full feed-${meta.tone}`} onClick={(e) => e.stopPropagation()} aria-label={meta.label}>
        <header className="feed-post-head">
          <span className={`feed-type feed-type-${meta.tone}`}><Icon name={meta.icon} size={13} /> {meta.label}</span>
          {who && <span className="dim feed-time">· {who}</span>}
          <span className="dim feed-time">{when(post.publishedAt)}{post.editedAt ? ' · изменено' : ''}</span>
          <span className="feed-post-actions">
            {post.can.edit && !editing && (
              <button type="button" className="ui-btn ui-btn-ghost ui-btn-sm" onClick={() => setEditing(true)} title="Изменить" aria-label="Изменить"><Icon name="edit" size={14} /></button>
            )}
            {post.can.pin && (
              <button type="button" className="ui-btn ui-btn-ghost ui-btn-sm" onClick={() => void pin()} title={post.isPinned ? 'Открепить' : 'Закрепить сверху ленты'} aria-pressed={post.isPinned}>
                <Icon name="pin" size={14} /> {post.isPinned ? 'Открепить' : 'Закрепить'}
              </button>
            )}
            {post.can.delete && (
              <button type="button" className="ui-btn ui-btn-ghost ui-btn-sm" onClick={() => void remove()} title="Удалить" aria-label="Удалить"><Icon name="trash" size={14} /></button>
            )}
            <button type="button" className="ui-btn ui-btn-ghost ui-btn-sm" onClick={onClose} title="Закрыть" aria-label="Закрыть"><Icon name="close" size={16} /></button>
          </span>
        </header>

        {post.type === 'kudos' && post.kudos ? (
          <div className="feed-kudos">
            <div className="feed-kudos-people">
              <Avatar path={post.authorAvatar} fallback={initialsOf(post.authorName)} className="avatar-sm" />
              <span><b>{post.authorName}</b> благодарит <b>{post.kudos.toName}</b></span>
              <Avatar path={post.kudos.toAvatar} fallback={initialsOf(post.kudos.toName)} className="avatar-sm" />
            </div>
            <blockquote className="feed-kudos-text">«<Body text={post.body} team={team} />»</blockquote>
            {post.kudos.badge && <span className="feed-kudos-badge">{badgeEmoji(post.kudos.badge.key)} {post.kudos.badge.label}</span>}
          </div>
        ) : post.type === 'poll' && post.poll ? (
          <>
            <div className="feed-byline">
              <Avatar path={post.authorAvatar} fallback={initialsOf(post.authorName)} className="avatar-sm" />
              <span className="feed-author">{post.authorName}</span>
            </div>
            <PollBlock post={post} onUpdated={update} />
            <div className="feed-row-actions">
              {post.can.voters && !voters && (
                <button type="button" className="ui-btn ui-btn-ghost ui-btn-sm" onClick={() => api.feedVoters(post.id).then(setVoters).catch(() => undefined)}>Кто как голосовал</button>
              )}
              {post.can.close && <button type="button" className="ui-btn ui-btn-outline ui-btn-sm" onClick={() => void closePoll()}>Завершить опрос</button>}
            </div>
            {voters && (
              <div className="feed-readers">
                {post.poll.options.map((o) => (
                  <div key={o.id}><b>{o.label}:</b> {voters.options.find((x) => x.optionId === o.id)?.names.join(', ') || '—'}</div>
                ))}
              </div>
            )}
          </>
        ) : editing ? (
          <div className="feed-edit">
            {post.type !== 'kudos' && <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Заголовок (необязательно)" maxLength={200} aria-label="Заголовок" />}
            <textarea className="input" rows={8} value={body} onChange={(e) => setBody(e.target.value)} aria-label="Текст" />
            <div className="feed-row-actions">
              <button type="button" className="ui-btn ui-btn-primary ui-btn-sm" onClick={() => void save()} disabled={!body.trim()}>Сохранить</button>
              <button type="button" className="ui-btn ui-btn-ghost ui-btn-sm" onClick={() => { setEditing(false); setTitle(post.title ?? ''); setBody(post.body); }}>Отмена</button>
            </div>
          </div>
        ) : (
          <>
            {!post.byAgent && (
              <div className="feed-byline">
                <Avatar path={post.authorAvatar} fallback={initialsOf(post.authorName)} className="avatar-sm" />
                <span className="feed-author">{post.authorName ?? 'Сотрудник'}</span>
              </div>
            )}
            {post.title && <h2 className="feed-title">{post.title}</h2>}
            <div className="feed-body"><Body text={post.body} team={team} /></div>
          </>
        )}

        {post.contributors.length > 0 && <div className="feed-contributors">Авторы: {post.contributors.map((c) => c.name).join(', ')}</div>}
        {post.projectId && post.projectName && (
          <button type="button" className="feed-source" onClick={() => { onClose(); navigate({ section: 'projects', projectId: post.projectId! }); }}>
            <Icon name="board" size={12} /> Открыть проект «{post.projectName}»
          </button>
        )}
        {post.sources.length > 0 && (
          <div className="feed-sources">
            <span className="dim">Источники:</span>
            {post.sources.map((s) => (
              <button key={s.path + s.label} type="button" className="feed-source" onClick={() => { onClose(); navigate(parsePath(s.path)); }}>
                <Icon name="link" size={11} /> {s.label}
              </button>
            ))}
          </div>
        )}

        {media.length > 0 && (
          <div className={`feed-banners${media.length > 1 ? ' many' : ''}`}>
            {media.map((f) => <NewsImage key={f.fileId} file={f} onOpen={setPreview} />)}
          </div>
        )}
        {docs.length > 0 && (
          <div className="feed-files">
            {docs.map((f) => (
              <button key={f.fileId} type="button" className="feed-file" onClick={() => void downloadFile(f)} title="Скачать">
                <Icon name="file" size={14} /> <span className="feed-file-name">{f.name}</span> <span className="dim">{fileSize(f.size)}</span>
              </button>
            ))}
          </div>
        )}
        {preview && <Lightbox items={[preview]} onClose={() => setPreview(null)} />}

        {post.cta && (
          <a className="ui-btn ui-btn-outline ui-btn-sm feed-cta" href={post.cta.url} target={post.cta.url.startsWith('/') ? undefined : '_blank'} rel="noreferrer">
            {post.cta.label} <Icon name="arrow-right" size={13} />
          </a>
        )}
        {post.activeUntil && <div className="dim feed-time">Действует до {until(post.activeUntil)}</div>}

        <footer className="feed-post-foot">
          <Reactions post={post} onUpdated={update} />
          {post.requiresAck && !post.acked && (
            <button type="button" className="ui-btn ui-btn-primary ui-btn-sm" onClick={async () => { await api.feedAck(post.id).catch(() => undefined); update({ ...post, acked: true, acks: post.acks + 1 }); }}>
              <Icon name="check" size={14} /> Ознакомился
            </button>
          )}
          {post.requiresAck && post.acked && <span className="dim"><Icon name="check" size={13} /> вы ознакомились</span>}
          {post.can.readers && (
            <button type="button" className="ui-btn ui-btn-ghost ui-btn-sm" onClick={() => (readers ? setReaders(null) : api.feedReaders(post.id).then(setReaders).catch(() => undefined))}>
              Ознакомились: {post.acks}{readers ? ` / ${readers.total}` : ''}
            </button>
          )}
        </footer>
        {readers && (
          <div className="feed-readers">
            <div className="feed-ack-bar" aria-label={`Ознакомились ${readers.read.length} из ${readers.total}`}>
              <span style={{ width: `${readers.total ? Math.round((readers.read.length / readers.total) * 100) : 0}%` }} />
            </div>
            <div><b>Ознакомились ({readers.read.length}):</b> {readers.read.map((r) => r.fullName).join(', ') || '—'}</div>
            <div className="dim"><b>Ещё нет ({readers.pending.length}):</b> {readers.pending.map((r) => r.fullName).join(', ') || '—'}</div>
          </div>
        )}

        {err && <div className="error-text" role="alert">{err}</div>}

        {comments && (
          <section className="feed-comments" aria-label="Обсуждение">
            {more > 0 && (
              <button type="button" className="ui-btn ui-btn-ghost ui-btn-sm feed-earlier" onClick={() => void loadEarlier()}>
                <Icon name="chevron-up" size={13} /> Показать предыдущие ({more})
              </button>
            )}
            {comments.map((c) => (
              <div key={c.id} className="feed-comment">
                <Avatar path={c.avatarUrl} fallback={initialsOf(c.fullName)} className="avatar-sm" />
                <div className="feed-comment-main">
                  <div className="feed-comment-head">
                    <b>{c.fullName}</b> <span className="dim feed-time">{when(c.createdAt)}</span>
                    <span className="feed-comment-acts">
                      {/* обсуждение превратилось в работу — задачей тем же окном, что везде (§50) */}
                      <button type="button" className="ui-btn ui-btn-ghost ui-btn-icon-sm" title="Создать задачу из комментария" aria-label="Создать задачу из комментария"
                        onClick={() => window.dispatchEvent(new CustomEvent('teamcrm:quick-task', { detail: { text: c.body } }))}>
                        <Icon name="check-circle" size={13} />
                      </button>
                      {c.canDelete && (
                        <button type="button" className="ui-btn ui-btn-ghost ui-btn-icon-sm" title="Удалить комментарий" aria-label="Удалить комментарий"
                          onClick={async () => {
                            if (!(await confirmAction({ title: 'Удалить комментарий?', confirmLabel: 'Удалить', danger: true }))) return;
                            await api.feedDeleteComment(c.id).catch(() => undefined);
                            setComments((cur) => (cur ?? []).filter((x) => x.id !== c.id));
                            update({ ...post, comments: Math.max(0, post.comments - 1) });
                          }}>
                          <Icon name="trash" size={13} />
                        </button>
                      )}
                    </span>
                  </div>
                  <div className="feed-body"><Body text={c.body} team={team} /></div>
                </div>
              </div>
            ))}
            <div className="feed-comment-new">
              <MentionField
                placeholder={post.type === 'kudos' ? 'Поздравить… через @ можно позвать человека' : 'Ответить… через @ можно позвать человека'}
                value={text}
                users={team}
                onChange={setText}
                onMention={(id) => setMentionIds((prev) => (prev.includes(id) ? prev : [...prev, id]))}
                onEnter={() => void send()}
              />
              <button type="button" className="ui-btn ui-btn-outline ui-btn-sm" onClick={() => void send()} disabled={!text.trim()}>Отправить</button>
            </div>
          </section>
        )}
      </article>
    </div>
  );
}
