/**
 * Черновик окна «Новая задача» (#1534).
 *
 * Окно закрывалось от случайного нажатия — мимо окна, «Отмена», Esc — и всё набранное
 * пропадало. Теперь поля сохраняются по мере ввода, а после закрытия без создания
 * появляется кнопка «Черновик»: нажал — та же доска и то же окно с тем же текстом.
 *
 * Черновик один на человека и живёт в этом браузере: это страховка от промаха, а не
 * склад незаконченных задач. Файлы в черновик не попадают — их не сохранить в памяти
 * браузера, — об этом окно говорит само.
 */

export interface TaskDraft {
  userId: string;
  projectId: string;
  columnId: string;
  columnName: string;
  title: string;
  description: string;
  assigneeId: string;
  managerId: string;
  priority: string;
  deadline: string;
  estimate: string;
  directions: string[];
  requiresApproval: boolean;
  savedAt: string;
}

const KEY = 'teamcrm.taskDraft';
/** Черновик изменился или исчез — кнопка «Черновик» перечитывает себя. */
export const TASK_DRAFT_CHANGED = 'teamcrm:task-draft';
/** Открыть окно с черновиком — слушает доска нужного проекта. */
export const TASK_DRAFT_OPEN = 'teamcrm:task-draft-open';

/** Окно открыто прямо сейчас — кнопку «Черновик» не показываем, она бы дублировала окно. */
let editing = false;
export function setDraftEditing(on: boolean): void {
  editing = on;
  window.dispatchEvent(new Event(TASK_DRAFT_CHANGED));
}
export function isDraftEditing(): boolean {
  return editing;
}

/** Есть что сохранять: пустое окно черновиком не считается. */
export function draftHasContent(d: Pick<TaskDraft, 'title' | 'description'>): boolean {
  return !!(d.title.trim() || d.description.replace(/<[^>]*>/g, '').trim());
}

export function loadDraft(userId: string | undefined): TaskDraft | null {
  if (!userId) return null;
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const d = JSON.parse(raw) as TaskDraft;
    return String(d.userId) === String(userId) && draftHasContent(d) ? d : null;
  } catch {
    return null;
  }
}

export function saveDraft(d: TaskDraft): void {
  try {
    if (draftHasContent(d)) localStorage.setItem(KEY, JSON.stringify(d));
    else localStorage.removeItem(KEY);
  } catch { /* память браузера недоступна — черновика просто не будет */ }
  window.dispatchEvent(new Event(TASK_DRAFT_CHANGED));
}

export function clearDraft(): void {
  try { localStorage.removeItem(KEY); } catch { /* нечего удалять */ }
  window.dispatchEvent(new Event(TASK_DRAFT_CHANGED));
}

/**
 * Запрос «открыть черновик», пока доска ещё грузится: доска заберёт его, когда
 * откроется нужный проект. Событие одно — а доска может появиться позже него.
 */
let pendingOpen: TaskDraft | null = null;
export function requestDraftOpen(d: TaskDraft): void {
  pendingOpen = d;
  window.dispatchEvent(new Event(TASK_DRAFT_OPEN));
}
export function takeDraftOpen(projectId: string | null): TaskDraft | null {
  if (!pendingOpen || !projectId || String(pendingOpen.projectId) !== String(projectId)) return null;
  const d = pendingOpen;
  pendingOpen = null;
  return d;
}
