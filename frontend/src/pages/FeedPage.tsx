import { useCallback, useEffect, useState } from 'react';
import { useEscape } from '../hooks/useEscape';
import { Avatar } from '../components/Avatar';
import { EmptyState } from '../components/EmptyState';
import { Icon } from '../components/Icon';
import { SkeletonList } from '../components/Skeleton';
import { Lightbox } from '../components/Lightbox';
import { MentionField } from '../components/MentionField';
import { MentionUser, stillMentioned, withMentions } from '../lib/mentions';
import { api, ApiError } from '../lib/api';
import { pageWindow } from '../lib/task-registry-view';
import { useAuth } from '../state/auth';
import { overlayProps } from '../lib/overlay';

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
  files: FeedFile[];
  canManage: boolean;
}

interface FeedFile {
  fileId: string;
  name: string;
  mime: string;
  size: number;
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
  /**
   * Может ли этот человек публиковать. Считает СЕРВЕР и присылает со списком: правило
   * одно (руководитель или должность с правом), и повторять его на клиенте значит
   * однажды разойтись — форма покажется тому, кому ответят отказом.
   */
  const [canPost, setCanPost] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [err, setErr] = useState('');
  const [body, setBody] = useState('');
  const [asAnnouncement, setAsAnnouncement] = useState(false);
  const [activeUntil, setActiveUntil] = useState('');
  const [groups, setGroups] = useState<{ id: string; name: string }[]>([]);
  const [groupIds, setGroupIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [files, setFiles] = useState<File[]>([]);
  /** Форма живёт в попапе: читают новости в сто раз чаще, чем пишут. */
  const [composerOpen, setComposerOpen] = useState(false);
  /** Страница ленты. Считает и отдаёт сервер — на клиенте её пришлось бы угадывать. */
  const [meta, setMeta] = useState({ total: 0, page: 1, pages: 1 });
  const [mentionIds, setMentionIds] = useState<string[]>([]);
  const [team, setTeam] = useState<MentionUser[]>([]);
  /**
   * Открытая новость.
   *
   * В ленте лежат превью, а целиком новость читают в окне: пост на два экрана
   * выталкивал соседние вниз, и «что вообще нового» приходилось собирать прокруткой.
   */
  const [openPost, setOpenPost] = useState<Post | null>(null);

  const reload = useCallback(
    (page = 1): Promise<Post[]> => api.feedList(page)
      .then((r) => {
        setItems(r.items);
        setCanPost(r.canPost !== false);
        setMeta({ total: r.total ?? r.items.length, page: r.page ?? 1, pages: r.pages ?? 1 });
        // Список возвращаем наружу: по ссылке из правой колонки новость надо не
        // только загрузить, но и сразу открыть — а состояние к этому моменту ещё старое.
        return r.items as Post[];
      })
      .catch((e) => {
        setErr(e instanceof ApiError ? e.message : 'Не удалось загрузить ленту');
        return [] as Post[];
      })
      .finally(() => setLoaded(true)),
    [],
  );

  useEffect(() => { void reload(); }, [reload]);

  /**
   * Открыть новость по номеру — так работают ссылки в правой колонке.
   *
   * Чаще всего она уже на этой странице; если нет (объявление месячной давности),
   * возвращаемся на первую и ищем там. Не нашли — молчим: пост мог быть удалён.
   */
  const openById = async (id: string) => {
    const here = items.find((p) => String(p.id) === String(id));
    if (here) return setOpenPost(here);
    const list = await reload(1);
    const found = list.find((p) => String(p.id) === String(id));
    if (found) setOpenPost(found);
  };

  /** Перейти на страницу: прокрутку возвращаем наверх — иначе человек смотрит в середину чужой страницы. */
  const setPage = (page: number) => {
    void reload(page);
    document.querySelector('.feed-scroll')?.scrollTo({ top: 0, behavior: 'smooth' });
  };

  /**
   * Открыть форму. Объявление и обычная новость — один и тот же попап с разным
   * заголовком: поля у них одни, а вот последствия разные, и выбирается это кнопкой
   * снаружи, а не галочкой внутри, которую легко не заметить.
   */
  const openComposer = (announcement: boolean) => {
    setAsAnnouncement(announcement);
    setErr('');
    setComposerOpen(true);
  };

  /** Закрытие черновик НЕ стирает: случайный промах мимо окна не должен стоить текста. */
  const closeComposer = () => setComposerOpen(false);
  useEffect(() => { api.listGroups().then(setGroups).catch(() => undefined); }, []);
  // список сотрудников нужен и подсказке по @, и подсветке упоминаний в готовом тексте
  useEffect(() => {
    api.listUsers()
      .then((list) => setTeam(list.filter((u: any) => u.isActive && u.role !== 'client')
        .map((u: any) => ({ id: String(u.id), fullName: u.fullName, avatarUrl: u.avatarUrl }))))
      .catch(() => undefined);
  }, []);

  const publish = async () => {
    if (!body.trim()) return;
    setBusy(true);
    setErr('');
    try {
      const post = await api.feedCreate({
        body: body.trim(),
        isAnnouncement: asAnnouncement,
        activeUntil: asAnnouncement && activeUntil ? new Date(activeUntil).toISOString() : undefined,
        groupIds,
        // в тексте упоминание живёт именем, но позвали именно этих людей
        mentionIds: stillMentioned(mentionIds, body, team),
      });
      // Файлы прикладываем к уже опубликованному посту: если один не долетит,
      // текст и остальные вложения останутся на месте.
      const failed: string[] = [];
      for (const f of files) {
        try { await api.feedAttach(post.id, f); } catch { failed.push(f.name); }
      }
      if (failed.length) setErr(`Не удалось приложить: ${failed.join(', ')}`);
      setBody('');
      setAsAnnouncement(false);
      setActiveUntil('');
      setGroupIds([]);
      setFiles([]);
      setMentionIds([]);
      setComposerOpen(false);
      // новая новость всегда наверху первой страницы — туда и возвращаемся
      await reload(1);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Не удалось опубликовать');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page feed-page">
      <div className="page-head">
        <h2>Новости компании</h2>
        {/*
          Форма ушла в попап, а на её месте — кнопки.

          Постоянно открытое поле ввода занимало верх экрана у всех, включая тех, кто
          пришёл читать: новости читают в сто раз чаще, чем пишут. Две кнопки, а не
          одна: «новость» и «объявление» — разные по последствиям вещи (объявление
          требует подтверждения прочтения и будит письмом всю компанию), и выбирать
          это галочкой внутри формы значит промахнуться по ней однажды.
        */}
        {canPost && (
          <span className="page-head-actions">
            <button className="btn btn-sm" onClick={() => openComposer(false)}>
              <Icon name="plus" size={14} /> Новость
            </button>
            {canAnnounce && (
              <button className="btn btn-primary btn-sm" onClick={() => openComposer(true)}>
                <Icon name="alert" size={14} /> Объявление
              </button>
            )}
          </span>
        )}
      </div>

      {/*
        Прокручиваемое тело страницы.

        Оболочка приложения не прокручивается специально (шапка и панель обязаны
        оставаться на месте), поэтому у каждой страницы своя область прокрутки. У
        ленты её не было: длинная новость просто уходила за нижний край экрана, и
        добраться до неё было нечем.
      */}
      <div className="feed-scroll">
      {composerOpen && (
      <div className="modal-overlay" {...overlayProps(closeComposer)}>
      <div className="modal-card feed-composer" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-head">
          <h3>{asAnnouncement ? 'Объявление компании' : 'Новость компании'}</h3>
          <button className="btn btn-ghost btn-sm" onClick={closeComposer} title="Закрыть"><Icon name="close" /></button>
        </div>
        {asAnnouncement && (
          // Последствия объявления надо знать ДО отправки, а не узнавать по звонкам
          <p className="dim">
            Объявление подсвечивается в ленте, требует подтверждения прочтения и уходит
            письмом (и в Telegram) тем, кому адресовано.
          </p>
        )}
        <MentionField
          rows={3}
          placeholder={asAnnouncement ? 'Что важно знать всем? Через @ можно позвать человека' : 'Написать всей компании…'}
          value={body}
          users={team}
          onChange={setBody}
          onMention={(id) => setMentionIds((prev) => (prev.includes(id) ? prev : [...prev, id]))}
        />

        <div className="feed-composer-row">
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
          <label className="btn btn-sm feed-attach" title="Приложить файлы к сообщению">
            <Icon name="paperclip" size={14} /> Файл
            <input
              type="file"
              multiple
              hidden
              onChange={(e) => {
                setFiles((prev) => [...prev, ...Array.from(e.target.files ?? [])].slice(0, 10));
                e.target.value = ''; // иначе тот же файл второй раз не выбрать
              }}
            />
          </label>
          <button className="btn btn-primary btn-sm" onClick={publish} disabled={busy || !body.trim()}>
            {busy ? 'Публикую…' : 'Опубликовать'}
          </button>
        </div>

        {files.length > 0 && (
          <div className="feed-chosen">
            {files.map((f, i) => (
              <button
                key={`${f.name}-${i}`}
                className="feed-chip"
                title="Убрать файл"
                onClick={() => setFiles(files.filter((_, x) => x !== i))}
              >
                <Icon name="paperclip" size={11} /> {f.name} <Icon name="close" size={11} />
              </button>
            ))}
          </div>
        )}

        {groupIds.length > 0 && (
          <div className="feed-chosen">
            {groupIds.map((id) => (
              <button key={id} className="feed-chip" onClick={() => setGroupIds(groupIds.filter((x) => x !== id))}>
                {groups.find((g) => String(g.id) === id)?.name ?? id} <Icon name="close" size={11} />
              </button>
            ))}
          </div>
        )}

        {err && <div className="error-text">{err}</div>}
      </div>
      </div>
      )}

      {!canPost && (
        // Молчать нельзя: человек, пришедший «написать всем», должен понимать, почему
        // кнопок нет, — иначе он решит, что раздел сломан.
        <p className="dim">
          Новости компании публикуют руководитель и сотрудники с должностью, которой это
          доверено. Комментировать и читать может каждый.
        </p>
      )}

      {err && !composerOpen && <div className="error-text">{err}</div>}

      {/*
        Две колонки: слева поток, справа короткие списки.

        Так устроены новости во всех корпоративных порталах, и не из моды: лента
        отвечает на «что нового», но не отвечает на «что я мог пропустить» и «что
        вообще происходит в компании». На узком экране колонка уходит вниз — она
        полезная, но не главная.
      */}
      <div className="feed-layout">
        <div className="feed-main">
          {!loaded && <SkeletonList rows={4} />}
          {loaded && items.length === 0 && (
            <EmptyState
              icon="chat"
              title="В ленте пока пусто"
              hint="Здесь живут сообщения всей компании и объявления, которые нужно прочитать каждому."
            />
          )}

          <div className="feed-list">
            {items.map((p) => (
              <PostCard key={p.id} post={p} team={team} onOpen={() => setOpenPost(p)} onChanged={reload} />
            ))}
          </div>

      {/*
        Постраничность — та же, что в реестре задач: один способ листать на всё
        приложение. Появляется, только когда страниц больше одной: одинокая кнопка «1»
        ничего не сообщает и только занимает место.
      */}
      {meta.pages > 1 && (
        <div className="registry-pages">
          <button
            className="registry-page"
            disabled={meta.page <= 1}
            onClick={() => setPage(meta.page - 1)}
            aria-label="Предыдущая страница"
          >
            <Icon name="chevron-left" size={14} />
          </button>
          {pageWindow(meta.page, meta.pages).map((n, i) => (n === 0 ? (
            <span key={`gap${i}`} className="dim">…</span>
          ) : (
            <button
              key={n}
              className={`registry-page${n === meta.page ? ' active' : ''}`}
              onClick={() => setPage(n)}
              aria-current={n === meta.page ? 'page' : undefined}
            >
              {n}
            </button>
          )))}
          <button
            className="registry-page"
            disabled={meta.page >= meta.pages}
            onClick={() => setPage(meta.page + 1)}
            aria-label="Следующая страница"
          >
            <Icon name="chevron-right" size={14} />
          </button>
        </div>
      )}
        </div>

        <FeedAside onOpenPost={openById} />
      </div>
      </div>

      {openPost && (
        <PostModal
          post={openPost}
          team={team}
          onClose={() => setOpenPost(null)}
          onChanged={() => { void reload(meta.page); }}
        />
      )}
    </div>
  );
}

/**
 * Превью новости в ленте.
 *
 * Карточка отвечает на один вопрос: «стоит ли это читать». Поэтому текст обрезан
 * четырьмя строками, картинка показана уголком, а обсуждение и список прочитавших
 * живут в окне. Пост на два экрана выталкивал соседние вниз, и лента переставала
 * быть лентой.
 */
function PostCard({ post, team, onOpen, onChanged }: {
  post: Post; team: MentionUser[]; onOpen: () => void; onChanged: () => void;
}) {
  const images = post.files.filter((f) => f.mime.startsWith('image/'));
  const attention = post.isAnnouncement && !post.isRead;
  return (
    <article
      className={`card feed-post feed-post-card ${post.isAnnouncement ? 'announcement' : ''} ${post.isPinned ? 'pinned' : ''}`}
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(); } }}
      title="Открыть новость"
    >
      <header className="feed-post-head">
        <Avatar path={post.authorAvatar} fallback={post.authorName?.[0]?.toUpperCase() ?? '?'} className="avatar-sm" />
        <span className="feed-author">{post.authorName ?? 'Сотрудник'}</span>
        <span className="dim feed-time">{when(post.createdAt)}</span>
        {post.isPinned && <Icon name="flag" size={13} />}
        {post.isAnnouncement && <span className="feed-badge">объявление</span>}
        {attention && <span className="feed-badge feed-badge-new">не прочитано</span>}
        {post.groups.length > 0 && <span className="dim feed-time">· {post.groups.join(', ')}</span>}
        {/* Управление постом остаётся на карточке: закрепляют и удаляют из списка,
            а не изнутри новости. Клик по кнопке не должен открывать окно. */}
        {post.canManage && (
          <span className="feed-post-actions" onClick={(e) => e.stopPropagation()}>
            <button className="btn btn-ghost btn-sm" onClick={() => api.feedPin(post.id, !post.isPinned).then(onChanged)}>
              {post.isPinned ? 'Открепить' : 'Закрепить'}
            </button>
            <button
              className="btn btn-ghost btn-sm"
              title="Удалить из ленты"
              aria-label="Удалить из ленты"
              onClick={() => { if (window.confirm('Удалить сообщение из ленты?')) api.feedDelete(post.id).then(onChanged); }}
            >
              <Icon name="trash" size={13} />
            </button>
          </span>
        )}
      </header>

