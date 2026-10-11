/**
 * Правила ящика предложений (ТЗ-21) — чистые функции: без базы, без часов, без модели.
 *
 * Здесь решается, как не превратить проактивность в поток уведомлений (§9, §83–84, §115.10):
 * что считать тем же самым предложением, когда звать человека пушем, а когда молча
 * положить в ящик, до какого момента «отложить» и в каком порядке показывать.
 */

export const SKILLS = ['commitment', 'workload', 'reply', 'followup', 'brief', 'decision', 'postcall'] as const;
export type Skill = typeof SKILLS[number];

export const PRIORITY_LABEL = ['Критично', 'Сегодня', 'Важно', 'К сведению'] as const;

/** Разделы экрана «Секретарь» (§10) — куда попадает предложение навыка. */
export const SECTION_OF: Record<Skill, 'attention' | 'commitments' | 'replies' | 'meetings' | 'morning'> = {
  commitment: 'commitments',
  workload: 'attention',
  reply: 'replies',
  followup: 'meetings',
  brief: 'morning',
  decision: 'attention',
  // ТЗ-22: итоги встречи не разобраны — через сутки или после «Разобрать позже»
  postcall: 'meetings',
};

/** Причины 👎 (§109). */
export const FEEDBACK_REASONS = ['wrong_person', 'wrong_deadline', 'already_done', 'not_needed', 'wrong_context', 'other'] as const;

/** Свести текст к смыслу для отпечатка: регистр, пунктуация, повторы пробелов. */
export function normalizeIntent(s: string): string {
  return String(s ?? '').toLowerCase().replace(/ё/g, 'е').replace(/[^\p{L}\p{N}]+/gu, ' ').trim().slice(0, 80);
}

/**
 * Отпечаток (§107): навык + источник + смысл + сущность. Одно и то же обещание из двух
 * прогонов разбора не станет двумя карточками; то же для «вам не ответили».
 */
export function fingerprint(p: { skill: string; sourceType: string; sourceId: string; intent?: string; entity?: string }): string {
  return [p.skill, p.sourceType, p.sourceId, normalizeIntent(p.intent ?? ''), p.entity ?? ''].join('|').slice(0, 160);
}

export type Delivery = 'push' | 'badge' | 'silent';

/**
 * Как сообщить о новом предложении (§9, §83–84):
 * - уровень «выкл» — не создаём вовсе (решает вызывающий), «тихо» — только в ящик;
 * - во время глубокой работы и после «день завершён»: P0 — пушем, P1 — значком, P2/P3 — молча;
 * - в обычное время пушем зовём только P0/P1; P2/P3 копятся и попадают в утреннюю сводку;
 * - дневной лимит: сверх него — молча (кроме P0).
 */
export function deliveryFor(p: { priority: number; quiet: boolean; level: string; sentToday: number; dailyLimit: number }): Delivery {
  if (p.level === 'quiet') return p.priority === 0 ? 'badge' : 'silent';
  if (p.priority === 0) return 'push';
  if (p.sentToday >= p.dailyLimit) return 'silent';
  if (p.quiet) return p.priority === 1 ? 'badge' : 'silent';
  return p.priority === 1 ? 'push' : 'badge';
}

export type SnoozePreset = 'hour' | 'afternoon' | 'tomorrow';

/**
 * «Отложить» (§108): через час · после обеда (14:00 местного; если уже позже — завтра в 14:00)
 * · завтра (9:00 следующего рабочего дня). `local` — местные дата/время человека.
 * Возвращает местные дату и время — в абсолютное время переводит вызывающий по поясу.
 */
export function snoozeTarget(preset: SnoozePreset, local: { date: string; hour: number; minute: number; isoDow: number }):
  { kind: 'relative'; minutes: number } | { kind: 'local'; date: string; time: string } {
  if (preset === 'hour') return { kind: 'relative', minutes: 60 };
  if (preset === 'afternoon') {
    if (local.hour < 14) return { kind: 'local', date: local.date, time: '14:00' };
    return { kind: 'local', date: addDays(local.date, 1), time: '14:00' };
  }
  // завтра — следующий рабочий день: из пятницы и выходных — понедельник
  const skip = local.isoDow === 5 ? 3 : local.isoDow === 6 ? 2 : 1;
  return { kind: 'local', date: addDays(local.date, skip), time: '09:00' };
}

export function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * Порядок в ящике (§82): приоритет, затем срок (ближе — выше), затем уверенность,
 * затем свежесть. Срок и «влияние на клиента» навык закладывает в приоритет сам.
 */
export function rankKey(p: { priority: number; dueAt?: Date | string | null; confidence: number; createdAt: Date | string }): [number, number, number, number] {
  const due = p.dueAt ? new Date(p.dueAt).getTime() : Number.MAX_SAFE_INTEGER;
  return [p.priority, due, -p.confidence, -new Date(p.createdAt).getTime()];
}

export function compareRank(a: ReturnType<typeof rankKey>, b: ReturnType<typeof rankKey>): number {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

/**
 * Порог уверенности (§8): ниже 0,70 — не предлагаем; для критичных полей (кто, кому,
 * клиент, срок) — 0,85. Между 0,70 и 0,90 — «рекомендация с оговоркой».
 */
export function confidenceBand(c: number, critical = false): 'strong' | 'hedged' | 'skip' {
  const floor = critical ? 0.85 : 0.7;
  if (c < floor) return 'skip';
  return c >= 0.9 ? 'strong' : 'hedged';
}

/** Свод «нашёл N вопросов» (§9): что сказать, когда слабых предложений накопилось много. */
export function batchLine(counts: Partial<Record<Skill, number>>): string | null {
  const total = Object.values(counts).reduce((n, x) => n + (x ?? 0), 0);
  if (!total) return null;
  const word = total % 10 === 1 && total % 100 !== 11 ? 'вопрос' : [2, 3, 4].includes(total % 10) && ![12, 13, 14].includes(total % 100) ? 'вопроса' : 'вопросов';
  return `Секретарь нашёл ${total} ${word}, требующих внимания.`;
}
