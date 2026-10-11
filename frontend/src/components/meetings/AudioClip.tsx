import { useEffect, useRef, useState } from 'react';
import { Icon } from '../Icon';
import { apiUrl } from '../../lib/origin';
import './audio-clip.css';

const fmt = (s: number) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

/**
 * Проигрыватель фрагмента созвона (ТЗ-25, §32): «▶ 00:00 ━━━ 00:15».
 *
 * Ссылка подписана и живёт минуты; по ней браузер сам перематывает к началу фрагмента
 * и подкачивает только нужный кусок — часовую запись целиком не тянет (§50). Для готового
 * фрагмента задачи start = 0, для предпросмотра черновика — секунда внутри всей записи.
 */
export function AudioClip({ url, start, end, label, compact = false, onPlay }: {
  url: string; start: number; end: number; label?: string; compact?: boolean; onPlay?: () => void;
}) {
  const ref = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [pos, setPos] = useState(0);
  const [failed, setFailed] = useState(false);
  const len = Math.max(1, end - start);

  useEffect(() => () => { ref.current?.pause(); }, []);

  const toggle = async () => {
    const a = ref.current;
    if (!a) return;
    if (playing) { a.pause(); return; }
    try {
      // доиграли до конца — начинаем фрагмент сначала
      if (a.currentTime < start || a.currentTime >= end - 0.2) a.currentTime = start;
      await a.play();
      onPlay?.();
    } catch { setFailed(true); }
  };

  return (
    <div className={`aclip${compact ? ' aclip-compact' : ''}`}>
      <audio
        ref={ref} src={apiUrl(url)} preload="none"
        onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)}
        onError={() => setFailed(true)}
        onTimeUpdate={(e) => {
          const t = e.currentTarget.currentTime;
          setPos(Math.max(0, Math.min(len, t - start)));
          if (t >= end) { e.currentTarget.pause(); } // фрагмент кончился — дальше встреча не играет
        }}
      />
      <button type="button" className="aclip-btn" onClick={() => void toggle()} aria-label={playing ? 'Пауза' : 'Послушать'} disabled={failed}>
        <Icon name={playing ? 'pause' : 'play'} size={14} />
      </button>
      {label && <span className="aclip-label">{label}</span>}
      <span className="aclip-time">{fmt(pos)}</span>
      <span className="aclip-bar" aria-hidden="true"><i style={{ width: `${Math.round((pos / len) * 100)}%` }} /></span>
      <span className="aclip-time">{fmt(len)}</span>
      {failed && <span className="aclip-err">не загрузился</span>}
    </div>
  );
}