      <div className="feed-card-row">
        <div className="feed-body feed-preview"><Body text={post.body} team={team} /></div>
        {/* Картинка уголком: она обещает, что внутри есть на что посмотреть, но не
            занимает пол-экрана в списке. Целиком — в окне новости. */}
        {images.length > 0 && (
          <div className="feed-thumb-wrap">
            <FeedImage file={images[0]} thumb />
            {images.length > 1 && <span className="feed-thumb-more">+{images.length - 1}</span>}
          </div>
        )}
      </div>

      <footer className="feed-post-foot dim">
        <span><Icon name="chat" size={13} /> {post.comments || 0}</span>
        {post.isAnnouncement && <span><Icon name="check" size={13} /> прочитали: {post.reads}</span>}
        {post.files.length > 0 && <span><Icon name="paperclip" size={13} /> {post.files.length}</span>}
        <span className="feed-open-hint">Читать</span>
      </footer>
    </article>
  );
}

/**
 * Правая колонка новостей.
 *
 * Четыре коротких списка: действующие объявления, свежие новости, дни рождения и
 * кто недавно пришёл. Пустые блоки не показываем вовсе — колонка из заголовков с
 * прочерками выглядит сломанной, а не пустой.
 */
function FeedAside({ onOpenPost }: { onOpenPost: (id: string) => void }) {
  const [data, setData] = useState<Awaited<ReturnType<typeof api.feedSidebar>> | null>(null);
  useEffect(() => { api.feedSidebar().then(setData).catch(() => undefined); }, []);
  if (!data) return <aside className="feed-aside" aria-hidden="true" />;

  const birthdayWhen = (b: { inDays: number; date: string }) => {
    if (b.inDays === 0) return 'сегодня';
    if (b.inDays === 1) return 'завтра';
    return new Date(`${b.date}T00:00:00`).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
  };

  const line = (text: string) => text.replace(/\s+/g, ' ').trim().slice(0, 90);

  return (
    <aside className="feed-aside">
      {data.announcements.length > 0 && (
        <div className="card feed-aside-card">
          <h4><Icon name="alert" size={14} /> Объявления</h4>
          {data.announcements.map((a) => (
            <button key={a.id} className="feed-aside-item" onClick={() => onOpenPost(a.id)}>
              <span className={a.isRead ? 'dim' : 'feed-aside-unread'}>{line(a.body)}</span>
              <span className="dim feed-time">{when(a.createdAt)}</span>
            </button>
          ))}
        </div>
      )}

      {data.latest.length > 0 && (
        <div className="card feed-aside-card">
          <h4><Icon name="bell" size={14} /> Последние новости</h4>
          {data.latest.map((n) => (
            <button key={n.id} className="feed-aside-item" onClick={() => onOpenPost(n.id)}>
              <span>{line(n.body)}</span>
              <span className="dim feed-time">{n.authorName ?? ''} · {when(n.createdAt)}</span>
            </button>
          ))}
        </div>
      )}

      {data.birthdays.length > 0 && (
        <div className="card feed-aside-card">
          <h4>🎂 Дни рождения</h4>
          {data.birthdays.map((b) => (
            <div key={b.userId} className={`feed-aside-person${b.inDays === 0 ? ' today' : ''}`}>
              <Avatar path={b.avatarUrl} fallback={b.fullName[0]?.toUpperCase() ?? '?'} className="avatar-sm" />
              <span className="feed-aside-name">{b.fullName}</span>
              <span className="dim feed-time">{birthdayWhen(b)}</span>
            </div>
          ))}
        </div>
      )}

      {data.newcomers.length > 0 && (
        <div className="card feed-aside-card">
          <h4><Icon name="user" size={14} /> Новые в команде</h4>
          {data.newcomers.map((n) => (
            <div key={n.userId} className="feed-aside-person">
              <Avatar path={n.avatarUrl} fallback={n.fullName[0]?.toUpperCase() ?? '?'} className="avatar-sm" />
              <span className="feed-aside-name">{n.fullName}</span>
              <span className="dim feed-time">{n.positionName ?? ''}</span>
            </div>
          ))}
        </div>
      )}
    </aside>
  );
}

