/**
 * Что Whisper «слышит» в тишине.
 *
 * На пустой дорожке (микрофон включён, человек молчит) модель сочиняет фразы из
 * роликов, на которых училась: «Продолжение следует…», «Субтитры сделал …»,
 * «Приветствую вас, дорогие друзья и гости канала …». В созвоне 22.10 такая фраза
 * стояла на дорожке молчавшего участника каждые 20 секунд — и попадала в стенограмму,
 * разбор и задачи.
 *
 * Два признака, оба из ответа Whisper: модель сама считает, что тут нет речи
 * (no_speech_prob), и текст — из известного набора выдумок. Выдумку из набора
 * убираем, только если она и есть весь фрагмент: «спасибо за просмотр макета»
 * внутри живой фразы — нормальная речь.
 */
export interface RawSttSegment {
  start: number;
  end: number;
  text: string;
  noSpeechProb?: number;
  avgLogprob?: number;
}

const PHRASES = [
  /^продолжение следует/,
  /^субтитры (?:сделал|делал|создавал|подготовил|подготовила|создал)/,
  /^редактор субтитров/,
  /^корректор /,
  /спасибо за просмотр/,
  /подписывайтесь на (?:наш )?канал/,
  /ставьте лайки?/,
  /дорогие друзья и гости канала/,
  /^приветствую вас,? дорогие друзья/,
  /^всем пока[.!]*$/,
  /^до новых встреч[.!]*$/,
  /^с вами был/,
  /^dimatorzok/,
];

const norm = (t: string) => t.toLowerCase().replace(/ё/g, 'е').replace(/[«»"“”]/g, '').trim();

/** Похоже ли на выдумку модели, а не на речь человека. */
export function isHallucination(s: RawSttSegment): boolean {
  const text = norm(s.text);
  if (!text) return true;
  // модель сама уверена, что речи нет, и уверенность в словах низкая
  if ((s.noSpeechProb ?? 0) > 0.6 && (s.avgLogprob ?? 0) < -0.7) return true;
  return text.length <= 90 && PHRASES.some((re) => re.test(text));
}

/**
 * Убрать выдумки и их эхо: одна и та же фраза три раза и больше на одной дорожке
 * при высокой вероятности тишины хотя бы у одного повтора — тоже тишина.
 */
export function dropHallucinations<T extends RawSttSegment>(segments: T[]): T[] {
  const kept = segments.filter((s) => !isHallucination(s));
  const byText = new Map<string, T[]>();
  for (const s of kept) {
    const k = norm(s.text);
    byText.set(k, [...(byText.get(k) ?? []), s]);
  }
  const echo = new Set<string>();
  for (const [k, list] of byText) {
    if (k.length >= 12 && list.length >= 3 && list.some((s) => (s.noSpeechProb ?? 0) > 0.3)) echo.add(k);
  }
  return echo.size ? kept.filter((s) => !echo.has(norm(s.text))) : kept;
}

/**
 * Срезать выдумку с краёв цельной расшифровки.
 *
 * Надиктовку распознают одним куском, без сегментов: выдумка на тишине после последних
 * слов приклеивается в конец — «…С вами был Игорь Негода.» (26.10, обращение заказчика
 * в службу заботы). Проверка «весь текст — выдумка» её не ловит. Режем по предложениям
 * с конца и с начала, пока предложение целиком из набора; середину не трогаем.
 */
const EDGE = [
  /^продолжение следует$/,
  /^субтитры (?:сделал|делал|создавал|подготовил|подготовила|создал).{0,40}$/,
  /^редактор субтитров.{0,40}$/,
  /^корректор .{0,40}$/,
  /^с вами (?:был|была|были) [a-zа-я-]+(?: [a-zа-я-]+)?$/,
  /^спасибо за просмотр$/,
  /^подписывайтесь на (?:наш )?канал$/,
  /^ставьте лайки?$/,
  /^всем пока$/,
  /^до новых встреч$/,
  /^dimatorzok$/,
];

export function stripHallucinationEdges(text: string): string {
  const parts = String(text ?? '').split(/(?<=[.!?…])\s+|\n+/);
  // на краях — только предложение, которое ЦЕЛИКОМ выдумка: «Спасибо за просмотр макета» — живая речь
  const bad = (p: string) => {
    const t = norm(p).replace(/[.!?…]+$/, '').trim();
    return !!t && t.length <= 90 && EDGE.some((re) => re.test(t));
  };
  let from = 0, to = parts.length;
  while (to > from && (!parts[to - 1].trim() || bad(parts[to - 1]))) to--;
  while (from < to && (!parts[from].trim() || bad(parts[from]))) from++;
  if (from === 0 && to === parts.length) return text;
  return parts.slice(from, to).join(' ').replace(/\s+/g, ' ').trim();
}
