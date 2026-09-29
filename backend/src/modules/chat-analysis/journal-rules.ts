/**
 * Решения, статусы и блокеры из переписки (ТЗ-12, разд. 5.5, 5.8, 5.9, 16, 24).
 *
 * Решение — не задача: его никто не исполняет, его помнят. Поэтому оно идёт в общий
 * журнал решений, где лежат и решения со встреч. Статус и блокер новых сущностей не
 * порождают вовсе: они ложатся строкой в обсуждение УЖЕ существующей задачи.
 *
 * Главный риск здесь тот же, что с проектом: приписать сказанное не той задаче. Строка
 * «не могу закончить, пока клиент не пришлёт доступ» в чужой задаче — это ложь о чужой
 * работе. Поэтому задачу определяем по основаниям, а не по догадке модели:
 *   * в сообщении переслана карточка задачи — это она, уверенность 1;
 *   * в сообщении назван номер «#1344» — это он, уверенность 1;
 *   * модель выбрала задачу из справочника — принимаем, только если автор сообщения её
 *     исполнитель или постановщик: о своей работе человек и говорит.
 * Ничего из этого — задачи нет, и честный ноль.
 *
 * Чистые функции; проверяются юнит-тестом рядом.
 */

/** Откуда взялась привязка к задаче: по этому видно, факт это или вывод. */
export type TaskGround = 'shared' | 'spoken' | 'author' | 'none';

/** Номера задач, названные в тексте: «#1344», «# 12». Без \b: он не видит кириллицу. */
export function taskNumbersIn(text: string): string[] {
  const out = new Set<string>();
  for (const m of String(text ?? '').matchAll(/#\s?(\d{1,9})(?!\d)/g)) out.add(String(Number(m[1])));
  return [...out];
}

export interface TaskSource {
  messageId: string;
  authorId: string | null;
  /** Карточка задачи, пересланная в этом сообщении. */
  sharedTaskId: string | null;
  text: string;
}

/**
 * К какой задаче относится статус или блокер.
 *
 * `alive` — какие из названных и пересланных задач существуют в этой организации и не в
 * корзине; проверяет вызывающий по базе. `owners` — справочник задач, отданный модели,
 * с исполнителем и постановщиком каждой.
 */
export function resolveTask(o: {
  sources: TaskSource[];
  alive: Set<string>;
  modelTaskId: string | null;
  owners: Map<string, { assigneeId: string | null; creatorId: string | null }>;
}): { taskId: string | null; confidence: number; ground: TaskGround } {
  const none = { taskId: null, confidence: 0, ground: 'none' as const };

  const shared = [...new Set(o.sources.map((s) => s.sharedTaskId).filter((id): id is string => !!id))]
    .filter((id) => o.alive.has(id));
  if (shared.length === 1) return { taskId: shared[0], confidence: 1, ground: 'shared' };

  const spoken = [...new Set(o.sources.flatMap((s) => taskNumbersIn(s.text)))].filter((id) => o.alive.has(id));
  if (spoken.length === 1 && !shared.length) return { taskId: spoken[0], confidence: 1, ground: 'spoken' };

  /*
    Названо несколько задач — выбирать между ними по догадке нельзя: «#12 готова, #14
    стоит» и есть тот случай, где модель путает. Отдаём выбор человеку.
  */
  if (shared.length > 1 || spoken.length > 1) return none;

  const picked = o.modelTaskId ? o.owners.get(String(o.modelTaskId)) : undefined;
  if (!picked) return none;
  const authors = new Set(o.sources.map((s) => s.authorId).filter((id): id is string => !!id));
  const own = (picked.assigneeId && authors.has(String(picked.assigneeId)))
    || (picked.creatorId && authors.has(String(picked.creatorId)));
  return own ? { taskId: String(o.modelTaskId), confidence: 0.8, ground: 'author' } : none;
}

/** Порог уверенности в самом смысле (ТЗ разд. 14): ниже — только «замечено». */
export const NOTE_INTENT_MIN = 0.9;

/**
 * Состояние наблюдения, которое не поручение.
 *
 * Решение готово, когда модель уверена, что оно ПРИНЯТО, а не обсуждается. Статусу и
 * блокеру нужна ещё задача: без неё их некуда положить, и «готово» было бы неправдой.
 */
export function noteReadiness(o: {
  type: string; intent: number; taskId: string | null; cancelled: boolean;
}): 'ready' | 'detected' {
  if (o.cancelled || o.intent < NOTE_INTENT_MIN) return 'detected';
  if (o.type === 'decision') return 'ready';
  if ((o.type === 'status' || o.type === 'blocker') && o.taskId) return 'ready';
  return 'detected';
}

/**
 * Записать решение в журнал без человека (ТЗ разд. 16: Decisions — AUTO LOG).
 *
 * Только в режиме, который включил владелец. Решение в журнале ни на кого не ложится —
 * ни писем, ни сроков, — поэтому здесь порог ниже, чем у задачи. А вот статус и блокер
 * сами не пишем даже тогда: это строка в чужой задаче, и её видят все её участники.
 */
export function autoLogDecision(o: { mode: string; type: string; status: string }): boolean {
  return o.mode === 'auto_high' && o.type === 'decision' && o.status === 'ready';
}

/** Участники решения — авторы сообщений, из которых оно выросло. Бот участником не бывает. */
export function participantsOf(sources: { authorId: string | null }[]): string[] {
  return [...new Set(sources.map((s) => s.authorId).filter((id): id is string => !!id))];
}

/**
 * Строка в обсуждении задачи.
 *
 * Пишет её система, а не человек, поэтому в тексте сказано, чьи это слова и откуда:
 * иначе участники задачи примут вывод агента за сообщение коллеги.
 */
export function noteText(o: {
  type: 'status' | 'blocker'; title: string; author: string | null; chat: string | null; quote: string | null;
}): string {
  const head = o.type === 'blocker' ? 'Помеха в работе' : 'Ход работы';
  const where = o.chat ? ` в чате «${o.chat}»` : ' в переписке';
  const quote = o.quote ? `\n«${o.quote.trim().slice(0, 300)}»` : '';
  return `${head}: ${o.title}.\nИз переписки${where}${o.author ? `, пишет ${o.author}` : ''}.${quote}`;
}
