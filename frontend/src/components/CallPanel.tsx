import { useCallback, useEffect, useRef, useState } from 'react';
import { Icon } from './Icon';
import { api, ApiError, tokens } from '../lib/api';
import { MeetClient, Peer, RemoteTrack } from '../lib/meet-client';
import { diag } from '../lib/diag';
import { useAuth } from '../state/auth';

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
export function CallPanel({ meetingId, inviteUserIds = [], onClose }: {
  meetingId: string; inviteUserIds?: string[]; onClose: () => void;
}) {
  const { user } = useAuth();
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

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { iceServers } = await api.iceServers();
        if (cancelled) return;
        const c = new MeetClient(meetingId, tokens.access ?? '', iceServers, {
          onPeers: setPeers,
          onTrack: (t) => setTracks((prev) => [...prev.filter((x) => x.consumerId !== t.consumerId), t]),
          onTrackGone: (id) => setTracks((prev) => prev.filter((x) => x.consumerId !== id)),
          onState: setState,
          onRecording: setRecording,
          onAiInvited: () => setAiInvited(true),
          onError: setErr,
        }, String(user?.id ?? ''));
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

  const leave = () => { client.current?.leave(); onClose(); };

  const audios = tracks.filter((t) => t.kind === 'audio');
  const screenTrack = tracks.find((t) => t.kind === 'video' && t.screen) ?? null;
  // видео по участникам: плитка есть у каждого, даже если камера выключена
  const camByUser = new Map(tracks.filter((t) => t.kind === 'video' && !t.screen).map((t) => [String(t.userId), t]));
  const me = String(user?.id ?? '');
  const tiles = peers.map((p) => ({ peer: p, track: camByUser.get(String(p.userId)) ?? null }));

  return (
    <div className="call-overlay">
      <div className="call-window" ref={windowRef}>
        <div className="call-head">
          <span>
            <Icon name="phone" size={16} /> Созвон · <span className="dim">{STATE_LABEL[state]}</span>
            {peers.length > 0 && <span className="badge badge-muted" style={{ marginLeft: 8 }}>участников: {peers.length}</span>}
          </span>
          <span className="call-head-actions">
            <button className="btn btn-ghost btn-sm" onClick={toggleFull} title={full ? 'Свернуть из полного экрана' : 'Развернуть на весь экран'}>
              <Icon name={full ? 'minimize' : 'maximize'} size={15} />
            </button>
            <button className="btn btn-ghost btn-sm" onClick={leave} title="Закрыть"><Icon name="close" /></button>
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

        {/* Показ экрана занимает сцену целиком, люди уезжают в полосу снизу:
            в общей сетке демонстрация выходила мелкой и нечитаемой. */}
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

        {/* Звук воспроизводится скрытыми элементами: на сцене ему делать нечего */}
        {audios.map((t) => <RemoteAudio key={t.consumerId} track={t.track} />)}

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
          <button
            className={`btn btn-sm ${recording ? 'call-rec-on' : 'call-off'}`}
            onClick={() => client.current?.setRecording(!recording)}
            title={recording ? 'Остановить запись и получить стенограмму' : 'Записать созвон для стенограммы и задач'}
          >
            <Icon name={recording ? 'stop' : 'record'} size={15} />{recording ? 'Остановить запись' : 'Записать'}
          </button>
          <button className="btn btn-sm call-leave" onClick={leave}>Выйти</button>
        </div>
      </div>
    </div>
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
      <span className="call-name">{self ? 'вы' : peer.displayName}{peer.isAi ? ' · стенограмма' : ''}</span>
    </div>
  );
}

/**
 * Видеодорожка в элемент: srcObject нельзя задать разметкой, только из кода,
 * и делать это надо после появления элемента — отсюда эффект.
 * Своё видео обязательно без звука, иначе слышишь сам себя.
 */
function RemoteMedia({ track, muted = false }: { track: MediaStreamTrack; muted?: boolean }) {
  const ref = useRef<HTMLVideoElement | null>(null);
  useEffect(() => {
    if (ref.current) ref.current.srcObject = new MediaStream([track]);
  }, [track]);
  return <video ref={ref} autoPlay playsInline muted={muted} />;
}

function RemoteAudio({ track }: { track: MediaStreamTrack }) {
  const ref = useRef<HTMLAudioElement | null>(null);
  useEffect(() => {
    if (ref.current) ref.current.srcObject = new MediaStream([track]);
  }, [track]);
  return <audio ref={ref} autoPlay />;
}
