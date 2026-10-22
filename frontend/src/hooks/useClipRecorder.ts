import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from '../lib/api';

/**
 * Запись клипа (голос с микрофона или экран со звуком) и его отправка.
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
 *  - запись не должна идти вечно: есть предел, после которого она останавливается сама;
 *  - отправка тоже не должна висеть вечно (#4635): раньше `fetch` шёл без сигнала и
 *    таймаута, сервер ждал расшифровку минутами, а в лифте соединение просто замирало —
 *    «Отправляю…» висело до перезагрузки страницы, отменить было нечем. Теперь у
 *    отправки есть потолок по времени и «Отменить» на каждом шаге.
 */

/** Дольше этого клип перестаёт быть клипом, а файл — разумным по размеру. */
const MAX_MS = 5 * 60_000;

export type ClipKind = 'voice' | 'screen';

/**
 * Отправка записи под таймаутом и с отменой. Ждём минуту с четвертью на расшифровку
 * плюс загрузку (~40 КБ/с), но не больше двух минут. Возвращает текст ошибки;
 * пусто — ушло или отменено (отменённое `ref` уже не держит, о нём молчим).
 */
export async function sendTimed(ref: { current: AbortController | null }, bytes: number, step: (signal: AbortSignal) => Promise<unknown>) {
  const ac = new AbortController();
  ref.current = ac;
  let late = false;
  const t = window.setTimeout(() => { late = true; ac.abort(); }, Math.min(120_000, 75_000 + bytes / 40));
  try { await step(ac.signal); return ''; }
  catch (e) {
    return ref.current !== ac ? '' : `${late ? 'Сервер не ответил вовремя' : e instanceof ApiError ? e.message : 'Нет связи с сервером'}. Запись сохранена — повторите или отмените.`;
  } finally { window.clearTimeout(t); if (ref.current === ac) ref.current = null; }
}

type Send = (blob: Blob, kind: ClipKind, target: string, signal: AbortSignal) => Promise<unknown>;

export function useClipRecorder(send: Send) {
  const [recording, setRecording] = useState<ClipKind | null>(null);
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);
  /** Отправка не удалась: текст для человека; сама запись лежит в `kept` до «Повторить». */
  const [failed, setFailed] = useState('');
  const recRef = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const timer = useRef<number | null>(null);
  const drop = useRef(false);
  const ctrl = useRef<AbortController | null>(null);
  const kept = useRef<{ blob: Blob; kind: ClipKind; target: string } | null>(null);
  const sink = useRef(send);
  sink.current = send;

  const run = useCallback(async () => {
    const c = kept.current;
    if (!c) return;
    setFailed(''); setSending(true);
    const msg = await sendTimed(ctrl, c.blob.size, (signal) => sink.current(c.blob, c.kind, c.target, signal));
    if (!msg) kept.current = null;
    setSending(false); setFailed(msg);
  }, []);

  const stop = useCallback(() => {
    if (timer.current) { window.clearTimeout(timer.current); timer.current = null; }
    const mr = recRef.current;
    if (mr && mr.state !== 'inactive') mr.stop();
  }, []);

  /** «Отменить» на любом шаге: запись выбрасывается, загрузка обрывается, поле снова свободно. */
  const cancel = useCallback(() => {
    drop.current = true;
    stop();
    const ac = ctrl.current;
    ctrl.current = null;
    ac?.abort();
    kept.current = null;
    setSending(false); setFailed(''); setError('');
  }, [stop]);

  const start = useCallback(async (kind: ClipKind, target: string) => {
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
    drop.current = false;
    mr.ondataavailable = (e) => { if (e.data.size) chunks.current.push(e.data); };
    mr.onstop = () => {
      stream.getTracks().forEach((t) => t.stop());
      recRef.current = null;
      setRecording(null);
      const blob = new Blob(chunks.current, { type: mr.mimeType || (kind === 'voice' ? 'audio/webm' : 'video/webm') });
      chunks.current = [];
      if (drop.current || !blob.size) return;
      kept.current = { blob, kind, target };
      void run();
    };
    // Показ экрана останавливают кнопкой браузера, а не нашей: это тоже конец записи
    stream.getVideoTracks().forEach((t) => { t.onended = () => stop(); });

    recRef.current = mr;
    mr.start();
    setRecording(kind);
    timer.current = window.setTimeout(stop, MAX_MS);
  }, [stop, run]);

  // Ушли со страницы во время записи — поток обязан закрыться вместе с ней. Начатую
  // отправку не рвём: человек нажал «отправить» и ушёл в задачи — запись должна дойти.
  useEffect(() => () => {
    const mr = recRef.current;
    if (mr && mr.state !== 'inactive') mr.stop();
  }, []);

  return { recording, error, sending, failed, start, stop, cancel, retry: run };
}
