/**
 * Реестр задач: срезы, сборка запроса и постраничность.
 *
 * Экран отвечает на вопрос, которого не было: «покажи ВСЁ, что я поставил» и «всё, что
 * на мне» — по всем проектам, вместе с завершённым. «Фокус дня» на него не отвечает
 * намеренно: там только сегодняшнее и только открытое.
 *
 * Логика вынесена сюда и проверяется npm run check, потому что ошибается молча: лишний
 * пустой параметр в адресе — и сервер отвечает 400 на `forbidNonWhitelisted`; забытый
 * `dayEnd` — и «просрочено» считается по часовому поясу сервера, а не человека;
 * съехавшее окно страниц — и до последней страницы не добраться.
 */

import { LEGACY_VIEWS, TaskView } from './task-views';

export type RegistryScope = TaskView | 'all';

export interface RegistryTab {
  key: RegistryScope;
  label: string;
  /** Подпись под заголовком: человек должен понимать, ЧТО именно перед ним. */
  hint: string;
}

/**
 * Виды задач — те же четыре слова, что и в кнопке «Мои задачи» на доске (`task-views`),
 * плюс «Все» последней. «Все задачи» в конце сознательно: это срез для разбора, а не
 * рабочий список, и открывать реестр он не должен.
 */
export const REGISTRY_TABS: RegistryTab[] = [
  { key: 'doing', label: 'Делаю', hint: 'Задачи, где исполнитель — вы' },
  { key: 'delegated', label: 'Поручил', hint: 'Всё, что вы поручили другим, по всем проектам' },
  { key: 'helping', label: 'Помогаю', hint: 'Задачи, где вы соисполнитель' },
  { key: 'watching', label: 'Наблюдаю', hint: 'Задачи, куда вас добавили наблюдателем' },
  { key: 'all', label: 'Все', hint: 'Все задачи компании во всех проектах' },
];

/**
 * Четыре роли для галочек: «все задачи компании» сюда не входит — это не роль,
 * а другой вопрос («чужая работа тоже»), и живёт он отдельной кнопкой.
 */
export const ROLE_TABS: RegistryTab[] = REGISTRY_TABS.filter((t) => t.key !== 'all');

/**
 * Подпись под заголовком: что сейчас показано.
 *
 * Перечислять роли словами, а не писать «выбрано 3 из 4»: человек должен понимать
 * список, не считая галочки.
 */
export function scopeHint(picked: string[]): string {
  if (picked.includes('all')) return 'Все задачи компании во всех проектах';
  const roles = ROLE_TABS.filter((t) => picked.includes(t.key));
  if (!roles.length || roles.length === ROLE_TABS.length) return 'Вся ваша работа: делаю, поручил, помогаю, наблюдаю';
  return `Только: ${roles.map((t) => t.label.toLowerCase()).join(', ')}`;
}

export const REGISTRY_SORTS: { key: string; label: string }[] = [
  { key: 'deadline', label: 'По сроку' },
  { key: 'priority', label: 'По приоритету' },
  { key: 'updated', label: 'По изменению' },
  { key: 'created', label: 'По созданию' },
  { key: 'project', label: 'По проекту' },
];

export const REGISTRY_DUES: { key: string; label: string }[] = [
  { key: 'any', label: 'Любой срок' },
  { key: 'overdue', label: 'Просроченные' },
  { key: 'today', label: 'Срок сегодня' },
  { key: 'week', label: 'Срок в течение недели' },
  { key: 'none', label: 'Без срока' },
];

/** Направление сортировки по столбцу: А→Я или Я→А. */
export type SortDir = 'asc' | 'desc';

/**
 * Столбцы реестра, по которым сортирует заголовок (просьба заказчика: нажатие по
 * шапке — А→Я, второе — Я→А, третье — обычный порядок).
 *
 * `who` — это один столбец, но разные поля: в срезе «От меня» в нём постановщик, в
 * остальных исполнитель. Что именно показано, знает экран, поэтому ключ он и выбирает.
 */
export const SORT_COLUMNS = ['title', 'project', 'status', 'assignee', 'manager', 'deadline'] as const;
export type SortColumn = typeof SORT_COLUMNS[number];

export interface RegistryFilters {
  scope: RegistryScope;
  q: string;
  projectId: string;
  assigneeId: string;
  priority: string;
  due: string;
  sort: string;
  dir: SortDir;
  /**
   * «В работе» — переключатель, а не фильтр «показать завершённые».
   *
   * Включён: только живые задачи в живых проектах — рабочий список. Выключен: видно
   * ВСЁ, что было, — и завершённое, и задачи из архивных проектов. Именно этого не
   * хватало: «сделанное полгода назад» находилось только через архив проекта.
   */
  inWork: boolean;
  page: number;
}

export const EMPTY_FILTERS: RegistryFilters = {
  scope: 'all', q: '', projectId: '', assigneeId: '', priority: '', due: 'any',
  sort: 'deadline', dir: 'asc', inWork: true, page: 1,
};

/**
 * Следующее состояние сортировки при нажатии на заголовок столбца.
 *
 * Три положения по кругу: А→Я, Я→А, обычный порядок (по сроку — то, с чем реестр
 * открывается). Нажали по ДРУГОМУ столбцу — начинаем с А→Я: продолжать чужое
 * направление некорректно, человек выбирает новый признак, а не переворачивает старый.
 */
export function nextSortState(
  current: { sort: string; dir: SortDir },
  column: SortColumn,
): { sort: string; dir: SortDir } {
  if (current.sort !== column) return { sort: column, dir: 'asc' };
  if (current.dir === 'asc') return { sort: column, dir: 'desc' };
  return { sort: EMPTY_FILTERS.sort, dir: EMPTY_FILTERS.dir };
}

