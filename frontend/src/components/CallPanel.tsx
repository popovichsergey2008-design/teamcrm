import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './Icon';
import { CallInvite } from './CallInvite';
import { CallMini } from './CallMini';
import { RemoteAudio, RemoteMedia } from './CallMedia';
import { api, ApiError, tokens } from '../lib/api';
import { Knock, MeetClient, Peer, RemoteTrack } from '../lib/meet-client';
import { MiniPerson } from '../lib/call-mini';
import { openPipWindow, pipSupported } from '../lib/pip';
import { watchSpeaking } from '../lib/speaking';
import { diag } from '../lib/diag';
import { playKnock } from '../lib/sound';
import { useAuth } from '../state/auth';

/**
 * Размер свёрнутого созвона по умолчанию.
 *
 * Маленький намеренно: свёрнутое окно должно напоминать о разговоре, а не занимать
 * угол экрана. Растянуть его можно и мышью, и это запоминается — но исходный размер
 * рассчитан на «вижу собеседника краем глаза», а не «смотрю встречу».
 */
const PIP_SIZE = { width: 250, height: 200 };
/** Размер плашки внутри страницы. Человек тянет за угол — размер сохраняется. */
const DOCK_SIZE_KEY = 'teamcrm.callDockSize';
const DOCK_DEFAULT = { width: 210, height: 175 };

const STATE_LABEL: Record<string, string> = {
  connecting: 'Подключаюсь…',
  connected: 'На связи',
  reconnecting: 'Связь потеряна, восстанавливаю…',
  closed: 'Звонок завершён',
};

/**
 * Окно созвона. Микрофон включается сразу, камера — по желанию: на рабочих
 * планёрках она нужна не всегда, а трафик экономит заметно.
 */
