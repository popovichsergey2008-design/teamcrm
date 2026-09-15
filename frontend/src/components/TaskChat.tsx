import { useEffect, useMemo, useRef, useState } from 'react';
import { EmptyState } from './EmptyState';
import { Icon } from './Icon';
import { MentionField } from './MentionField';
import { VoiceStatus } from './VoiceStatus';
import { ChatAttachment } from './ChatAttachment';
import { Lightbox } from './Lightbox';
import { api, ApiError } from '../lib/api';
import { dayLabel, sameGroup, stampLabel } from '../lib/chat-text';
import { MessageText } from './MessageText';
import { humanSize, isAnonymousClipboardName, isImageName, screenshotName } from '../lib/attachments';
import { orderMentions } from '../lib/task-mentions';
import { useVoiceInput } from '../hooks/useVoiceInput';
import { useAuth } from '../state/auth';
import { getSocket } from '../lib/socket';

/** Реакции: ответить «ок» знаком, не засоряя обсуждение и не будя участников. */
const REACTIONS = ['👍', '❤️', '🔥', '👏', '😁', '🤔'];

/**
 * Помощник в списке упоминаний.
 *
 * Зовут его так же, как коллегу, — через «@». Отдельная кнопка делала из ИИ
 * инструмент в стороне от разговора, хотя он участник этого разговора.
 */
const AI_MENTION_ID = 'ai';
const AI_MENTION_NAME = 'AnthillBot';
/**
 * «@AnthillBot», «@AI», «@бот» — человек пишет как придётся, и старые написания
 * обязаны работать: они уже в чужой переписке и в чужих привычках.
 *
 * ГРАБЛИ: `\\b` и `\\w` не видят кириллицу, из-за чего «@ии» не срабатывало
 * вовсе — границу слова проверяем явным классом.
 */
const MENTIONS_AI = /@(anthillbot|ai|ии|ai-помощник|бот)(?![\wа-яё-])/gi;

/** Частые вопросы помощнику — чтобы не формулировать заново то, что спрашивают всегда. */
const QUICK_ASKS: { label: string; ask: string }[] = [
  { label: 'Объяснить задачу', ask: 'Объясни коротко и простыми словами, что от меня требуется по этой задаче.' },
  { label: 'Составить план', ask: 'Предложи порядок действий по этой задаче.' },
  { label: 'Что осталось', ask: 'Что по этой задаче ещё не сделано? Сверься с чек-листом и обсуждением.' },
  { label: 'Резюме обсуждения', ask: 'Кратко подведи итог обсуждения: что решили, что изменилось, какие вопросы открыты.' },
  { label: 'Отчёт постановщику', ask: 'Подготовь короткий отчёт о проделанной работе для постановщика.' },
];

/** Событие истории по-русски: строка вида «participant_added» человеку ничего не говорит. */
const ACTIVITY_LABEL: Record<string, string> = {
  created: 'создал задачу',
  updated: 'изменил поля',
  moved: 'перенёс',
  commented: 'написал сообщение',
  attached: 'приложил файл',
  checklist: 'правил чек-лист',
  label: 'менял метки',
  handoff_forced: 'сдал работу без полной готовности',
  participant_added: 'добавил участника',
  participant_removed: 'убрал участника',
  approval_requested: 'сдал работу на согласование',
  approval_confirmed: 'принял работу',
  approval_returned: 'вернул на доработку',
  approval_setting: 'изменил правило согласования',
  merged_in: 'объединил сюда другую задачу',
  merged_into: 'объединил эту задачу с другой',
};