/**
 * Картинка новости — во всю ширину карточки.
 *
 * Файлы лежат за авторизацией, поэтому обычный <img src="/api/files/…"> получает отказ:
 * тянем блоб с токеном и показываем его. Ссылку освобождаем при размонтировании — в
 * длинной ленте иначе течёт память.
 */
function FeedImage({ file, onOpen, thumb }: {
  file: FeedFile;
  /** Не задан — картинка не кликается: в превью клик принадлежит самой карточке. */
  onOpen?: (p: { url: string; name: string; mime: string }) => void;
  /** Уголком, а не во всю ширину: так картинка показана в ленте. */
  thumb?: boolean;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let dead = false;
    let objectUrl = '';
    api.authedBlob(`/api/files/${file.fileId}`)
      .then((blob) => {
        if (dead) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      })
      .catch(() => { if (!dead) setFailed(true); });
    return () => { dead = true; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [file.fileId]);

  // Не загрузилась — говорим об этом, а не показываем пустоту: пустое место в новости
  // читается как «тут ничего и не было».
  if (failed) return thumb ? null : <div className="dim">Картинка «{file.name}» не загрузилась</div>;
  if (!url) return <div className={thumb ? 'feed-thumb-skeleton' : 'feed-banner-skeleton'} aria-hidden="true" />;
  if (thumb || !onOpen) return <span className="feed-thumb"><img src={url} alt={file.name} /></span>;
  return (
    <button
      className="feed-banner"
      onClick={() => onOpen({ url, name: file.name, mime: file.mime })}
      title="Открыть во весь экран"
    >
      <img src={url} alt={file.name} />
    </button>
  );
}

/** Скачивание с токеном: голая ссылка на файл за авторизацией отдаёт отказ. */
async function downloadFile(file: FeedFile): Promise<void> {
  try {
    const blob = await api.authedBlob(`/api/files/${file.fileId}`);
    const href = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = href;
    a.download = file.name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(href), 5000);
  } catch { /* кнопка — удобство; молчаливый отказ лучше ошибки поверх ленты */ }
}

