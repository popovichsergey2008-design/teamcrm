/**
 * Разбор готовых стенограмм (.vtt/.srt) и сборка ленты реплик.
 *
 * Зачем принимать готовую стенограмму, а не только звук: Zoom и Google Meet отдают
 * субтитры С ИМЕНАМИ говорящих. Из смешанной аудиодорожки имена не восстановить,
 * поэтому загруженный .vtt даёт то, чего распознавание звука дать не может.
 */

export interface Reply {
  start: number;
  end: number;
  speaker: string | null;
  text: string;
}

/** «00:01:02.500» / «00:01:02,500» / «01:02.500» → секунды. NaN — не таймкод. */
export function parseTimecode(raw: string): number {
  const m = /^(?:(\d+):)?(\d{1,2}):(\d{1,2})[.,](\d{1,3})$/.exec(raw.trim());
  if (!m) return NaN;
  const [, h, mm, ss, ms] = m;
  return Number(h ?? 0) * 3600 + Number(mm) * 60 + Number(ss) + Number(ms.padEnd(3, '0')) / 1000;
}

/**
 * «<v Иван>текст» или «Иван: текст» → говорящий + текст.
 *
 * Двоеточие в обычной речи встречается часто («Смотрите что получилось: …»), поэтому
 * за имя принимаем только 1–3 слова, КАЖДОЕ с заглавной буквы: у фразы хотя бы одно
 * слово будет строчным. Иначе в стенограмме заводятся люди с именем «Смотрите что получилось».
 */
export function splitSpeaker(line: string): { speaker: string | null; text: string } {
  const tag = /^<v\s+([^>]+)>\s*(.*)$/.exec(line);
  if (tag) return { speaker: tag[1].trim(), text: tag[2].replace(/<\/v>\s*$/, '').trim() };

  const colon = /^([^:]{2,40}):\s+(.+)$/.exec(line);
  if (colon && looksLikeName(colon[1])) return { speaker: colon[1].trim(), text: colon[2].trim() };
  return { speaker: null, text: line.trim() };
}

function looksLikeName(raw: string): boolean {
  const cleaned = raw.replace(/\s*\([^)]*\)\s*$/, '').trim(); // Zoom пишет «Иван Петров (Гость)»
  if (!cleaned || /[.!?,]/.test(cleaned)) return false;
  const words = cleaned.split(/\s+/);
  if (words.length < 1 || words.length > 3) return false;
  return words.every((w) => /^\p{Lu}[\p{L}'-]*$/u.test(w));
}

/**
 * Разбирает WebVTT и SubRip. Форматы отличаются мелочами (заголовок, запятая
 * вместо точки в миллисекундах), поэтому парсер один.
 */
export function parseSubtitles(content: string): Reply[] {
  const out: Reply[] = [];
  const blocks = content.replace(/\r\n/g, '\n').replace(/^WEBVTT.*?\n/s, '').split(/\n{2,}/);

  for (const block of blocks) {
    const lines = block.split('\n').map((l) => l.trim()).filter(Boolean);
    if (!lines.length) continue;

    const arrowAt = lines.findIndex((l) => l.includes('-->'));
    if (arrowAt < 0) continue;

    const [from, to] = lines[arrowAt].split('-->').map((s) => s.trim().split(/\s+/)[0]);
    const start = parseTimecode(from);
    const end = parseTimecode(to);
    if (Number.isNaN(start)) continue;

    const body = lines.slice(arrowAt + 1);
    if (!body.length) continue;

    // говорящий указывается в первой строке реплики; остальные строки — продолжение
    const first = splitSpeaker(body[0]);
    const text = [first.text, ...body.slice(1)].join(' ').replace(/\s+/g, ' ').trim();
    if (!text) continue;

    out.push({ start, end: Number.isNaN(end) ? start : end, speaker: first.speaker, text });
  }
  return out;
}

/**
 * Сшивает реплики соседних кусков записи: Whisper нумерует время от начала КУСКА,
 * поэтому каждому куску добавляется его смещение. Без этого стенограмма часовой
 * встречи превращается в шесть наложенных друг на друга десятиминуток.
 */
export function shiftSegments(segments: { start: number; end: number; text: string }[], offsetSec: number): Reply[] {
  return segments.map((s) => ({
    start: s.start + offsetSec,
    end: s.end + offsetSec,
    speaker: null,
    text: s.text.trim(),
  }));
}

/** Стенограмма одним текстом для отправки в LLM: «[мм:сс] Имя: реплика». */
export function repliesToText(replies: Reply[]): string {
  const stamp = (sec: number) => {
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  };
  return replies.map((r) => `[${stamp(r.start)}] ${r.speaker ? r.speaker + ': ' : ''}${r.text}`).join('\n');
}
