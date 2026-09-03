import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Запись клипа: голос с микрофона или экран со звуком.
 *
 * Отдельно от `useVoiceInput` намеренно: тот записывает фразу, чтобы превратить её в
 * ТЕКСТ в поле ввода, а здесь запись — сама по себе сообщение. Смешивать их в одном
 * хуке значит каждый раз объяснять флагом, что именно имелось в виду.
 *
 * Что здесь легко сделать неправильно и потому сделано явно:
 *  - дорожки закрываются ВСЕГДА и первым делом, иначе в браузере остаётся гореть
 *    значок микрофона (или «идёт запись экрана»), и человек считает, что его пишут;
 *  - остановку показа экрана человек может нажать в панели браузера, а не в нашем
 *    интерфейсе — это тоже конец записи, и его надо поймать;
 *  - запись не должна идти вечно: есть предел, после которого она останавливается сама.
 */

/** Дольше этого клип перестаёт быть клипом, а файл — разумным по размеру. */
const MAX_MS = 5 * 60_000;

export type ClipKind = 'voice' | 'screen';

export function useClipRecorder(onClip: (blob: Blob, kind: ClipKind) => void) {
  const [recording, setRecording] = useState<ClipKind | null>(null);
  const [error, setError] = useState('');
  const recRef = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const timer = useRef<number | null>(null);
  const sink = useRef(onClip);
  sink.current = onClip;

  const stop = useCallback(() => {
    if (timer.current) { window.clearTimeout(timer.current); timer.current = null; }
    const mr = recRef.current;
    if (mr && mr.state !== 'inactive') mr.stop();
  }, []);

  const start = useCallback(async (kind: ClipKind) => {
    setError('');
    if (recRef.current && recRef.current.state !== 'inactive') return;
    if (typeof MediaRecorder === 'undefined') return setError('Браузер не умеет записывать');

    let stream: MediaStream;
    try {
      stream = kind === 'voice'
        ? await navigator.mediaDevices.getUserMedia({ audio: true })
        // Звук просим вместе с картинкой: запись экрана без голоса показывает, ЧТО
        // происходит, но не объясняет, что с этим не так.
        : await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    } catch {
      return setError(kind === 'voice' ? 'Микрофон недоступен' : 'Показ экрана отменён');
    }

    const mr = new MediaRecorder(stream);
    chunks.current = [];
    mr.ondataavailable = (e) => { if (e.data.size) chunks.current.push(e.data); };
    mr.onstop = () => {
      stream.getTracks().forEach((t) => t.stop());
      recRef.current = null;
      setRecording(null);
      const blob = new Blob(chunks.current, { type: mr.mimeType || (kind === 'voice' ? 'audio/webm' : 'video/webm') });
      if (blob.size) sink.current(blob, kind);
    };
    // Показ экрана останавливают кнопкой браузера, а не нашей: это тоже конец записи
    stream.getVideoTracks().forEach((t) => { t.onended = () => stop(); });

    recRef.current = mr;
    mr.start();
    setRecording(kind);
    timer.current = window.setTimeout(stop, MAX_MS);
  }, [stop]);

  // Ушли со страницы во время записи — поток обязан закрыться вместе с ней
  useEffect(() => () => {
    const mr = recRef.current;
    if (mr && mr.state !== 'inactive') mr.stop();
  }, []);

  return { recording, error, start, stop };
}
