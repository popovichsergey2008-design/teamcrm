import { api, ApiError } from '../lib/api';
import type { Task } from '../types';

/**
 * Откуда Mini App берёт данные: из CRM (человек привязан) или из демо (не привязан,
 * либо открыл «демо-доску» до регистрации). Экраны об этом не знают — у них одна
 * модель и один набор действий.
 */

export interface TgCard {
  id: string;
  title: string;
  assignee: string | null;
  /** Срок готовой строкой: «пт, 31 окт, 15:00» или «Пятница, 15:00» в демо. */
  due: string | null;
  overdue: boolean;
  checkDone: number;
  checkTotal: number;
}
export interface TgColumn { id: string; name: string; cards: TgCard[] }
export interface TgBoard { project: { id: string; name: string }; columns: TgColumn[] }
export interface TgTaskView {
  card: TgCard;
  description: string | null;
  columnId: string;
  projectId: string;
  projectName: string;
  columns: { id: string; name: string }[];
  closed: boolean;
}
export interface TgCheck { id: string; text: string; done: boolean }
/** Сдать не получилось: чего не хватает и можно ли всё равно. */
export interface TgGate { column: string; missing: string[]; locked: boolean }

export class GateError extends Error {
  constructor(public readonly gate: TgGate) { super('gate'); }
}

export interface TgSource {
  demo: boolean;
  projects(): Promise<{ id: string; name: string }[]>;
  board(projectId: string | null): Promise<TgBoard | null>;
  task(id: string): Promise<TgTaskView>;
  checklist(taskId: string): Promise<TgCheck[]>;
  toggle(taskId: string, itemId: string, done: boolean): Promise<void>;
  move(taskId: string, columnId: string, force: boolean): Promise<void>;
}

const DUE_FMT = new Intl.DateTimeFormat('ru-RU', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

export function formatDue(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : DUE_FMT.format(d).replace(/\.$/, '');
}

function toCard(t: Task): TgCard {
  return {
    id: String(t.id),
    title: t.title,
    assignee: t.assignee_name ?? null,
    due: formatDue(t.deadline_at),
    overdue: !!t.deadline_at && !t.closed_at && new Date(t.deadline_at).getTime() < Date.now(),
    checkDone: t.checklistDone ?? 0,
    checkTotal: t.checklistTotal ?? 0,
  };
}

/** Последний открытый в Mini App проект — свой ключ, общий «последний проект» CRM не трогаем. */
const LAST_KEY = 'qevo.tg.project';
export function rememberProject(id: string): void {
  try { localStorage.setItem(LAST_KEY, id); } catch { /* приватный режим */ }
}
function lastProject(): string | null {
  try { return localStorage.getItem(LAST_KEY); } catch { return null; }
}

export const crmSource: TgSource = {
  demo: false,
  async projects() {
    const list = await api.listProjects();
    return list.map((p) => ({ id: String(p.id), name: p.name }));
  },
  async board(projectId) {
    let id = projectId ?? lastProject();
    if (!id) {
      const list = await api.listProjects();
      if (!list.length) return null;
      id = String(list[0].id);
    }
    let b;
    try {
      b = await api.getBoard(id);
    } catch (e) {
      // запомненный проект удалили или закрыли от нас — берём первый доступный
      if (projectId || !(e instanceof ApiError) || !['NOT_FOUND', 'FORBIDDEN'].includes(e.code)) throw e;
      const list = await api.listProjects();
      if (!list.length) return null;
      b = await api.getBoard(String(list[0].id));
    }
    rememberProject(String(b.project.id));
    return {
      project: { id: String(b.project.id), name: b.project.name },
      columns: b.columns.map((c) => ({ id: String(c.id), name: c.name, cards: c.tasks.map(toCard) })),
    };
  },
  async task(id) {
    // карточка = задача с доски её проекта: доска проверяет доступ к проекту так же,
    // как обычная карточка в CRM, и заодно даёт колонки для смены статуса
    const brief = await api.taskBrief(id);
    const b = await api.getBoard(brief.projectId);
    for (const c of b.columns) {
      const t = c.tasks.find((x) => String(x.id) === String(id));
      if (!t) continue;
      return {
        card: toCard(t),
        description: t.description,
        columnId: String(c.id),
        projectId: String(b.project.id),
        projectName: b.project.name,
        columns: b.columns.map((x) => ({ id: String(x.id), name: x.name })),
        closed: !!t.closed_at,
      };
    }
    throw new ApiError('NOT_FOUND', 'Задача не найдена на доске проекта');
  },
  async checklist(taskId) {
    const items = await api.listChecklist(taskId);
    return items.map((i: { id: unknown; text: string; is_done?: boolean }) => ({ id: String(i.id), text: i.text, done: !!i.is_done }));
  },
  async toggle(taskId, itemId, done) {
    await api.patchChecklist(taskId, itemId, { isDone: done });
  },
  async move(taskId, columnId, force) {
    try {
      await api.moveTask(taskId, { columnId, position: 0, confirmGate: force });
    } catch (e) {
      const g = e instanceof ApiError
        ? (e.details as { gate?: { column: string; missing: { text: string; blocking?: boolean }[]; blocking?: boolean } } | undefined)?.gate
        : undefined;
      if (g && Array.isArray(g.missing) && g.missing.length) {
        throw new GateError({ column: g.column, missing: g.missing.map((m) => m.text), locked: !!g.blocking || g.missing.some((m) => m.blocking) });
      }
      throw e;
    }
  },
};