/**
 * Новость целиком — в окне поверх ленты.
 *
 * Здесь всё, чего нет в превью: полный текст, все картинки, файлы, список
 * прочитавших и обсуждение. Читают по одной новости за раз, поэтому окно, а не
 * разворачивание на месте: развёрнутый пост сдвигал ленту под курсором.
 */
function PostModal({ post, team, onChanged, onClose }: {
  post: Post; team: MentionUser[]; onChanged: () => void; onClose: () => void;
}) {
  useEscape(onClose);
  const [comments, setComments] = useState<Comment[] | null>(null);
  /** Сколько комментариев осталось выше загруженных: цифра на кнопке «показать предыдущие». */
  const [more, setMore] = useState(0);
  const [text, setText] = useState('');
  const [mentionIds, setMentionIds] = useState<string[]>([]);
  /** Что показываем во весь экран: уже загруженный блоб, а не адрес за авторизацией. */
  const [preview, setPreview] = useState<{ url: string; name: string; mime: string } | null>(null);
  const images = post.files.filter((f) => f.mime.startsWith('image/'));
  const docs = post.files.filter((f) => !f.mime.startsWith('image/'));
  const [readers, setReaders] = useState<{ read: { fullName: string }[]; pending: { fullName: string }[] } | null>(null);
  const [read, setRead] = useState(post.isRead);

  /**
   * Открыть обсуждение: показываем ПОСЛЕДНИЕ десять.
   *
   * Обсуждение читают с конца — важно, чем всё кончилось, а не начало переписки
   * трёхмесячной давности. Старшие поднимаются кнопкой.
   */
  const openComments = useCallback(async () => {
    const r = await api.feedComments(post.id).catch(() => ({ items: [], total: 0, hasMore: false }));
    setComments(r.items);
    setMore(r.hasMore ? r.total - r.items.length : 0);
  }, [post.id]);

  // Обсуждение подгружаем сразу: в окно и заходят, чтобы прочитать целиком —
  // включая то, что по новости уже сказали.
  useEffect(() => { void openComments(); }, [openComments]);

  /** Поднять предыдущие: докладываем их СВЕРХУ, не трогая уже прочитанное. */
  const loadEarlier = async () => {
    const first = comments?.[0]?.id;
    if (!first) return;
    const r = await api.feedComments(post.id, first).catch(() => ({ items: [], total: 0, hasMore: false }));
    setComments([...r.items, ...(comments ?? [])]);
    setMore(r.hasMore ? r.total - r.items.length - (comments?.length ?? 0) : 0);
  };

  const send = async () => {
    if (!text.trim()) return;
    const called = stillMentioned(mentionIds, text, team);
    const r = await api.feedComment(post.id, text.trim(), called)
      .catch(() => ({ items: comments ?? [], total: 0, hasMore: false }));
    setComments(r.items);
    setMore(r.hasMore ? r.total - r.items.length : 0);
    setText('');
    setMentionIds([]);
    onChanged();
  };

  const confirmRead = async () => {
    await api.feedRead(post.id).catch(() => undefined);
    // Отметку показываем сразу: список за окном перезагрузится, но `post` в окне
    // остался прежним, и кнопка «Прочитал» иначе висела бы как ни в чём не бывало.
    setRead(true);
    onChanged();
  };

  const showReaders = async () => {
    if (readers) return setReaders(null);
    setReaders(await api.feedReaders(post.id).catch(() => null));
  };

  return (
    <div className="modal-overlay" {...overlayProps(onClose)}>
    <article
      className={`modal-card feed-post feed-post-full ${post.isAnnouncement ? 'announcement' : ''} ${post.isPinned ? 'pinned' : ''}`}
      onClick={(e) => e.stopPropagation()}
    >
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
                if (window.confirm('Удалить сообщение из ленты?')) {
                  api.feedDelete(post.id).then(() => { onChanged(); onClose(); });
                }
              }}>
                <Icon name="trash" size={13} />
              </button>
            </>
          )}
          <button className="btn btn-ghost btn-sm" onClick={onClose} title="Закрыть" aria-label="Закрыть">
            <Icon name="close" size={16} />
          </button>
        </span>
      </header>

      <div className="feed-body"><Body text={post.body} team={team} /></div>

      {/*
        Картинка в новости — БАННЕР, а не строчка «файл».

        Раньше приложенный к посту снимок выглядел как «image.png», и открыть его было
        нельзя вовсе: файлы лежат за авторизацией, а ссылку мы отдавали браузеру голой —
        он приходил без токена и получал отказ. Теперь картинки показываются прямо в
        новости (блоб тянется с токеном), а всё остальное остаётся строкой с размером.
      */}
      {images.length > 0 && (
        <div className={`feed-banners${images.length > 1 ? ' many' : ''}`}>
          {images.map((f) => (
            <FeedImage key={f.fileId} file={f} onOpen={setPreview} />
          ))}
        </div>
      )}
      {docs.length > 0 && (
        <div className="feed-files">
          {docs.map((f) => (
            <button
              key={f.fileId}
              className="feed-file"
              onClick={() => downloadFile(f)}
              title="Скачать"
            >
              <Icon name="file" size={14} />
              <span className="feed-file-name">{f.name}</span>
              <span className="dim">{fileSize(f.size)}</span>
            </button>
          ))}
        </div>
      )}
      {preview && (
        <Lightbox
          url={preview.url}
          name={preview.name}
          mime={preview.mime}
          onClose={() => setPreview(null)}
        />
      )}

      {/* Подтверждение прочтения — суть объявления, у обычной новости этой строки нет */}
      {post.isAnnouncement && (
        <footer className="feed-post-foot">
          {!read && (
            <button className="btn btn-primary btn-sm" onClick={confirmRead}>
              <Icon name="check" size={14} /> Прочитал
            </button>
          )}
          {read && <span className="dim"><Icon name="check" size={13} /> вы прочитали</span>}
          <button className="btn btn-ghost btn-sm" onClick={showReaders}>
            Прочитали: {post.reads}
          </button>
        </footer>
      )}

      {readers && (
        <div className="feed-readers">
          <div><b>Прочитали:</b> {readers.read.map((r) => r.fullName).join(', ') || '—'}</div>
          <div className="dim"><b>Ещё нет:</b> {readers.pending.map((r) => r.fullName).join(', ') || '—'}</div>
        </div>
      )}

      {comments && (
        <div className="feed-comments">
          {/* Сколько ещё наверху — говорим числом: «показать ещё» без числа не даёт
              понять, там три сообщения или триста. */}
          {more > 0 && (
            <button className="btn btn-ghost btn-sm feed-earlier" onClick={loadEarlier}>
              <Icon name="chevron-up" size={13} /> Показать предыдущие ({more})
            </button>
          )}
          {comments.map((c) => (
            <div key={c.id} className="feed-comment">
              <Avatar path={c.avatarUrl} fallback={c.fullName?.[0]?.toUpperCase() ?? '?'} className="avatar-sm" />
              <div>
                <div className="feed-comment-head">
                  <b>{c.fullName}</b> <span className="dim feed-time">{when(c.createdAt)}</span>
                </div>
                <div><Body text={c.body} team={team} /></div>
              </div>
            </div>
          ))}
          <div className="feed-comment-new">
            <MentionField
              placeholder="Ответить… через @ можно позвать человека"
              value={text}
              users={team}
              onChange={setText}
              onMention={(id) => setMentionIds((prev) => (prev.includes(id) ? prev : [...prev, id]))}
              onEnter={send}
            />
            <button className="btn btn-sm" onClick={send} disabled={!text.trim()}>Отправить</button>
          </div>
        </div>
      )}
    </article>
    </div>
  );
}

/** Размер файла человеческими словами: «2,4 МБ» вместо 2516582. */
function fileSize(bytes: number): string {
  if (!bytes) return '';
  const mb = bytes / 1024 / 1024;
  return mb >= 1 ? `${mb.toFixed(1).replace('.', ',')} МБ` : `${Math.max(1, Math.round(bytes / 1024))} КБ`;
}

/** Текст сообщения: упомянутые имена выделяем, всё остальное — как написано. */
function Body({ text, team }: { text: string; team: MentionUser[] }) {
  return (
    <>
      {withMentions(text, team).map((part, i) =>
        typeof part === 'string'
          ? <span key={i}>{part}</span>
          : <span key={i} className="mention">@{part.name}</span>)}
    </>
  );
}
