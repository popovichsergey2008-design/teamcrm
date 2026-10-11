import './news.css';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Avatar } from '../../components/Avatar';
import { EmptyState } from '../../components/EmptyState';
import { Icon } from '../../components/Icon';
import { SkeletonList } from '../../components/Skeleton';
import { DropdownMenu, MenuItem } from '../../components/ui/dropdown-menu';
import { Tabs } from '../../components/ui/tabs';
import { api, ApiError, NewsCan, NewsFilter, NewsPost } from '../../lib/api';
import { MentionUser } from '../../lib/mentions';
import { getSocket } from '../../lib/socket';
import { navigate } from '../../lib/router';
import { initialsOf } from '../../lib/initials';
import { useAuth } from '../../state/auth';
import { KudosDialog, PollDialog, PostComposer, ReleaseDialog } from './Composers';
import { PostCard } from './PostCard';
import { PostModal } from './PostModal';
import { ReviewPanel, SettingsDialog } from './Review';
import { until, when } from './shared';

const FILTERS: { value: NewsFilter; label: string }[] = [
  { value: 'all', label: 'Все' },
  { value: 'highlights', label: 'Хайлайты' },
  { value: 'kudos', label: 'Спасибо' },
  { value: 'releases', label: 'Релизы' },
  { value: 'polls', label: 'Опросы' },
  { value: 'announcements', label: 'Объявления' },
];

const NO_CAN: NewsCan = { post: false, announce: false, poll: false, pin: false, approve: false, manage: false, kudos: true };

/**
 * «Новости» (ТЗ-20): что важного, хорошего и общего произошло в компании.
 *
 * Наверху — закреплённое и AI-Хайлайты дня, ниже — лента по времени без системного
 * шума: только то, что опубликовали люди (новость, объявление, спасибо, опрос, релиз)
 * или система по поводу (хайлайт, выводы недели, веха). Всё обновляется на лету.
 */
