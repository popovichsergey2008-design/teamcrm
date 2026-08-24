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
export function useVoiceInput(onText: (text: string) => void) {
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [error, setError] = useState('');
  const recRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  // колбэк меняется на каждый рендер — держим в ссылке, иначе onstop поймает устаревший
  const sink = useRef(onText);
  sink.current = onText;

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
      mr.ondataavailable = (e) => { if (e.data.size) chunksRef.current.push(e.data); };
      mr.onstop = async () => {
        // Дорожки закрываем всегда и первым делом: иначе в браузере остаётся
        // гореть значок микрофона, даже если распознавание упало.
        stream.getTracks().forEach((t) => t.stop());
        setRecording(false);
        const blob = new Blob(chunksRef.current, { type: mr.mimeType || 'audio/webm' });
        if (!blob.size) return;
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

  return { recording, transcribing, error, start, stop, toggle };
}