function activityText(a: { kind: string; detail?: Record<string, any> }): string {
  const label = ACTIVITY_LABEL[a.kind] ?? a.kind;
  if (a.kind === 'moved' && a.detail?.to) return `${label} в «${a.detail.to}»`;
  if (a.kind === 'approval_returned' && a.detail?.reason) return `${label}: ${a.detail.reason}`;
  // Номер обязателен: «объединил» без номера не отвечает на вопрос «с чем».
  if ((a.kind === 'merged_in' || a.kind === 'merged_into') && a.detail?.taskId) {
    return `${label} #${a.detail.taskId}${a.detail.title ? ` «${a.detail.title}»` : ''}`;
  }
  // обход приёмки без списка нехваток бесполезен: ради этого списка запись и делается
  if (a.kind === 'handoff_forced' && Array.isArray(a.detail?.missing)) {
    return `${label}: ${a.detail.missing.join('; ')}`;
  }
  return label;
}

const initials = (name: string) => (name?.trim()?.[0] ?? '?').toUpperCase();

/**
 * Чат задачи: разговор команды и помощник, который знает эту задачу.
 *
 * Устроен как переписка, а не как список комментариев: сообщения одного человека
 * подряд склеиваются, дни разделены, картинки видны сразу, ответить можно на
 * выделенный кусок. Разница не косметическая — по задаче спорят, договариваются и
 * возвращаются к сказанному через неделю, и «кто, когда и о чём» должно читаться
 * взглядом, а не восстанавливаться по датам.
 *
 * История задачи внизу — не украшение: строка «написал сообщение» ведёт к самому
 * сообщению. Без этого история отсылает в никуда.
 */
