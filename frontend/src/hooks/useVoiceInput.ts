import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../lib/api';

/**
 * Запись голоса и расшифровка.
 *
 * Вынесено из окна быстрой команды, потому что микрофон теперь в двух местах —
 * ещё и в командной строке. Две копии работы с MediaRecorder разошлись бы на первой
 * же правке, а цена ошибки здесь высокая: незакрытый поток оставляет гореть индикатор
 * микрофона в браузере, и человек считает, что его слушают.
 *
 * Распознавание не потоковое: Whisper работает по готовому файлу. «Слова появляются
 * во время речи» из ТЗ требует другого провайдера — записано в границы этапа.
 */
/*
  #4808: громкость, ниже которой запись считаем тишиной (средний уровень сигнала 0…1).
  Речь у микрофона — 0,02–0,3; выключенный или не тот микрофон — тысячные доли.
*/
const SILENCE_LEVEL = 0.008;
/** Через сколько секунд тишины предупреждаем «Не слышу вас». */
const QUIET_AFTER_MS = 3000;

export function useVoiceInput(onText: (text: string) => void, opts?: { onBlob?: (blob: Blob) => void }) {
  const [recording, setRecording] = useState(false);
  // #4808: микрофон молчит — 08.11 три записи по 40 с ушли пустыми, а волна «играла»
  const [quiet, setQuiet] = useState(false);
  const peakRef = useRef(0);
  const [transcribing, setTranscribing] = useState(false);
  const [error, setError] = useState('');
  const recRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  // колбэк меняется на каждый рендер — держим в ссылке, иначе onstop поймает устаревший
  const sink = useRef(onText);
  sink.current = onText;
  /**
   * Кому отдать саму запись.
   *
   * Короткая фраза в командной строке распознаётся здесь же — ждать её нечего.
   * Длинная надиктовка уходит на сервер целиком: расшифровка идёт минутами, и держать
   * ради неё открытый запрос значит снова упереться в таймаут.
   */
  const blobSink = useRef(opts?.onBlob);
  blobSink.current = opts?.onBlob;

  const start = useCallback(async () => {
    setError('');
    if (recRef.current && recRef.current.state !== 'inactive') return;
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      return setError('Браузер не поддерживает запись с микрофона');
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mr = new MediaRecorder(stream);
      chunksRef.current = [];
      const meter = listenLevel(stream, (level) => {
        peakRef.current = Math.max(peakRef.current, level);
        if (peakRef.current >= SILENCE_LEVEL) setQuiet(false);
      });
      peakRef.current = meter ? 0 : 1;
      setQuiet(false);
      const quietTimer = window.setTimeout(() => { if (peakRef.current < SILENCE_LEVEL) setQuiet(true); }, QUIET_AFTER_MS);
      mr.ondataavailable = (e) => { if (e.data.size) chunksRef.current.push(e.data); };
      mr.onstop = async () => {
        // Дорожки закрываем всегда и первым делом: иначе в браузере остаётся
        // гореть значок микрофона, даже если распознавание упало.
        stream.getTracks().forEach((t) => t.stop());
        window.clearTimeout(quietTimer);
        meter?.close();
        setRecording(false);
        setQuiet(false);
        const blob = new Blob(chunksRef.current, { type: mr.mimeType || 'audio/webm' });
        if (!blob.size) return;
        // тишину не отправляем: модель распознавания сочинит текст, и разбор поставит не то
        if (peakRef.current < SILENCE_LEVEL) {
          setError('Микрофон молчит — запись пустая. Проверьте, какой микрофон выбран в браузере (значок микрофона в адресной строке) и не выключен ли он, и скажите ещё раз.');
          return;
        }
        if (blobSink.current) { blobSink.current(blob); return; }
        setTranscribing(true);
        try {
          const { text } = await api.nlTranscribe(blob);
          if (!text) setError('Речь не распознана. Для голоса нужен ключ OpenAI (Whisper) в «Интеграции → ИИ».');
          else sink.current(text);
        } catch (e) {
          setError(e instanceof ApiError ? e.message : 'Ошибка распознавания речи');
        } finally {
          setTranscribing(false);
        }
      };
      mr.start();
      recRef.current = mr;
      setRecording(true);
    } catch {
      setError('Нет доступа к микрофону');
    }
  }, []);

  const stop = useCallback(() => {
    if (recRef.current && recRef.current.state !== 'inactive') recRef.current.stop();
  }, []);

  const toggle = useCallback(() => { if (recording) stop(); else start(); }, [recording, start, stop]);

  // ушли с экрана на середине записи — отпускаем микрофон
  useEffect(() => () => {
    if (recRef.current && recRef.current.state !== 'inactive') recRef.current.stop();
  }, []);

  return { recording, transcribing, error, quiet, start, stop, toggle };
}

/**
 * Уровень сигнала с микрофона, ~10 раз в секунду. Нет Web Audio — null, и тишину
 * не проверяем: лучше отправить запись, чем отказать в ней из-за браузера.
 */
function listenLevel(stream: MediaStream, onLevel: (level: number) => void): { close: () => void } | null {
  const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctx) return null;
  try {
    const ctx = new Ctx();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    ctx.createMediaStreamSource(stream).connect(analyser);
    const buf = new Float32Array(analyser.fftSize);
    const t = window.setInterval(() => {
      analyser.getFloatTimeDomainData(buf);
      let sum = 0;
      for (const v of buf) sum += v * v;
      onLevel(Math.sqrt(sum / buf.length));
    }, 100);
    return { close: () => { window.clearInterval(t); void ctx.close().catch(() => undefined); } };
  } catch {
    return null;
  }
}
