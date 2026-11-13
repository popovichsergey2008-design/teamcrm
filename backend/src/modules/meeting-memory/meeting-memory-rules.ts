/**
 * #4902, п. 12 «Встреча помнит прошлую и пересказывает опоздавшим» — правила без базы и сети.
 *
 * Две части:
 *  1) какую встречу считать «прошлой» для идущего звонка — та же комната (повторяющаяся
 *     встреча календаря), тот же чат, та же тема или тот же состав;
 *  2) «Кратко до сих пор» — пересказ, который читается за 15 секунд: не больше пяти
 *     пунктов, у каждого метка времени записи.
 */

// ───── прошлая встреча ─────

export type PrevReason = 'same_room' | 'same_chat' | 'same_topic' | 'same_people';

export interface CurrentCall {
  roomId: string;
  chatId: string | null;
  topic: string | null;
  participantIds: string[];
  startedAt: Date;
}

export interface MeetingCandidate {
  id: string;
  roomId: string | null;
  chatId: string | null;
  title: string | null;
  participantIds: string[];
  at: Date;
  /** задач, заведённых по итогам: встреча без задач карточке не нужна */
  tasks: number;
}

const STOP = new Set([
  'созвон', 'встреча', 'звонок', 'планёрка', 'планерка', 'обсуждение', 'по', 'на', 'для', 'и', 'в', 'с', 'о', 'об',
  'про', 'от', 'до', 'за', 'the', 'and', 'call', 'meeting', 'sync', 'чат', 'группа',
]);

/**
 * Слова темы. Делим по не-буквам через Unicode-классы: `\b` и `\w` кириллицу не видят.
 * Числа (даты и время в «Созвон 11.11, 09:22») темой не считаем.
 */
export function topicTokens(title: string | null | undefined): string[] {
  const words = String(title ?? '').toLowerCase().replace(/ё/g, 'е').split(/[^\p{L}]+/u).filter(Boolean);
  return [...new Set(words.filter((w) => w.length >= 3 && !STOP.has(w)))];
}

function jaccard(a: string[], b: string[]): { j: number; common: number } {
  if (!a.length || !b.length) return { j: 0, common: 0 };
  const sb = new Set(b);
  const common = a.filter((x) => sb.has(x)).length;
  return { j: common / (a.length + b.length - common), common };
}

/** Тема совпадает: половина значимых слов общая (и хотя бы одно). */
export function sameTopic(a: string | null | undefined, b: string | null | undefined): boolean {
  const { j, common } = jaccard(topicTokens(a), topicTokens(b));
  return common >= 1 && j >= 0.5;
}

/** Тот же состав: двое и больше общих и пересечение не меньше 60 %. */
export function samePeople(a: string[], b: string[]): boolean {
  const { j, common } = jaccard([...new Set(a.map(String))], [...new Set(b.map(String))]);
  return common >= 2 && j >= 0.6;
}

const WEIGHT: Record<PrevReason, number> = { same_room: 4, same_chat: 3, same_topic: 2, same_people: 2 };

/**
 * Прошлая встреча для идущего звонка. Только раньше начала звонка и только с задачами
 * по итогам — карточка «сколько готово» без задач пуста. Из равных — самая свежая.
 */
export function pickPrevious(cur: CurrentCall, list: MeetingCandidate[]): { meeting: MeetingCandidate; reasons: PrevReason[] } | null {
  let best: { meeting: MeetingCandidate; reasons: PrevReason[]; score: number } | null = null;
  for (const m of list) {
    if (m.at.getTime() >= cur.startedAt.getTime() || m.tasks <= 0) continue;
    const reasons: PrevReason[] = [];
    if (m.roomId && m.roomId === cur.roomId) reasons.push('same_room');
    if (m.chatId && cur.chatId && String(m.chatId) === String(cur.chatId)) reasons.push('same_chat');
    if (cur.topic && sameTopic(cur.topic, m.title)) reasons.push('same_topic');
    if (samePeople(cur.participantIds, m.participantIds)) reasons.push('same_people');
    if (!reasons.length) continue;
    const score = reasons.reduce((s, r) => s + WEIGHT[r], 0);
    if (!best || score > best.score || (score === best.score && m.at > best.meeting.at)) best = { meeting: m, reasons, score };
  }
  return best ? { meeting: best.meeting, reasons: best.reasons } : null;
}

export function reasonText(reasons: PrevReason[]): string {
  const r = reasons[0];
  if (r === 'same_room') return 'та же встреча';
  if (r === 'same_chat') return 'этот же чат';
  if (r === 'same_topic') return 'та же тема';
  return 'те же участники';
}

// ───── задачи прошлой встречи ─────

/** Этап задачи — из task_stage() (ТЗ-30) плюс «начата ли»: была ли работа или движение. */
export type Bucket = 'done' | 'review' | 'in_progress' | 'not_started';

export function bucketOf(stage: string, started: boolean): Bucket {
  if (stage === 'done') return 'done';
  if (stage === 'testing' || stage === 'review' || stage === 'approval' || stage === 'waiting_external') return 'review';
  return started ? 'in_progress' : 'not_started';
}

