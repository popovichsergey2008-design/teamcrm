import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../../lib/api';
import { getSocket } from '../../lib/socket';
import { collectSupportContext, describeContext } from '../../lib/support-context';
import { shrinkImage } from '../../lib/image-shrink';
import { requestCall } from '../../lib/notifications';
import { stampLabel } from '../../lib/chat-text';
import { useAuth } from '../../state/auth';
import { Icon } from '../Icon';
import { MessageText } from '../MessageText';
import type { SupportConversation, SupportDesk, SupportQueueItem } from '../../types';

/**
 * Открыть службу заботы откуда угодно.
 *
 * Панель живёт в оболочке приложения, а звать её нужно из левого меню, из командной
 * строки и из пустых экранов («настроить вместе со специалистом»). Событие — самый
 * дешёвый способ: никому не приходится протаскивать через себя чужой обработчик.
 */
export const SUPPORT_OPEN = 'teamcrm:support-open';

export function openSupport(): void {
  window.dispatchEvent(new Event(SUPPORT_OPEN));
}

/** Оценка: четыре лица вместо звёзд — на них отвечают, не задумываясь (ТЗ-8, разд. 31). */
const FACES: { score: number; face: string; label: string }[] = [
  { score: 1, face: '😞', label: 'Плохо' },
  { score: 2, face: '😐', label: 'Так себе' },
  { score: 3, face: '🙂', label: 'Хорошо' },
  { score: 4, face: '😍', label: 'Отлично' },
];

/** Почему низкая оценка — списком, а не полем: так отвечают, а не закрывают окно. */
const REASONS = ['долго ждал', 'проблема не решена', 'сложно объяснили', 'пришлось повторять', 'другое'];

/** Время ответа человеческими словами: «около 30 секунд», а не «28.4 s». */
function etaText(sec: number | null): string {
  if (!sec) return 'Ищем свободного специалиста';
  if (sec < 90) return `Ответим примерно за ${Math.max(10, Math.round(sec / 10) * 10)} сек`;
  const min = Math.round(sec / 60);
  return `Ответим примерно за ${min} ${min === 1 ? 'минуту' : min < 5 ? 'минуты' : 'минут'}`;
}

/**
 * Служба заботы — панель поверх CRM (ТЗ-8).
 *
 * Открывается кнопкой в правом нижнем углу из любого раздела и не уводит человека
 * со страницы: он видит свою задачу и разговор одновременно — именно поэтому
 * панель, а не отдельный экран (разд. 2.1, 4).
 *
 * Что здесь принципиально:
 *
 * 1. Никакой анкеты. Поле ввода и «Отправить» — всё. Тема, категория и номер
 *    обращения человеку не нужны (разд. 2.2).
 * 2. Кнопка «Позвать человека» видна всегда, пока разговор ведёт помощник (разд. 8).
 * 3. Что уходит специалисту — видно до отправки: строка контекста внизу (разд. 50).
 * 4. Закрывает разговор сам человек: «всё работает?» с оценкой (разд. 21, 31).
 */
