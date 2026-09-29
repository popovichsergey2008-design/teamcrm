/**
 * Политика разбора переписки: когда агенту можно завести задачу самому (ТЗ-12, разд.
 * 14–15, 26, 53, 58).
 *
 * Заказчик решил 29.09: по умолчанию агент ТОЛЬКО ПРЕДЛАГАЕТ. Автосоздание — режим,
 * который владелец включает сам. Но и включённым он срабатывает не на всё: только на
 * поручение, в котором понятно всё, и только после повторной проверки по базе — модель
 * могла смотреть на мир, которого уже нет (проект закрыли, человека уволили, сообщение
 * удалили).
 *
 * Чистые функции; проверяются юнит-тестом рядом.
 */

/** Сколько после автосоздания его ещё можно отменить одним нажатием. */
export const UNDO_WINDOW_MS = 24 * 60 * 60_000;

/** Что проверили по базе прямо перед созданием (ТЗ разд. 53). */
export interface CreateFacts {
  /** Проект существует и не в архиве. */
  projectAlive: boolean;
  /** Постановщик — действующий сотрудник этой организации, не клиент. */
  assignerActive: boolean;
  /** Исполнитель — действующий сотрудник этой организации, не клиент. */
  assigneeActive: boolean;
  /** Сообщение-поручение на месте: удалённое поручение — отменённое поручение. */
  instructionAlive: boolean;
}

export type AutoVerdict =
  | { create: true }
  | { create: false; reason: string };

/**
 * Заводить ли задачу без человека.
 *
 * Отказ — не ошибка: наблюдение просто остаётся «готовым», и его заведут руками. Причину
 * возвращаем словами, чтобы по журналу было видно, почему агент не стал.
 */
export function autoCreateVerdict(o: {
  mode: string;
  type: string;
  /** Состояние наблюдения по `taskReadiness`: только `ready` вообще рассматриваем. */
  status: string;
  facts: CreateFacts;
}): AutoVerdict {
  if (o.mode !== 'auto_high') return { create: false, reason: 'режим «только предлагать»' };
  if (o.type !== 'task') return { create: false, reason: 'заводим только поручения' };
  if (o.status !== 'ready') return { create: false, reason: 'поручению чего-то не хватает' };
  const f = o.facts;
  if (!f.projectAlive) return { create: false, reason: 'проекта нет или он в архиве' };
  if (!f.assignerActive) return { create: false, reason: 'постановщик не работает в компании' };
  if (!f.assigneeActive) return { create: false, reason: 'исполнитель не работает в компании' };
  if (!f.instructionAlive) return { create: false, reason: 'сообщение с поручением удалено' };
  return { create: true };
}

/**
 * Можно ли отменить автоматически заведённую задачу.
 *
 * Отменять вправе те, кого ошибка касается: постановщик, исполнитель и руководство. Окно
 * — сутки: дальше это уже обычная задача, с которой работают, и убирать её надо
 * обычным удалением со всеми его проверками.
 */
export function undoVerdict(o: {
  status: string;
  createdAt: Date;
  now: Date;
  userId: string;
  role: string;
  assignerId: string | null;
  assigneeId: string | null;
}): { ok: true } | { ok: false; reason: string } {
  if (o.status !== 'auto_created') return { ok: false, reason: 'Отменить можно только задачу, которую агент завёл сам' };
  if (o.now.getTime() - o.createdAt.getTime() > UNDO_WINDOW_MS) {
    return { ok: false, reason: 'Прошло больше суток — удалите задачу обычным способом' };
  }
  const me = String(o.userId);
  const involved = me === String(o.assignerId ?? '') || me === String(o.assigneeId ?? '');
  if (!involved && o.role !== 'owner' && o.role !== 'manager') {
    return { ok: false, reason: 'Отменить может постановщик, исполнитель или руководитель' };
  }
  return { ok: true };
}

/** Потолок расхода: пустой — без потолка. */
export function overLimit(spentUsd: number, limitUsd: number | null): boolean {
  return limitUsd != null && limitUsd >= 0 && spentUsd >= limitUsd;
}

/**
 * Счётчики попадания (ТЗ разд. 58): на них владелец смотрит, прежде чем включать
 * автосоздание. Доли — от того, что человек уже рассмотрел: нерассмотренное ещё ничего
 * не говорит о качестве.
 */
export interface QualityCounts {
  tasksDetected: number;
  ready: number;
  needsClarification: number;
  confirmed: number;
  autoCreated: number;
  rejected: number;
  undone: number;
  correctedProject: number;
  correctedAssignee: number;
  /** Заведённые, где поправили хоть что-то из двух: одна задача — один промах. */
  corrected: number;
  duplicates: number;
}

export interface Quality extends QualityCounts {
  /** Сколько поручений человек рассмотрел: завёл, отверг или отменил. */
  reviewed: number;
  /** Доля отвергнутых и отменённых — «это не задача» или «не то». */
  rejectRate: number | null;
  /** Доля заведённых, где пришлось поправить проект или исполнителя. */
  correctionRate: number | null;
  /** Хватает ли рассмотренного, чтобы доверять долям. */
  enoughData: boolean;
}

/** Меньше этого числа рассмотренных поручений доли — шум. */
export const MIN_REVIEWED = 20;

export function quality(c: QualityCounts): Quality {
  const reviewed = c.confirmed + c.autoCreated + c.rejected;
  const created = c.confirmed + c.autoCreated;
  return {
    ...c,
    reviewed,
    rejectRate: reviewed ? (c.rejected + c.undone) / reviewed : null,
    correctionRate: created ? Math.min(1, c.corrected / created) : null,
    enoughData: reviewed >= MIN_REVIEWED,
  };
}