export function FeedPage({ postId }: { postId?: string }) {
  const { user } = useAuth();
  const meId = String(user?.id ?? '');
  const [filter, setFilter] = useState<NewsFilter>('all');
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const [top, setTop] = useState<NewsPost[]>([]);
  const [items, setItems] = useState<NewsPost[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [can, setCan] = useState<NewsCan>(NO_CAN);
  const [loaded, setLoaded] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [err, setErr] = useState('');
  const [fresh, setFresh] = useState(0);
  const [team, setTeam] = useState<MentionUser[]>([]);
  const [open, setOpen] = useState<NewsPost | null>(null);
  const [dialog, setDialog] = useState<null | 'post' | 'announcement' | 'kudos' | 'poll' | 'release' | 'settings'>(null);
  const [kudosFor, setKudosFor] = useState<string | undefined>(undefined);
  const [reviewKey, setReviewKey] = useState(0);
  const [asideKey, setAsideKey] = useState(0);
  const [justAdded, setJustAdded] = useState<string | null>(null);
  const loadedIds = useRef(new Set<string>());

  useEffect(() => { const t = window.setTimeout(() => setQuery(q.trim()), 300); return () => window.clearTimeout(t); }, [q]);

  const load = useCallback(async () => {
    try {
      const r = await api.feedList({ filter, q: query || undefined });
      setTop(r.top);
      setItems(r.items);
      setCursor(r.nextCursor);
      setCan(r.can);
      setErr('');
      setFresh(0);
      return r;
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Не удалось загрузить «Новости»');
      return null;
    } finally {
      setLoaded(true);
    }
  }, [filter, query]);

  useEffect(() => { void load(); }, [load]);

  // зашёл в раздел — всё до этого момента уже не «новое» (§47–48); метки «новое» в
  // этой загрузке остаются, чтобы было видно, что появилось с прошлого раза
  useEffect(() => {
    void api.feedSeen().then(() => window.dispatchEvent(new Event('teamcrm:news-seen'))).catch(() => undefined);
  }, []);

  useEffect(() => {
    api.listUsers()
      .then((list) => setTeam(list.filter((u: any) => u.isActive && u.role !== 'client')
        .map((u: any) => ({ id: String(u.id), fullName: u.fullName, avatarUrl: u.avatarUrl }))))
      .catch(() => undefined);
  }, []);

  useEffect(() => { loadedIds.current = new Set([...top, ...items].map((p) => p.id)); }, [top, items]);

  /** Заменить пост на месте — в ленте, наверху и в открытом окне. */
  const replace = useCallback((p: NewsPost) => {
    setTop((cur) => cur.map((x) => (x.id === p.id ? p : x)));
    setItems((cur) => cur.map((x) => (x.id === p.id ? p : x)));
    setOpen((cur) => (cur && cur.id === p.id ? p : cur));
  }, []);
  const drop = useCallback((id: string) => {
    setTop((cur) => cur.filter((x) => x.id !== id));
    setItems((cur) => cur.filter((x) => x.id !== id));
  }, []);

  /** Своё — сразу наверх, с короткой анимацией (§78), без перезагрузки ленты. */
  const added = (p: NewsPost) => {
    if (p.status !== 'published') { setReviewKey((k) => k + 1); return; }
    setItems((cur) => [p, ...cur.filter((x) => x.id !== p.id)]);
    setJustAdded(p.id);
    setAsideKey((k) => k + 1);
    window.setTimeout(() => setJustAdded(null), 1600);
  };

  /*
    На лету (§73, §93): сервер говорит «пост N изменился» — перечитываем ровно его.
    Чужое новое не вставляем под курсор, а показываем плашкой «Новые публикации» —
    лента не прыгает, пока человек читает.
  */
  useEffect(() => {
    const socket = getSocket();
    const onChanged = (p: { postId: string; kind: string }) => {
      const id = String(p.postId);
      if (p.kind === 'deleted') { drop(id); setAsideKey((k) => k + 1); return; }
      if (p.kind === 'draft') { setReviewKey((k) => k + 1); return; }
      if (p.kind === 'created') {
        if (loadedIds.current.has(id)) return; // своё уже вставили
        setFresh((n) => n + 1);
        setAsideKey((k) => k + 1);
        setReviewKey((k) => k + 1);
        return;
      }
      if (!loadedIds.current.has(id)) return;
      api.feedGet(id).then(replace).catch(() => drop(id));
    };
    socket.on('feed.changed', onChanged);
    return () => { socket.off('feed.changed', onChanged); };
  }, [replace, drop]);

  // ссылка на пост (/news/123 — из письма, push, хайлайта) — открыть его поверх ленты
  useEffect(() => {
    if (!postId) return;
    api.feedGet(postId).then(setOpen).catch(() => setErr('Эта новость удалена или вам недоступна'));
  }, [postId]);
  const closeModal = () => { setOpen(null); if (postId) navigate({ section: 'news' }, { replace: true }); };

  const more = async () => {
    if (!cursor) return;
    setLoadingMore(true);
    try {
      const r = await api.feedList({ filter, q: query || undefined, before: cursor });
      setItems((cur) => [...cur, ...r.items.filter((x) => !cur.some((y) => y.id === x.id))]);
      setCursor(r.nextCursor);
    } catch { /* кнопка останется — нажмут ещё раз */ }
    finally { setLoadingMore(false); }
  };

  const highlight = top.find((p) => p.type === 'highlight');
  const pinned = top.filter((p) => p !== highlight);

  return (
    <div className="page feed-page">
      <div className="page-head feed-head">
        <h2>Новости</h2>
        <span className="page-head-actions">
          <button type="button" className="ui-btn ui-btn-outline ui-btn-sm" onClick={() => { setKudosFor(undefined); setDialog('kudos'); }}>
            <Icon name="heart" size={14} /> Сказать спасибо
          </button>
          <DropdownMenu trigger={<button type="button" className="ui-btn ui-btn-primary ui-btn-sm"><Icon name="plus" size={14} /> Создать</button>}>
            {can.post && <MenuItem icon={<Icon name="chat" size={14} />} onSelect={() => setDialog('post')}>Новость</MenuItem>}
            {can.announce && <MenuItem icon={<Icon name="megaphone" size={14} />} onSelect={() => setDialog('announcement')}>Важное объявление</MenuItem>}
            <MenuItem icon={<Icon name="heart" size={14} />} onSelect={() => { setKudosFor(undefined); setDialog('kudos'); }}>Спасибо коллеге</MenuItem>
            {can.poll && <MenuItem icon={<Icon name="chart" size={14} />} onSelect={() => setDialog('poll')}>Опрос</MenuItem>}
            {can.post && <MenuItem icon={<Icon name="rocket" size={14} />} onSelect={() => setDialog('release')}>Объявить релиз</MenuItem>}
          </DropdownMenu>
        </span>
      </div>

      <div className="feed-scroll">
        <div className="feed-toolbar">
          <Tabs value={filter} onValueChange={setFilter} items={FILTERS} ariaLabel="Что показать" className="feed-tabs" />
          <label className="feed-search">
            <Icon name="search" size={14} />
            <input className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Поиск: заголовок, текст, автор, проект" aria-label="Поиск по новостям" />
          </label>
        </div>

        {err && <div className="error-text" role="alert">{err}</div>}

        <div className="feed-layout">
          <div className="feed-main">
            {can.approve && <ReviewPanel key={reviewKey} onPublished={added} onOpenSettings={() => setDialog('settings')} />}

            {fresh > 0 && (
              <button type="button" className="feed-fresh" onClick={() => { void load(); document.querySelector('.feed-scroll')?.scrollTo({ top: 0, behavior: 'smooth' }); }}>
                <Icon name="arrow-up" size={13} /> Новые публикации: {fresh} — показать
              </button>
            )}

            {highlight && (
              <PostCard post={highlight} team={team} featured onOpen={() => setOpen(highlight)} onUpdated={replace} />
            )}
            {pinned.map((p) => (
              <PostCard key={p.id} post={p} team={team} onOpen={() => setOpen(p)} onUpdated={replace} />
            ))}

            {!loaded && <SkeletonList rows={4} />}
            {loaded && !top.length && !items.length && !err && (
              query || filter !== 'all'
                ? <EmptyState icon="search" title="Ничего не нашлось" hint="Попробуйте другой фильтр или слова поиска." />
                : (
                  <EmptyState
                    icon="sparkles"
                    title="Здесь появятся победы команды"
                    hint="Релизы, благодарности, важные объявления и опросы. Системного шума — статусов и комментариев задач — здесь не будет."
                    action={{ label: 'Сказать спасибо коллеге', onClick: () => setDialog('kudos') }}
                  />
                )
            )}

            <div className="feed-list">
              {items.map((p) => (
                <div key={p.id} className={justAdded === p.id ? `feed-just-added feed-just-${p.type}` : undefined}>
                  <PostCard post={p} team={team} onOpen={() => setOpen(p)} onUpdated={replace} />
                </div>
              ))}
            </div>
            {cursor && (
              <button type="button" className="ui-btn ui-btn-outline ui-btn-sm feed-more" onClick={() => void more()} disabled={loadingMore}>
                {loadingMore ? 'Загружаю…' : 'Показать ещё'}
              </button>
            )}
          </div>

          <FeedAside
            key={asideKey}
            onOpenPost={(id) => api.feedGet(id).then(setOpen).catch(() => undefined)}
            onCongrats={(userId) => { setKudosFor(userId); setDialog('kudos'); }}
            meId={meId}
          />
        </div>
      </div>

      {open && <PostModal post={open} team={team} onClose={closeModal} onUpdated={replace} onDeleted={drop} />}

      <PostComposer open={dialog === 'post' || dialog === 'announcement'} announcement={dialog === 'announcement'} team={team} canPin={can.pin}
        onClose={() => setDialog(null)} onPublished={added} />
      <KudosDialog open={dialog === 'kudos'} team={team} meId={meId} presetUserId={kudosFor} onClose={() => setDialog(null)} onPublished={added} />
      <PollDialog open={dialog === 'poll'} team={team} onClose={() => setDialog(null)} onPublished={added} />
      <ReleaseDialog open={dialog === 'release'} onClose={() => setDialog(null)} onPublished={added} />
      <SettingsDialog open={dialog === 'settings'} onClose={() => setDialog(null)} />
    </div>
  );
}

/**
 * Правая колонка: объявления, ждущие «Ознакомился», опросы, где вы ещё не голосовали,
 * дни рождения (с «Поздравить» — тем же «спасибо», только по поводу) и новички.
 */
function FeedAside({ onOpenPost, onCongrats, meId }: { onOpenPost: (id: string) => void; onCongrats: (userId: string) => void; meId: string }) {
  const [data, setData] = useState<Awaited<ReturnType<typeof api.feedSidebar>> | null>(null);
  useEffect(() => { api.feedSidebar().then(setData).catch(() => undefined); }, []);
  if (!data) return <aside className="feed-aside" aria-hidden="true" />;
  const birthdayWhen = (b: { inDays: number; date: string }) => (b.inDays === 0 ? 'сегодня' : b.inDays === 1 ? 'завтра'
    : new Date(`${b.date}T00:00:00`).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' }));
  const line = (text: string) => text.replace(/\s+/g, ' ').trim().slice(0, 90);
  return (
    <aside className="feed-aside">
      {data.announcements.length > 0 && (
        <div className="card feed-aside-card">
          <h4><Icon name="megaphone" size={14} /> Объявления</h4>
          {data.announcements.map((a) => (
            <button key={a.id} type="button" className="feed-aside-item" onClick={() => onOpenPost(a.id)}>
              <span className={a.needsAck ? 'feed-aside-unread' : 'dim'}>{line(a.title || a.body)}</span>
              <span className="dim feed-time">{a.needsAck ? 'ждёт «Ознакомился» · ' : ''}{when(a.createdAt)}</span>
            </button>
          ))}
        </div>
      )}
      {data.polls.length > 0 && (
        <div className="card feed-aside-card">
          <h4><Icon name="chart" size={14} /> Проголосуйте</h4>
          {data.polls.map((p) => (
            <button key={p.id} type="button" className="feed-aside-item" onClick={() => onOpenPost(p.id)}>
              <span className="feed-aside-unread">{line(p.question)}</span>
              {p.deadlineAt && <span className="dim feed-time">до {until(p.deadlineAt)}</span>}
            </button>
          ))}
        </div>
      )}
      {data.birthdays.length > 0 && (
        <div className="card feed-aside-card">
          <h4>🎂 Дни рождения</h4>
          {data.birthdays.map((b) => (
            <div key={b.userId} className={`feed-aside-person${b.inDays === 0 ? ' today' : ''}`}>
              <Avatar path={b.avatarUrl} fallback={initialsOf(b.fullName)} className="avatar-sm" />
              <span className="feed-aside-name">{b.fullName}</span>
              <span className="dim feed-time">{birthdayWhen(b)}</span>
              {b.inDays === 0 && b.userId !== meId && (
                <button type="button" className="ui-btn ui-btn-ghost ui-btn-icon-sm" title="Поздравить" aria-label={`Поздравить ${b.fullName}`} onClick={() => onCongrats(b.userId)}>
                  <Icon name="party" size={13} />
                </button>
              )}
            </div>
          ))}
        </div>
      )}
      {data.newcomers.length > 0 && (
        <div className="card feed-aside-card">
          <h4><Icon name="user-plus" size={14} /> Новые в команде</h4>
          {data.newcomers.map((n) => (
            <div key={n.userId} className="feed-aside-person">
              <Avatar path={n.avatarUrl} fallback={initialsOf(n.fullName)} className="avatar-sm" />
              <span className="feed-aside-name">{n.fullName}</span>
              <span className="dim feed-time">{n.positionName ?? ''}</span>
            </div>
          ))}
        </div>
      )}
    </aside>
  );
}
