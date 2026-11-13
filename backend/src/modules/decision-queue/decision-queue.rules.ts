/**
 * #4890, п. 3 и 13: ОДНО определение «ждут вашего решения».
 *
 * Раньше одну и ту же очередь показывали разные числа: брифинг считал предложения
 * секретаря и согласования, Фокус — сданное мне (я постановщик) и согласования, Пульс —
 * свои решения с переносами сроков, клиентами и черновиками встреч, бейдж меню — опять
 * по-своему. Теперь число считает одна функция (DecisionQueueService.waiting), а все
 * экраны берут его оттуда. Здесь — чистые правила: что входит, сколько минут, паспорт.
 */

/** Минут на одно решение в разборе по одной карточке: 10 решений ≈ 20 минут (п. 2). */
export const DECISION_MINUTES = 2;

/** Пачка разбора (п. 4): по 10 карточек, начиная с самых старых. */
export const BATCH_SIZE = 10;

export const etaMinutes = (n: number) => Math.max(0, Math.round(n * DECISION_MINUTES));

export type QueueKind = 'review' | 'approval';

export interface QueueItem {
  key: string;
  kind: QueueKind;
  taskId: string | null;
  approvalId: string | null;
  title: string;
  projectId: string | null;
  projectName: string | null;
  assigneeId: string | null;
  assigneeName: string | null;
  /** Когда работу сдали (или задали вопрос согласования) — отсюда «ждёт N дн.». */
  since: Date;
  deadlineAt: Date | null;
  priority: string | null;
}

const D = 86_400_000;

export const waitingDays = (since: Date, now: Date) => Math.max(0, Math.floor((now.getTime() - since.getTime()) / D));

/** Сводка очереди: число, сколько из неё уже с прошедшим сроком, кто и какие проекты ждут. */
export function queueStats(items: QueueItem[], now: Date) {
  const overdue = items.filter((i) => i.deadlineAt && i.deadlineAt.getTime() < now.getTime()).length;
  const people = new Set(items.map((i) => i.assigneeId).filter(Boolean)).size;
  const projects = [...new Map(items.filter((i) => i.projectId).map((i) => [i.projectId, i.projectName ?? ''])).values()];
  const oldest = items.reduce<Date | null>((m, i) => (!m || i.since < m ? i.since : m), null);
  return {
    count: items.length, overdue, people, projects,
    oldestDays: oldest ? waitingDays(oldest, now) : 0,
  };
}

/** Порядок разбора: самые старые первыми (п. 4), при равенстве — по номеру, чтобы не прыгало. */
export function oldestFirst(a: QueueItem, b: QueueItem): number {
  return a.since.getTime() - b.since.getTime() || a.key.localeCompare(b.key);
}

/** Следующая пачка: без решённых в этом разборе и пропущенных (п. 4: пропущенная остаётся в очереди). */
export function nextBatch(items: QueueItem[], exclude: Set<string>, size = BATCH_SIZE): QueueItem[] {
  return [...items].sort(oldestFirst).filter((i) => !exclude.has(i.key)).slice(0, size);
}

export function plural(n: number, one: string, few: string, many: string): string {
  const a = Math.abs(n) % 100; const b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  if (b === 1) return one;
  return many;
}

/** «81 задача ждёт вашей проверки» — от второго лица (п. 2). */
export function waitingTitle(n: number): string {
  return `${n} ${plural(n, 'задача ждёт', 'задачи ждут', 'задач ждут')} вашей проверки`;
}

export interface Passport {
  metric: string;
  title: string;
  value: number;
  what: string;
  period: string;
  scope: string;
  updatedAt: string;
  related: { label: string; value: number | string }[];
  list: { label: string; count: number } | null;
}

/** Паспорт числа «ждут вашего решения» (п. 3): что считается, период, охват, связанные числа. */
export function decisionsPassport(i: {
  count: number; reviews: number; approvals: number; overdue: number; teamReview: number; projects: number; updatedAt: Date;
}): Passport {
  return {
    metric: 'decisions',
    title: waitingTitle(i.count),
    value: i.count,
    what: 'Задачи на проверке, тестировании или приёмке, где следующий шаг — вы (вы проверяющий, а если он не назначен — постановщик), и согласования, которых ждут от вас. Свои задачи и отложенные согласования не входят.',
    period: 'Сейчас (не за неделю)',
    scope: i.projects ? `Все проекты, где вы проверяете · ${i.projects} ${plural(i.projects, 'проект', 'проекта', 'проектов')}` : 'Все проекты, кроме архивных и демо',
    updatedAt: i.updatedAt.toISOString(),
    related: [
      { label: 'из них проверок', value: i.reviews },
      { label: 'согласований', value: i.approvals },
      { label: 'из них срок прошёл', value: i.overdue },
      { label: 'у всей команды на проверке', value: i.teamReview },
    ],
    list: { label: 'Открыть список', count: i.count },
  };
}

