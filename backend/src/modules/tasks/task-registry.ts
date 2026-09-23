/**
 * Реестр задач: сборка условий выборки по всем проектам сразу.
 *
 * «Фокус дня» отвечает на вопрос «что делать сегодня» и потому намеренно узок: только
 * открытое, только со сроком, без фильтров и без истории. Реестр отвечает на другой
 * вопрос — «покажи ВСЁ, что я поставил» и «всё, что на мне», включая завершённое, с
 * отбором по проекту, исполнителю, сроку и приоритету.
 *
 * Условия собираются здесь, отдельным модулем и под jest'ом: строка WHERE, склеенная
 * по месту в репозитории, ошибается молча — теряется срез, ломается нумерация $-параметров,
 * фильтр «без исполнителя» превращается в «любой исполнитель». Такое видно только по
 * неверным цифрам в интерфейсе, а не по упавшему запросу.
 *
 * Параметры нумеруются от $1: репозиторий подставляет тот же массив, что получил здесь.
 */

/**
 * Кто я в задаче — этим и различаются вкладки реестра.
 *
 * `doing` и `helping` разделены намеренно: исполнитель отвечает за результат,
 * соисполнитель помогает. В одной куче («мне») человек не видел, где с него спросят,
 * а где он вторая пара рук. `mine` оставлен как старое название — по нему приходят
 * сохранённые ссылки, и ломать их нельзя.
 */
export type RegistryScope = 'doing' | 'helping' | 'mine' | 'delegated' | 'watching' | 'all';

/** Отбор по сроку. `none` — задачи вообще без срока: их легко потерять. */
export type RegistryDue = 'any' | 'overdue' | 'today' | 'week' | 'none';

/**
 * Чем упорядочить реестр.
 *
 * Первые пять — готовые наборы из выпадающего списка («по сроку», «по приоритету»…).
 * Остальные — столбцы таблицы: заказчик попросил сортировать нажатием на заголовок,
 * как в таблице, с направлением А→Я, Я→А и возвратом к обычному порядку.
 */
export type RegistrySort =
  | 'deadline' | 'created' | 'updated' | 'priority' | 'project'
  | 'title' | 'status' | 'assignee' | 'manager';

/** Направление для сортировки по столбцу. Наборы из списка своё направление знают сами. */
export type RegistryDir = 'asc' | 'desc';

export interface RegistryFilters {
  scope?: string | null;
  /** Поиск по названию; целое число ищется ещё и как номер задачи. */
  q?: string | null;
  projectId?: string | null;
  /** Идентификатор исполнителя либо `none` — «без исполнителя». */
  assigneeId?: string | null;
  priority?: string | null;
  due?: string | null;
  /**
   * Показывать ли всё, что было.
   *
   * По умолчанию нет: реестр открывается рабочим списком — живые задачи в живых
   * проектах. Включённый флаг снимает ОБА ограничения сразу: и «только незакрытые»,
   * и «только неархивные проекты». Это одно человеческое действие — «покажи и то,
   * что уже сделано», — и разводить его на два переключателя незачем.
   */
  closed?: boolean;
  sort?: string | null;
  /** Направление сортировки по столбцу: `asc` — А→Я и раньше→позже, `desc` — наоборот. */
  dir?: string | null;
  page?: number | null;
  /**
   * Конец «сегодня» у ЧЕЛОВЕКА, ISO-строкой с клиента. День на сервере и день у
   * пользователя — разные сутки, и «просрочено» без этого считается неверно.
   */
  dayEnd: string;
}

export interface RegistryQuery {
  /** Готовое тело WHERE без слова WHERE. */
  where: string;
  /** ORDER BY без слова ORDER BY. */
  orderBy: string;
  params: unknown[];
  limit: number;
  offset: number;
}

export const REGISTRY_PAGE_SIZE = 50;

const SCOPES: RegistryScope[] = ['doing', 'helping', 'mine', 'delegated', 'watching', 'all'];
const DUES: RegistryDue[] = ['any', 'overdue', 'today', 'week', 'none'];
const SORTS: RegistrySort[] = [
  'deadline', 'created', 'updated', 'priority', 'project',
  'title', 'status', 'assignee', 'manager',
];
const PRIORITIES = ['urgent', 'high', 'normal', 'low'];