/** Что рисовать в заголовке столбца: стрелку вверх, вниз или ничего. */
export function sortMark(current: { sort: string; dir: SortDir }, column: SortColumn): SortDir | null {
  return current.sort === column ? current.dir : null;
}

export function isScope(value: string | undefined | null): value is RegistryScope {
  return REGISTRY_TABS.some((t) => t.key === value);
}

/**
 * Срез из адреса. Старые ссылки (`/tasks/mine`, `/tasks/created`) обязаны открывать
 * то же, что открывали вчера, — иначе сохранённая закладка ведёт в пустоту.
 *
 * Без хвоста (`/tasks`) — ВСЕ задачи компании: так решил заказчик. Раздел отвечает
 * на вопрос «что вообще происходит», а свою роль человек сужает галочками.
 */
export function toScope(value: string | undefined | null): RegistryScope {
  if (isScope(value)) return value;
  // Несколько ролей в адресе («doing,delegated»): проверяем каждую по отдельности,
  // иначе ссылка на такой срез открывалась бы как «делаю» и человек терял выбор.
  const parts = String(value ?? '').split(',').filter(Boolean);
  if (parts.length > 1 && parts.every((p) => isScope(p))) return parts.join(',') as RegistryScope;
  const legacy = LEGACY_VIEWS[String(value ?? '')];
  return legacy ?? 'all';
}

/**
 * Конец «сегодня» по часам ЧЕЛОВЕКА, ISO-строкой.
 *
 * Сервер живёт в UTC, а сутки — у пользователя: без этой границы «просрочено» и «срок
 * сегодня» у вечерних задач считаются на день мимо. `now` параметром — чтобы проверять.
 */
export function endOfTodayIso(now = new Date()): string {
  const d = new Date(now.getTime());
  d.setHours(23, 59, 59, 999);
  return d.toISOString();
}

/**
 * Строка запроса к /tasks/registry.
 *
 * Пустые фильтры не отправляются вовсе: на сервере включён `forbidNonWhitelisted`, и
 * `priority=` пустой строкой не «отсутствие фильтра», а неверное значение и ответ 400.
 */
export function registryQuery(f: RegistryFilters, now = new Date()): string {
  const p = new URLSearchParams();
  p.set('scope', f.scope);
  const q = f.q.trim();
  if (q) p.set('q', q);
  if (f.projectId) p.set('projectId', f.projectId);
  if (f.assigneeId) p.set('assigneeId', f.assigneeId);
  if (f.priority) p.set('priority', f.priority);
  if (f.due && f.due !== 'any') p.set('due', f.due);
  if (f.sort && f.sort !== 'deadline') p.set('sort', f.sort);
  // Направление отправляем только у сортировки по столбцу: у наборов из списка своё.
  if (f.dir === 'desc') p.set('dir', 'desc');
  // «В работе» выключили — просим у сервера всё: и завершённое, и архивные проекты
  if (!f.inWork) p.set('closed', '1');
  if (f.page > 1) p.set('page', String(f.page));
  p.set('dayEnd', endOfTodayIso(now));
  return p.toString();
}

/** Сколько фильтров сверх среза человек уже наложил — чтобы показать кнопку «сбросить». */
export function activeFilterCount(f: RegistryFilters): number {
  let n = 0;
  if (f.q.trim()) n++;
  if (f.projectId) n++;
  if (f.assigneeId) n++;
  if (f.priority) n++;
  if (f.due && f.due !== 'any') n++;
  if (!f.inWork) n++;
  return n;
}

/**
 * Окно номеров страниц: первая, последняя и соседние вокруг текущей.
 *
 * `0` — разрыв («…»). Без окна тысяча задач превращалась бы в двадцать кнопок в ряд,
 * а без первой и последней — до края списка было бы не дойти.
 */
export function pageWindow(page: number, pages: number, span = 1): number[] {
  if (pages <= 1) return [1];
  const keep = new Set<number>([1, pages, page]);
  for (let d = 1; d <= span; d++) {
    if (page - d >= 1) keep.add(page - d);
    if (page + d <= pages) keep.add(page + d);
  }
  const sorted = [...keep].sort((a, b) => a - b);
  const out: number[] = [];
  for (let i = 0; i < sorted.length; i++) {
    if (i > 0 && sorted[i] - sorted[i - 1] > 1) out.push(0);
    out.push(sorted[i]);
  }
  return out;
}

/** «1–50 из 137» — человеку нужна не только цифра всего, но и где он находится. */
export function rangeLabel(page: number, pageSize: number, total: number): string {
  if (total === 0) return 'ничего не найдено';
  const from = (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);
  return `${from}–${to} из ${total}`;
}

/** Подпись пустого среза: почему пусто — вопрос, который задают в первую очередь. */
export function emptyHint(scope: RegistryScope, filtered: boolean): string {
  if (filtered) return 'По выбранным фильтрам ничего нет. Снимите часть условий.';
  switch (scope) {
    case 'delegated':
      return 'Вы пока никому не поручали задач. Поставьте задачу — она появится здесь.';
    case 'helping':
      return 'Вас не добавляли соисполнителем ни в одну задачу.';
    case 'watching':
      return 'Вас не добавляли наблюдателем ни в одну задачу.';
    case 'all':
      return 'В компании ещё нет задач.';
    default:
      return 'На вас не назначено задач. Это нормально в начале — или всё уже закрыто.';
  }
}
