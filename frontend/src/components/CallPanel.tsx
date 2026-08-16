import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError, tokens } from '../lib/api';
import { MeetClient, Peer, RemoteTrack } from '../lib/meet-client';

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
  const [state, setState] = useState<'connecting' | 'connected' | 'reconnecting' | 'closed'>('connecting');
  const [peers, setPeers] = useState<Peer[]>([]);
  const [tracks, setTracks] = useState<RemoteTrack[]>([]);
  const [micOn, setMicOn] = useState(true);
  const [camOn, setCamOn] = useState(false);
  const [screenOn, setScreenOn] = useState(false);
  const [hand, setHand] = useState(false);
  const [recording, setRecording] = useState(false);
  const [err, setErr] = useState('');

  const client = useRef<MeetClient | null>(null);
  const localStream = useRef<MediaStream | null>(null);
  const camProducer = useRef<string | null>(null);
  const screenProducer = useRef<string | null>(null);
  const localVideo = useRef<HTMLVideoElement | null>(null);

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
          onError: setErr,
        });
        client.current = c;
        await c.join();

        // микрофон берём сразу: звонок без звука бессмысленен
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        localStream.current = stream;
        const audio = stream.getAudioTracks()[0];
        if (audio) await c.publish(audio);

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
        if (localVideo.current) localVideo.current.srcObject = null;
        setCamOn(false);
        return;
      }
      const cam = await navigator.mediaDevices.getUserMedia({ video: { width: 1280, height: 720 } });
      const track = cam.getVideoTracks()[0];
      localStream.current?.addTrack(track);
      if (localVideo.current) localVideo.current.srcObject = new MediaStream([track]);
      camProducer.current = await c.publish(track);
      setCamOn(true);
    } catch {
      setErr('Нет доступа к камере');
    }
  }, [camOn]);

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
    } catch {
      setErr('Демонстрация экрана отменена');
    }
  }, [screenOn]);

  const leave = () => { client.current?.leave(); onClose(); };

  const videos = tracks.filter((t) => t.kind === 'video');
  const audios = tracks.filter((t) => t.kind === 'audio');

  return (
    <div className="call-overlay">
      <div className="call-window">
        <div className="call-head">
          <span>
            📞 Созвон · <span className="dim">{STATE_LABEL[state]}</span>
            {peers.length > 0 && <span className="badge badge-muted" style={{ marginLeft: 8 }}>участников: {peers.length}</span>}
          </span>
          <button className="btn btn-ghost btn-sm" onClick={leave}>✕</button>
        </div>

        {/* запись видна всем и всегда: тихой записи в продукте нет */}
        {recording && (
          <div className="call-recording">
            ⏺ Идёт запись. После завершения ИИ соберёт стенограмму с именами, сводку и предложит задачи.
          </div>
        )}
        {err && <div className="error-text" style={{ padding: '0 12px' }}>{err}</div>}

        <div className="call-grid">
          {videos.length === 0 && (
            <div className="call-empty muted">
              Видео никто не включил — идёт разговор голосом.
            </div>
          )}
          {videos.map((t) => (
            <RemoteVideo key={t.consumerId} track={t} name={peers.find((p) => p.userId === t.userId)?.displayName ?? '…'} />
          ))}
          {camOn && (
            <div className="call-tile call-self">
              <video ref={localVideo} autoPlay playsInline muted />
              <span className="call-name">вы</span>
            </div>
          )}
        </div>

        {/* Звук воспроизводится скрытыми элементами: в сетке ему делать нечего */}
        {audios.map((t) => <RemoteAudio key={t.consumerId} track={t.track} />)}

        <div className="call-peers">
          {peers.map((p) => (
            <span key={p.userId} className="badge badge-muted">
              {p.handRaised ? '✋ ' : ''}{p.displayName}
            </span>
          ))}
        </div>

        <div className="call-controls">
          <button className={`btn btn-sm ${micOn ? '' : 'call-off'}`} onClick={toggleMic}>
            {micOn ? '🎤 Микрофон' : '🔇 Включить микрофон'}
          </button>
          <button className={`btn btn-sm ${camOn ? '' : 'call-off'}`} onClick={toggleCam}>
            {camOn ? '📹 Камера' : '📷 Включить камеру'}
          </button>
          <button className={`btn btn-sm ${screenOn ? '' : 'call-off'}`} onClick={toggleScreen}>
            {screenOn ? '🖥 Показ идёт' : '🖥 Показать экран'}
          </button>
          <button className={`btn btn-sm ${hand ? '' : 'call-off'}`} onClick={() => { setHand(!hand); client.current?.raiseHand(!hand); }}>
            ✋ Рука
          </button>
          <button
            className={`btn btn-sm ${recording ? 'call-rec-on' : 'call-off'}`}
            onClick={() => client.current?.setRecording(!recording)}
            title={recording ? 'Остановить запись и получить стенограмму' : 'Записать созвон для стенограммы и задач'}
          >
            {recording ? '⏹ Остановить запись' : '⏺ Записать'}
          </button>
          <button className="btn btn-sm call-leave" onClick={leave}>Выйти</button>
        </div>
      </div>
    </div>
  );
}

function RemoteVideo({ track, name }: { track: RemoteTrack; name: string }) {
  const ref = useRef<HTMLVideoElement | null>(null);
  useEffect(() => {
    if (ref.current) ref.current.srcObject = new MediaStream([track.track]);
  }, [track]);
  return (
    <div className={`call-tile ${track.screen ? 'call-screen' : ''}`}>
      <video ref={ref} autoPlay playsInline />
      <span className="call-name">{name}{track.screen ? ' · экран' : ''}</span>
    </div>
  );
}

function RemoteAudio({ track }: { track: MediaStreamTrack }) {
  const ref = useRef<HTMLAudioElement | null>(null);
  useEffect(() => {
    if (ref.current) ref.current.srcObject = new MediaStream([track]);
  }, [track]);
  return <audio ref={ref} autoPlay />;
}
