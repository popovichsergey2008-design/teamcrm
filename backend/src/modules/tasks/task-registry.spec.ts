import { buildRegistry, normalizeScope, REGISTRY_PAGE_SIZE } from './task-registry';

/**
 * Условия выборки ошибаются молча: потерянный срез покажет чужие задачи, сбитая
 * нумерация $-параметров подставит срок в поле проекта. Ни то, ни другое не роняет
 * запрос — видно только по неверному списку на экране. Поэтому проверяем сборку.
 */

const DAY_END = '2026-09-03T20:59:59.000Z';
const base = { dayEnd: DAY_END };

describe('buildRegistry: срезы', () => {
  it('«Мне» — и исполнитель, и соисполнитель', () => {
    const q = buildRegistry('1', '7', { ...base, scope: 'mine' });
    expect(q.where).toContain('t.assignee_id = $2');
    expect(q.where).toContain("tp.role = 'co_assignee'");
  });

  it('«От меня» не включает задачи, поставленные самому себе', () => {
    const q = buildRegistry('1', '7', { ...base, scope: 'delegated' });
    expect(q.where).toContain('t.created_by = $2');
    expect(q.where).toContain('t.assignee_id <> $2');
  });

  it('«Наблюдаю» — только участие наблюдателем', () => {
    const q = buildRegistry('1', '7', { ...base, scope: 'watching' });
    expect(q.where).toContain("tp.role = 'watcher'");
    expect(q.where).not.toContain('t.assignee_id = $2');
  });

  it('«Все» не ограничивает роль, но остаётся внутри организации', () => {
    const q = buildRegistry('1', '7', { ...base, scope: 'all' });
    expect(q.where).toContain('t.tenant_id = $1');
    expect(q.where).not.toContain('$2');
  });

  it('неизвестный срез — это «Мне», а не «все задачи компании»', () => {
    expect(normalizeScope('everything')).toBe('mine');
    expect(normalizeScope(null)).toBe('mine');
    expect(normalizeScope('all')).toBe('all');
  });
});

describe('buildRegistry: фильтры', () => {
  it('по умолчанию завершённые скрыты, архивные проекты — всегда', () => {
    const q = buildRegistry('1', '7', base);
    expect(q.where).toContain('t.closed_at IS NULL');
    expect(q.where).toContain("p.status <> 'archived'");
  });

  it('завершённые показываются по явному флагу', () => {
    const q = buildRegistry('1', '7', { ...base, closed: true });
    expect(q.where).not.toContain('t.closed_at IS NULL');
  });

  it('«без исполнителя» — это IS NULL, а не сравнение со строкой', () => {
    const q = buildRegistry('1', '7', { ...base, assigneeId: 'none' });
    expect(q.where).toContain('t.assignee_id IS NULL');
    expect(q.params).toEqual(['1', '7', DAY_END]);
  });

  it('фильтры подставляются параметрами и нумеруются по порядку', () => {
    const q = buildRegistry('1', '7', { ...base, projectId: '12', assigneeId: '9', priority: 'high' });
    expect(q.where).toContain('t.project_id = $4');
    expect(q.where).toContain('t.assignee_id = $5');
    expect(q.where).toContain('t.priority = $6');
    expect(q.params).toEqual(['1', '7', DAY_END, '12', '9', 'high']);
  });

  it('выдуманный приоритет не попадает в запрос', () => {
    const q = buildRegistry('1', '7', { ...base, priority: 'сверхсрочно' });
    expect(q.where).not.toContain('t.priority');
    expect(q.params).toHaveLength(3);
  });

  it('сроки считаются от присланного конца суток', () => {
    expect(buildRegistry('1', '7', { ...base, due: 'overdue' }).where)
      .toContain("t.deadline_at < $3::timestamptz - interval '1 day'");
    expect(buildRegistry('1', '7', { ...base, due: 'week' }).where)
      .toContain("interval '7 days'");
    expect(buildRegistry('1', '7', { ...base, due: 'none' }).where)
      .toContain('t.deadline_at IS NULL');
    // «any» не должен дописывать условий по сроку вообще
    expect(buildRegistry('1', '7', { ...base, due: 'any' }).where).not.toContain('deadline_at');
  });
});

describe('buildRegistry: поиск', () => {
  it('текст ищется по названию параметром, а не подстановкой', () => {
    const q = buildRegistry('1', '7', { ...base, q: "макет'; DROP" });
    expect(q.where).toContain('t.title ILIKE $4');
    expect(q.where).not.toContain('DROP');
    expect(q.params[3]).toBe("%макет'; DROP%");
  });

  it('целое число ищется ещё и как номер задачи', () => {
    const q = buildRegistry('1', '7', { ...base, q: '1232' });
    expect(q.where).toContain('t.id = $5::bigint');
    expect(q.params).toEqual(['1', '7', DAY_END, '%1232%', '1232']);
  });

  it('число длиннее bigint по номеру не ищется — иначе переполнение роняет запрос', () => {
    const q = buildRegistry('1', '7', { ...base, q: '1'.repeat(25) });
    expect(q.where).not.toContain('::bigint');
  });

  it('пробелы поиском не считаются', () => {
    expect(buildRegistry('1', '7', { ...base, q: '   ' }).where).not.toContain('ILIKE');
  });
});

describe('buildRegistry: сортировка и страницы', () => {
  it('завершённые всегда в конце, задачи без срока — тоже', () => {
    const q = buildRegistry('1', '7', base);
    expect(q.orderBy.startsWith('t.closed_at IS NOT NULL')).toBe(true);
    expect(q.orderBy).toContain('t.deadline_at IS NULL');
  });

  it('сортировка по проекту идёт по имени, а не по идентификатору', () => {
    expect(buildRegistry('1', '7', { ...base, sort: 'project' }).orderBy).toContain('p.name ASC');
  });

  it('неизвестная сортировка — по сроку', () => {
    expect(buildRegistry('1', '7', { ...base, sort: 'rand()' }).orderBy)
      .toBe(buildRegistry('1', '7', base).orderBy);
  });

  it('страницы считаются от единицы, мусор не уводит в отрицательный сдвиг', () => {
    expect(buildRegistry('1', '7', base).offset).toBe(0);
    expect(buildRegistry('1', '7', { ...base, page: 3 }).offset).toBe(2 * REGISTRY_PAGE_SIZE);
    expect(buildRegistry('1', '7', { ...base, page: -5 }).offset).toBe(0);
    expect(buildRegistry('1', '7', { ...base, page: 1.7 }).offset).toBe(0);
  });
});
