import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '../components/Icon';
import { EmptyState } from '../components/EmptyState';
import { SkeletonList } from '../components/Skeleton';
import { api } from '../lib/api';
import { deadlineBadge, priorityBadge } from '../lib/labels';
import {
  EMPTY_FILTERS, REGISTRY_DUES, REGISTRY_SORTS, RegistryFilters, RegistryScope, ROLE_TABS,
  SortColumn, activeFilterCount, emptyHint, nextSortState, pageWindow, rangeLabel,
  registryQuery, scopeHint, sortMark,
} from '../lib/task-registry-view';
import type { Project } from '../types';

/**
 * Реестр задач — «покажи ВСЁ».
 *
 * Зачем отдельный экран, когда есть «Фокус дня» и доски. «Фокус» отвечает на вопрос
 * «что делать сегодня» и потому узок намеренно: только открытое, только со сроком, без
 * истории и фильтров. Доска отвечает «что происходит в ЭТОМ проекте». А вопрос «всё,
 * что я поставил по всем проектам, включая закрытое» до сих пор не имел ответа: люди
 * искали задачи, обходя доски по одной.
 *
 * Почему список, а не карточки: реестр просматривают глазами по столбцам — срок,
 * исполнитель, проект. Карточки хороши, когда их десяток, и разваливаются на сотне.
 *
 * Фильтры считает сервер (task-registry на бэкенде), а не клиент: отбирать на клиенте
 * можно, пока задач тысяча, и нельзя, когда их сто тысяч — а расходятся эти два случая
 * молча, «подвисанием на большом проекте».
 *
 * Срез живёт в адресе (/tasks/delegated), остальные фильтры — в состоянии экрана.
 * Так ссылкой делятся вкладкой, а не чьим-то временным отбором.
 */

type Row = Awaited<ReturnType<typeof api.taskRegistry>>['items'][number];

const PRIORITIES = [
  { key: '', label: 'Любой приоритет' },
  { key: 'urgent', label: 'Срочный' },
  { key: 'high', label: 'Высокий' },
  { key: 'normal', label: 'Обычный' },
  { key: 'low', label: 'Низкий' },
];

/**
 * Заголовок столбца, который сортирует.
 *
 * Стрелка показывает не «куда нажать», а текущий порядок — иначе после перезагрузки
 * непонятно, почему список выглядит именно так. `aria-sort` говорит то же самое тем,
 * кто читает экран с голоса.
 */
function SortHead({ column, label, filters, onSort }: {
  column: SortColumn;
  label: string;
  filters: { sort: string; dir: 'asc' | 'desc' };
  onSort: (column: SortColumn) => void;
}) {
  const mark = sortMark(filters, column);
  return (
    <span role="columnheader" aria-sort={mark === 'asc' ? 'ascending' : mark === 'desc' ? 'descending' : 'none'}>
      <button
        className={`registry-sort${mark ? ' on' : ''}`}
        onClick={() => onSort(column)}
        title={mark === 'asc' ? 'Сейчас А→Я, нажмите для Я→А' : mark === 'desc' ? 'Сейчас Я→А, нажмите для обычного порядка' : `Сортировать по столбцу «${label}»`}
      >
        {label}
        <Icon name={mark === 'desc' ? 'chevron-down' : 'chevron-up'} size={12} />
      </button>
    </span>
  );
}

/** Короткая дата: в списке нужен день и месяц, год — только если он не этот. */
function shortDate(iso?: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  const opts: Intl.DateTimeFormatOptions = d.getFullYear() === new Date().getFullYear()
    ? { day: 'numeric', month: 'short' }
    : { day: 'numeric', month: 'short', year: '2-digit' };
  return new Intl.DateTimeFormat('ru-RU', opts).format(d);
}

