import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './Icon';
import { CallInvite } from './CallInvite';
import { CallMini } from './CallMini';
import { RemoteAudio, RemoteMedia } from './CallMedia';
import { api, ApiError, tokens } from '../lib/api';
import { Knock, MeetClient, Peer, RemoteTrack } from '../lib/meet-client';
import { MiniPerson, callTime, currentScreen, mergeTrack } from '../lib/call-mini';
import { openPipWindow, pipSupported } from '../lib/pip';
import { watchSpeaking } from '../lib/speaking';
import { diag } from '../lib/diag';
import { playKnock, startRingback, stopRingback } from '../lib/sound';
import { useAuth } from '../state/auth';
import { platform } from '../platform';
import { clampTo, useDragMove } from '../hooks/useDragMove';
import { useMediaQuery } from '../hooks/useMediaQuery';
import { savedDevices } from './DeviceCheck';
import { confirmAction } from './ui/dialog';

/**
 * Размер свёрнутого созвона по умолчанию.
 *
 * Просим у браузера самое маленькое окно, какое он согласится открыть: свёрнутый
 * созвон должен напоминать о разговоре, а не занимать угол экрана. Chrome и Edge
 * подтягивают запрошенный размер до своего минимума сами — просить меньше не вредно,
 * а больше отдавать незачем. Кому нужно крупнее — тянет за край окна, и размер
 * запоминается.
 */
const PIP_SIZE = { width: 168, height: 108 };
/** Размер плашки внутри страницы. Человек тянет за угол — размер сохраняется. */
const DOCK_SIZE_KEY = 'teamcrm.callDockSize';
const DOCK_DEFAULT = { width: 148, height: 100 };