// ── п. 5: пересказ сданной работы ──

export interface RecapFacts {
  files: { name: string; type: string }[];
  checklist: { total: number; done: number };
  comments: number;
  /** Вопросы в чате задачи, на которые после них никто, кроме автора, не ответил. */
  openQuestions: number;
  /** Из них — заданные исполнителем (то есть к проверяющему). */
  questionsToReviewer: number;
}

/**
 * Вопросы без ответа в чате задачи: сообщение с «?», после которого не писал никто,
 * кроме его автора. Заданные исполнителем — вопросы к проверяющему.
 */
export function openQuestionsOf(comments: { authorId: string | null; body: string }[], assigneeId: string | null) {
  let open = 0; let toReviewer = 0;
  comments.forEach((c, i) => {
    if (!/\?/.test(c.body)) return;
    const answered = comments.slice(i + 1).some((x) => x.authorId && x.authorId !== c.authorId);
    if (answered) return;
    open += 1;
    if (assigneeId && c.authorId === assigneeId) toReviewer += 1;
  });
  return { open, toReviewer };
}

const kindOf = (f: { name: string; type: string }) => {
  const t = f.type.toLowerCase(); const n = f.name.toLowerCase();
  if (t.startsWith('image/')) return 'изображение';
  if (t === 'application/pdf' || n.endsWith('.pdf')) return 'PDF';
  if (/\.(docx?|odt|rtf)$/.test(n)) return 'документ';
  if (/\.(xlsx?|csv|ods)$/.test(n)) return 'таблица';
  if (t.startsWith('video/')) return 'видео';
  return 'файл';
};

/**
 * Пересказ правилами — запасной путь без ключа ИИ и проверка того, что сказала модель.
 * Опирается только на вложения, чек-лист и чат ЭТОЙ задачи; нет данных — так и пишем.
 */
export function recapByRules(f: RecapFacts): string {
  const parts: string[] = [];
  if (f.files.length) {
    const names = f.files.slice(0, 2).map((x) => `${x.name} (${kindOf(x)})`);
    parts.push(`Приложено ${f.files.length} ${plural(f.files.length, 'вложение', 'вложения', 'вложений')}: ${names.join(', ')}${f.files.length > 2 ? ' и др.' : ''}`);
  } else parts.push('вложений нет');
  if (f.checklist.total) parts.push(`чек-лист: отмечено ${f.checklist.done} из ${f.checklist.total}`);
  else parts.push('чек-листа нет');
  if (!f.comments) parts.push('комментариев нет');
  else if (f.openQuestions) parts.push(`в чате задачи ${f.openQuestions} ${plural(f.openQuestions, 'вопрос', 'вопроса', 'вопросов')} без ответа${f.questionsToReviewer ? `, из них к вам — ${f.questionsToReviewer}` : ''}`);
  else parts.push('открытых вопросов в чате задачи нет');
  const s = parts.join(', ');
  return `${s.charAt(0).toUpperCase()}${s.slice(1)}.`;
}

/** Числа в тексте модели должны быть из фактов — иначе это выдумка, берём правила. */
export function recapIsGrounded(text: string, f: RecapFacts): boolean {
  const t = text.trim();
  if (!t || t.length > 400) return false;
  const allowed = new Set<string>([
    String(f.files.length), String(f.checklist.total), String(f.checklist.done), String(f.comments),
    String(f.openQuestions), String(f.questionsToReviewer), ...f.files.flatMap((x) => x.name.match(/\d+/g) ?? []),
  ]);
  const nums = t.match(/\d+/g) ?? [];
  if (nums.some((n) => !allowed.has(String(Number(n))) && !allowed.has(n))) return false;
  // нет вложений — модель не должна их «видеть»
  if (!f.files.length && /приложен|вложени[еяй]\s+(?!нет)/i.test(t) && !/вложений нет|нет вложений/i.test(t)) return false;
  return true;
}

/** Хэш фактов — пересказ кэшируется, пока в задаче ничего не поменялось. */
export function factsKey(f: RecapFacts): string {
  const s = JSON.stringify([f.files.map((x) => x.name), f.checklist, f.comments, f.openQuestions, f.questionsToReviewer]);
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(16);
}