export function CallPanel({ meetingId, inviteUserIds = [], guest, onClose }: {
  meetingId: string;
  inviteUserIds?: string[];
  /**
   * Гостевой вход по ссылке: свой токен и свои ICE-серверы, потому что учётной записи
   * у гостя нет. Внутри окна он отличается только урезанными правами.
   */
  guest?: { token: string; iceServers: RTCIceServer[]; userId: string };
  onClose: () => void;
}) {
  const { user } = useAuth();
  const isGuest = !!guest;
  const [state, setState] = useState<'connecting' | 'connected' | 'reconnecting' | 'closed'>('connecting');
  const [peers, setPeers] = useState<Peer[]>([]);
  const [tracks, setTracks] = useState<RemoteTrack[]>([]);
  const [micOn, setMicOn] = useState(true);
  const [camOn, setCamOn] = useState(false);
  const [screenOn, setScreenOn] = useState(false);
  const [hand, setHand] = useState(false);
  const [recording, setRecording] = useState(false);
  const [aiInvited, setAiInvited] = useState(false);
  const [err, setErr] = useState('');
  /** Гости, стучащиеся в дверь (видит только сотрудник). */
  const [knocks, setKnocks] = useState<Knock[]>([]);
  /** Состояние самого гостя: пока не впустили — сцены нет. */
  const [guestState, setGuestState] = useState<'waiting' | 'in' | 'rejected'>(isGuest ? 'waiting' : 'in');
  const [guestNote, setGuestNote] = useState('');
  const [linkNote, setLinkNote] = useState('');

  const client = useRef<MeetClient | null>(null);
  const localStream = useRef<MediaStream | null>(null);
  const camProducer = useRef<string | null>(null);
  const screenProducer = useRef<string | null>(null);
  // Своя дорожка хранится состоянием, а не ссылкой на элемент: элемент появляется
  // только после включения камеры, и присваивать ему поток раньше было некуда —
  // собственная плитка оставалась пустой.
  const [selfVideo, setSelfVideo] = useState<MediaStreamTrack | null>(null);
  const windowRef = useRef<HTMLDivElement | null>(null);
  const [full, setFull] = useState(false);
  /**
   * Свёрнутый созвон.
   *
   * Разговор продолжается: соединение, звук и запись не трогаем, меняется только
   * размер окна. Ради этого компонент и не размонтируется — иначе «свернуть» означало бы
   * «положить трубку», а человеку нужно посмотреть задачу, не выходя из разговора.
   */
  const [mini, setMini] = useState(false);
  /**
   * Окно поверх всех окон, если браузер его умеет.
   *
   * Плашка в углу страницы жила только на своей вкладке: человек уходил в почту
   * или в соседний проект — и созвон пропадал с глаз. Отдельное окно остаётся
   * поверх всего, как в Google Meet.
   */
  const [pipWin, setPipWin] = useState<Window | null>(null);
  const pipRef = useRef<Window | null>(null);
  /** Кто сейчас говорит: в свёрнутом окне видно три-четыре лица, и это должны быть нужные лица. */
  const [speaking, setSpeaking] = useState<string | null>(null);
  /** Куда человек перетащил плашку. Отсчёт от правого нижнего угла — она там и появляется. */
  const [dock, setDock] = useState({ right: 16, bottom: 16 });
  const dragFrom = useRef<{ x: number; y: number; right: number; bottom: number } | null>(null);
  /**
   * Размер плашки: человек тянет за угол, браузер меняет размеры сам (CSS resize),
   * а мы только запоминаем результат — иначе после каждого сворачивания окно
   * возвращалось бы к исходному, и растягивать его приходилось бы каждый раз.
   */
  const dockRef = useRef<HTMLDivElement | null>(null);
  const [dockSize] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(DOCK_SIZE_KEY) || 'null');
      return saved?.width && saved?.height ? saved as { width: number; height: number } : DOCK_DEFAULT;
    } catch { return DOCK_DEFAULT; }
  });
  const tracksRef = useRef<RemoteTrack[]>([]);

  // Полноэкранный режим: следим за системным событием, а не за своей кнопкой —
  // выйти можно и клавишей Esc, кнопка обязана это отражать.
  useEffect(() => {
    const onChange = () => setFull(document.fullscreenElement === windowRef.current);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);
  const toggleFull = async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await windowRef.current?.requestFullscreen();
    } catch { setErr('Браузер не разрешил полноэкранный режим'); }
  };

  /**
   * Свернуть.
   *
   * Сначала пробуем настоящее окно поверх всех окон и только при отказе браузера
   * оставляем плашку внутри страницы: Safari такого API не имеет, а разговор
   * сворачивать умеет каждый.
   */
  const minimize = async () => {
    if (document.fullscreenElement) { try { await document.exitFullscreen(); } catch { /* уже вышли */ } }
    const win = await openPipWindow(PIP_SIZE.width, PIP_SIZE.height);
    if (win) { pipRef.current = win; setPipWin(win); }
    setMini(true);
  };

  /** Вернуться к полному окну: отдельное окно при этом закрывается. */
  const expand = useCallback(() => {
    pipRef.current?.close();
    pipRef.current = null;
    setPipWin(null);
    setMini(false);
  }, []);

  // Окно поверх всех окон человек может закрыть крестиком — для нас это «развернуть обратно»,
  // а не «положить трубку»: разговор продолжается, менять надо только представление.
  useEffect(() => {
    if (!pipWin) return;
    const onHide = () => { pipRef.current = null; setPipWin(null); setMini(false); };
    pipWin.addEventListener('pagehide', onHide);
    return () => pipWin.removeEventListener('pagehide', onHide);
  }, [pipWin]);

  // Размер плашки запоминаем по окончании растягивания: писать в хранилище на каждый
  // пиксель бессмысленно, а терять выбранный размер — обидно.
  useEffect(() => {
    const el = dockRef.current;
    if (!el || !mini || pipWin || typeof ResizeObserver === 'undefined') return;
    let timer = 0;
    const ro = new ResizeObserver(() => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        try {
          localStorage.setItem(DOCK_SIZE_KEY, JSON.stringify({
            width: Math.round(el.offsetWidth), height: Math.round(el.offsetHeight),
          }));
        } catch { /* приватный режим — просто не запомним */ }
      }, 400);
    });
    ro.observe(el);
    return () => { window.clearTimeout(timer); ro.disconnect(); };
  }, [mini, pipWin]);

  // Созвон закончился, а окно осталось бы висеть поверх всего — закрываем вместе с панелью.
  useEffect(() => () => { pipRef.current?.close(); pipRef.current = null; }, []);

  // Кто говорит. Пересобираем анализаторы только при смене состава дорожек:
  // на каждое обновление списка участников это открывало бы новый AudioContext.
  tracksRef.current = tracks;
  const audioKey = tracks.filter((t) => t.kind === 'audio').map((t) => t.consumerId).sort().join(',');
  useEffect(() => {
    const list = tracksRef.current
      .filter((t) => t.kind === 'audio')
      .map((t) => ({ userId: String(t.userId), track: t.track }));
    return watchSpeaking(list, setSpeaking);
  }, [audioKey]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // у гостя ICE уже на руках — он получил их вместе с токеном, отдельного маршрута ему не дают
        const iceServers = guest ? guest.iceServers : (await api.iceServers()).iceServers;
        if (cancelled) return;
        const c = new MeetClient(meetingId, guest?.token ?? tokens.access ?? '', iceServers, {
          onPeers: setPeers,
          onTrack: (t) => setTracks((prev) => [...prev.filter((x) => x.consumerId !== t.consumerId), t]),
          onTrackGone: (id) => setTracks((prev) => prev.filter((x) => x.consumerId !== id)),
          onState: setState,
          onRecording: setRecording,
          onAiInvited: () => setAiInvited(true),
          onKnocks: (list) => {
            // звук только на прибавление: список приходит и когда гость ушёл сам
            setKnocks((prev) => { if (list.length > prev.length) playKnock(); return list; });
          },
          onGuestWaiting: (hostPresent) => {
            setGuestState('waiting');
            setGuestNote(hostPresent
              ? 'Вы в комнате ожидания — организатор видит вашу заявку.'
              : 'Встреча ещё не началась. Как только организатор подключится, он вас впустит.');
          },
          onGuestAdmitted: () => { setGuestState('in'); setGuestNote(''); },
          onGuestRejected: (reason) => {
            setGuestState('rejected');
            setGuestNote(reason === 'revoked'
              ? 'Ссылка больше не действует — попросите новую.'
              : 'Организатор отклонил вход.');
          },
          onError: setErr,
        }, String(guest?.userId ?? user?.id ?? ''));
        client.current = c;
        await c.join();

        // микрофон берём сразу: звонок без звука бессмысленен
        // Просим подавление эха явно: со значением по умолчанию браузеры расходятся,
        // и голос из динамиков возвращается собеседнику отражённым.
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        });
        localStream.current = stream;
        const audio = stream.getAudioTracks()[0];
        // Что именно дал браузер: заглушенный или выключённый микрофон выглядит
        // для собеседника ровно как «не слышно», а причина совсем другая.
        diag('meet', 'mic', meetingId, audio
          ? { label: audio.label, enabled: audio.enabled, muted: audio.muted, state: audio.readyState }
          : { missing: true });
        // молчание в одну сторону — самая обидная поломка созвона, поэтому говорим прямо
        if (!audio) setErr('Микрофон не найден — вас не будет слышно');
        else if (!(await c.publish(audio))) setErr('Микрофон не удалось передать — перезайдите в созвон');

        // зовём собеседников уже после того, как сами вошли: иначе человек примет
        // звонок и попадёт в пустую комнату
        if (inviteUserIds.length) c.invite(inviteUserIds);
      } catch (e) {
        setErr(e instanceof ApiError ? e.message : (e as Error)?.message ?? 'Не удалось подключиться');
      }
    })();
    return () => {
      cancelled = true;
      client.current?.leave();
      localStream.current?.getTracks().forEach((t) => t.stop());
    };
    // список приглашаемых берётся один раз при входе в комнату — перезаходить на его смену нельзя
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meetingId]);

  const toggleMic = useCallback(async () => {
    const next = !micOn;
    setMicOn(next);
    await client.current?.setMuted('audio', !next);
  }, [micOn]);

  const toggleCam = useCallback(async () => {
    const c = client.current;
    if (!c) return;
    try {
      if (camOn) {
        if (camProducer.current) await c.unpublish(camProducer.current);
        camProducer.current = null;
        localStream.current?.getVideoTracks().forEach((t) => { t.stop(); localStream.current?.removeTrack(t); });
        setSelfVideo(null);
        setCamOn(false);
        return;
      }
      const cam = await navigator.mediaDevices.getUserMedia({ video: { width: 1280, height: 720 } });
      const track = cam.getVideoTracks()[0];
      localStream.current?.addTrack(track);
      setSelfVideo(track);
      camProducer.current = await c.publish(track);
      setCamOn(true);
    } catch (e) {
      diag('meet', 'camera.denied', meetingId, { error: (e as Error)?.name });
      setErr('Нет доступа к камере');
    }
  }, [camOn, meetingId]);

  const toggleScreen = useCallback(async () => {
    const c = client.current;
    if (!c) return;
    try {
      if (screenOn) {
        if (screenProducer.current) await c.unpublish(screenProducer.current);
        screenProducer.current = null;
        setScreenOn(false);
        return;
      }
      const display = await navigator.mediaDevices.getDisplayMedia({ video: true });
      const track = display.getVideoTracks()[0];
      // пользователь может остановить показ кнопкой браузера — состояние надо вернуть
      track.onended = () => { screenProducer.current = null; setScreenOn(false); };
      screenProducer.current = await c.publish(track, { screen: true });
      setScreenOn(true);
    } catch (e) {
      diag('meet', 'screen.cancelled', meetingId, { error: (e as Error)?.name });
      setErr('Демонстрация экрана отменена');
    }
  }, [screenOn, meetingId]);

  const leave = () => {
    pipRef.current?.close();
    pipRef.current = null;
    client.current?.leave();
    onClose();
  };

  /** Впустить гостя или отказать — одинаково из полного окна и из свёрнутого. */
  const answerKnock = (guestId: string, admit: boolean) => {
    client.current?.answerKnock(guestId, admit);
    setKnocks((x) => x.filter((i) => i.guestId !== guestId));
  };

  /**
   * Перетаскивание плашки (там, где отдельного окна нет).
   *
   * Прижатая к правому нижнему углу плашка закрывает кнопки задач — человек
   * должен иметь возможность её отодвинуть, а не терпеть.
   */
  const startDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest('button')) return;
    dragFrom.current = { x: e.clientX, y: e.clientY, ...dock };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    const from = dragFrom.current;
    if (!from) return;
    // держим плашку в пределах экрана: утащить её за край значит потерять созвон
    setDock({
      right: Math.max(8, Math.min(window.innerWidth - 140, from.right - (e.clientX - from.x))),
      bottom: Math.max(8, Math.min(window.innerHeight - 120, from.bottom - (e.clientY - from.y))),
    });
  };
  const endDrag = () => { dragFrom.current = null; };

  /**
   * Ссылка для внешнего гостя. Копируем сразу в буфер: её всё равно понесут в мессенджер,
   * а показывать длинный токен на экране незачем.
   */
  const copyGuestLink = async () => {
    try {
      const { url } = await api.createGuestLink({ roomId: meetingId });
      try {
        await navigator.clipboard.writeText(url);
        setLinkNote('Ссылка скопирована — отправьте её гостю. Действует сутки.');
      } catch {
        // буфер обмена может быть запрещён политикой браузера — тогда показываем адрес
        setLinkNote(url);
      }
    } catch (e) {
      setLinkNote(e instanceof ApiError ? e.message : 'Не удалось создать ссылку');
    }
  };

  const audios = tracks.filter((t) => t.kind === 'audio');
  const screenTrack = tracks.find((t) => t.kind === 'video' && t.screen) ?? null;
  // видео по участникам: плитка есть у каждого, даже если камера выключена
  const camByUser = new Map(tracks.filter((t) => t.kind === 'video' && !t.screen).map((t) => [String(t.userId), t]));
  const me = String(guest?.userId ?? user?.id ?? '');
  const tiles = peers.map((p) => ({ peer: p, track: camByUser.get(String(p.userId)) ?? null }));

  const people: MiniPerson[] = tiles.map(({ peer, track }) => ({
    id: String(peer.userId),
    name: peer.displayName,
    hasVideo: String(peer.userId) === me ? !!selfVideo : !!track,
    isSelf: String(peer.userId) === me,
    isAi: peer.isAi,
  }));

  /*
    Звук стоит первым и вне окна созвона намеренно.

    Свернув разговор, человек уносит окно в другое документное дерево (окно поверх
    всех окон) — переезд пересоздал бы элементы <audio>, и на каждом сворачивании
    собеседник пропадал бы на полсекунды. Здесь же элементы остаются на месте
    независимо от того, как выглядит созвон.
  */
  const sound = <>{audios.map((t) => <RemoteAudio key={t.consumerId} track={t.track} />)}</>;

  if (mini) {
    const panel = (
      <CallMini
        people={people}
        videoOf={(id) => (id === me ? selfVideo : camByUser.get(id)?.track ?? null)}
        speaking={speaking}
        micOn={micOn}
        camOn={camOn}
        recording={recording}
        peerCount={peers.length}
        detached={!!pipWin}
        knocks={isGuest ? [] : knocks}
        onKnock={answerKnock}
        onMic={toggleMic}
        onCam={toggleCam}
        onExpand={expand}
        onLeave={leave}
      />
    );
    return (
      <>
        {sound}
        {pipWin
          ? createPortal(panel, pipWin.document.body)
          : (
            <div
              className="call-dock"
              ref={dockRef}
              style={{ right: dock.right, bottom: dock.bottom, width: dockSize.width, height: dockSize.height }}
              onPointerDown={startDrag}
              onPointerMove={onDrag}
              onPointerUp={endDrag}
              onPointerCancel={endDrag}
            >
              {panel}
            </div>
          )}
      </>
    );
  }

  return (
    <>
    {sound}
    <div className="call-overlay">
      <div className="call-window" ref={windowRef}>
        <div className="call-head">
          <span>
            <Icon name="phone" size={16} /> Созвон · <span className="dim">{STATE_LABEL[state]}</span>
            {peers.length > 0 && <span className="badge badge-muted" style={{ marginLeft: 8 }}>участников: {peers.length}</span>}
            {/* Статус ИИ виден всегда и первым делом: человек должен понимать,
                слушает его система или нет, не разглядывая кнопки внизу. */}
            <span className={`call-ai-status${recording ? ' on' : ''}`} title={recording
              ? 'Идёт запись: после созвона будут стенограмма, сводка и предложенные задачи'
              : 'Запись выключена — стенограммы и задач по этому созвону не будет'}>
              <span className="call-ai-dot" aria-hidden="true" />
              AI: {recording ? 'активен' : aiInvited ? 'ждёт речи' : 'выключен'}
              {recording && <span className="dim call-ai-what"> — транскрибирует и готовит задачи</span>}
            </span>
          </span>
          <span className="call-head-actions">
            {/* Позвать человека можно двумя способами, и оба стоят здесь: сотрудника —
                звонком, внешнего гостя — ссылкой. Раньше состав собирали до звонка,
                а нужный человек вспоминается по ходу разговора. */}
            {!isGuest && (
              <>
                <CallInvite
                  present={peers.map((p) => String(p.userId))}
                  onInvite={(ids) => client.current?.invite(ids)}
                />
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={copyGuestLink}
                  title="Скопировать ссылку для внешнего гостя — он войдёт из браузера, без регистрации"
                >
                  <Icon name="link" size={15} /> Ссылка для гостя
                </button>
              </>
            )}
            <button
              className="btn btn-ghost btn-sm"
              onClick={() => void minimize()}
              title={pipSupported()
                ? 'Свернуть — созвон останется отдельным окном поверх других программ'
                : 'Свернуть — разговор продолжится в углу страницы'}
              aria-label="Свернуть созвон"
            >
              <Icon name="minimize" size={15} />
            </button>
            <button className="btn btn-ghost btn-sm" onClick={toggleFull} title={full ? 'Свернуть из полного экрана' : 'Развернуть на весь экран'}>
              <Icon name={full ? 'minimize' : 'maximize'} size={15} />
            </button>
            <button className="btn btn-ghost btn-sm" onClick={leave} title="Выйти из созвона"><Icon name="close" /></button>
          </span>
        </div>

        {/* запись видна всем и всегда: тихой записи в продукте нет */}
        {recording && (
          <div className="call-recording">
            <Icon name="record" /> Идёт запись. После завершения ИИ соберёт стенограмму с именами, сводку и предложит задачи.
          </div>
        )}
        {/* ИИ позвали, но запись ещё не пошла: звук не начался */}
        {aiInvited && !recording && (
          <div className="call-recording call-ai-waiting">
            <Icon name="robot" /> ИИ-ассистент приглашён — запись начнётся, как только кто-нибудь заговорит.
          </div>
        )}
        {err && <div className="error-text" style={{ padding: '0 12px' }}>{err}</div>}

        {/* Гости за дверью. Впустить может любой сотрудник, который уже в комнате. */}
        {knocks.map((k) => (
          <div className="call-knock" key={k.guestId}>
            <span><Icon name="user" size={15} /> <b>{k.name}</b> просится в созвон — это внешний гость</span>
            <span className="call-knock-actions">
              <button className="btn btn-sm" onClick={() => answerKnock(k.guestId, true)}>Впустить</button>
              <button className="btn btn-ghost btn-sm" onClick={() => answerKnock(k.guestId, false)}>Отказать</button>
            </span>
          </div>
        ))}
        {linkNote && <div className="call-recording call-ai-waiting"><Icon name="link" size={15} /> {linkNote}</div>}

        {/* Гость до впуска сцены не видит и не слышит: он ещё не в комнате. */}
        {isGuest && guestState !== 'in' && (
          <div className="call-stage call-lobby">
            <div className="call-lobby-box">
              <Icon name={guestState === 'rejected' ? 'close' : 'clock'} size={28} />
              <h3>{guestState === 'rejected' ? 'Вход не состоялся' : 'Ждём, пока вас впустят'}</h3>
              <p className="dim">{guestNote}</p>
              {guestState !== 'rejected' && (
                <p className="dim" style={{ fontSize: 12 }}>
                  Микрофон можно разрешить заранее — тогда вы сразу сможете говорить.
                </p>
              )}
            </div>
          </div>
        )}

        {/* Показ экрана занимает сцену целиком, люди уезжают в полосу снизу:
            в общей сетке демонстрация выходила мелкой и нечитаемой. */}
        {(!isGuest || guestState === 'in') && (
        <div className="call-stage">
          {screenTrack && (
            <div className="call-spotlight">
              <RemoteMedia track={screenTrack.track} />
            </div>
          )}
          <div className={screenTrack ? 'call-strip' : 'call-grid'}>
            {tiles.map(({ peer, track }) => (
              <ParticipantTile
                key={peer.userId}
                peer={peer}
                track={track?.track ?? null}
                self={String(peer.userId) === me}
                selfTrack={String(peer.userId) === me ? selfVideo : null}
                selfMicOn={micOn}
              />
            ))}
          </div>
        </div>
        )}

        <div className="call-controls">
          <button className={`btn btn-sm ${micOn ? '' : 'call-off'}`} onClick={toggleMic}>
            <Icon name={micOn ? 'mic' : 'mic-off'} size={15} />{micOn ? 'Микрофон' : 'Включить микрофон'}
          </button>
          <button className={`btn btn-sm ${camOn ? '' : 'call-off'}`} onClick={toggleCam}>
            <Icon name={camOn ? 'video' : 'video-off'} size={15} />{camOn ? 'Камера' : 'Включить камеру'}
          </button>
          <button className={`btn btn-sm ${screenOn ? '' : 'call-off'}`} onClick={toggleScreen}>
            <Icon name="screen" size={15} />{screenOn ? 'Показ идёт' : 'Показать экран'}
          </button>
          <button className={`btn btn-sm ${hand ? '' : 'call-off'}`} onClick={() => { setHand(!hand); client.current?.raiseHand(!hand); }}>
            <Icon name="hand" size={15} /> Рука
          </button>
          {/* Запись и приглашение гостей — права хозяина встречи, не гостя */}
          {!isGuest && (
            <button
              className={`btn btn-sm ${recording ? 'call-rec-on' : 'call-off'}`}
              onClick={() => client.current?.setRecording(!recording)}
              title={recording ? 'Остановить запись и получить стенограмму' : 'Записать созвон для стенограммы и задач'}
            >
              <Icon name={recording ? 'stop' : 'record'} size={15} />AI-запись: {recording ? 'вкл' : 'выкл'}
            </button>
          )}
          <button className="btn btn-sm call-leave" onClick={leave}>Выйти</button>
        </div>
      </div>
    </div>
    </>
  );
}

