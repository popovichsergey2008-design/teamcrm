/**
 * #4902, п. 9 «Решения чата» — чистые правила: что похоже на решение, что — на вопрос
 * без ответа, выполнено ли решение, разбор ответа модели.
 *
 * ИИ предлагает, человек подтверждает: правила и модель дают только кандидатов,
 * решением сообщение становится по нажатию.
 */

// \b не видит кириллицу — границы слова пишем явно через \p{L}
const W = '[^\\p{L}\\p{N}]';
const DECISION_WORDS = 'решили|решено|договорились|итого|утвердили|утверждено|согласовали|согласовано|принято|делаем так';
const DECISION_RE = new RegExp(`(?:^|${W})(?:${DECISION_WORDS})(?=${W}|$)`, 'iu');
const NEGATED_RE = new RegExp(`(?:^|${W})(?:не|ещё не|еще не|пока не)\\s+(?:${DECISION_WORDS})(?=${W}|$)`, 'iu');
const URL_RE = /https?:\/\/\S+/gi;

export interface ChatMsg {
  id: string; authorId: string | null; body: string; at: Date;
  threadRootId: string | null; replyCount: number; replyToId: string | null; isAi?: boolean;
}

/** Без ссылок: «?» в адресе — это параметры, а не вопрос. */
function plain(body: string): string {
  return String(body ?? '').replace(URL_RE, ' ').replace(/\s+/g, ' ').trim();
}

/** Сообщение похоже на решение: «решили / договорились / итого / утвердили / согласовали». */
export function isDecisionText(body: string): boolean {
  const t = plain(body);
  if (t.length < 8) return false;
  if (/\?\s*$/.test(t)) return false; // «решили, кто делает?» — вопрос
  if (!DECISION_RE.test(t)) return false;
  return !NEGATED_RE.test(t);
}

/** Текст решения из сообщения: без «Решили:», «Итого,» в начале, одной строкой, до 300 знаков. */
export function cleanDecisionText(body: string): string {
  let t = plain(body).replace(new RegExp(`^(?:${DECISION_WORDS})\\s*[:,.—–-]*\\s*(?:(?:что|так)(?=${W}|$))?\\s*[:,.—–-]*\\s*`, 'iu'), '');
  if (!t) t = plain(body);
  t = t.length > 300 ? `${t.slice(0, 297).trimEnd()}…` : t;
  return t.charAt(0).toUpperCase() + t.slice(1);
}

/** Похоже на вопрос к команде: есть «?» вне ссылок и это не пара букв. */
export function isQuestionText(body: string): boolean {
  const t = plain(body);
  return t.length >= 8 && t.includes('?') && /\p{L}{3,}/u.test(t);
}

/**
 * Вопросы без ответа в ленте чата (сообщения — по времени, старые первыми).
 * Отвеченным считаем вопрос, если: в его ветке есть ответы, на него ответили цитатой,
 * или следом за ним в течение `quietMin` минут написал кто-то другой (разговор
 * продолжился). Свежие (моложе `minAgeHours`) ещё ждут — им рано в «без ответа».
 */
export function unansweredQuestions(list: ChatMsg[], now: Date, minAgeHours = 2, quietMin = 60): ChatMsg[] {
  const quoted = new Set(list.filter((m) => m.replyToId).map((m) => String(m.replyToId)));
  const roots = list.filter((m) => !m.threadRootId);
  const out: ChatMsg[] = [];
  for (let i = 0; i < roots.length; i++) {
    const m = roots[i];
    if (m.isAi || !m.authorId) continue;
    if (!isQuestionText(m.body)) continue;
    if (now.getTime() - m.at.getTime() < minAgeHours * 3_600_000) continue;
    if (m.replyCount > 0 || quoted.has(m.id)) continue;
    const next = roots.slice(i + 1).find((x) => !x.isAi && x.authorId && x.authorId !== m.authorId);
    if (next && next.at.getTime() - m.at.getTime() <= quietMin * 60_000) continue;
    out.push(m);
  }
  return out;
}

/** Выполнено ли решение: связанная задача закрыта или отметили вручную. */
export function decisionDone(d: { done_at: Date | string | null; task_closed_at: Date | string | null }): { done: boolean; by: 'task' | 'manual' | null } {
  if (d.task_closed_at) return { done: true, by: 'task' };
  if (d.done_at) return { done: true, by: 'manual' };
  return { done: false, by: null };
}

/** Ключ вопроса: сообщение чата или вопрос из протокола встречи. */
export const msgQuestionKey = (messageId: string) => `m:${messageId}`;
export const meetingQuestionKey = (meetingId: string, index: number) => `q:${meetingId}:${index}`;

/** Открытые вопросы протокола: в сводке встречи это строки или { text }. */
export function meetingQuestions(raw: unknown): string[] {
  const arr = Array.isArray(raw) ? raw : [];
  return arr.map((x) => (typeof x === 'string' ? x : (x && typeof x === 'object' ? String((x as { text?: unknown }).text ?? '') : '')))
    .map((s) => s.replace(/\s+/g, ' ').trim()).filter((s) => s.length >= 3).map((s) => s.slice(0, 300));
}

/**
 * Ответ модели «какие сообщения — решения»: {"decisions":[{"id":"…","text":"…"}]}.
 * Берём только настоящие id из входа и не больше `max`; мусор — пустой список.
 */
export function parseAiCandidates(raw: string, ids: Set<string>, max = 10): { id: string; text: string }[] {
  let j: { decisions?: { id?: unknown; text?: unknown }[] } = {};
  try { j = JSON.parse(String(raw ?? '').match(/\{[\s\S]*\}/)?.[0] ?? '{}'); } catch { return []; }
  const seen = new Set<string>();
  const out: { id: string; text: string }[] = [];
  for (const d of Array.isArray(j.decisions) ? j.decisions : []) {
    const id = String(d?.id ?? '');
    const text = String(d?.text ?? '').replace(/\s+/g, ' ').trim();
    if (!ids.has(id) || seen.has(id) || text.length < 3) continue;
    seen.add(id);
    out.push({ id, text: text.slice(0, 300) });
    if (out.length >= max) break;
  }
  return out;
}

/** Варианты опроса: без пустых и повторов, 2–10; не хватает — «Да / Нет». */
export function pollOptions(raw: string[] | undefined): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of raw ?? []) {
    const t = String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, 100);
    if (!t || seen.has(t.toLowerCase())) continue;
    seen.add(t.toLowerCase());
    out.push(t);
  }
  return out.length >= 2 ? out.slice(0, 10) : ['Да', 'Нет'];
}
