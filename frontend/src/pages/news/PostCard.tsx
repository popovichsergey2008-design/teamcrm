import { useState } from 'react';
import { Avatar } from '../../components/Avatar';
import { Icon } from '../../components/Icon';
import { api, ApiError, NewsPost } from '../../lib/api';
import { MentionUser } from '../../lib/mentions';
import { navigate, parsePath } from '../../lib/router';
import { initialsOf } from '../../lib/initials';
import { audienceLabel, badgeEmoji, Body, isMedia, NewsImage, REACTIONS, TYPE_META, until, when } from './shared';
import { feedback } from '../../lib/feedback';

/**
 * Пост в ленте (ТЗ-20). Карточка отвечает на «стоит ли читать» и даёт сделать
 * главное, не открывая окна: отреагировать, проголосовать, нажать «Ознакомился».
 * Обсуждение, файлы и список ознакомившихся — в окне по нажатию.
 */
export function PostCard({ post, team, onOpen, onUpdated, featured }: {
  post: NewsPost;
  team: MentionUser[];
  onOpen: () => void;
  onUpdated: (p: NewsPost) => void;
  /** Хайлайт дня наверху — крупнее остальных. */
  featured?: boolean;
}) {
  const meta = TYPE_META[post.type] ?? TYPE_META.manual;
  const media = post.files.filter(isMedia);
  const who = audienceLabel(post);
  const stop = (e: React.SyntheticEvent) => e.stopPropagation();

  return (
    <article
      className={`card feed-post feed-post-card feed-${meta.tone}${post.isPinned ? ' pinned' : ''}${featured ? ' featured' : ''}${post.isNew ? ' is-new' : ''}`}
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget) { e.preventDefault(); onOpen(); } }}
      aria-label={`${meta.label}${post.title ? `: ${post.title}` : ''}`}
    >
      <header className="feed-post-head">
        <span className={`feed-type feed-type-${meta.tone}`}><Icon name={meta.icon} size={13} /> {meta.label}</span>
        {post.isPinned && <span className="feed-pin" title="Закреплено"><Icon name="pin" size={12} /></span>}
        {post.isNew && <span className="feed-new" title="Появилось с вашего прошлого визита">новое</span>}
        {who && <span className="dim feed-time">· {who}</span>}
        <span className="dim feed-time feed-when">{when(post.publishedAt)}</span>
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
      ) : (
        <>
          {!post.byAgent && post.type !== 'poll' && (
            <div className="feed-byline">
              <Avatar path={post.authorAvatar} fallback={initialsOf(post.authorName)} className="avatar-sm" />
              <span className="feed-author">{post.authorName ?? 'Сотрудник'}</span>
            </div>
          )}
          {post.title && post.type !== 'poll' && <h3 className="feed-title">{post.title}</h3>}
          {post.type === 'poll' && post.poll ? (
            <PollBlock post={post} onUpdated={onUpdated} />
          ) : (
            <div className="feed-card-row">
              <div className={`feed-body${featured ? '' : ' feed-preview'}`}><Body text={post.body} team={team} /></div>
              {media.length > 0 && (
                <div className="feed-thumb-wrap">
                  <NewsImage file={media[0]} thumb />
                  {media.length > 1 && <span className="feed-thumb-more">+{media.length - 1}</span>}
                </div>
              )}
            </div>
          )}
        </>
      )}

      {post.contributors.length > 0 && (
        <div className="feed-contributors dim">Авторы: {post.contributors.map((c) => c.name).join(', ')}</div>
      )}

      {post.sources.length > 0 && featured && (
        <div className="feed-sources" onClick={stop}>
          {post.sources.slice(0, 4).map((s) => (
            <button key={s.path + s.label} type="button" className="feed-source" onClick={() => navigate(parsePath(s.path))} title="Открыть источник">
              <Icon name="link" size={11} /> {s.label}
            </button>
          ))}
        </div>
      )}

      {post.cta && (
        <div onClick={stop}>
          <a className="ui-btn ui-btn-outline ui-btn-sm" href={post.cta.url} target={post.cta.url.startsWith('/') ? undefined : '_blank'} rel="noreferrer">
            {post.cta.label} <Icon name="arrow-right" size={13} />
          </a>
        </div>
      )}

      <footer className="feed-post-foot" onClick={stop}>
        <Reactions post={post} onUpdated={onUpdated} />
        {post.requiresAck && <AckButton post={post} onUpdated={onUpdated} />}
        <button type="button" className="feed-foot-btn" onClick={onOpen} title="Обсуждение">
          <Icon name="chat" size={13} /> {post.comments || ''}
        </button>
        {post.files.length > 0 && <span className="dim"><Icon name="paperclip" size={13} /> {post.files.length}</span>}
      </footer>
    </article>
  );
}