export function SupportDock() {
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const [desk, setDesk] = useState<SupportDesk | null>(null);
  const [conv, setConv] = useState<SupportConversation | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [view, setView] = useState<'chat' | 'history' | 'queue'>('chat');
  /** Очередь дежурного: кто ждёт ответа прямо сейчас. */
  const [queue, setQueue] = useState<SupportQueueItem[]>([]);
  const [lowReason, setLowReason] = useState<number | null>(null);
  /** Диагностика и подключение инженера — инструменты дежурного (MVP 2). */
  const [diag, setDiag] = useState<Awaited<ReturnType<typeof api.supportDiagnostics>> | null>(null);
  const [tools, setTools] = useState(false);
  const [people, setPeople] = useState<{ id: string; fullName: string }[]>([]);
  /** Кому из инженеров открыт разговор: доступ выдаётся на срок и отзывается. */
  const [grants, setGrants] = useState<Awaited<ReturnType<typeof api.supportEngineers>>>([]);
  /** Подсказка копилота дежурному: суть, что проверить, что сказать человеку. */
  const [copilot, setCopilot] = useState<Awaited<ReturnType<typeof api.supportCopilot>> | null>(null);
  const feedRef = useRef<HTMLDivElement | null>(null);

  const load = useCallback(async () => {
    try {
      const d = await api.supportDesk();
      setDesk(d);
      setConv(d.conversation);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Служба заботы сейчас недоступна');
    }
  }, []);

  // Панель узнаёт о себе, только когда её открыли: фоновые запросы ради кнопки не нужны.
  useEffect(() => { if (open && !desk) void load(); }, [open, desk, load]);

  // Позвали снаружи — из меню, командной строки или пустого экрана.
  useEffect(() => {
    const show = () => setOpen(true);
    window.addEventListener(SUPPORT_OPEN, show);
    return () => window.removeEventListener(SUPPORT_OPEN, show);
  }, []);

  /*
    Очередь дежурного.

    Обновляем при открытии вкладки и по событию: человек, которому ответили не сразу,
    запоминает именно это ожидание — очередь не должна жить до перезагрузки страницы.
  */
  const loadQueue = useCallback(() => {
    api.supportQueue().then(setQueue).catch(() => undefined);
  }, []);
  useEffect(() => { if (open && view === 'queue') loadQueue(); }, [open, view, loadQueue]);
  useEffect(() => {
    if (!desk?.isAgent) return undefined;
    const socket = getSocket();
    const onQueue = () => loadQueue();
    socket.on('support.queue.changed', onQueue);
    return () => { socket.off('support.queue.changed', onQueue); };
  }, [desk?.isAgent, loadQueue]);

  /*
    Инструменты дежурного открываются по кнопке и грузятся тогда же.

    Диагностика, список коллег и заведённые баги нужны в одном разговоре из десяти —
    тянуть их вместе с каждым открытием панели значит платить за них всегда.
  */
  const openTools = async (id: string) => {
    setTools((v) => !v);
    if (diag) return;
    const [d, users] = await Promise.all([
      api.supportDiagnostics(id).catch(() => null),
      api.listUsers().then((u) => u.map((x: { id: string; fullName: string }) => ({ id: String(x.id), fullName: x.fullName }))).catch(() => []),
    ]);
    setDiag(d);
    setPeople(users);
    await loadGrants(id);
  };

  /** Позвать инженера — в ТОТ ЖЕ разговор: объяснять второй раз человек не должен. */
  const addEngineer = async (userId: string) => {
    if (!conv || !userId) return;
    setBusy(true);
    try { setConv(await api.supportAddEngineer(conv.id, userId)); await loadGrants(conv.id); }
    catch (e) { setErr(e instanceof ApiError ? e.message : 'Не получилось подключить'); }
    finally { setBusy(false); }
  };

  /** Баг из разговора: описание, шаги и контекст уезжают в задачу сами. */
  const createBug = async () => {
    if (!conv) return;
    setBusy(true);
    try {
      const res = await api.supportCreateBug(conv.id);
      setConv(res.conversation);
      setDiag(await api.supportDiagnostics(conv.id).catch(() => null));
    } catch (e) { setErr(e instanceof ApiError ? e.message : 'Не получилось завести задачу'); }
    finally { setBusy(false); }
  };

  /**
   * Созвон из поддержки (разд. 13).
   *
   * Комнату поднимает обычный созвон CRM — со звуком, видео, демонстрацией экрана и
   * записью. Мы лишь помечаем, что разговор идёт по этому обращению: по пометке итог
   * с расшифровкой и разбором вернётся сюда же.
   */
  /**
   * Попросить созвон.
   *
   * Никому не звонит: вторая сторона увидит карточку и ответит. Комната поднимется,
   * только если она согласится, — звонить человеку, который может быть на совещании или
   * за рулём, продукт не должен.
   */
  const askCall = async () => {
    if (!conv) return;
    setBusy(true); setErr('');
    try { setConv(await api.supportRequestCall(conv.id)); }
    catch (e) { setErr(e instanceof ApiError ? e.message : 'Не получилось'); }
    finally { setBusy(false); }
  };

  /** «Сейчас неудобно» — такой же обычный ответ, как согласие. */
  const declineCall = async () => {
    if (!conv) return;
    setBusy(true);
    try { setConv(await api.supportDeclineCall(conv.id)); }
    catch (e) { setErr(e instanceof ApiError ? e.message : 'Не получилось'); }
    finally { setBusy(false); }
  };

  /** Согласиться: комнату и гостевую ссылку поднимает согласившаяся сторона. */
  const startHuddle = async () => {
    if (!conv) return;
    setBusy(true); setErr('');
    try {
      const room = await api.startCall(undefined, true);
      /*
        Ссылку на комнату кладём в разговор — гостевую.

        Специалист и человек в РАЗНЫХ организациях: обычное приглашение на созвон до
        собеседника не дойдёт, оно ходит внутри компании. Гостевая ссылка работает
        всегда и не даёт ничего, кроме этой комнаты: вход через комнату ожидания, и
        её можно отозвать.
      */
      const link = await api.createGuestLink({
        roomId: String(room.id),
        label: `Служба заботы · ${conv.subject}`.slice(0, 80),
        ttlHours: 4,
      });
      setConv(await api.supportAcceptCall(conv.id, String(room.id), link.url));
      // Своим (когда обращение внутри одной организации) звоним и обычным приглашением.
      const to = mineConversation
        ? conv.participants.map((p) => String(p.user_id)).filter((uid) => uid !== String(user?.id ?? ''))
        : [];
      requestCall({ memberIds: to, title: `Служба заботы · ${conv.subject}`.slice(0, 80) });
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Не удалось начать созвон. Разговор сохранён — попробуйте ещё раз.');
    } finally { setBusy(false); }
  };

  /** Слово человека по предложенному действию: без него не происходит ничего. */
  const decideAction = async (actionId: string, allow: boolean) => {
    if (!conv) return;
    setBusy(true);
    try { setConv(await api.supportDecideAction(conv.id, actionId, allow)); }
    catch (e) { setErr(e instanceof ApiError ? e.message : 'Не получилось'); }
    finally { setBusy(false); }
  };

  const undoAction = async (actionId: string) => {
    if (!conv) return;
    setBusy(true);
    try { setConv(await api.supportUndoAction(conv.id, actionId)); }
    catch (e) { setErr(e instanceof ApiError ? e.message : 'Не получилось вернуть'); }
    finally { setBusy(false); }
  };

  /** Вернуть помощника: после подключения человека он молчит, пока его не позовут. */
  const returnAi = async () => {
    if (!conv) return;
    setBusy(true);
    try { setConv(await api.supportReturnAi(conv.id)); }
    catch (e) { setErr(e instanceof ApiError ? e.message : 'Не получилось'); }
    finally { setBusy(false); }
  };

  /** Копилот: готовит специалисту то, на что уходит первая пара минут разговора. */
  const loadGrants = async (id: string) => {
    setGrants(await api.supportEngineers(id).catch(() => []));
  };

  const revokeEngineer = async (engineerId: string) => {
    if (!conv) return;
    setBusy(true);
    try { setConv(await api.supportRevokeEngineer(conv.id, engineerId)); await loadGrants(conv.id); }
    catch (e) { setErr(e instanceof ApiError ? e.message : 'Не получилось закрыть доступ'); }
    finally { setBusy(false); }
  };

  const askCopilot = async () => {
    if (!conv) return;
    setBusy(true); setErr('');
    try { setCopilot(await api.supportCopilot(conv.id)); }
    catch (e) { setErr(e instanceof ApiError ? e.message : 'Помощник не ответил'); }
    finally { setBusy(false); }
  };

  /** Взять разговор себе: человек сразу видит, кто ему отвечает. */
  const takeConversation = async (id: string) => {
    setBusy(true); setErr('');
    try {
      setConv(await api.supportJoin(id));
      setView('chat');
      loadQueue();
    } catch (e) { setErr(e instanceof ApiError ? e.message : 'Не получилось взять разговор'); }
    finally { setBusy(false); }
  };

  /** Ответ дежурного — в тот же разговор, что читает человек. */
  const replyAsAgent = async () => {
    const body = text.trim();
    if (!conv || !body) return;
    setBusy(true); setErr(''); setText('');
    try { setConv(await api.supportReply(conv.id, body)); }
    catch (e) { setText(body); setErr(e instanceof ApiError ? e.message : 'Не отправилось'); }
    finally { setBusy(false); }
  };

  /** «Кажется, решено»: разговор уходит человеку на проверку, а не закрывается. */
  const resolveAsAgent = async () => {
    if (!conv) return;
    setBusy(true);
    try { setConv(await api.supportResolve(conv.id)); }
    catch (e) { setErr(e instanceof ApiError ? e.message : 'Не получилось'); }
    finally { setBusy(false); }
  };

  /*
    Живой разговор: ответ специалиста должен появляться сам.

    Слушаем всегда, а не только при открытой панели: если человеку ответили, пока
    он работал, кнопка обязана это показать — иначе он ждёт у закрытой двери.
  */
  useEffect(() => {
    const socket = getSocket();
    const refresh = () => { void load(); };
    for (const ev of ['support.message.created', 'support.status.changed', 'support.agent.joined', 'support.resolved']) {
      socket.on(ev, refresh);
    }
    return () => {
      for (const ev of ['support.message.created', 'support.status.changed', 'support.agent.joined', 'support.resolved']) {
        socket.off(ev, refresh);
      }
    };
  }, [load]);

  // Лента всегда на последней реплике: разговор читают с конца.
  useEffect(() => {
    if (!open) return;
    const el = feedRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [open, conv?.messages.length, view]);

  const send = async () => {
    const body = text.trim();
    if (!body || busy) return;
    setBusy(true); setErr('');
    setText('');
    try {
      // Контекст собираем в момент отправки: важно, где человек был, когда написал.
      const next = await api.supportSend(body, collectSupportContext());
      setConv(next);
      void load();
    } catch (e) {
      setText(body); // не теряем написанное
      setErr(e instanceof ApiError ? e.message : 'Сообщение не отправилось');
    } finally { setBusy(false); }
  };

  const attach = async (file: File) => {
    setBusy(true); setErr('');
    try {
      const small = await shrinkImage(file);
      setConv(await api.supportAttach(small, text.trim(), mineConversation ? undefined : conv?.id));
      setText('');
      void load();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Файл не отправился');
    } finally { setBusy(false); }
  };

  const callHuman = async () => {
    if (!conv) return;
    setBusy(true);
    try { setConv(await api.supportCallHuman(conv.id)); }
    catch (e) { setErr(e instanceof ApiError ? e.message : 'Не получилось позвать'); }
    finally { setBusy(false); }
  };

  const confirm = async (ok: boolean, csat?: number, reason?: string) => {
    if (!conv) return;
    setBusy(true);
    try {
      setConv(await api.supportConfirm(conv.id, ok, csat, reason));
      setLowReason(null);
      void load();
    } catch (e) { setErr(e instanceof ApiError ? e.message : 'Не получилось'); }
    finally { setBusy(false); }
  };

  /**
   * «Вопрос снят»: человек закрывает свой разговор сам.
   *
   * Половина обращений заканчивается тем, что человек разобрался сам. Держать
   * такой разговор открытым до ответа специалиста — значит гонять его за ответом,
   * который уже не нужен.
   */
  const closeMine = async () => {
    if (!conv) return;
    setBusy(true);
    try { setConv(await api.supportClose(conv.id)); void load(); }
    catch (e) { setErr(e instanceof ApiError ? e.message : 'Не получилось закрыть'); }
    finally { setBusy(false); }
  };

  const reopen = async (id: string) => {
    setBusy(true);
    try {
      setConv(await api.supportReopen(id));
      setView('chat');
      void load();
    } catch (e) { setErr(e instanceof ApiError ? e.message : 'Не получилось открыть заново'); }
    finally { setBusy(false); }
  };

  const online = desk?.team.filter((t) => t.online) ?? [];
  const agent = conv?.participants.find((p) => p.role === 'agent');
  /** Ждём ответа человека о результате — тогда лента уступает место вопросу. */
  const asksResult = conv?.status === 'waiting_user' && String(conv?.userId) === String(user?.id ?? '');
  /** Чей разговор открыт: свой — пишем как человек, чужой — отвечаем как дежурный. */
  const mineConversation = !conv || String(conv.userId) === String(user?.id ?? '');
  const ctx = describeContext(collectSupportContext());

  if (!user || user.role === 'client') return null;

  return (
    <>
      {/*
        Кнопка службы заботы — всегда под рукой, в правом нижнем углу.

        Не в меню и не в настройках: у человека, у которого что-то сломалось, нет сил
        искать, где тут просят о помощи (разд. 3.1).
      */}
      {!open && (
        <button
          className="support-fab"
          onClick={() => setOpen(true)}
          title="Служба заботы ANTHILL"
          aria-label="Служба заботы"
        >
          <Icon name="support" size={20} />
          {online.length > 0 && <span className="support-fab-dot" aria-hidden="true" />}
        </button>
      )}

      {open && (
        <aside className="support-dock" role="dialog" aria-label="Служба заботы">
          <header className="support-head">
            <span className="support-head-mark" aria-hidden="true"><Icon name="support" size={18} /></span>
            <div className="support-head-title">
              <b>{agent ? agent.full_name : 'Служба заботы'}</b>
              <span className="dim support-head-sub">
                {agent
                  ? 'Специалист на связи'
                  : conv?.status === 'waiting_agent'
                    ? 'Ищем свободного специалиста'
                    : etaText(desk?.etaSeconds ?? null)}
                {online.length > 0 && !agent && <span className="support-online"> · {online.length} на связи</span>}
              </span>
            </div>
            {conv && (
              <button
                className="msg-icon"
                onClick={() => void askCall()}
                disabled={busy || !!conv.call}
                title={conv.call
                  ? 'Просьба о созвоне уже отправлена — ждём ответа'
                  : 'Предложить созвон: вторая сторона решит, удобно ли ей сейчас'}
                aria-label="Предложить созвон"
              >
                <Icon name="phone" size={15} />
              </button>
            )}
            {desk?.isAgent && conv && !mineConversation && (
              <button
                className={`msg-icon${tools ? ' active' : ''}`}
                onClick={() => void openTools(conv.id)}
                title="Диагностика, инженер, задача"
                aria-label="Инструменты специалиста"
                aria-expanded={tools}
              >
                <Icon name="settings" size={15} />
              </button>
            )}
            {desk?.isAgent && (
              <button
                className={`msg-icon${view === 'queue' ? ' active' : ''}`}
                onClick={() => setView(view === 'queue' ? 'chat' : 'queue')}
                title="Очередь службы заботы"
                aria-label="Очередь службы заботы"
              >
                <Icon name="inbox" size={15} />
                {queue.some((q) => q.status === 'waiting_agent') && <span className="support-fab-dot" aria-hidden="true" />}
              </button>
            )}
            <button
              className={`msg-icon${view === 'history' ? ' active' : ''}`}
              onClick={() => setView(view === 'history' ? 'chat' : 'history')}
              title="Мои прошлые обращения"
              aria-label="Мои прошлые обращения"
            >
              <Icon name="clock" size={15} />
            </button>
            <button className="msg-icon" onClick={() => setOpen(false)} title="Закрыть" aria-label="Закрыть">
              <Icon name="close" size={15} />
            </button>
          </header>

          {/*
            Массовый сбой — первым делом и для всех (разд. 43).

            Человек, у которого «всё сломалось», должен узнать об этом раньше, чем
            напишет: иначе двадцать человек по очереди объясняют одну и ту же аварию.
          */}
          {desk?.incident && (
            <div className="support-incident">
              <Icon name="alert" size={14} />
              <span><b>{desk.incident.title}.</b> {desk.incident.message}</span>
            </div>
          )}

          {err && <div className="error-text support-err">{err}</div>}

          {view === 'queue' ? (
            <div className="support-feed">
              {!queue.length && <p className="dim support-empty">Сейчас никто не ждёт — тишина.</p>}
              {queue.map((q) => (
                <div key={q.id} className="support-history-row">
                  <div className="support-history-head">
                    <b>{q.subject || 'Обращение'}</b>
                    <span className="dim">{stampLabel(q.waitingSince)}</span>
                  </div>
                  <div className="dim support-history-sub">
                    {q.userName} · {q.statusText}
                    {q.agentName ? ` · ведёт ${q.agentName}` : ''}
                  </div>
                  <button
                    className={q.agentName ? 'btn btn-sm' : 'btn btn-primary btn-sm'}
                    disabled={busy}
                    onClick={() => void takeConversation(q.id)}
                  >
                    {q.agentName ? 'Открыть' : 'Взять себе'}
                  </button>
                </div>
              ))}
            </div>
          ) : view === 'history' ? (
            <div className="support-feed">
              {!desk?.history.length && (
                <p className="dim support-empty">Здесь появятся ваши прошлые обращения.</p>
              )}
              {desk?.history.map((h) => (
                <div key={h.id} className="support-history-row">
                  <div className="support-history-head">
                    <b>{h.subject || 'Обращение'}</b>
                    <span className="dim">{new Date(h.createdAt).toLocaleDateString('ru-RU')}</span>
                  </div>
                  <div className="dim support-history-sub">
                    {h.statusText}
                    {h.agentName ? ` · ${h.agentName}` : ''}
                    {h.csat ? ` · оценка ${h.csat}/4` : ''}
                  </div>
                  {h.closedAt && (
                    <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void reopen(h.id)}>
                      Проблема снова появилась
                    </button>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <>
              <div className="support-feed" ref={feedRef}>
                {!conv && (
                  <div className="support-hello">
                    <p><b>Расскажите, что случилось.</b></p>
                    <p className="dim">
                      Сначала ответит AnthillBot — он видит, на каком вы экране, и знает систему.
                      Если не поможет, позовём живого специалиста: контекст не потеряется.
                    </p>
                  </div>
                )}
                {conv?.messages.map((m) => (
                  m.kind === 'system' ? (
                    <div key={m.id} className="support-system">
                      {m.authorName ? `${m.authorName} ${m.body}` : m.body}
                    </div>
                  ) : (
                    <div key={m.id} className={`support-msg support-msg-${m.kind}`}>
                      <div className="support-msg-who">
                        {m.kind === 'user' ? 'Вы' : m.kind === 'ai' ? 'AnthillBot' : m.authorName ?? 'Специалист'}
                        <span className="dim support-msg-time">{stampLabel(m.createdAt)}</span>
                      </div>
                      {m.body && <MessageText text={m.body} className="support-msg-text" />}
                      {/*
                        Файл берём через ручку разговора, а не общую /files/:id.

                        Снимок лежит в организации обратившегося: специалист вендора по
                        общему адресу его не откроет, а по разговору — да.
                      */}
                      {m.fileId && (
                        <a className="support-file" href={`/api/support/desk/${conv?.id}/files/${m.fileId}`} target="_blank" rel="noreferrer">
                          <Icon name="paperclip" size={13} /> {m.fileName ?? 'файл'}
                        </a>
                      )}
                    </div>
                  )
                ))}
              </div>

              {/*
                Предложенные действия (разд. 38).

                Человек читает, ЧТО именно произойдёт, и решает сам. Пока не разрешил —
                не сделано ничего; сделанное можно вернуть, если это осмысленно.
              */}
              {conv?.actions.filter((a) => a.status === 'proposed' || a.status === 'done').map((a) => (
                <div key={a.id} className={`support-action${a.status === 'done' ? ' done' : ''}`}>
                  <span className="support-action-text">
                    <Icon name={a.status === 'done' ? 'check' : 'zap'} size={13} /> {a.preview}
                  </span>
                  {a.status === 'proposed' && mineConversation && (
                    <span className="support-action-acts">
                      <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => void decideAction(a.id, true)}>
                        Разрешить
                      </button>
                      <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void decideAction(a.id, false)}>
                        Не надо
                      </button>
                    </span>
                  )}
                  {a.status === 'done' && a.action !== 'project.columns' && (
                    <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void undoAction(a.id)}>
                      Вернуть как было
                    </button>
                  )}
                </div>
              ))}

              {/*
                Просьба о созвоне (04_SUPPORT_HUDDLE §2).

                Карточку видит ВТОРАЯ сторона — та, которую зовут. Отказ стоит рядом с
                согласием и выглядит так же обычно: «сейчас неудобно» должно быть таким
                же простым ответом, как «давайте», иначе люди соглашаются из вежливости.
              */}
              {conv?.call && String(conv.call.byUserId) !== String(user?.id ?? '') && (
                <div className="support-ask">
                  <b>
                    {conv.call.byRole === 'user'
                      ? `${conv.call.byName ?? 'Человек'} просит созвон`
                      : `${conv.call.byName ?? 'Специалист'} предлагает созвониться`}
                  </b>
                  <div className="support-ask-row">
                    <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => void startHuddle()}>
                      Присоединиться
                    </button>
                    <button className="btn btn-sm" disabled={busy} onClick={() => void declineCall()}>
                      Сейчас неудобно
                    </button>
                  </div>
                </div>
              )}
              {conv?.call && String(conv.call.byUserId) === String(user?.id ?? '') && (
                <div className="support-ask">
                  <span className="dim">Просьба о созвоне отправлена — ждём ответа.</span>
                </div>
              )}

              {/*
                «Всё работает?» — единственный способ закрыть разговор.

                Специалист может считать, что починил; знает это только человек
                (разд. 21). Низкая оценка сразу спрашивает причину — иначе цифра
                ничего не объясняет.
              */}
              {asksResult && (
                <div className="support-ask">
                  <b>Всё работает?</b>
                  <span className="dim">
                    Специалист считает, что починил. Закрыть разговор можете только вы.
                  </span>
                  <div className="support-ask-row">
                    <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => setLowReason(0)}>
                      Да, проблема решена
                    </button>
                    <button className="btn btn-sm" disabled={busy} onClick={() => void confirm(false)}>
                      Нет, нужна помощь
                    </button>
                  </div>
                  {lowReason !== null && (
                    <div className="support-csat">
                      <span className="dim">Как прошла помощь?</span>
                      <div className="support-faces">
                        {FACES.map((f) => (
                          <button
                            key={f.score}
                            className="support-face"
                            title={f.label}
                            disabled={busy}
                            onClick={() => (f.score <= 2 ? setLowReason(f.score) : void confirm(true, f.score))}
                          >
                            {f.face}
                          </button>
                        ))}
                      </div>
                      {!!lowReason && lowReason <= 2 && (
                        <div className="support-reasons">
                          {REASONS.map((r) => (
                            <button key={r} className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void confirm(true, lowReason, r)}>
                              {r}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}

              {/*
                Инструменты специалиста: диагностика, инженер, задача.

                Всё, за чем раньше пришлось бы ходить по системе и спрашивать человека:
                где он был, в каком браузере, что за ошибка (разд. 17), — плюс два
                действия, из-за которых обращение обычно и застревает.
              */}
              {tools && conv && (
                <div className="support-tools">
                  <div className="support-tools-head">
                    <b>Диагностика</b>
                    <span className="dim">видно только специалисту</span>
                  </div>

                  {/*
                    Записка помощника — первым делом.

                    Человек уже рассказал боту, что случилось и что пробовал. Первый
                    вопрос живого специалиста «расскажите, что у вас» — ровно та потеря,
                    ради которой эта записка и готовится.
                  */}
                  {conv.handoffNote && (
                    <div className="support-handoff">
                      <b>Что было до вас</b>
                      <span>{conv.handoffNote}</span>
                    </div>
                  )}
                  <dl className="support-diag">
                    <dt>Адрес</dt><dd>{diag?.context?.url ?? '—'}</dd>
                    <dt>Раздел</dt>
                    <dd>
                      {diag?.context?.route ?? '—'}
                      {diag?.context?.entity_type ? ` · ${diag.context.entity_type} #${diag.context.entity_id}` : ''}
                    </dd>
                    <dt>Браузер</dt><dd>{diag?.context?.browser ?? '—'} · {diag?.context?.os ?? '—'}</dd>
                    <dt>Сборка</dt><dd>{diag?.context?.app_version ?? '—'}{diag?.context?.build_id ? ` (${diag.context.build_id})` : ''}</dd>
                    <dt>Ошибка</dt><dd>{diag?.context?.last_error ?? 'не было'}</dd>
                    <dt>Сеть</dt><dd>{diag?.context?.network ?? '—'}</dd>
                  </dl>
                  {!!diag?.issues.length && (
                    <div className="support-issues">
                      {diag.issues.map((i) => (
                        <span key={i.taskId} className={`badge${i.closed ? ' badge-muted' : ' badge-info'}`}>
                          Задача #{i.taskId} · {i.closed ? 'закрыта' : 'в работе'}
                        </span>
                      ))}
                    </div>
                  )}
                  {/*
                    Копилот (разд. 41): суть, что проверить, что сказать человеку.

                    Клиенту сам ничего не отправляет — после подключения специалиста ИИ
                    молчит, пока его не попросят. Ответ читает человек, а не машина.
                  */}
                  <div className="support-tools-acts">
                    <button className="btn btn-sm" disabled={busy} onClick={() => void askCopilot()}>
                      <Icon name="sparkles" size={13} /> Подсказка помощника
                    </button>
                    {/*
                      Режим помощника виден и переключается только здесь.

                      «Копилот» означает, что клиенту он не пишет. Вернуть его — решение
                      специалиста: сам он посреди живого разговора не возвращается.
                    */}
                    {conv.aiMode === 'copilot' ? (
                      <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void returnAi()}>
                        Вернуть помощника в разговор
                      </button>
                    ) : (
                      <span className="badge badge-info">помощник отвечает сам</span>
                    )}
                    {copilot?.known && (
                      <span className="badge badge-warn" title={`Задача #${copilot.known.taskId}`}>
                        похоже на известную: {copilot.known.title}
                      </span>
                    )}
                  </div>
                  {copilot?.summary && <div className="support-copilot">{copilot.summary}</div>}

                  <div className="support-tools-acts">
                    <select
                      className="input"
                      value=""
                      disabled={busy}
                      onChange={(e) => { void addEngineer(e.target.value); e.currentTarget.value = ''; }}
                      aria-label="Подключить инженера"
                    >
                      <option value="">Подключить инженера…</option>
                      {people
                        .filter((p) => !conv.participants.some((x) => String(x.user_id) === p.id))
                        .map((p) => <option key={p.id} value={p.id}>{p.fullName}</option>)}
                    </select>
                    <button className="btn btn-sm" disabled={busy} onClick={() => void createBug()}>
                      <Icon name="alert" size={13} /> Завести задачу
                    </button>
                  </div>

                  {/*
                    Доступ инженеров — со сроком и кнопкой «Закрыть».

                    Право читать чужую переписку выдаётся на время эскалации, а не
                    навсегда. Специалист должен видеть, кому сейчас открыт разговор, —
                    иначе отозвать доступ не придёт в голову никому.
                  */}
                  {!!grants.length && (
                    <div className="support-grants">
                      {grants.map((g) => (
                        <span key={g.engineerId} className={`support-grant${g.live ? ' live' : ''}`}>
                          <Icon name="user" size={12} /> {g.name}
                          <span className="dim">
                            {g.live
                              ? ` до ${new Date(g.expiresAt).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}`
                              : ' доступ закрыт'}
                          </span>
                          {g.live && (
                            <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void revokeEngineer(g.engineerId)}>
                              Закрыть
                            </button>
                          )}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              )}

              <div className="support-compose">
                <label className="chat-tool" title="Приложить снимок экрана или файл">
                  <Icon name="paperclip" size={17} />
                  <input
                    type="file"
                    hidden
                    onChange={(e) => { const f = e.target.files?.[0]; if (f) void attach(f); e.currentTarget.value = ''; }}
                  />
                </label>
                <textarea
                  className="input"
                  value={text}
                  rows={1}
                  placeholder="Что случилось?"
                  onChange={(e) => setText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key !== 'Enter' || e.shiftKey) return;
                    e.preventDefault();
                    void (mineConversation ? send() : replyAsAgent());
                  }}
                />
                <button
                  className="chat-send"
                  disabled={busy || !text.trim()}
                  onClick={() => void (mineConversation ? send() : replyAsAgent())}
                  title="Отправить"
                  aria-label="Отправить"
                >
                  <Icon name="send" size={17} />
                </button>
              </div>

              <footer className="support-foot">
                {/* Человек вправе знать, что уходит вместе с сообщением (разд. 50). */}
                <span className="dim support-ctx" title="Эти данные уйдут специалисту вместе с сообщением">
                  <Icon name="info" size={12} /> {ctx.join(' · ')}
                </span>
                {conv && mineConversation && !conv.agentId && conv.status !== 'closed' && (
                  <button className="btn btn-sm support-human" disabled={busy} onClick={() => void callHuman()}>
                    <Icon name="user" size={13} /> Позвать человека
                  </button>
                )}
                {conv && mineConversation && conv.status !== 'closed' && !asksResult && (
                  <button
                    className="btn btn-ghost btn-sm"
                    disabled={busy}
                    onClick={() => void closeMine()}
                    title="Закрыть разговор: вопрос больше не нужен. Если проблема вернётся — откроете заново."
                  >
                    <Icon name="check" size={13} /> Вопрос снят
                  </button>
                )}
                {conv && !mineConversation && conv.status !== 'closed' && conv.status !== 'waiting_user' && (
                  <button
                    className="btn btn-sm support-human"
                    disabled={busy}
                    onClick={() => void resolveAsAgent()}
                    title="Человек получит вопрос «Всё работает?» и закроет разговор сам"
                  >
                    <Icon name="check" size={13} /> Решено — спросить человека
                  </button>
                )}
              </footer>
            </>
          )}
        </aside>
      )}
    </>
  );
}
