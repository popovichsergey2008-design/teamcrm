/**
 * Черновики постановки задачи (#1534, #4668).
 *
 * Окно закрывалось от случайного нажатия — мимо окна, «Отмена», Esc, — страница
 * обновлялась, приложение вылетало, и всё набранное пропадало. Теперь поля
 * сохраняются по мере ввода, а при следующем открытии окно предлагает продолжить.
 *
 * Черновиков несколько: начатая и брошенная задача не должна затираться следующей.
 * Два вида — форма «Новая задача» на доске (`form`) и быстрая постановка текстом или
 * голосом (`quick`, #4615): у второй сохраняется фраза или расшифровка записи, чтобы
 * сбой разбора не терял сказанное.
 *
 * Хранятся в этом браузере (localStorage), а не на сервере: это страховка от промаха
 * и вылета на том же устройстве, она должна работать и без сети, и в ту же секунду.
 * Чужому человеку на общем компьютере черновик не покажется — он привязан к userId.
 * Выбранные файлы лежат отдельно, в IndexedDB (`draft-files.ts`): localStorage их не
 * вмещает. Модуль с файлами грузится только вместе с окнами постановки.
 */

export interface TaskDraft {
  /** Свой у каждого черновика; у старого единственного (#1534) его не было. */
  id: string;
  kind: 'form' | 'quick';
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
  /** Выбранные теги — после возврата их снова подтверждает постановщик. */
  tagIds?: string[];
  /** Чек-лист и шаблон, по которому заполняли. */
  checklist?: string[];
  tplId?: string;
  /** Последняя распознанная фраза: разбор сорвался — сказанное не пропадает. */
  speech?: string;
  /** Быстрая постановка: фраза или расшифровка и срок чипом. */
  text?: string;
  quickDeadline?: string | null;
  /** Запись ушла на сервер, расшифровка ещё шла: при возврате продолжаем следить за ней. */
  voiceJobId?: string;
  /** Имена выбранных файлов: сами файлы — в IndexedDB, если поместились. */
  fileNames?: string[];
  savedAt: string;
}

const KEY = 'teamcrm.taskDrafts';
/** Единственный черновик до #4668 — переносим в список при первом чтении. */
const OLD_KEY = 'teamcrm.taskDraft';
/** Больше черновиков не держим: это страховка, а не склад. Старые — через 30 дней. */
const MAX = 20;
const TTL = 30 * 24 * 3600 * 1000;

/** Черновик изменился или исчез — кнопка «Черновик» перечитывает себя. */
export const TASK_DRAFT_CHANGED = 'teamcrm:task-draft';
/** Открыть окно с черновиком — слушает доска нужного проекта. */
export const TASK_DRAFT_OPEN = 'teamcrm:task-draft-open';
/** Открыть быструю постановку с черновиком — слушает оболочка приложения. */
export const TASK_QUICK_DRAFT_OPEN = 'teamcrm:task-quick-draft-open';

/** Окно открыто прямо сейчас — кнопку «Черновик» не показываем, она бы дублировала окно. */
let editing = 0;
export function setDraftEditing(on: boolean): void {
  editing = Math.max(0, editing + (on ? 1 : -1));
  window.dispatchEvent(new Event(TASK_DRAFT_CHANGED));
}
export function isDraftEditing(): boolean {
  return editing > 0;
}

export function newDraftId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

const strip = (s: string | undefined) => String(s ?? '').replace(/<[^>]*>/g, '').trim();

/** Есть что сохранять: пустое окно черновиком не считается. */
export function draftHasContent(d: Pick<TaskDraft, 'title' | 'description'> & Partial<TaskDraft>): boolean {
  return !!(strip(d.title) || strip(d.description) || strip(d.text) || strip(d.speech) || d.voiceJobId || d.fileNames?.length);
}

/** Чем назвать черновик в списке: название, фраза или «без названия». */
export function draftLabel(d: TaskDraft): string {
  return strip(d.title) || strip(d.text) || strip(d.speech) || strip(d.description).slice(0, 80) || 'задача без названия';
}

function readAll(): TaskDraft[] {
  try {
    const list: TaskDraft[] = JSON.parse(localStorage.getItem(KEY) || '[]');
    const old = localStorage.getItem(OLD_KEY);
    if (old) {
      const d = JSON.parse(old) as TaskDraft;
      list.push({ ...d, id: d.id || newDraftId(), kind: d.kind || 'form' });
      localStorage.removeItem(OLD_KEY);
      writeAll(list);
    }
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function writeAll(list: TaskDraft[]): void {
  try {
    if (list.length) localStorage.setItem(KEY, JSON.stringify(list));
    else localStorage.removeItem(KEY);
  } catch { /* память браузера недоступна или полна — черновика просто не будет */ }
}

/** Черновики человека, свежие сверху. Просроченные и пустые не показываем. */
export function listDrafts(userId: string | undefined): TaskDraft[] {
  if (!userId) return [];
  const now = Date.now();
  return readAll()
    .filter((d) => String(d.userId) === String(userId) && draftHasContent(d) && now - Date.parse(d.savedAt) < TTL)
    .sort((a, b) => b.savedAt.localeCompare(a.savedAt));
}

/** Самый свежий черновик — для кнопки «Черновик». */
export function loadDraft(userId: string | undefined): TaskDraft | null {
  return listDrafts(userId)[0] ?? null;
}

export function saveDraft(d: TaskDraft): void {
  const rest = readAll().filter((x) => x.id !== d.id);
  if (!draftHasContent(d)) {
    writeAll(rest);
  } else {
    const now = Date.now();
    // свой — первым; лишние и просроченные уходят, файлы их — тоже
    const kept = [d, ...rest.filter((x) => now - Date.parse(x.savedAt) < TTL)]
      .sort((a, b) => b.savedAt.localeCompare(a.savedAt));
    const drop = kept.slice(MAX);
    writeAll(kept.slice(0, MAX));
    if (drop.length) void import('./draft-files').then((m) => drop.forEach((x) => m.dropDraftFiles(x.id))).catch(() => undefined);
  }
  window.dispatchEvent(new Event(TASK_DRAFT_CHANGED));
}

/** Удалить черновик: задача создана или человек сказал «не нужно». */
export function removeDraft(id: string | undefined): void {
  if (!id) return;
  writeAll(readAll().filter((x) => x.id !== id));
  void import('./draft-files').then((m) => m.dropDraftFiles(id)).catch(() => undefined);
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

/**
 * Открыть черновик там, где его начали: форму — на доске проекта, быструю
 * постановку — окном поверх любого раздела. `navigate` передаём снаружи, чтобы этот
 * модуль не тянул за собой роутер.
 */
export function openDraft(d: TaskDraft, go: (projectId: string) => void): void {
  if (d.kind === 'quick' || !d.projectId) {
    window.dispatchEvent(new CustomEvent(TASK_QUICK_DRAFT_OPEN, { detail: d }));
    return;
  }
  requestDraftOpen(d);
  go(d.projectId);
}