export function countBuckets(items: { bucket: Bucket }[]): Record<Bucket, number> & { total: number } {
  const out = { done: 0, review: 0, in_progress: 0, not_started: 0, total: items.length };
  for (const i of items) out[i.bucket] += 1;
  return out;
}

// ───── «Кратко до сих пор» ─────

export interface LiveSegment {
  /** секунды от начала записи созвона */
  sec: number;
  speaker: string;
  text: string;
}

export interface RecapPoint {
  sec: number;
  speaker: string | null;
  text: string;
}

/** «0:42», «12:05», «1:02:07». */
export function stamp(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${r}` : `${m}:${r}`;
}

/** Пересказ за 15 секунд — это примерно 40–45 слов: пять пунктов по 12 слов максимум. */
export const RECAP_MAX_POINTS = 5;
export const RECAP_POINT_WORDS = 14;

export function cutWords(text: string, n = RECAP_POINT_WORDS): string {
  const words = String(text ?? '').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  if (words.length <= n) return words.join(' ');
  return `${words.slice(0, n).join(' ').replace(/[,;:—-]+$/, '')}…`;
}

const WEIGHTY = /(решил|договорил|сделаю|сделаем|срок|дедлайн|нужно|надо|задач|до пятниц|до понедельник|завтра|итог|проблем|ошибк|баг|риск|бюджет|согласова|перенос|отложи|важно)/i;

/**
 * Пересказ правилами, когда модели нет или она не ответила: из реплик выбираем «весомые»
 * (решения, сроки, проблемы), а если их мало — длинные, и разносим по всему разговору,
 * чтобы опоздавший видел и начало, и последние минуты.
 */
export function recapFallback(segments: LiveSegment[], max = RECAP_MAX_POINTS): RecapPoint[] {
  const real = segments.filter((s) => s.text.trim().split(/\s+/).length >= 4).sort((a, b) => a.sec - b.sec);
  if (!real.length) return [];
  const scored = real.map((s, i) => ({ s, i, w: (WEIGHTY.test(s.text) ? 10 : 0) + Math.min(s.text.length, 200) / 40 }));
  const picked = new Set<number>();
  // по одному лучшему из равных частей разговора — пересказ покрывает весь звонок
  const parts = Math.min(max, real.length);
  for (let p = 0; p < parts; p += 1) {
    const from = Math.floor((p * real.length) / parts);
    const to = Math.floor(((p + 1) * real.length) / parts);
    const slice = scored.slice(from, Math.max(to, from + 1));
    const top = slice.reduce((a, b) => (b.w > a.w ? b : a));
    picked.add(top.i);
  }
  return [...picked].sort((a, b) => a - b).map((i) => ({ sec: real[i].sec, speaker: real[i].speaker || null, text: cutWords(real[i].text) }));
}

/**
 * Ответ модели: JSON {"points":[{"sec":…,"speaker":"…","text":"…"}]}. Секунды проверяем:
 * метка, которой нет в записи, хуже, чем её отсутствие, — по ней опоздавший пойдёт
 * слушать пустое место. Берём ближайшую настоящую реплику.
 */
export function parseRecap(raw: string, segments: LiveSegment[]): RecapPoint[] {
  const m = String(raw ?? '').match(/\{[\s\S]*\}/);
  if (!m || !segments.length) return [];
  let data: any;
  try { data = JSON.parse(m[0]); } catch { return []; }
  const list = Array.isArray(data?.points) ? data.points : [];
  const out: RecapPoint[] = [];
  for (const p of list.slice(0, RECAP_MAX_POINTS)) {
    const text = cutWords(String(p?.text ?? ''), RECAP_POINT_WORDS + 4);
    if (!text) continue;
    const want = Number(p?.sec);
    const near = segments.reduce((a, b) => (Math.abs(b.sec - want) < Math.abs(a.sec - want) ? b : a), segments[0]);
    const sec = Number.isFinite(want) ? near.sec : segments[0].sec;
    out.push({ sec, speaker: (typeof p?.speaker === 'string' && p.speaker.trim()) ? p.speaker.trim().slice(0, 80) : near.speaker || null, text });
  }
  return out.sort((a, b) => a.sec - b.sec);
}

/** Стенограмма для модели: «[0:42] Ира: …», не длиннее limit знаков — с конца важнее. */
export function transcriptForModel(segments: LiveSegment[], limit = 12000): string {
  const lines = [...segments].sort((a, b) => a.sec - b.sec).map((s) => `[${Math.round(s.sec)}с ${stamp(s.sec)}] ${s.speaker}: ${s.text}`);
  let out = lines.join('\n');
  if (out.length > limit) out = out.slice(out.length - limit);
  return out;
}

/** Реплики двух дорожек сшиваются по времени; пустые и повторы Whisper отбрасываем. */
export function mergeTracks(tracks: { speaker: string; segments: { start: number; text: string }[]; offsetSec: number }[]): LiveSegment[] {
  const out: LiveSegment[] = [];
  for (const t of tracks) {
    let prev = '';
    for (const s of t.segments) {
      const text = String(s.text ?? '').trim();
      if (!text || text === prev) continue;
      prev = text;
      out.push({ sec: Math.max(0, t.offsetSec + Number(s.start || 0)), speaker: t.speaker, text });
    }
  }
  return out.sort((a, b) => a.sec - b.sec);
}
