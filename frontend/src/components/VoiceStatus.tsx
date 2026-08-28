import { useEffect, useState } from 'react';

/**
 * Что сейчас происходит с микрофоном: слушаем, распознаём или сломалось.
 *
 * Без этой строки запись выглядит как зависшее окно: кнопка сменила подпись на
 * «Остановить», и всё — человек не знает, слышат ли его вообще, и говорит в тишину.
 * Живая волна и бегущий счётчик отвечают на оба вопроса сразу: идёт запись и сколько
 * она уже длится.
 *
 * Один компонент на все места диктовки: в командной строке и в быстрой команде
 * состояние микрофона обязано выглядеть одинаково.
 */
export function VoiceStatus({ recording, transcribing, error, hint, className }: {
  recording: boolean;
  transcribing: boolean;
  error?: string;
  /** Чем остановить запись — зависит от места: в палитре это ещё и пробел. */
  hint?: string;
  className?: string;
}) {
  const [seconds, setSeconds] = useState(0);

  useEffect(() => {
    if (!recording) return setSeconds(0);
    setSeconds(0);
    const t = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [recording]);

  if (!recording && !transcribing && !error) return null;

  const mmss = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  return (
    // role=status: экранный диктор сам объявит начало записи и распознавание
    <div className={`voice-status${error ? ' error' : ''}${className ? ` ${className}` : ''}`} role="status">
      {recording && (
        <>
          <span className="voice-wave" aria-hidden="true"><i /><i /><i /><i /></span>
          <span className="voice-status-main">Говорите…</span>
          <span className="voice-status-time">{mmss}</span>
          {hint && <span className="voice-status-hint">{hint}</span>}
        </>
      )}
      {!recording && transcribing && 'Распознаю речь…'}
      {!recording && !transcribing && error}
    </div>
  );
}