/** Почему не впустили — словами (ТЗ-14, §93). */
const REJECT_NOTE: Record<string, string> = {
  revoked: 'Ссылка больше не действует — попросите новую.',
  'invite-revoked': 'Ваше приглашение больше не активно.',
  empty: 'В этом созвоне сейчас нет никого из команды — впустить вас некому.',
  locked: 'Организатор закрыл вход в эту встречу.',
  ended: 'Встреча уже завершена.',
  cancelled: 'Встреча отменена организатором.',
  unavailable: 'У этой встречи больше нет созвона.',
};

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
export function CallPanel({ meetingId, inviteUserIds = [], guest, withCamera = false, onClose }: {
  meetingId: string;
  inviteUserIds?: string[];
  /**
   * Войти сразу с камерой — «видеозвонок» против «позвонить».
   *
   * Разница только в этом: комната одна и та же, камера в ней и так включается
   * кнопкой. Заводить два разных созвона ради этого было бы обманом — снаружи они
   * выглядели бы разными сущностями, а внутри одинаковы.
   */
  withCamera?: boolean;
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
  // Гудки звонящему: позвали людей, а в комнате пока никого. Вошёл первый — тишина.
  useEffect(() => {
    if (inviteUserIds.length > 0 && peers.length === 0 && !isGuest) startRingback();
    else stopRingback();
    return () => stopRingback();
  }, [inviteUserIds.length, peers.length, isGuest]);
  const [tracks, setTracks] = useState<RemoteTrack[]>([]);
  const [micOn, setMicOn] = useState(true);
  /**
   * Куда идёт звук (задача #1464): null — платформа не умеет выбирать (браузер), и
   * кнопки громкой связи нет; иначе earpiece | speaker | headset.
   */
  const [audioRoute, setAudioRoute] = useState<string | null>(null);
  const [camOn, setCamOn] = useState(withCamera);
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
  /** Организатор этой встречи (или начавший созвон): ему — «Завершить для всех» и «Закрыть вход». */
  const [hostRole, setHostRole] = useState(false);
  const [locked, setLocked] = useState(false);
  /** «Сообщить организатору»: отправлено / можно ещё раз. */
  const [notified, setNotified] = useState<'pending' | 'sent' | 'later' | null>(null);
  const [linkNote, setLinkNote] = useState('');

  const client = useRef<MeetClient | null>(null);
  const localStream = useRef<MediaStream | null>(null);
  const camProducer = useRef<string | null>(null);
  const screenProducer = useRef<string | null>(null);
  /** Захват экрана: держим сам поток, чтобы погасить его дорожки при остановке показа. */
  const screenStream = useRef<MediaStream | null>(null);
  // Своя дорожка хранится состоянием, а не ссылкой на элемент: элемент появляется
  // только после включения камеры, и присваивать ему поток раньше было некуда —
  // собственная плитка оставалась пустой.
  const [selfVideo, setSelfVideo] = useState<MediaStreamTrack | null>(null);
  const windowRef = useRef<HTMLDivElement | null>(null);
  const [full, setFull] = useState(false);
  /**
   * Как показан созвон. Сам разговор от этого не зависит НИКАК: соединение, звук и
   * запись живут, пока компонент смонтирован, — меняется только представление.
   *
   *  - `full`   — обычное окно;
   *  - `mini`   — свёрнут (отдельное окно поверх всех окон либо плашка в углу);
   *  - `hidden` — убран с глаз совсем: на экране остаётся только маленькая кнопка
   *               с часами и микрофоном. Сюда ведут ДВА крестика: в шапке полного окна
   *               и в полосе кнопок свёрнутого. А вот системный крестик самого
   *               окошка-невелички возвращает разговор в полное окно: человек
   *               закрывает окошко, чтобы оно не мешало ЗДЕСЬ, а не чтобы спрятать
   *               созвон ещё глубже. Раньше крестик означал «положить трубку», и
   *               убрать окно, не выходя из разговора, было нельзя вовсе.
   */
  const [view, setView] = useState<'full' | 'mini' | 'hidden'>('full');
  const mini = view === 'mini';
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
  /*
    Куда передвинули само окно созвона (сдвиг от центра) и кнопку с часами.

    Заказчик: окно должно двигаться при любом размере — и большое, и маленькое, и
    самое маленькое. Сворачивается всё в правый нижний угол, а дальше человек ставит
    куда удобно. На телефоне большое окно — во весь экран, двигать там нечего.
  */
  const [shift, setShift] = useState({ x: 0, y: 0 });
  const [pill, setPill] = useState(() => ({ right: 16, bottom: window.innerWidth <= 1100 ? 80 : 16 }));
  const narrow = useMediaQuery('(max-width: 640px)');
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
  /**
   * Сколько идёт разговор.
   *
   * Нужно там, где созвон убран с глаз: маленькая кнопка возврата — единственное
   * свидетельство, что разговор ещё идёт, и часы на ней отвечают на главный вопрос
   * «я всё ещё в созвоне?». В полном окне часы не считаем: перерисовывать окно с
   * видео раз в секунду незачем.
   */
  const startedAt = useRef(Date.now());
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (view === 'full') return;
    const tick = () => setElapsed(Math.floor((Date.now() - startedAt.current) / 1000));
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [view]);

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
    setView('mini');
  };

  /**
   * Закрыть окно поверх всех окон ПО СВОЕЙ воле.
   *
   * Ссылку обнуляем ДО закрытия: по ней обработчик `pagehide` отличает «закрыли мы»
   * от «человек нажал крестик», а это два разных намерения с разным исходом.
   */
  const dropPip = useCallback(() => {
    const win = pipRef.current;
    pipRef.current = null;
    setPipWin(null);
    win?.close();
  }, []);

  /** Вернуться к полному окну: отдельное окно при этом закрывается. */
  const expand = useCallback(() => { dropPip(); setView('full'); }, [dropPip]);

  /** Убрать созвон с глаз. Разговор продолжается, на экране остаётся кнопка возврата. */
  const hide = useCallback(() => { dropPip(); setView('hidden'); }, [dropPip]);

  /*
    Системный крестик маленького окна — это «ВЕРНИ РАЗГОВОР В ОКНО».

    Крестиков в свёрнутом созвоне два, и означают они разное. Системный, в рамке
    самого окошка, человек нажимает, когда окошко больше не нужно ЗДЕСЬ, — и ждёт, что
    созвон вернётся в приложение. Наш, в полосе кнопок, убирает созвон с глаз совсем.
    Мы сначала сделали наоборот, и это оказалось ловушкой: попытка развернуть разговор
    сворачивала его ещё сильнее — до кнопки с часами.

    Трубку не кладём ни в том, ни в другом случае: разговор идёт, меняется только вид.
  */
  useEffect(() => {
    if (!pipWin) return;
    const onHide = () => {
      if (pipRef.current !== pipWin) return; // закрыли мы сами — представление уже выбрано
      pipRef.current = null;
      setPipWin(null);
      setView('full');
    };
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
          // правила сложения потоков — в call-mini: там же они и проверяются
          onTrack: (t) => setTracks((prev) => mergeTrack(prev, t)),
          onTrackGone: (id) => setTracks((prev) => prev.filter((x) => x.consumerId !== id)),
          onState: setState,
          onRecording: setRecording,
          onAiInvited: () => setAiInvited(true),
          onKnocks: (list) => {
            // звук только на прибавление: список приходит и когда гость ушёл сам
            setKnocks((prev) => { if (list.length > prev.length) playKnock(); return list; });
          },
          onGuestWaiting: (hostPresent, hostCalled) => {
            setGuestState('waiting');
            // сотрудник стучится в чужой созвон: его туда не звали
            if (!isGuest) {
              setGuestNote('Вас не звали в этот созвон — участники видят, что вы проситесь войти, и решат, впустить ли.');
              return;
            }
            setGuestNote(hostPresent
              ? 'Вы в комнате ожидания — организатор видит вашу заявку.'
              : hostCalled
                ? 'Организатору отправлено уведомление, что вы ждёте. Как только он подключится, он вас впустит.'
                : 'Встреча ещё не началась. Как только организатор подключится, он вас впустит.');
          },
          onGuestTooEarly: (opensAt) => {
            setGuestState('waiting');
            const at = new Date(opensAt);
            setGuestNote(Number.isNaN(at.getTime())
              ? 'Встреча ещё не скоро — вход откроется незадолго до начала.'
              : `Встреча ещё не скоро. Вход откроется в ${at.toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })}.`);
          },
          onGuestAdmitted: () => { setGuestState('in'); setGuestNote(''); },
          onGuestRejected: (reason) => {
            setGuestState('rejected');
            setGuestNote(REJECT_NOTE[reason]
              ?? (isGuest ? 'Организатор отклонил вход.' : 'Участники созвона не впустили вас.'));
          },
          onRole: (r) => { setHostRole(r.host); setLocked(r.locked); },
          onLocked: setLocked,
          onReplaced: () => {
            setGuestState('rejected');
            setGuestNote('Вы подключились к этому созвону в другой вкладке или на другом устройстве — здесь он закрыт.');
          },
          onEnded: (by) => {
            setGuestState('rejected');
            setGuestNote(by ? `${by} завершил(а) встречу для всех.` : 'Встреча завершена для всех.');
          },
          onHostNotified: (ok) => setNotified(ok ? 'sent' : 'later'),
          onError: setErr,
        }, String(guest?.userId ?? user?.id ?? ''));
        client.current = c;
        await c.join();

        // микрофон берём сразу: звонок без звука бессмысленен
        // Просим подавление эха явно: со значением по умолчанию браузеры расходятся,
        // и голос из динамиков возвращается собеседнику отражённым.
        // устройство, выбранное на проверке перед встречей, — если его выбирали
        const pickedMic = savedDevices().audioIn;
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true, noiseSuppression: true, autoGainControl: true,
            ...(pickedMic ? { deviceId: { ideal: pickedMic } } : {}),
          },
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
      // захват экрана живёт своим потоком: не погасив его, оставляем человеку
      // полосу «идёт демонстрация» уже после конца созвона
      screenStream.current?.getTracks().forEach((t) => { t.onended = null; t.stop(); });
      screenStream.current = null;
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
      const pickedCam = savedDevices().videoIn;
      const cam = await navigator.mediaDevices.getUserMedia({
        video: { width: 1280, height: 720, ...(pickedCam ? { deviceId: { ideal: pickedCam } } : {}) },
      });
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

  /**
   * Прекратить показ экрана — ОДНИМ путём, откуда бы его ни остановили.
   *
   * Остановить показ можно двумя способами: нашей кнопкой и полосой самого браузера
   * («Прекратить показ»). Второй путь раньше только гасил подпись на кнопке: серверу
   * никто не сообщал, поток оставался жить с мёртвой дорожкой, и следующий показ
   * упирался в него — собеседники видели чёрный прямоугольник вместо экрана.
   * Поэтому оба пути ведут сюда, и сервер узнаёт о конце показа всегда.
   */
  const stopScreen = useCallback(async () => {
    const id = screenProducer.current;
    screenProducer.current = null;
    setScreenOn(false);
    if (id) await client.current?.unpublish(id);
    // дорожки гасим сами: браузер держит полосу «идёт показ», пока жив хоть один трек
    screenStream.current?.getTracks().forEach((t) => { t.onended = null; t.stop(); });
    screenStream.current = null;
  }, []);

  const toggleScreen = useCallback(async () => {
    const c = client.current;
    if (!c) return;
    if (screenOn) { await stopScreen(); return; }
    let display: MediaStream | null = null;
    try {
      display = await navigator.mediaDevices.getDisplayMedia({ video: true });
      screenStream.current = display;
      const track = display.getVideoTracks()[0];
      if (!track) throw new Error('Браузер не дал картинку экрана');
      const id = await c.publish(track, { screen: true });
      if (!id) throw new Error('Сервер не принял показ экрана');
      screenProducer.current = id;
      setScreenOn(true);
      // остановка кнопкой браузера — такой же конец показа, как наша кнопка
      track.onended = () => { void stopScreen(); };
    } catch (e) {
      // не отдали экран или не долетел до сервера — гасим захват, иначе браузер
      // продолжит показывать «идёт демонстрация» при выключенном показе
      display?.getTracks().forEach((t) => t.stop());
      screenStream.current = null;
      screenProducer.current = null;
      setScreenOn(false);
      diag('meet', 'screen.cancelled', meetingId, { error: (e as Error)?.name ?? (e as Error)?.message });
      setErr('Демонстрация экрана отменена');
    }
  }, [screenOn, meetingId, stopScreen]);

  /*
    Звук к уху, как в Телеграме (задача #1464). Chromium в приложении при звонке сам
    включает громкую связь, поэтому переключаем, когда разговор уже пошёл, и ещё раз
    чуть позже: при старте звука он маршрут иногда переигрывает. После созвона —
    как было, иначе у человека и музыка потом заиграет «в трубку».
  */
  const routedRef = useRef(false);
  useEffect(() => {
    if (state !== 'connected' || routedRef.current) return;
    routedRef.current = true;
    void platform.calls.setAudioRoute('earpiece').then(setAudioRoute);
    const again = window.setTimeout(() => {
      void platform.calls.setAudioRoute('earpiece').then(setAudioRoute);
    }, 1500);
    return () => window.clearTimeout(again);
  }, [state]);
  useEffect(() => () => { void platform.calls.setAudioRoute('normal'); }, []);
  const toggleSpeaker = () => {
    const next = audioRoute === 'speaker' ? 'earpiece' : 'speaker';
    void platform.calls.setAudioRoute(next).then(setAudioRoute);
  };

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
  // Окошко в углу: держим целиком в пределах экрана — утащить его за край значит потерять созвон.
  // За уголок не тянем: там ручка, которой окошко растягивают.
  const dockDrag = useDragMove(
    (el) => ({ ...dock, w: el.offsetWidth, h: el.offsetHeight }),
    (s, dx, dy) => setDock({
      right: clampTo(s.right - dx, 8, window.innerWidth - s.w - 8),
      bottom: clampTo(s.bottom - dy, 8, window.innerHeight - s.h - 8),
    }),
    {
      ignore: (e) => {
        const r = e.currentTarget.getBoundingClientRect();
        return e.clientX > r.right - 18 && e.clientY > r.bottom - 18;
      },
    },
  );
  // Кнопка с часами: самое маленькое окно тоже двигается — за любое место, включая кнопки.
  const pillDrag = useDragMove(
    (el) => ({ ...pill, w: el.offsetWidth, h: el.offsetHeight }),
    (s, dx, dy) => setPill({
      right: clampTo(s.right - dx, 4, window.innerWidth - s.w - 4),
      bottom: clampTo(s.bottom - dy, 4, window.innerHeight - s.h - 4),
    }),
  );
  // Большое окно — за шапку. Шапка всегда остаётся на экране, чтобы окно можно было вернуть.
  const windowDrag = useDragMove(
    () => ({ ...shift, r: windowRef.current?.getBoundingClientRect() ?? new DOMRect() }),
    (s, dx, dy) => setShift({
      x: s.x + clampTo(dx, -(s.r.right - 160), window.innerWidth - s.r.left - 160),
      y: s.y + clampTo(dy, -s.r.top, window.innerHeight - s.r.top - 56),
    }),
    { disabled: full || narrow },
  );

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
  // Показов может прилететь несколько (кто-то показывает вслед за другим) — на сцене
  // всегда САМЫЙ СВЕЖИЙ. Брать первый попавшийся значило показывать то, что уже кончилось.
  const screenTrack = currentScreen(tracks);
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

  /*
    Созвон убран с глаз.

    На экране не остаётся ничего, кроме маленькой кнопки в углу: разговор идёт,
    вернуться — одним нажатием. Совсем без следа убирать нельзя — человек забудет,
    что микрофон включён, и его услышат там, где он этого не ждёт. Поэтому на кнопке
    состояние микрофона и часы разговора, а выключить микрофон можно, не возвращаясь.
  */
  if (view === 'hidden') {
    return (
      <>
        {sound}
        <div
          className="call-pill"
          style={{ right: pill.right, bottom: pill.bottom }}
          title="Созвон идёт. Окошко можно перетащить в любое место"
          {...pillDrag}
        >
          <span className="call-pill-grip" aria-hidden="true" />
          <button
            className={`call-pill-btn${micOn ? '' : ' call-pill-off'}`}
            onClick={toggleMic}
            title={micOn ? 'Выключить микрофон' : 'Включить микрофон'}
            aria-label={micOn ? 'Выключить микрофон' : 'Включить микрофон'}
          >
            <Icon name={micOn ? 'mic' : 'mic-off'} size={14} />
          </button>
          <button
            className="call-pill-back"
            onClick={() => setView('full')}
            title={knocks.length
              ? `Просятся в созвон (${knocks.length}) — вернитесь в окно, чтобы впустить`
              : 'Идёт созвон — вернуться в окно разговора'}
          >
            {recording
              ? <span className="mini-rec-dot" aria-hidden="true" />
              : <Icon name="phone" size={13} />}
            <span>{callTime(elapsed)}</span>
            {/* Гость, стучащийся в дверь, обязан быть виден даже в убранном созвоне:
                иначе он стоит там, пока о нём не вспомнят. */}
            {knocks.length > 0 && <span className="call-pill-knock">{knocks.length}</span>}
          </button>
          {/* Сбросить созвон прямо отсюда (задача #1463): раньше висящий в углу созвон
              приходилось разворачивать, чтобы найти «Выйти». */}
          <button
            className="call-pill-btn call-pill-hangup"
            onClick={leave}
            title="Положить трубку — выйти из созвона"
            aria-label="Положить трубку"
          >
            <Icon name="phone-off" size={14} />
          </button>
        </div>
      </>
    );
  }

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
        onHide={isGuest ? undefined : hide}
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
              {...dockDrag}
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
    <div className={`call-overlay${narrow ? '' : ' call-overlay-floating'}`}>
      <div
        className="call-window"
        ref={windowRef}
        style={full || narrow ? undefined : { transform: `translate(${shift.x}px, ${shift.y}px)` }}
      >
        <div className="call-head" title={full || narrow ? undefined : 'Окно можно перетащить за эту полосу'} {...windowDrag}>
          <span>
            <Icon name="phone" size={16} /> Созвон · <span className="dim">{STATE_LABEL[state]}</span>
            {peers.length > 0 && <span className="ui-badge ui-badge-neutral" style={{ marginLeft: 8 }}>участников: {peers.length}</span>}
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
                  className="ui-btn ui-btn-ghost ui-btn-sm"
                  onClick={copyGuestLink}
                  title="Скопировать ссылку для внешнего гостя — он войдёт из браузера, без регистрации"
                >
                  <Icon name="link" size={15} /><span className="call-btn-label"> Ссылка для гостя</span>
                </button>
              </>
            )}
            {/*
              Кнопки окна — как у любого окна на компьютере (просьба заказчика):
              «−» сворачивает до самого маленького — кнопки с часами и микрофоном;
              «❐» уменьшает до небольшого окна с лицами (поверх других программ, если
              браузер умеет); «⛶» — на весь экран; «×» выходит из созвона, как и
              красная кнопка внизу. Раньше крестик только прятал окно, и созвон
              продолжался незаметно для человека.
              У гостя «−» нет: за окном созвона у него пусто, сворачивать некуда.
            */}
            {!isGuest && (
              <button
                className="ui-btn ui-btn-ghost ui-btn-sm"
                onClick={hide}
                title="Свернуть до маленькой кнопки с часами и микрофоном — разговор продолжится"
                aria-label="Свернуть созвон до кнопки"
              >
                <Icon name="minus" size={15} />
              </button>
            )}
            <button
              className="ui-btn ui-btn-ghost ui-btn-sm"
              onClick={() => void minimize()}
              title={pipSupported()
                ? 'Уменьшить — небольшое окно поверх других программ'
                : 'Уменьшить — небольшое окно в углу страницы'}
              aria-label="Уменьшить окно созвона"
            >
              <Icon name="restore" size={15} />
            </button>
            <button className="ui-btn ui-btn-ghost ui-btn-sm" onClick={toggleFull} title={full ? 'Выйти из полного экрана' : 'Развернуть на весь экран'}>
              <Icon name={full ? 'minimize' : 'maximize'} size={15} />
            </button>
            <button
              className="ui-btn ui-btn-ghost ui-btn-sm call-head-close"
              onClick={leave}
              title="Выйти из созвона"
              aria-label="Выйти из созвона"
            >
              <Icon name="close" />
            </button>
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

        {/* За дверью: гости по ссылке и коллеги, которых не звали. Впустить может любой сотрудник в комнате. */}
        {knocks.map((k) => (
          <div className="call-knock" key={k.guestId}>
            <span>
              <Icon name="user" size={15} /> <b>{k.name}</b> просится в созвон
              {k.employee ? ' — коллега, его сюда не звали' : ' — это внешний гость'}
            </span>
            <span className="call-knock-actions">
              <button className="ui-btn ui-btn-outline ui-btn-sm" onClick={() => answerKnock(k.guestId, true)}>Впустить</button>
              <button className="ui-btn ui-btn-ghost ui-btn-sm" onClick={() => answerKnock(k.guestId, false)}>Отказать</button>
            </span>
          </div>
        ))}
        {linkNote && <div className="call-recording call-ai-waiting"><Icon name="link" size={15} /> {linkNote}</div>}

        {/* До впуска сцены не видно и не слышно — ни гостю, ни коллеге, которого не звали. */}
        {guestState !== 'in' && (
          <div className="call-stage call-lobby">
            <div className="call-lobby-box">
              <Icon name={guestState === 'rejected' ? 'close' : 'clock'} size={28} />
              <h3>{guestState === 'rejected' ? 'Вход не состоялся' : 'Ждём, пока вас впустят'}</h3>
              <p className="dim">{guestNote}</p>
              {guestState !== 'rejected' && isGuest && (
                <p className="dim" style={{ fontSize: 12 }}>
                  Микрофон можно разрешить заранее — тогда вы сразу сможете говорить.
                </p>
              )}
              {/* «Сообщить организатору, что я жду» — с ответом, что сообщение ушло (ТЗ-14, §35) */}
              {guestState === 'waiting' && (
                <button className="ui-btn ui-btn-outline ui-btn-sm" onClick={() => { client.current?.notifyHost(); setNotified('pending'); }} disabled={notified === 'pending' || notified === 'sent'}>
                  <Icon name="bell" size={14} /> {notified === 'sent' ? 'Организатору сообщили' : notified === 'later' ? 'Сообщить ещё раз' : 'Сообщить организатору, что я жду'}
                </button>
              )}
              {(!isGuest || guestState === 'rejected') && (
                <button className="ui-btn ui-btn-outline ui-btn-sm" onClick={leave}>
                  {guestState === 'rejected' ? 'Закрыть' : 'Не ждать'}
                </button>
              )}
            </div>
          </div>
        )}

        {/* Показ экрана занимает сцену целиком, люди уезжают в полосу снизу:
            в общей сетке демонстрация выходила мелкой и нечитаемой. */}
        {guestState === 'in' && (
        <div className="call-stage">
          {screenTrack && (
            <div className="call-spotlight">
              {/* ключ по потоку: сменился показывающий — элемент пересоздаётся целиком,
                  а не переиспользуется вместе с застрявшим кадром прежнего показа */}
              <RemoteMedia key={screenTrack.consumerId} track={screenTrack.track} />
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
          <button className={`ui-btn ui-btn-outline ui-btn-sm ${micOn ? '' : 'call-off'}`} onClick={toggleMic}>
            <Icon name={micOn ? 'mic' : 'mic-off'} size={15} />
            <span className="call-btn-label">{micOn ? 'Микрофон' : 'Включить микрофон'}</span>
            <span className="call-btn-cap">Микрофон</span>
          </button>
          <button className={`ui-btn ui-btn-outline ui-btn-sm ${camOn ? '' : 'call-off'}`} onClick={toggleCam}>
            <Icon name={camOn ? 'video' : 'video-off'} size={15} />
            <span className="call-btn-label">{camOn ? 'Камера' : 'Включить камеру'}</span>
            <span className="call-btn-cap">Камера</span>
          </button>
          {/* Громкая связь — только там, где ОС даёт выбрать, куда идёт звук (приложение на Android). */}
          {audioRoute !== null && audioRoute !== 'headset' && (
            <button
              className={`ui-btn ui-btn-outline ui-btn-sm ${audioRoute === 'speaker' ? 'call-on' : 'call-off'}`}
              onClick={toggleSpeaker}
              aria-pressed={audioRoute === 'speaker'}
              title={audioRoute === 'speaker' ? 'Выключить громкую связь — звук к уху' : 'Включить громкую связь'}
            >
              <Icon name="volume" size={15} />
              <span className="call-btn-label">{audioRoute === 'speaker' ? 'Громкая связь' : 'Громкая связь выкл.'}</span>
              <span className="call-btn-cap">Динамик</span>
            </button>
          )}
          {/* Показ экрана — только там, где браузер его умеет: в WebView Android getDisplayMedia нет,
              и кнопка обещала бы то, что кончится ошибкой (нативный показ — отдельным мостом, волна 11). */}
          {typeof navigator.mediaDevices?.getDisplayMedia === 'function' && (
          <button className={`ui-btn ui-btn-outline ui-btn-sm ${screenOn ? '' : 'call-off'}`} onClick={toggleScreen}>
            <Icon name="screen" size={15} /><span className="call-btn-label">{screenOn ? 'Показ идёт' : 'Показать экран'}</span>
            <span className="call-btn-cap">Экран</span>
          </button>
          )}
          <button className={`ui-btn ui-btn-outline ui-btn-sm ${hand ? '' : 'call-off'}`} onClick={() => { setHand(!hand); client.current?.raiseHand(!hand); }}>
            <Icon name="hand" size={15} /><span className="call-btn-label"> Рука</span>
            <span className="call-btn-cap">Рука</span>
          </button>
          {/* Запись и приглашение гостей — права хозяина встречи, не гостя */}
          {!isGuest && (
            <button
              className={`ui-btn ui-btn-outline ui-btn-sm ${recording ? 'call-rec-on' : 'call-off'}`}
              onClick={() => client.current?.setRecording(!recording)}
              title={recording ? 'Остановить запись и получить стенограмму' : 'Записать созвон для стенограммы и задач'}
            >
              <Icon name={recording ? 'stop' : 'record'} size={15} />
              <span className="call-btn-label">AI-запись: {recording ? 'вкл' : 'выкл'}</span>
              <span className="call-btn-cap">Запись</span>
            </button>
          )}
          {/*
            Организатору — «Закрыть вход» и «Завершить для всех» (ТЗ-14, §71, §74). Это не то же,
            что «Выйти»: выход кладёт только свою трубку, разговор у остальных продолжается.
          */}
          {hostRole && (
            <button
              className={`ui-btn ui-btn-outline ui-btn-sm ${locked ? 'call-rec-on' : 'call-off'}`}
              onClick={() => client.current?.setLocked(!locked)}
              title={locked ? 'Вход закрыт: новые люди не войдут и не постучатся. Нажмите, чтобы открыть' : 'Закрыть вход: новые люди не войдут, вернуться смогут только те, кто уже был'}
            >
              <Icon name="lock" size={15} />
              <span className="call-btn-label">{locked ? 'Вход закрыт' : 'Закрыть вход'}</span>
              <span className="call-btn-cap">{locked ? 'Закрыто' : 'Вход'}</span>
            </button>
          )}
          {hostRole && (
            <button
              className="ui-btn ui-btn-outline ui-btn-sm call-end-all"
              onClick={async () => { if (await confirmAction({ title: 'Завершить встречу для всех?', description: 'Все участники выйдут из созвона, а войти снова сможет только организатор.', confirmLabel: 'Завершить для всех', danger: true })) client.current?.endForAll(); }}
              title="Завершить встречу для всех: созвон закончится у каждого"
            >
              <Icon name="phone-off" size={15} />
              <span className="call-btn-label">Завершить для всех</span>
              <span className="call-btn-cap">Для всех</span>
            </button>
          )}
          {/* Выход — заметной красной кнопкой «положить трубку» (задача #1463). */}
          <button className="ui-btn ui-btn-outline ui-btn-sm call-leave" onClick={leave} title="Выйти из созвона — у остальных разговор продолжится" aria-label="Выйти из созвона">
            <span className="call-hangup-ico"><Icon name="phone" size={16} /></span>
            <span className="call-btn-label">Выйти</span>
            <span className="call-btn-cap">Выйти</span>
          </button>
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