export function TaskChat({
  taskId, assigneeId, creatorId, participants = [], onRefresh,
  wide = false, title, status, onExpand, onCollapse,
}: {
  taskId: string;
  /** Кто в этой задаче кто — от этого зависит порядок подсказки при «@». */
  assigneeId?: string | null;
  creatorId?: string | null;
  participants?: { user_id: string; role: string }[];
  onRefresh: () => void;
  /**
   * Разговор во всю ширину карточки (вкладка «Чат»).
   *
   * В узкой колонке справа абзац из пяти строк превращается в двадцать — на это и
   * жаловались. Компонент один и тот же: расходятся только ширина и шапка, а вся
   * механика (ответы, реакции, поиск, ИИ) остаётся общей и не разъезжается.
   */
  wide?: boolean;
  /** Название задачи и колонка — подпись в шапке: о чём разговор и на каком этапе. */
  title?: string;
  status?: string | null;
  /** Развернуть из колонки во вкладку и обратно. */
  onExpand?: () => void;
  onCollapse?: () => void;
}) {
  const { user } = useAuth();
  const [comments, setComments] = useState<any[]>([]);
  const [activity, setActivity] = useState<any[]>([]);
  const [users, setUsers] = useState<{ id: string; fullName: string }[]>([]);
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  /** Поиск по обсуждению: в переписке на сотню сообщений нужное иначе не найти. */
  const [query, setQuery] = useState('');
  /** Поиск прячется за лупой в шапке: над лентой он отнимает место у разговора. */
  const [searchOpen, setSearchOpen] = useState(false);
  /** Кому отвечаем и на какой именно кусок его сообщения. */
  const [replyTo, setReplyTo] = useState<{ id: string; author: string; excerpt: string } | null>(null);
  /** Правка своего сообщения: сказанное вслух не переписывают, написанное — да. */
  const [editing, setEditing] = useState<{ id: string; body: string } | null>(null);
  /** Файл, выбранный или вставленный, но ещё не отправленный. */
  const [pending, setPending] = useState<{ file: File; url: string } | null>(null);
  /** Куда прокрутили из истории — подсвечиваем, иначе непонятно, что именно нашли. */
  const [highlight, setHighlight] = useState<string | null>(null);
  /** У какого сообщения открыт выбор реакции: набор из шести эмодзи в каждой строке — мусор. */
  const [reactFor, setReactFor] = useState<string | null>(null);
  const [allHistory, setAllHistory] = useState(false);
  const [preview, setPreview] = useState<{ url: string; name: string; mime: string } | null>(null);
  const [advice, setAdvice] = useState<{
    answer: string; checklist: string[]; suggestion: { field: string; value: string; label: string } | null;
  } | null>(null);
  const feedRef = useRef<HTMLDivElement | null>(null);

  /**
   * Загружена ли переписка целиком.
   *
   * Карточка открывается с хвостом в сто сообщений: у импортированной задачи их
   * бывают сотни, и рисовать всё разом — это пауза при открытии ради того, что
   * человек не читает. Кнопка сверху поднимает остальное.
   */
  const [fullyLoaded, setFullyLoaded] = useState(false);

  const reload = (all = false) => {
    api.listComments(taskId, all)
      .then((rows) => {
        setComments(rows);
        // «Всё загружено» решаем по факту: пришло меньше предела — выше ничего нет
        if (all || rows.length < 100) setFullyLoaded(true);
      })
      .catch(() => undefined);
    api.taskActivity(taskId).then(setActivity).catch(() => undefined);
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { reload(); }, [taskId]);
  /*
    Живое обсуждение задачи.

    Раньше карточка не слушала сокет вовсе: коллега писал в обсуждении, а увидеть это
    можно было только перезагрузкой страницы или переоткрытием задачи. В чатах так
    давно не работает — в задачах должно быть так же.

    Перечитываем пачкой: на бурное обсуждение прилетает десяток событий подряд, и
    десять запросов подряд ради одного и того же списка не нужны. Своё сообщение
    уже на экране — перечитывание его не двоит, список приходит с сервера целиком.
  */
  useEffect(() => {
    const socket = getSocket();
    let timer: number | null = null;
    const soon = (p: { taskId?: string }) => {
      if (String(p?.taskId ?? '') !== String(taskId)) return;
      if (timer) return;
      timer = window.setTimeout(() => { timer = null; reload(fullyLoaded); }, 350);
    };
    for (const ev of ['task.comment_added', 'task.attachment_added', 'task.comment_deleted']) socket.on(ev, soon);
    // связь моргнула — догоняем пропущенное, иначе обсуждение застынет на моменте обрыва
    const onReconnect = () => reload(fullyLoaded);
    socket.on('connect', onReconnect);
    return () => {
      for (const ev of ['task.comment_added', 'task.attachment_added', 'task.comment_deleted']) socket.off(ev, soon);
      socket.off('connect', onReconnect);
      if (timer) window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId, fullyLoaded]);

  // Отчёт проверки ИИ ложится в переписку с сервера — обсуждение обязано его показать
  // сразу, а не после переоткрытия карточки.
  useEffect(() => {
    const onExternal = (e: Event) => {
      const id = (e as CustomEvent<{ taskId?: string }>).detail?.taskId;
      if (!id || String(id) === String(taskId)) reload();
    };
    window.addEventListener('teamcrm:task-chat-reload', onExternal);
    return () => window.removeEventListener('teamcrm:task-chat-reload', onExternal);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId]);
  useEffect(() => {
    api.listUsers()
      .then((team: any[]) => setUsers(team.map((u) => ({ id: String(u.id), fullName: u.fullName }))))
      .catch(() => undefined);
  }, []);

  /**
   * Скриншот из буфера — как в мессенджерах: Ctrl+V, и он в обсуждении.
   *
   * Слушаем окно, пока карточка открыта: человек снимает экран, возвращается в задачу
   * и жмёт вставку, не целясь в поле ввода. Текстовую вставку это не задевает —
   * реагируем, только если в буфере действительно файл-картинка.
   */
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const file = Array.from(e.clipboardData?.files ?? []).find((f) => f.type.startsWith('image/'));
      if (!file) return;
      e.preventDefault();
      attach(file);
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId]);

  /**
   * Список для «@»: сначала помощник, потом те, кто в этой задаче участвует.
   *
   * Общий алфавитный перечень сотрудников почти бесполезен — зовут не «кого-нибудь
   * из компании», а участников задачи. Порядок зависит от того, кто пишет: исполнителю
   * первым нужен постановщик, постановщику — исполнитель.
   */
  const mentionUsers = orderMentions(
    [{ id: AI_MENTION_ID, fullName: AI_MENTION_NAME, hint: 'знает эту задачу' }, ...users],
    { meId: String(user?.id ?? ''), assigneeId, creatorId, participants },
    AI_MENTION_ID,
  );

  /** Скриншот приходит без имени — даём ему дату, иначе в файлах десяток «image.png». */
  const attach = (file: File) => {
    const named = isAnonymousClipboardName(file.name) && file.type.startsWith('image/')
      ? new File([file], screenshotName(new Date(), file.type), { type: file.type })
      : file;
    setPending((prev) => {
      if (prev?.url) URL.revokeObjectURL(prev.url);
      return { file: named, url: isImageName(named.name) ? URL.createObjectURL(named) : '' };
    });
  };
  const clearPending = () => setPending((prev) => {
    if (prev?.url) URL.revokeObjectURL(prev.url);
    return null;
  });

  const ask = async (question: string) => {
    if (!question.trim()) return;
    setBusy(true); setErr(''); setAdvice(null);
    try {
      const res = await api.askTaskAssistant(taskId, question.trim());
      setAdvice(res);
      setBody('');
      reload(); // ответ лёг в ленту обсуждения — он часть истории задачи
    } catch (e) { setErr(e instanceof ApiError ? e.message : 'Помощник не ответил'); }
    finally { setBusy(false); }
  };

  const send = async () => {
    const text = body.trim();
    if (!text && !pending) return;
    // Помощника зовут упоминанием, как коллегу: «@AI-помощник, что тут по срокам».
    // Ищем в любом месте строки: в живой переписке обращение идёт после слов
    // «Борис, глянь, и @AI тоже».
    if (!pending && MENTIONS_AI.test(text)) return ask(text.replace(MENTIONS_AI, ' ').trim() || text);
    setBusy(true);
    try {
      if (editing) {
        await api.editComment(taskId, editing.id, text);
        setEditing(null);
      } else if (pending) {
        await api.addCommentFile(taskId, pending.file, text, replyTo?.id, replyTo?.excerpt);
        clearPending();
      } else {
        await api.addComment(taskId, text, undefined, replyTo?.id, replyTo?.excerpt);
      }
      setBody(''); setReplyTo(null); reload(); onRefresh();
    } catch (e) { setErr(e instanceof ApiError ? e.message : 'Не отправилось'); }
    finally { setBusy(false); }
  };

  const remove = async (id: string) => {
    if (!window.confirm('Удалить сообщение? Восстановить его будет нельзя.')) return;
    try { await api.deleteComment(taskId, id); reload(); }
    catch (e) { setErr(e instanceof ApiError ? e.message : 'Не удалилось'); }
  };

  const react = async (id: string, emoji: string) => {
    setReactFor(null);
    // Оптимистично: реакция должна ставиться мгновенно, это её единственная ценность.
    setComments((prev) => prev.map((c) => {
      if (String(c.id) !== String(id)) return c;
      const list = [...(c.reactions ?? [])];
      const found = list.find((r: any) => r.emoji === emoji);
      if (found) {
        found.mine ? (found.count -= 1) : (found.count += 1);
        found.mine = !found.mine;
      } else list.push({ emoji, count: 1, mine: true });
      return { ...c, reactions: list.filter((r: any) => r.count > 0) };
    }));
    try { await api.reactToComment(taskId, id, emoji); } catch { reload(); }
  };

  // Голос: продиктовать замечание проще, чем набирать его на телефоне.
  const voice = useVoiceInput((text) => { setBody((prev) => (prev.trim() ? prev.trim() + ' ' + text : text)); });

  /**
   * Ответить — и, если человек выделил кусок, ответить именно на него.
   *
   * В длинном сообщении спорят об одном абзаце, а цитата целиком («да, согласен» под
   * простынёй текста) не отвечает, с чем именно согласны. Выделение берём только внутри
   * этого сообщения: случайный текст со стороны в цитату попасть не должен.
   */
  const startReply = (c: any, node: Element | null) => {
    const sel = window.getSelection();
    const picked = sel && !sel.isCollapsed && node && sel.anchorNode && node.contains(sel.anchorNode)
      ? sel.toString().trim().slice(0, 600)
      : '';
    setReplyTo({
      id: String(c.id),
      author: c.is_ai ? AI_MENTION_NAME : c.author_name,
      excerpt: picked || String(c.body ?? '').slice(0, 300),
    });
    setEditing(null);
  };

  /**
   * Переход из истории к самому сообщению.
   *
   * Сообщения может не оказаться на экране: показан хвост переписки, а ссылка ведёт
   * к старому. Тогда сначала поднимаем всю переписку и прыгаем после отрисовки —
   * молча ничего не делать здесь нельзя, кнопка выглядела бы сломанной.
   */
  const goToMessage = async (id: string) => {
    let el = feedRef.current?.querySelector(`[data-msg="${id}"]`);
    if (!el && !fullyLoaded) {
      const rows = await api.listComments(taskId, true).catch(() => null);
      if (rows) {
        setComments(rows);
        setFullyLoaded(true);
        await new Promise((r) => window.setTimeout(r, 60)); // ждём отрисовку
        el = feedRef.current?.querySelector(`[data-msg="${id}"]`);
      }
    }
    if (!el) return;
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    setHighlight(String(id));
    window.setTimeout(() => setHighlight(null), 2200);
  };

  const acceptChecklist = async () => {
    if (!advice?.checklist.length) return;
    setBusy(true);
    try { await api.applyAssistantChecklist(taskId, advice.checklist); setAdvice(null); onRefresh(); }
    catch (e) { setErr(e instanceof ApiError ? e.message : 'Не добавилось'); }
    finally { setBusy(false); }
  };

  const q = query.trim().toLowerCase();
  const shown = q ? comments.filter((c) => String(c.body ?? '').toLowerCase().includes(q)) : comments;
  const history = allHistory ? activity : activity.slice(0, 5);

  /*
    Кто в разговоре.

    Участники задачи и есть участники чата: постановщик, исполнитель, соисполнители,
    наблюдатели. Отдельного состава у обсуждения нет и быть не должно — иначе человек
    добавлен в задачу, но не слышит, что по ней говорят.
  */
  const people = useMemo(() => {
    const byId = new Map(users.map((u) => [String(u.id), u.fullName]));
    const seen = new Set<string>();
    const out: { id: string; name: string; role: string }[] = [];
    const add = (id?: string | null, role = 'участник') => {
      const key = String(id ?? '');
      if (!key || seen.has(key)) return;
      seen.add(key);
      out.push({ id: key, name: byId.get(key) ?? '—', role });
    };
    add(creatorId, 'постановщик');
    add(assigneeId, 'исполнитель');
    for (const p of participants) add(p.user_id, p.role === 'watcher' ? 'наблюдатель' : 'соисполнитель');
    return out;
  }, [users, participants, assigneeId, creatorId]);

  return (
    <div className={`task-chat-box${wide ? ' task-chat-wide' : ''}`}>
      {/*
        Шапка разговора.

        В мессенджере всегда видно, с кем говоришь; здесь то же самое — название
        задачи, её этап и люди. Раньше на этом месте стоял заголовок «Чат задачи»,
        который не отвечал ни на один вопрос.
      */}
      <div className="task-chat-head">
        <div className="task-chat-title">
          <Icon name="chat" size={15} />
          <span className="task-chat-name">{title ?? 'Чат задачи'}</span>
          {status && <span className="badge badge-muted">{status}</span>}
          {comments.length > 0 && <span className="dim chat-count">{comments.length}</span>}
        </div>
        <div className="task-chat-people">
          {people.slice(0, 6).map((p) => (
            <span key={p.id} className="task-chat-person" title={`${p.name} · ${p.role}`}>{initials(p.name)}</span>
          ))}
          {people.length > 6 && <span className="dim">+{people.length - 6}</span>}
        </div>
        <div className="task-chat-acts">
          {comments.length > 5 && (
            <button
              className={`msg-icon${searchOpen ? ' active' : ''}`}
              onClick={() => { setSearchOpen((v) => !v); if (searchOpen) setQuery(''); }}
              title="Поиск по обсуждению"
              aria-label="Поиск по обсуждению"
            >
              <Icon name="search" size={15} />
            </button>
          )}
          {onExpand && (
            <button className="msg-icon" onClick={onExpand} title="Развернуть на всю карточку" aria-label="Развернуть на всю карточку">
              <Icon name="maximize" size={15} />
            </button>
          )}
          {onCollapse && (
            <button className="msg-icon" onClick={onCollapse} title="Свернуть в колонку" aria-label="Свернуть в колонку">
              <Icon name="minimize" size={15} />
            </button>
          )}
        </div>
      </div>

      {/* Поиск появляется по лупе: постоянное поле над лентой съедает место,
          а ищут в обсуждении редко. */}
      {searchOpen && (
        <input
          className="input chat-search-input"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Поиск по обсуждению"
          aria-label="Поиск по обсуждению"
          autoFocus
        />
      )}
      {q && (
        <div className="dim chat-found">
          {shown.length ? `Найдено сообщений: ${shown.length}` : 'Ничего не нашлось'}
        </div>
      )}

      {comments.length === 0 && (
        <EmptyState compact icon="chat" title="Обсуждения ещё не было"
          hint="Здесь остаётся история решений по задаче. Помощника можно спросить тут же: «@AI что от меня требуется?»" />
      )}

      <div
        className="msg-feed"
        ref={feedRef}
        // Файл можно перетащить прямо в переписку — то же, что вставка из буфера.
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => { const f = e.dataTransfer.files?.[0]; if (f) { e.preventDefault(); attach(f); } }}
      >
        {/* Показан хвост переписки — остальное поднимается кнопкой. Появляется, только
            когда наверху действительно что-то есть. */}
        {!fullyLoaded && comments.length >= 100 && (
          <button className="btn btn-ghost btn-sm chat-earlier" onClick={() => reload(true)}>
            <Icon name="chevron-up" size={13} /> Показать всю переписку
          </button>
        )}
        {shown.map((c, i) => {
          const prev = shown[i - 1];
          const newDay = !prev || new Date(prev.created_at).toDateString() !== new Date(c.created_at).toDateString();
          const grouped = !newDay && !q && sameGroup(prev, c);
          const mine = String(c.author_id) === String(user?.id ?? '') && !c.is_ai;
          const name = c.is_ai ? AI_MENTION_NAME : c.author_name;
          return (
            <div key={c.id}>
              {newDay && <div className="chat-day">{dayLabel(c.created_at)}</div>}
              <div
                data-msg={String(c.id)}
                className={`msg${mine ? ' msg-mine' : ''}${c.is_ai ? ' msg-ai' : ''}`
                  + `${grouped ? ' msg-grouped' : ''}${highlight === String(c.id) ? ' msg-found' : ''}`}
              >
                <div className="msg-avatar" aria-hidden="true">
                  {grouped ? '' : c.is_ai ? <Icon name="robot" size={14} /> : initials(name)}
                </div>
                <div className="msg-main">
                  {!grouped && (
                    <div className="msg-head">
                      <b className="msg-name">{name}</b>
                      {/* Дата рядом со временем: черта дня выше есть, но сопоставлять
                          с ней каждую реплику неудобно — заказчик сказал это прямо. */}
                      <span className="msg-time" title={new Date(c.created_at).toLocaleString('ru-RU')}>{stampLabel(c.created_at)}</span>
                      {c.edited_at && <span className="msg-time">· изменено</span>}
                    </div>
                  )}

                  {/* Цитата: без неё «да, согласен» через десять реплик — согласие
                      неизвестно с чем. Клик ведёт к исходному сообщению. */}
                  {c.reply_to_id && c.reply_body && (
                    <button className="msg-quote" onClick={() => goToMessage(String(c.reply_to_id))} title="Перейти к сообщению">
                      <b>{c.reply_author}</b>: {String(c.reply_body).slice(0, 200)}
                    </button>
                  )}

                  {c.body && <MessageText text={c.body} className="msg-text" />}

                  {c.file_id && (
                    <ChatAttachment
                      fileId={String(c.file_id)}
                      fileName={c.file_name ?? 'файл'}
                      onOpen={(url, fname, mime) => setPreview({ url, name: fname, mime })}
                    />
                  )}

                  <div className="msg-foot">
                    {(c.reactions ?? []).map((r: any) => (
                      <button
                        key={r.emoji}
                        className={r.mine ? 'reaction mine' : 'reaction'}
                        onClick={() => react(String(c.id), r.emoji)}
                        title={r.mine ? 'Снять свою реакцию' : 'Поддержать'}
                      >
                        {r.emoji} {r.count}
                      </button>
                    ))}
                    {/* Набор всплывает НАД сообщением — так же, как в мессенджере:
                        строка действий не должна раздуваться от шести смайлов. */}
                    <span className="msg-actions">
                      <button
                        className="msg-icon"
                        onClick={() => setReactFor(reactFor === String(c.id) ? null : String(c.id))}
                        title="Поставить реакцию"
                        aria-label="Поставить реакцию"
                      >
                        <Icon name="smile" size={17} />
                      </button>
                      {reactFor === String(c.id) && (
                        <span className="react-pop">
                          {REACTIONS.map((emoji) => (
                            <button key={emoji} className="react-pop-btn" onClick={() => react(String(c.id), emoji)}>
                              {emoji}
                            </button>
                          ))}
                        </span>
                      )}
                    </span>
                    {!c.is_ai && (
                      <button
                        className="msg-act"
                        onClick={(e) => startReply(c, (e.currentTarget as HTMLElement).closest('.msg'))}
                        title="Ответить. Если выделить кусок текста — ответ будет на него"
                      >
                        Ответить
                      </button>
                    )}
                    {mine && (
                      <>
                        <button
                          className="msg-act"
                          onClick={() => { setEditing({ id: String(c.id), body: c.body }); setBody(c.body); setReplyTo(null); }}
                        >
                          Изменить
                        </button>
                        <button className="msg-act msg-act-danger" onClick={() => remove(String(c.id))}>Удалить</button>
                      </>
                    )}
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {err && <div className="error-text">{err}</div>}

      {/* Предложения помощника: применяет их человек, и это принципиально —
          сам ИИ задачу не меняет. */}
      {advice && (advice.checklist.length > 0 || advice.suggestion) && (
        <div className="ai-advice">
          {advice.checklist.length > 0 && (
            <>
              <div className="ai-advice-head">Предложенные шаги</div>
              <ul className="ai-advice-list">
                {advice.checklist.map((step, i) => <li key={i}>{step}</li>)}
              </ul>
              <button className="btn btn-sm" onClick={acceptChecklist} disabled={busy}>
                <Icon name="check" size={13} /> Добавить в чек-лист
              </button>
            </>
          )}
          {advice.suggestion && (
            <div className="ai-advice-suggest">
              <Icon name="alert" size={13} /> {advice.suggestion.label || 'Помощник предлагает изменить задачу'} —
              примените это сами во вкладке «Обзор»: менять задачу за вас он не станет.
            </div>
          )}
        </div>
      )}

      <div className="ai-quick">
        {QUICK_ASKS.map((qa) => (
          <button key={qa.label} className="btn btn-ghost btn-sm" disabled={busy} onClick={() => ask(qa.ask)}>
            {qa.label}
          </button>
        ))}
      </div>

      {/* Кому отвечаем или что правим — видно прямо над полем, а не угадывается. */}
      {(replyTo || editing) && (
        <div className="comment-reply-to">
          <Icon name={editing ? 'edit' : 'reply'} size={13} />
          <span className="dim">
            {editing ? 'Правите своё сообщение' : `В ответ ${replyTo?.author}: ${replyTo?.excerpt.slice(0, 80)}`}
          </span>
          <button className="msg-act" onClick={() => { setReplyTo(null); setEditing(null); setBody(''); }}>Отмена</button>
        </div>
      )}

      {/* Вложение перед отправкой: видно, что уйдёт, и можно подписать. */}
      {pending && (
        <div className="chat-pending">
          {pending.url
            ? <img className="chat-pending-img" src={pending.url} alt={pending.file.name} />
            : <Icon name="paperclip" size={16} />}
          <span className="chat-pending-name">
            {pending.file.name} <span className="dim">· {humanSize(pending.file.size)}</span>
          </span>
          <button className="btn btn-ghost btn-sm" onClick={clearPending} title="Убрать вложение" aria-label="Убрать вложение">
            <Icon name="close" size={14} />
          </button>
        </div>
      )}

      <div className="comment-input">
        <MentionField
          value={body}
          users={mentionUsers}
          onChange={setBody}
          // Упомянутого нужно позвать: без этого «@Юрий, посмотри» он увидит,
          // только если сам зайдёт в задачу.
          onMention={(userId) => {
            // помощник участником задачи не становится — он не человек
            if (userId === AI_MENTION_ID) return;
            void api.addTaskParticipant(taskId, userId, 'watcher').catch(() => undefined);
          }}
          rows={2}
          autoGrow
          placeholder={pending ? 'Подпись к вложению…' : 'Нажмите @, чтобы позвать человека или помощника'}
          onEnter={send}
        />
        <div className="comment-actions">
          <label className="btn btn-sm btn-ghost" title="Прикрепить файл — или просто вставьте скриншот через Ctrl+V">
            <Icon name="paperclip" size={14} />
            <input
              type="file"
              hidden
              onChange={(e) => { const f = e.target.files?.[0]; if (f) attach(f); e.currentTarget.value = ''; }}
            />
          </label>
          <button
            className={voice.recording ? 'btn btn-sm btn-primary' : 'btn btn-sm btn-ghost'}
            onClick={voice.toggle}
            disabled={busy || voice.transcribing}
            title="Написать голосом"
          >
            <Icon name={voice.recording ? 'stop' : 'mic'} size={14} />
          </button>
          <button className="btn btn-primary btn-sm" disabled={busy || (!body.trim() && !pending)} onClick={send}>
            {busy ? '…' : editing ? 'Сохранить' : 'Отправить'}
          </button>
        </div>
      </div>
      <VoiceStatus recording={voice.recording} transcribing={voice.transcribing} error={voice.error} className="nl-voice" />

      <div className="drawer-section-title chat-history-head">
        <Icon name="clock" size={13} /> История
      </div>
      {history.map((a: any) => {
        const to = a.kind === 'commented' && a.detail?.commentId ? String(a.detail.commentId) : null;
        const line = `${new Date(a.created_at).toLocaleString('ru-RU')} · ${a.actor_name ?? 'система'} · ${activityText(a)}`;
        // Строка про сообщение ведёт к самому сообщению: история, из которой нельзя
        // попасть в то, о чём она говорит, отсылает в никуда.
        return to
          ? <button key={a.id} className="activity-row activity-link" onClick={() => goToMessage(to)} title="Перейти к сообщению">{line}</button>
          : <div key={a.id} className="dim activity-row">{line}</div>;
      })}
      {activity.length > 5 && (
        <button className="msg-act" onClick={() => setAllHistory((v) => !v)}>
          {allHistory ? 'Свернуть историю' : `Показать всю историю (${activity.length})`}
        </button>
      )}

      {preview && <Lightbox url={preview.url} name={preview.name} mime={preview.mime} onClose={() => setPreview(null)} />}
    </div>
  );
}
