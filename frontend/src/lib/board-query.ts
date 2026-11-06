/**
 * Что показывает доска (#4798 §1, §12; #4799 §3): режим «Мои / Все», роли, быстрые
 * условия, прочие фильтры и поиск по этой доске — одним объектом.
 *
 * Хранится на человека, компанию и проект: у Анны свои условия на каждой доске, и
 * коллеге они не передаются. Поиск не храним — это вопрос на минуту, а не настройка.
 */

import { TASK_VIEWS, type TaskView } from './task-views';
import type { FilterOpts, MineMode, QuickKey } from './board-filter';

export interface BoardQuery {
  scope: 'mine' | 'all';
  /** Роли в режиме «Мои» — ИЛИ. Пустыми не бывают: пустой набор = все четыре. */
  roles: TaskView[];
  creatorId: string;
  hideDone: boolean;
  quick: QuickKey[];
  assigneeId: string;
  columnId: string;
  priority: string;
  labelId: string;
  search: string;
}

export const ALL_ROLES: TaskView[] = TASK_VIEWS.map((v) => v.key);

export const DEFAULT_QUERY: BoardQuery = {
  scope: 'mine', roles: [...ALL_ROLES], creatorId: '', hideDone: false, quick: [],
  assigneeId: '', columnId: '', priority: '', labelId: '', search: '',
};

/** Три быстрых условия на панели доски и ещё два — в «Фильтрах» (#4798 §12). */
export const QUICK: { key: QuickKey; label: string; hint: string }[] = [
  { key: 'decide', label: 'Ждут моего решения', hint: 'Работа сдана, решение — за вами: вы проверяющий или постановщик' },
  { key: 'today', label: 'Срок сегодня', hint: 'Срок — на сегодняшнюю дату. Просроченные сюда не входят' },
  { key: 'blocked', label: 'Есть препятствия', hint: 'Отмечено «Есть препятствие». Просрочка сама по себе препятствием не считается' },
  { key: 'overdue', label: 'Просроченные', hint: 'Срок прошёл, а работа у исполнителя' },
  { key: 'answer', label: 'Нужен мой ответ', hint: 'В препятствии помочь просят вас' },
];
export const QUICK_ON_BAR: QuickKey[] = ['decide', 'today', 'blocked'];

const key = (tenantId: string, userId: string, projectId: string) => `qevo.board.q1:${tenantId}:${userId}:${projectId}`;

/** Прежние настройки (одна на все доски) — с них начинаем, чтобы не сбить привычку. */
function legacy(): BoardQuery {
  const q: BoardQuery = { ...DEFAULT_QUERY, roles: [...ALL_ROLES] };
  try {
    const mode = localStorage.getItem('teamcrm.boardMine2');
    if (mode === 'off') q.scope = 'all';
    else if (mode && ALL_ROLES.includes(mode as TaskView)) q.roles = [mode as TaskView];
    q.hideDone = localStorage.getItem('teamcrm.boardInWork') === '1';
  } catch { /* нет хранилища — умолчания */ }
  return q;
}

export function loadQuery(tenantId: string | undefined, userId: string | undefined, projectId: string | null): BoardQuery {
  if (!tenantId || !userId || !projectId) return legacy();
  try {
    const raw = localStorage.getItem(key(tenantId, userId, projectId));
    if (!raw) return legacy();
    const s = JSON.parse(raw) as Partial<BoardQuery>;
    return normalize({ ...DEFAULT_QUERY, ...s, search: '' });
  } catch {
    return legacy();
  }
}

export function saveQuery(tenantId: string | undefined, userId: string | undefined, projectId: string | null, q: BoardQuery): void {
  if (!tenantId || !userId || !projectId) return;
  try {
    const { search, ...rest } = q;
    void search;
    localStorage.setItem(key(tenantId, userId, projectId), JSON.stringify(rest));
  } catch { /* без хранилища — до перезагрузки */ }
}

/** Пустые роли в «Моих» — все четыре; неизвестные значения отбрасываем. */
export function normalize(q: BoardQuery): BoardQuery {
  const roles = (q.roles ?? []).filter((r) => ALL_ROLES.includes(r));
  return {
    ...q,
    scope: q.scope === 'all' ? 'all' : 'mine',
    roles: roles.length ? roles : [...ALL_ROLES],
    quick: (q.quick ?? []).filter((k) => QUICK.some((x) => x.key === k)),
  };
}

/** Для отбора карточек — в понятиях модуля board-filter. */
export function toFilter(q: BoardQuery, userId: string): FilterOpts {
  const mode: MineMode = q.scope === 'all' ? 'off' : 'both';
  return {
    userId, mode, roles: q.scope === 'mine' ? q.roles : undefined, creatorId: q.creatorId || null,
    inWorkOnly: q.hideDone, quick: q.quick, assigneeId: q.assigneeId || null, columnId: q.columnId || null,
    priority: q.priority || null, labelId: q.labelId || null, search: q.search,
  };
}

/**
 * «Сбросить условия»: быстрые условия, поля фильтров и поиск — прочь; режим «Мои / Все»,
 * роли и «Скрыть завершённые» — остаются (#4799 §3.3).
 */
export function resetConditions(q: BoardQuery): BoardQuery {
  return { ...q, quick: [], creatorId: '', assigneeId: '', columnId: '', priority: '', labelId: '', search: '' };
}

/**
 * «Показать все задачи»: перейти ко всем задачам доски, снять роли, постановщика,
 * поиск, быстрые и прочие фильтры. «Скрыть завершённые» — сохраняем и подписываем.
 */
export function showAll(q: BoardQuery): BoardQuery {
  return { ...resetConditions(q), scope: 'all', roles: [...ALL_ROLES], hideDone: q.hideDone };
}

/** Есть ли что сбрасывать кнопкой «Сбросить условия». */
export const hasConditions = (q: BoardQuery) =>
  !!(q.quick.length || q.creatorId || q.assigneeId || q.columnId || q.priority || q.labelId || q.search.trim());
