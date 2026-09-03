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

export type RegistryScope = 'mine' | 'delegated' | 'watching' | 'all';

export interface RegistryTab {
  key: RegistryScope;
  label: string;
  /** Подпись под заголовком: человек должен понимать, ЧТО именно перед ним. */
  hint: string;
}

/**
 * Порядок вкладок — по частоте: сначала своя работа, потом поручения, потом наблюдение
 * и только в конце «всё». «Все задачи» последней сознательно: это срез для разбора, а
 * не рабочий список, и открывать реестр он не должен.
 */
export const REGISTRY_TABS: RegistryTab[] = [
  { key: 'mine', label: 'Мне', hint: 'Задачи, где вы исполнитель или соисполнитель' },
  { key: 'delegated', label: 'От меня', hint: 'Всё, что вы поручили другим, по всем проектам' },
  { key: 'watching', label: 'Наблюдаю', hint: 'Задачи, куда вас добавили наблюдателем' },
  { key: 'all', label: 'Все', hint: 'Все задачи компании во всех неархивных проектах' },
];

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

export interface RegistryFilters {
  scope: RegistryScope;
  q: string;
  projectId: string;
  assigneeId: string;
  priority: string;
  due: string;
  sort: string;
  closed: boolean;
  page: number;
}

export const EMPTY_FILTERS: RegistryFilters = {
  scope: 'mine', q: '', projectId: '', assigneeId: '', priority: '', due: 'any',
  sort: 'deadline', closed: false, page: 1,
};

export function isScope(value: string | undefined | null): value is RegistryScope {
  return REGISTRY_TABS.some((t) => t.key === value);
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
  if (f.closed) p.set('closed', '1');
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
  if (f.closed) n++;
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
    case 'watching':
      return 'Вас не добавляли наблюдателем ни в одну задачу.';
    case 'all':
      return 'В компании ещё нет задач в неархивных проектах.';
    default:
      return 'На вас не назначено задач. Это нормально в начале — или всё уже закрыто.';
  }
}