/**
 * Плитка участника: своя у каждого, кто в созвоне, — как в привычных
 * видеовстречах. Без камеры показываем инициал, иначе на месте человека
 * зияет чёрный прямоугольник и непонятно, здесь он вообще или нет.
 */
function ParticipantTile({ peer, track, self, selfTrack, selfMicOn }: {
  peer: Peer;
  track: MediaStreamTrack | null;
  self: boolean;
  selfTrack: MediaStreamTrack | null;
  selfMicOn: boolean;
}) {
  const shown = self ? selfTrack : track;
  return (
    <div className={`call-tile ${self ? 'call-self' : ''} ${peer.isAi ? 'call-tile-ai' : ''}`}>
      {shown
        ? <RemoteMedia track={shown} muted={self} />
        : (
          <span className="call-avatar">
            {peer.isAi ? <Icon name="robot" size={26} /> : (peer.displayName?.[0] ?? '?').toUpperCase()}
          </span>
        )}
      {peer.handRaised && <span className="call-hand" title="Просит слова"><Icon name="hand" size={16} /></span>}
      {self && !selfMicOn && <span className="call-muted-mark" title="Ваш микрофон выключен"><Icon name="mic-off" size={16} /></span>}
      <span className="call-name">
        {self ? 'вы' : peer.displayName}
        {peer.isAi ? ' · стенограмма' : ''}
        {/* внешнего человека видно сразу: при нём говорят иначе, чем при своих */}
        {peer.isGuest ? ' · гость' : ''}
      </span>
    </div>
  );
}