export function TasksPage({ active, scope, onScope, onOpenTask, onNewTask, onVoiceTask }: {
  active: boolean;
  scope: RegistryScope;
  onScope: (scope: RegistryScope) => void;
  onOpenTask: (projectId: string, taskId: string) => void;
  /** Поставить задачу отсюда: текстом или голосом. Окно живёт в приложении. */
  onNewTask?: () => void;
  onVoiceTask?: () => void;
}) {
  const [filters, setFilters] = useState<RegistryFilters>({ ...EMPTY_FILTERS, scope });
  const [rows, setRows] = useState<Row[]>([]);
  const [meta, setMeta] = useState({ total: 0, page: 1, pageSize: 50, pages: 1 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [people, setPeople] = useState<{ id: string; full_name: string }[]>([]);
  const [filtersOpen, setFiltersOpen] = useState(false);

  // Срез приходит из адреса: по ссылке /tasks/delegated экран обязан открыться на
  // «От меня», а не на том, что было выбрано в прошлый раз.
  useEffect(() => {
    setFilters((f) => (f.scope === scope ? f : { ...f, scope, page: 1 }));
  }, [scope]);

  /**
   * Загрузка страницы реестра.
   *
   * Ответы нумеруются: при быстром наборе в поиске запросы возвращаются не в том
   * порядке, в каком ушли, и без счётчика на экране оседает результат предыдущей
   * строки поиска. Ровно этот баг мы ловили в поиске по чатам.
   */
  const seq = useRef(0);
  const load = useCallback(async (f: RegistryFilters) => {
    const mine = ++seq.current;
    setLoading(true);
    try {
      const res = await api.taskRegistry(registryQuery(f));
      if (mine !== seq.current) return;
      // Страница могла опустеть, пока человек на ней стоял: задачи закрыли или
      // перенесли в архивный проект. Пустая пятая страница — тупик: кнопок
      // постраничности при total=0 больше нет, и вернуться нечем.
      if (res.total === 0 && f.page > 1) {
        setFilters((cur) => ({ ...cur, page: 1 }));
        return;
      }
      setRows(res.items);
      setMeta({ total: res.total, page: res.page, pageSize: res.pageSize, pages: res.pages });
      setError(null);
    } catch {
      if (mine !== seq.current) return;
      setError('Не удалось загрузить задачи. Проверьте связь и попробуйте ещё раз.');
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, []);

  // Поиск ждёт, пока человек допечатает: запрос на каждую букву — это и лишняя
  // нагрузка, и мигание списка под пальцами. Остальные фильтры применяются сразу.
  const q = filters.q;
  const [debouncedQ, setDebouncedQ] = useState(q);
  useEffect(() => {
    const id = window.setTimeout(() => setDebouncedQ(q), 300);
    return () => window.clearTimeout(id);
  }, [q]);

  const request = useMemo(() => ({ ...filters, q: debouncedQ }), [filters, debouncedQ]);

  useEffect(() => {
    if (!active) return;
    void load(request);
  }, [active, request, load]);

  // Справочники для фильтров грузим один раз при первом открытии раздела.
  useEffect(() => {
    if (!active || projects.length > 0) return;
    void api.listProjects().then(setProjects).catch(() => {});
    void api.taskRegistryAssignees().then(setPeople).catch(() => {});
  }, [active, projects.length]);

  /** Любая правка фильтра возвращает на первую страницу: иначе «пусто» на пятой. */
  const patch = (part: Partial<RegistryFilters>) => setFilters((f) => ({ ...f, ...part, page: 1 }));

  // «Задачи сотрудника» из сайдбара чата: реестр открывается уже с фильтром по
  // исполнителю. Событием, а не адресом — фильтров в адресе у реестра нет.
  useEffect(() => {
    const onTasksOf = (e: Event) => {
      const userId = (e as CustomEvent<{ userId: string }>).detail?.userId;
      if (!userId) return;
      onScope('all');
      setFilters((f) => ({ ...f, scope: 'all', assigneeId: String(userId), page: 1 }));
    };
    window.addEventListener('teamcrm:tasks-of', onTasksOf);
    return () => window.removeEventListener('teamcrm:tasks-of', onTasksOf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Отмеченные роли: срез приходит строкой через запятую и остаётся в адресе. */
  const picked = String(filters.scope ?? 'all').split(',').filter(Boolean) as RegistryScope[];
  const setScopes = (next: RegistryScope[]) => {
    // Снять все галочки нельзя: пустой экран человек читает как поломку, а не
    // как «вы ничего не выбрали». Без единой роли — все задачи, как при входе.
    const value = (next.length ? next : ['all']).join(',');
    onScope(value as RegistryScope);
    patch({ scope: value as RegistryScope });
  };
  const toggleRole = (key: RegistryScope, on: boolean) => {
    const base = picked.filter((k) => k !== 'all');
    setScopes(on ? [...base, key] : base.filter((k) => k !== key));
  };
  const toggleAll = (on: boolean) => setScopes(on ? ['all'] : ROLE_TABS.map((t) => t.key));
  const filterCount = activeFilterCount(request);
  const showWho: 'assignee' | 'manager' = picked.length === 1 && picked[0] === 'delegated' ? 'assignee' : 'manager';
  /*
    Нажали по заголовку столбца. Страницу сбрасываем на первую: человек сменил порядок
    и ждёт начало списка, а не тридцатую страницу прежнего.
  */
  const sortBy = (column: SortColumn) => setFilters((f) => ({ ...f, ...nextSortState(f, column), page: 1 }));

  return (
    <div className="page registry-page">
      <header className="registry-head">
        <div className="registry-title">
          <h1>Задачи</h1>
          <span className="registry-sub">{scopeHint(picked)}</span>
        </div>
        {/*
          Поставить задачу — прямо отсюда.

          Раньше единственная кнопка постановки стояла в левой панели; заказчик убрал
          её оттуда и попросил ставить задачи там, где они живут. Реестр — одно из
          двух таких мест (второе — доска проекта).
        */}
        {(onNewTask || onVoiceTask) && (
          <span className="registry-create">
            {onNewTask && (
              <button className="btn btn-primary btn-sm" onClick={onNewTask} title="Новая задача — текстом (клавиша C)">
                <Icon name="plus" size={15} /> Новая задача
              </button>
            )}
            {onVoiceTask && (
              <button className="btn btn-primary btn-sm" onClick={onVoiceTask} title="Продиктовать задачу голосом" aria-label="Продиктовать задачу голосом">
                <Icon name="mic" size={15} />
              </button>
            )}
          </span>
        )}
        {/*
          Роли — ГАЛОЧКАМИ, а не вкладками.

          Вкладки заставляли смотреть свою работу по четырём спискам: «делаю»,
          «поручил», «помогаю», «наблюдаю». Человек хочет видеть её целиком, поэтому
          по умолчанию отмечены все четыре, а снимая галочку, он сужает список.

          «Все задачи компании» стоит особняком: это другой вопрос — чужая работа,
          а не моя роль в ней. Поэтому он выключает роли, а не складывается с ними.
        */}
        <nav className="registry-roles" aria-label="Мои роли в задачах">
          {ROLE_TABS.map((t) => (
            <label key={t.key} className={`registry-role${picked.includes(t.key) ? ' active' : ''}`} title={t.hint}>
              <input
                type="checkbox"
                checked={picked.includes(t.key)}
                onChange={(e) => toggleRole(t.key, e.target.checked)}
              />
              {t.label}
            </label>
          ))}
          <button
            className={`registry-tab${picked.includes('all') ? ' active' : ''}`}
            title="Все задачи компании во всех проектах, включая чужие"
            onClick={() => toggleAll(!picked.includes('all'))}
          >
            Все задачи
          </button>
        </nav>
      </header>

      <div className="registry-bar">
        <label className="registry-search">
          <Icon name="search" size={15} />
          <input
            value={filters.q}
            placeholder="Поиск по названию или номеру задачи…"
            aria-label="Поиск по задачам"
            onChange={(e) => patch({ q: e.target.value })}
          />
          {filters.q && (
            <button className="registry-clear" title="Очистить" onClick={() => patch({ q: '' })}>
              <Icon name="close" size={14} />
            </button>
          )}
        </label>

        {/*
          Фильтры на узком экране убираются под кнопку, но НЕ прячутся за наведение:
          спрятанный до наведения элемент не существует — ни на телефоне, ни для того,
          кто просто не догадался туда навести.
        */}
        <button
          className={`btn btn-sm registry-toggle${filtersOpen ? ' active' : ''}`}
          onClick={() => setFiltersOpen((v) => !v)}
        >
          <Icon name="filter" size={14} /> Фильтры{filterCount > 0 ? ` (${filterCount})` : ''}
        </button>

        <span className="registry-count">{loading ? 'Загрузка…' : rangeLabel(meta.page, meta.pageSize, meta.total)}</span>
      </div>

      <div className={`registry-filters${filtersOpen ? ' open' : ''}`}>
        <select value={filters.projectId} onChange={(e) => patch({ projectId: e.target.value })} aria-label="Проект">
          <option value="">Все проекты</option>
          {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>

        <select value={filters.assigneeId} onChange={(e) => patch({ assigneeId: e.target.value })} aria-label="Исполнитель">
          <option value="">Любой исполнитель</option>
          <option value="none">Без исполнителя</option>
          {people.map((u) => <option key={u.id} value={u.id}>{u.full_name}</option>)}
        </select>

        <select value={filters.priority} onChange={(e) => patch({ priority: e.target.value })} aria-label="Приоритет">
          {PRIORITIES.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
        </select>

        <select value={filters.due} onChange={(e) => patch({ due: e.target.value })} aria-label="Срок">
          {REGISTRY_DUES.map((d) => <option key={d.key} value={d.key}>{d.label}</option>)}
        </select>

        <select value={filters.sort} onChange={(e) => patch({ sort: e.target.value })} aria-label="Сортировка">
          {REGISTRY_SORTS.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
        </select>

        {/*
          «В работе» — главный переключатель списка, поэтому он выглядит как кнопка,
          а не как галочка среди фильтров. Включён: только живая работа. Выключен:
          видно всё, что было, — завершённое и задачи из архивных проектов.
        */}
        <button
          className={`btn btn-sm registry-inwork${filters.inWork ? ' active' : ''}`}
          onClick={() => patch({ inWork: !filters.inWork })}
          aria-pressed={filters.inWork}
          title={filters.inWork
            ? 'Показаны только задачи в работе. Выключите, чтобы увидеть завершённые и архив'
            : 'Показано всё, включая завершённое и архивные проекты'}
        >
          <Icon name={filters.inWork ? 'play' : 'archive'} size={14} />
          {filters.inWork ? 'В работе' : 'Всё, включая архив'}
        </button>

        {filterCount > 0 && (
          <button className="btn btn-sm" onClick={() => setFilters({ ...EMPTY_FILTERS, scope: filters.scope })}>
            Сбросить
          </button>
        )}
      </div>

      {error && <div className="error-text">{error}</div>}

      {loading && rows.length === 0 && <SkeletonList rows={8} />}

      {!loading && rows.length === 0 && !error && (
        <EmptyState icon="check-circle" title="Задач нет" hint={emptyHint(picked[0] ?? 'doing', filterCount > 0)} />
      )}

      {rows.length > 0 && (
        <div className="registry-list" role="table">
          {/*
            Шапка сортирует нажатием (просьба заказчика): А→Я, Я→А, обычный порядок.
            Считает сервер — сортировать на клиенте нельзя, на экране лишь страница из
            пятидесяти строк, и «по алфавиту» получилось бы в пределах страницы.
          */}
          <div className="registry-row registry-header" role="row">
            <SortHead column="title" label="Задача" filters={filters} onSort={sortBy} />
            <SortHead column="project" label="Проект" filters={filters} onSort={sortBy} />
            <SortHead column="status" label="Статус" filters={filters} onSort={sortBy} />
            <SortHead
              column={showWho === 'assignee' ? 'assignee' : 'manager'}
              label={showWho === 'assignee' ? 'Исполнитель' : 'Постановщик'}
              filters={filters}
              onSort={sortBy}
            />
            <SortHead column="deadline" label="Срок" filters={filters} onSort={sortBy} />
          </div>
          {rows.map((t) => {
            const prio = priorityBadge(t.priority);
            const due = deadlineBadge(t.deadline_at, !!t.closed_at);
            const who = showWho === 'assignee' ? t.assignee_name : t.manager_name;
            return (
              <button
                key={t.id}
                role="row"
                className={`registry-row${t.overdue ? ' late' : ''}${t.closed_at ? ' done' : ''}`}
                onClick={() => onOpenTask(String(t.project_id), String(t.id))}
              >
                <span className="registry-cell-title" role="cell">
                  {/*
                    Красная точка — только по МОИМ задачам: так решено заказчиком, и это
                    правильно. В YouGile краснеет вся доска, и через неделю на счётчики
                    перестают смотреть.
                  */}
                  {t.unread > 0 && <span className="registry-new" title={`Новых событий: ${t.unread}`}>{t.unread}</span>}
                  <span className="registry-name">{t.title}</span>
                  <span className="registry-id">#{t.id}</span>
                  {t.closed_at && <span className="badge badge-ok">Завершена</span>}
                  {prio && <span className={prio.cls}>{prio.text}</span>}
                </span>
                <span className="registry-cell-dim" role="cell">{t.project_name}</span>
                <span className="registry-cell-dim" role="cell">{t.column_name}</span>
                <span className="registry-cell-who" role="cell">
                  {who ? (
                    <>
                      <span className="avatar-xs avatar-ph">{who[0]?.toUpperCase()}</span>
                      <span className="registry-who-name">{who}</span>
                    </>
                  ) : (
                    <span className="registry-nobody">не назначен</span>
                  )}
                </span>
                <span className="registry-cell-due" role="cell">
                  {due
                    ? <span className={due.cls} title={due.title}>{due.text}</span>
                    : <span className="registry-nobody">{shortDate(t.deadline_at) || 'без срока'}</span>}
                </span>
              </button>
            );
          })}
        </div>
      )}

      {meta.pages > 1 && (
        <nav className="registry-pages" aria-label="Страницы">
          <button
            className="btn btn-sm"
            disabled={meta.page <= 1}
            onClick={() => setFilters((f) => ({ ...f, page: f.page - 1 }))}
          >
            <Icon name="chevron-left" size={14} /> Назад
          </button>
          {pageWindow(meta.page, meta.pages).map((n, i) => (
            n === 0
              ? <span key={`gap${i}`} className="registry-gap">…</span>
              : (
                <button
                  key={n}
                  className={`registry-page${n === meta.page ? ' active' : ''}`}
                  aria-current={n === meta.page ? 'page' : undefined}
                  onClick={() => setFilters((f) => ({ ...f, page: n }))}
                >
                  {n}
                </button>
              )
          ))}
          <button
            className="btn btn-sm"
            disabled={meta.page >= meta.pages}
            onClick={() => setFilters((f) => ({ ...f, page: f.page + 1 }))}
          >
            Далее <Icon name="chevron-right" size={14} />
          </button>
        </nav>
      )}
    </div>
  );
}
