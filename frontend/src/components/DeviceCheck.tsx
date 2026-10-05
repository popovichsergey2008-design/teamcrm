import { useEffect, useRef, useState } from 'react';
import { Icon } from './Icon';

/** Выбранные устройства — их же берёт окно созвона при входе. */
export const DEVICES_KEY = 'teamcrm.meet.devices';
export function savedDevices(): { audioIn?: string; videoIn?: string } {
  try { return JSON.parse(localStorage.getItem(DEVICES_KEY) || '{}'); } catch { return {}; }
}
function saveDevices(d: { audioIn?: string; videoIn?: string }) {
  try { localStorage.setItem(DEVICES_KEY, JSON.stringify(d)); } catch { /* приватный режим — не запомним */ }
}

/**
 * Проверка камеры и микрофона перед встречей (ТЗ-14, §32–33).
 *
 * Разрешения браузер спрашивает ТОЛЬКО по нажатию «Проверить» (§92): открыть ссылку за
 * сутки до встречи — не повод требовать камеру. Видно своё лицо, уровень микрофона
 * полоской, можно выбрать устройства и послушать звук. Выбор запоминается — окно созвона
 * возьмёт эти же устройства.
 */
export function DeviceCheck() {
  const [on, setOn] = useState(false);
  const [err, setErr] = useState('');
  const [level, setLevel] = useState(0);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [chosen, setChosen] = useState(savedDevices);
  const video = useRef<HTMLVideoElement | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const stopMeter = useRef<(() => void) | null>(null);

  const stop = () => {
    stopMeter.current?.(); stopMeter.current = null;
    stream.current?.getTracks().forEach((t) => t.stop());
    stream.current = null;
  };
  useEffect(() => stop, []);

  const start = async (pick = chosen) => {
    setErr('');
    stop();
    try {
      let s: MediaStream;
      try {
        s = await navigator.mediaDevices.getUserMedia({
          audio: pick.audioIn ? { deviceId: { ideal: pick.audioIn } } : true,
          video: pick.videoIn ? { deviceId: { ideal: pick.videoIn } } : true,
        });
      } catch {
        // камеры нет или её не дали — проверим хотя бы микрофон
        s = await navigator.mediaDevices.getUserMedia({ audio: pick.audioIn ? { deviceId: { ideal: pick.audioIn } } : true });
      }
      stream.current = s;
      if (video.current) { video.current.srcObject = s; void video.current.play().catch(() => undefined); }
      // уровень микрофона — полоской: видно, что вас слышно, ещё до встречи
      const ctx = new AudioContext();
      const src = ctx.createMediaStreamSource(s);
      const an = ctx.createAnalyser(); an.fftSize = 512;
      src.connect(an);
      const buf = new Uint8Array(an.fftSize);
      let raf = 0;
      const tick = () => {
        an.getByteTimeDomainData(buf);
        let peak = 0;
        for (const v of buf) peak = Math.max(peak, Math.abs(v - 128));
        setLevel(Math.min(1, peak / 64));
        raf = requestAnimationFrame(tick);
      };
      tick();
      stopMeter.current = () => { cancelAnimationFrame(raf); void ctx.close().catch(() => undefined); };
      setDevices(await navigator.mediaDevices.enumerateDevices());
      setOn(true);
    } catch {
      setErr('Браузер не дал доступ к микрофону и камере. Разрешите доступ в настройках сайта и нажмите «Проверить» ещё раз.');
    }
  };

  const pick = (kind: 'audioIn' | 'videoIn', id: string) => {
    const next = { ...chosen, [kind]: id || undefined };
    setChosen(next); saveDevices(next);
    void start(next);
  };

  /** Короткий сигнал — проверить динамик или наушники. */
  const beep = () => {
    const ctx = new AudioContext();
    const osc = ctx.createOscillator(); const g = ctx.createGain();
    osc.frequency.value = 660; g.gain.value = 0.12;
    osc.connect(g).connect(ctx.destination);
    osc.start(); osc.stop(ctx.currentTime + 0.35);
    osc.onended = () => { void ctx.close(); };
  };

  const mics = devices.filter((d) => d.kind === 'audioinput');
  const cams = devices.filter((d) => d.kind === 'videoinput');

  if (!on) {
    return (
      <div className="device-check">
        <button className="btn btn-sm" onClick={() => void start()}>
          <Icon name="video" size={15} /> Проверить камеру и микрофон
        </button>
        {err && <div className="error-text">{err}</div>}
      </div>
    );
  }
  return (
    <div className="device-check is-on">
      <video ref={video} className="device-preview" muted playsInline autoPlay />
      <div className="device-meter" aria-label="Уровень микрофона">
        <Icon name="mic" size={14} />
        <span className="device-meter-track"><span style={{ width: `${Math.round(level * 100)}%` }} /></span>
      </div>
      <div className="device-selects">
        {mics.length > 0 && (
          <select className="input" value={chosen.audioIn ?? ''} onChange={(e) => pick('audioIn', e.target.value)} aria-label="Микрофон">
            <option value="">Микрофон по умолчанию</option>
            {mics.map((d, i) => <option key={d.deviceId || i} value={d.deviceId}>{d.label || `Микрофон ${i + 1}`}</option>)}
          </select>
        )}
        {cams.length > 0 && (
          <select className="input" value={chosen.videoIn ?? ''} onChange={(e) => pick('videoIn', e.target.value)} aria-label="Камера">
            <option value="">Камера по умолчанию</option>
            {cams.map((d, i) => <option key={d.deviceId || i} value={d.deviceId}>{d.label || `Камера ${i + 1}`}</option>)}
          </select>
        )}
      </div>
      <div className="device-actions">
        <button className="btn btn-ghost btn-sm" onClick={beep}><Icon name="volume" size={14} /> Проверить звук</button>
        <button className="btn btn-ghost btn-sm" onClick={() => { stop(); setOn(false); }}>Закрыть проверку</button>
      </div>
    </div>
  );
}