export function normalizeScope(value?: string | null): RegistryScope {
  return SCOPES.includes(value as RegistryScope) ? (value as RegistryScope) : 'doing';
}

/**
 * Несколько ролей сразу: «делаю» + «поручил» + «помогаю» + «наблюдаю».
 *
 * Заказчик попросил выбирать роли галочками, а не по одной вкладке: человек хочет
 * видеть свою работу целиком, а не переключаться между четырьмя списками. Приходит
 * это строкой через запятую — так срез остаётся в адресе и ссылкой делятся как есть.
 *
 * Неизвестные слова молча отбрасываем, пустой список превращаем в «делаю»: пустой
 * экран вместо задач человек читает как поломку.
 */
export function normalizeScopes(value?: string | null): RegistryScope[] {
  const parts = String(value ?? '').split(',').map((x) => x.trim()).filter(Boolean);
  const known = parts.filter((x): x is RegistryScope => SCOPES.includes(x as RegistryScope));
  const unique = [...new Set(known)];
  // «Все задачи компании» шире любой роли — при нём остальные галочки не нужны.
  if (unique.includes('all')) return ['all'];
  return unique.length ? unique : ['doing'];
}

function normalizeDue(value?: string | null): RegistryDue {
  return DUES.includes(value as RegistryDue) ? (value as RegistryDue) : 'any';
}

function normalizeSort(value?: string | null): RegistrySort {
  return SORTS.includes(value as RegistrySort) ? (value as RegistrySort) : 'deadline';
}

function normalizeDir(value?: string | null): RegistryDir {
  return value === 'desc' ? 'desc' : 'asc';
}

/**
 * Срез по моей роли в задаче.
 *
 * `mine` — и то, что делаю сам, и то, где я соисполнитель: работу делает человек, а не
 * поле в таблице, и видеть её он должен у себя. `delegated` — поставленное мной другим;
 * своя же задача, поставленная себе, живёт в «Мне» и дублироваться не должна.
 */
/* eslint-disable-next-line complexity */
function scopeCondition(scope: RegistryScope): string {
  const participant = (role: string) => `EXISTS (
      SELECT 1 FROM task_participants tp
       WHERE tp.tenant_id = t.tenant_id AND tp.task_id = t.id
         AND tp.user_id = $2 AND tp.role = '${role}')`;
  switch (scope) {
    case 'doing':
      return `t.assignee_id = $2`;
    case 'helping':
      return participant('co_assignee');
    // старое название среза: и своё, и то, где помогаю
    case 'mine':
      return `(t.assignee_id = $2 OR ${participant('co_assignee')})`;
    case 'delegated':
      return `(t.created_by = $2 AND (t.assignee_id IS NULL OR t.assignee_id <> $2))`;
    case 'watching':
      return participant('watcher');
    // `all` — весь тенант: проекты у нас видны всем сотрудникам, клиента в этот
    // контроллер не пускает роль.
    default:
      return 'TRUE';
  }
}

/**
 * Сортировка. Завершённые всегда уезжают в конец: даже когда их специально показали,
 * работа впереди истории. Задачи без срока в сортировке по сроку — тоже в конце, иначе
 * NULL'ы в Postgres встают первыми и закрывают собой всё срочное.
 */
function orderClause(sort: RegistrySort, dir: RegistryDir): string {
  const priority = `CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END`;
  const tail = `${priority}, t.created_at DESC`;
  /*
    Сортировка по столбцу.

    `lower()` — потому что «Актуализировать» и «актуализировать» для человека одно и то
    же слово, а без него строчные уезжают за прописные отдельной пачкой. Пустые клетки
    (нет исполнителя, нет срока) всегда в конце: в начале списка они закрывают собой то,
    ради чего в реестр и заходят.
  */
  const by = (expr: string) => `t.closed_at IS NOT NULL, ${expr} ${dir.toUpperCase()} NULLS LAST, ${tail}`;
  switch (sort) {
    case 'title':
      return by('lower(t.title)');
    case 'status':
      return by('lower(bc.name)');
    case 'assignee':
      return by('lower(ua.full_name)');
    case 'manager':
      return by('lower(um.full_name)');
    case 'created':
      return `t.closed_at IS NOT NULL, t.created_at DESC`;
    case 'updated':
      return `t.closed_at IS NOT NULL, t.updated_at DESC`;
    case 'priority':
      return `t.closed_at IS NOT NULL, ${priority}, t.deadline_at IS NULL, t.deadline_at ASC, t.created_at DESC`;
    case 'project':
      return by('lower(p.name)');
    default:
      // Срок: по возрастанию — ближайший первым; по убыванию — самый дальний.
      return `t.closed_at IS NOT NULL, t.deadline_at ${dir.toUpperCase()} NULLS LAST, ${tail}`;
  }
}