/** Реакции (§24): уже стоящие — с числом; добавить — из пяти, раскрываются по «+». */
export function Reactions({ post, onUpdated }: { post: NewsPost; onUpdated: (p: NewsPost) => void }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const react = async (emoji: string) => {
    if (busy) return;
    setBusy(true);
    setOpen(false);
    try { onUpdated(await api.feedReact(post.id, emoji)); } catch { /* сеть — реакция просто не встанет */ }
    finally { setBusy(false); }
  };
  const shown = new Set(post.reactions.map((r) => r.emoji));
  return (
    <span className="feed-reactions">
      {post.reactions.map((r) => (
        <button key={r.emoji} type="button" className={`reaction${r.mine ? ' mine' : ''}`} onClick={() => void react(r.emoji)} aria-pressed={r.mine}>
          {r.emoji} {r.count}
        </button>
      ))}
      {open
        ? REACTIONS.filter((e) => !shown.has(e)).map((e) => (
          <button key={e} type="button" className="reaction feed-reaction-pick" onClick={() => void react(e)} aria-label={`Реакция ${e}`}>{e}</button>
        ))
        : (
          <button type="button" className="reaction feed-reaction-add" onClick={() => setOpen(true)} aria-label="Добавить реакцию" title="Реакция">
            <Icon name="smile" size={13} /><Icon name="plus" size={10} />
          </button>
        )}
    </span>
  );
}

/** «Ознакомился» (§41) — прямо на карточке: ради него объявление и публикуют. */
function AckButton({ post, onUpdated }: { post: NewsPost; onUpdated: (p: NewsPost) => void }) {
  const [busy, setBusy] = useState(false);
  if (post.acked) return <span className="dim feed-acked"><Icon name="check" size={13} /> ознакомились: {post.acks}</span>;
  return (
    <button
      type="button"
      className="ui-btn ui-btn-primary ui-btn-sm"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try { await api.feedAck(post.id); onUpdated({ ...post, acked: true, acks: post.acks + 1, isNew: false }); }
        catch { /* повторим по следующему нажатию */ }
        finally { setBusy(false); }
      }}
    >
      <Icon name="check" size={14} /> Ознакомился
    </button>
  );
}

/**
 * Опрос (§31–37): голос — прямо в ленте, результат — полосами на лету. До голоса
 * результатов не показываем: чужие проценты подталкивают к «как все».
 */
export function PollBlock({ post, onUpdated }: { post: NewsPost; onUpdated: (p: NewsPost) => void }) {
  const poll = post.poll!;
  const [picked, setPicked] = useState<string[]>(poll.options.filter((o) => o.mine).map((o) => o.id));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const showResults = poll.voted || poll.closed;
  const toggle = (id: string) => setPicked((cur) => (poll.multiple ? (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]) : [id]));
  const vote = async () => {
    setBusy(true);
    setErr('');
    try { onUpdated(await api.feedVote(post.id, picked)); feedback('poll.voted'); }
    catch (e) { setErr(e instanceof ApiError ? e.message : 'Голос не учтён'); }
    finally { setBusy(false); }
  };
  return (
    <div className="feed-poll" onClick={(e) => e.stopPropagation()}>
      <h3 className="feed-title">{poll.question}</h3>
      <div className="feed-poll-options" role={showResults ? undefined : poll.multiple ? 'group' : 'radiogroup'}>
        {poll.options.map((o) => {
          const pct = poll.totalVotes ? Math.round((o.votes / poll.totalVotes) * 100) : 0;
          return showResults ? (
            <div key={o.id} className={`feed-poll-result${o.mine ? ' mine' : ''}`}>
              <span className="feed-poll-bar" style={{ width: `${pct}%` }} aria-hidden="true" />
              <span className="feed-poll-label">{o.mine && <Icon name="check" size={12} />} {o.label}</span>
              <span className="feed-poll-pct">{pct}%</span>
            </div>
          ) : (
            <label key={o.id} className={`feed-poll-option${picked.includes(o.id) ? ' on' : ''}`}>
              <input type={poll.multiple ? 'checkbox' : 'radio'} name={`poll-${post.id}`} checked={picked.includes(o.id)} onChange={() => toggle(o.id)} />
              {o.label}
            </label>
          );
        })}
      </div>
      <div className="feed-poll-foot">
        {!poll.closed && !poll.voted && (
          <button type="button" className="ui-btn ui-btn-primary ui-btn-sm" disabled={busy || !picked.length} onClick={() => void vote()}>Голосовать</button>
        )}
        {!poll.closed && poll.voted && (
          <button type="button" className="ui-btn ui-btn-ghost ui-btn-sm" onClick={() => onUpdated({ ...post, poll: { ...poll, voted: false } })}>Переголосовать</button>
        )}
        <span className="dim">
          {poll.closed ? (poll.result ?? 'Опрос завершён') : `голосов: ${poll.voters}`}
          {!poll.closed && poll.deadlineAt ? ` · до ${until(poll.deadlineAt)}` : ''}
          {poll.anonymous ? ' · анонимно' : ''}{poll.multiple ? ' · можно несколько' : ''}
        </span>
        {err && <span className="error-text">{err}</span>}
      </div>
    </div>
  );
}
