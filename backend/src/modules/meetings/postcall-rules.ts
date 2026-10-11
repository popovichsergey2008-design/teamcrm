/**
 * Правила итогов встречи (ТЗ-22) — чистые функции, без базы и модели.
 */

interface Line { start: number; text: string; speaker?: string | null; speakerUserId?: string | null }

const norm = (s: string) => s.toLowerCase().replace(/ё/g, 'е').replace(/[^\p{L}\p{N} ]+/gu, ' ').replace(/\s+/g, ' ').trim();

/**
 * Где и кем это сказано. Секунду даёт модель по метке реплики; не дала — ищем реплику
 * по цитате (её модель переписывает из стенограммы как есть). Говорящий — по реплике,
 * а не со слов модели: у своих созвонов он известен достоверно, по дорожке участника.
 */
export function speakerAt(
  replies: Line[], sec: number | null, quote?: string | null,
): { sec: number | null; speaker: string | null; speakerUserId: string | null } {
  let at = sec;
  if (at == null && quote) {
    // модель часто переписывает цитату вместе с именем: «Алина: беру интеграцию»
    const q = norm(quote.replace(/^[^:]{2,40}:\s*/, '')).slice(0, 40);
    const hit = q.length >= 8 ? replies.find((r) => norm(r.text).includes(q)) : undefined;
    if (hit) at = Math.round(hit.start);
  }
  if (at == null) return { sec: null, speaker: null, speakerUserId: null };
  // реплика, которая шла в эту секунду: последняя начавшаяся не позже (с секундой запаса на округление)
  let line: Line | undefined;
  for (const r of replies) if (r.start <= at + 1) line = r; else break;
  // метка за пределами записи — модель ошиблась; без источника лучше, чем с выдуманным
  const last = replies[replies.length - 1];
  if (!line || (last && at > last.start + 600)) return { sec: null, speaker: null, speakerUserId: null };
  return { sec: at, speaker: line.speaker ?? null, speakerUserId: line.speakerUserId ?? null };
}

/** Реплика стенограммы с концом — для фрагмента. */
export interface Segment { start: number; end: number | null; text: string; speaker?: string | null; speakerUserId?: string | null }

/**
 * Фрагмент записи для аудио-доказательства задачи (ТЗ-25, §20–21): реплика поручения
 * плюс ~4 с до и ~5 с после, но смысл механически не режем — вопрос, на который
 * поручение отвечает, входит целиком. 10–30 секунд.
 */
export function proofRange(segments: Segment[], sec: number, durationSec?: number | null): {
  startSec: number; endSec: number; anchorSec: number; quote: string; speaker: string | null; speakerUserId: string | null;
} | null {
  if (!segments.length || !Number.isFinite(sec)) return null;
  let i = -1;
  for (let k = 0; k < segments.length; k++) if (segments[k].start <= sec + 1) i = k; else break;
  if (i < 0) i = 0;
  const seg = segments[i];
  const segEnd = seg.end ?? seg.start + 6;
  let start = Math.max(0, seg.start - 4);
  let end = segEnd + 5;
  // вопрос прямо перед поручением — часть его смысла: «Кто проверит Android?» — «Сергей, проверь»
  const prev = segments[i - 1];
  if (prev && /\?\s*$/.test(prev.text) && seg.start - (prev.end ?? prev.start) < 3 && seg.start - prev.start <= 20) {
    start = Math.min(start, Math.max(0, prev.start - 0.5));
  }
  if (end - start < 10) end = start + 10;
  if (end - start > 30) end = start + 30;
  const limit = durationSec && durationSec > 0 ? durationSec : null;
  if (limit != null) {
    end = Math.min(end, limit);
    if (end - start < 10) start = Math.max(0, end - 10);
  }
  const inside = segments.filter((s) => s.start < end && (s.end ?? s.start) > start);
  const quote = inside.map((s) => `${s.speaker ? `${s.speaker}: ` : ''}${s.text}`).join('\n').slice(0, 1500);
  return {
    startSec: Math.round(start * 10) / 10, endSec: Math.round(end * 10) / 10, anchorSec: Math.round(seg.start * 10) / 10,
    quote, speaker: seg.speaker ?? null, speakerUserId: seg.speakerUserId ?? null,
  };
}

/** Гость (клиент) говорит во фрагменте — делиться им можно только с согласия (§41). */
export function guestInRange(segments: Segment[], startSec: number, endSec: number): boolean {
  return segments.some((s) => s.start < endSec && (s.end ?? s.start) > startSec && !s.speakerUserId && /\(гость\)\s*$/.test(s.speaker ?? ''));
}

/**
 * Формулировку задачи переписали до неузнаваемости — подходит ли ей звук (§37)?
 * Общих слов (с основой из 5 букв) с репликой почти нет — стоит проверить.
 */
export function proofDrifted(title: string, quote: string): boolean {
  const stems = (t: string) => new Set(t.toLowerCase().replace(/ё/g, 'е').split(/[^а-яa-z0-9]+/).filter((w) => w.length >= 4).map((w) => w.slice(0, 5)));
  const a = stems(title);
  if (a.size < 2) return false;
  const b = stems(quote);
  let common = 0;
  for (const w of a) if (b.has(w)) common++;
  return common / a.size < 0.25;
}

/**
 * Достойна ли встреча поста в «Новостях» (§26): только если решили что-то, что
 * вехой и является, — релиз, запуск, сдачу, подписание. Обычные итоги в ленту не идут.
 */
export function newsKind(decisions: string[]): 'release' | 'milestone' | null {
  const text = decisions.join(' \n ').toLowerCase().replace(/ё/g, 'е');
  if (/(^|[^а-я])(релиз|выпустил|выпускаем|запустил|запускаем|запуск)/.test(text)) return 'release';
  if (/(^|[^а-я])(сдали|сдаем проект|подписал|подписан|веха|этап закрыт|закрыли этап)/.test(text)) return 'milestone';
  return null;
}

/**
 * Уверенность в исполнителе черновика (§14): высокая — назван и найден в команде;
 * средняя — найден, но модель сама не уверена («ИИ предполагает»); низкая — не определён.
 */
export function draftConfidence(found: boolean, model: 'high' | 'medium' | 'low' | null): number {
  if (!found) return 0.3;
  return model === 'medium' || model === 'low' ? 0.6 : 0.9;
}
