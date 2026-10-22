import { loudest } from './call-mini';

/**
 * Кто сейчас говорит.
 *
 * Нужно свёрнутому окну: в него влезает три-четыре лица, и показывать надо
 * говорящего. Сервер об этом не сообщает, но звук каждого участника приходит
 * отдельной дорожкой — громкость считаем прямо в браузере.
 *
 * Считаем по копии дорожки через WebAudio и никуда её не выводим: звук
 * воспроизводят обычные <audio>, а анализатор только слушает. Подключи его к
 * выходу — человек услышал бы собеседника дважды.
 */

/** Ниже этого уровня — дыхание, вентилятор и щелчки клавиатуры, а не речь. */
const THRESHOLD = 0.045;
/** Раз в столько миллисекунд пересчитываем. Чаще — дёргает плитки, реже — опаздывает. */
const PERIOD = 250;

export interface SpeakingTrack {
  userId: string;
  track: MediaStreamTrack;
}

/**
 * Следить за громкостью и сообщать смену говорящего.
 *
 * Возвращает функцию остановки. Если браузер не дал WebAudio (старый движок,
 * запрет автоплея), молча ничего не делает: подсветка говорящего — украшение,
 * из-за которого созвон падать не должен.
 */
export function watchSpeaking(tracks: SpeakingTrack[], onChange: (userId: string | null) => void): () => void {
  if (!tracks.length) { onChange(null); return () => undefined; }

  const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return () => undefined;

  let ctx: AudioContext;
  try { ctx = new Ctor(); } catch { return () => undefined; }

  const nodes = tracks.map(({ userId, track }) => {
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    // сглаживание: без него уровень скачет между кадрами и «говорящий» мигает
    analyser.smoothingTimeConstant = 0.6;
    try {
      ctx.createMediaStreamSource(new MediaStream([track])).connect(analyser);
    } catch {
      return null;
    }
    return { userId, analyser, buf: new Uint8Array(new ArrayBuffer(analyser.fftSize)) };
  }).filter(Boolean) as { userId: string; analyser: AnalyserNode; buf: Uint8Array<ArrayBuffer> }[];

  if (!nodes.length) { void ctx.close().catch(() => undefined); return () => undefined; }

  let current: string | null = null;
  const timer = setInterval(() => {
    const levels: Record<string, number> = {};
    for (const n of nodes) {
      n.analyser.getByteTimeDomainData(n.buf);
      // среднеквадратичное отклонение от тишины (128) — грубо, но речь от шума отделяет
      let sum = 0;
      for (let i = 0; i < n.buf.length; i++) { const v = (n.buf[i] - 128) / 128; sum += v * v; }
      levels[n.userId] = Math.sqrt(sum / n.buf.length);
    }
    const next = loudest(levels, THRESHOLD, current);
    if (next !== current) { current = next; onChange(next); }
  }, PERIOD);

  return () => {
    clearInterval(timer);
    void ctx.close().catch(() => undefined);
  };
}

/**
 * Порядок плиток при показе экрана (#4622): кто говорил последним — первым.
 *
 * Полоса участников листается, и людей в ней больше, чем влезает. Говорящий должен
 * быть на виду, поэтому каждый новый голос встаёт в начало; остальные — в порядке
 * последней реплики, а кто ещё не говорил, остаётся на своём месте после них.
 */
export function promoteSpeaker(order: string[], userId: string): string[] {
  return order[0] === userId ? order : [userId, ...order.filter((id) => id !== userId)];
}

export function orderBySpeech<T>(items: T[], idOf: (item: T) => string, order: string[]): T[] {
  const rank = new Map(order.map((id, i) => [id, i]));
  return items
    .map((item, i) => ({ item, i, r: rank.get(idOf(item)) ?? Infinity }))
    .sort((a, b) => (a.r === b.r ? a.i - b.i : a.r - b.r))
    .map((x) => x.item);
}
