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