/**
 * Собрать выборку реестра.
 *
 * $1 — организация, $2 — пользователь, $3 — конец его «сегодня»: эти три есть всегда,
 * на них опираются срез и отбор по сроку. Остальные фильтры дописывают параметры дальше.
 */
export function buildRegistry(tenantId: string, userId: string, f: RegistryFilters): RegistryQuery {
  const scopes = normalizeScopes(f.scope);
  const due = normalizeDue(f.due);
  const params: unknown[] = [tenantId, userId, f.dayEnd];
  // Роли объединяются через ИЛИ: задача попадает в список, если человек в ней
  // хоть кто-то из отмеченного.
  const where: string[] = ['t.tenant_id = $1', `(${scopes.map(scopeCondition).join(' OR ')})`];

  // Рабочий список — только живое: незакрытые задачи в неархивных проектах. Архивные
  // проекты иначе всплывали бы в каждом фильтре. Сняли «В работе» — показываем всё,
  // что было: и завершённое, и то, что уехало в архив вместе с проектом.
  if (!f.closed) {
    where.push(`p.status <> 'archived'`);
    where.push('t.closed_at IS NULL');
  }

  const add = (value: unknown): string => {
    params.push(value);
    return `$${params.length}`;
  };

  if (f.projectId) where.push(`t.project_id = ${add(f.projectId)}`);

  if (f.assigneeId === 'none') where.push('t.assignee_id IS NULL');
  else if (f.assigneeId) where.push(`t.assignee_id = ${add(f.assigneeId)}`);

  if (f.priority && PRIORITIES.includes(f.priority)) where.push(`t.priority = ${add(f.priority)}`);

  // Границы дня считаем от присланного конца суток: начало «сегодня» — минус день,
  // конец недели — плюс семь. Второй параметр под это заводить незачем.
  if (due === 'overdue') where.push(`t.deadline_at IS NOT NULL AND t.deadline_at < $3::timestamptz - interval '1 day'`);
  else if (due === 'today') {
    where.push(`t.deadline_at IS NOT NULL
      AND t.deadline_at >= $3::timestamptz - interval '1 day' AND t.deadline_at <= $3::timestamptz`);
  } else if (due === 'week') {
    where.push(`t.deadline_at IS NOT NULL
      AND t.deadline_at >= $3::timestamptz - interval '1 day' AND t.deadline_at <= $3::timestamptz + interval '7 days'`);
  } else if (due === 'none') where.push('t.deadline_at IS NULL');

  const q = (f.q ?? '').trim();
  if (q) {
    // Номер задачи — то, чем люди обмениваются в переписке («глянь 1232»), поэтому
    // целое число ищем и как номер тоже. ILIKE-обёртку строим параметром: подстановка
    // текста в шаблон открыла бы инъекцию.
    const like = add(`%${q}%`);
    const parts = [`t.title ILIKE ${like}`];
    // Ограничение на длину — не придирчивость: число длиннее bigint'а роняет ВЕСЬ
    // запрос ошибкой переполнения, а не просто ничего не находит.
    if (/^\d{1,18}$/.test(q)) parts.push(`t.id = ${add(q)}::bigint`);
    where.push(`(${parts.join(' OR ')})`);
  }

  const page = Math.max(1, Math.trunc(Number(f.page) || 1));
  return {
    where: where.join('\n          AND '),
    orderBy: orderClause(normalizeSort(f.sort), normalizeDir(f.dir)),
    params,
    limit: REGISTRY_PAGE_SIZE,
    offset: (page - 1) * REGISTRY_PAGE_SIZE,
  };
}
