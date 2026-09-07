import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '../components/Icon';
import { EmptyState } from '../components/EmptyState';
import { SkeletonList } from '../components/Skeleton';
import { api } from '../lib/api';
import { deadlineBadge, priorityBadge } from '../lib/labels';
import {
  EMPTY_FILTERS, REGISTRY_DUES, REGISTRY_SORTS, REGISTRY_TABS, RegistryFilters, RegistryScope,
  activeFilterCount, emptyHint, pageWindow, rangeLabel, registryQuery,
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

/** Короткая дата: в списке нужен день и месяц, год — только если он не этот. */
function shortDate(iso?: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  const opts: Intl.DateTimeFormatOptions = d.getFullYear() === new Date().getFullYear()
    ? { day: 'numeric', month: 'short' }
    : { day: 'numeric', month: 'short', year: '2-digit' };
  return new Intl.DateTimeFormat('ru-RU', opts).format(d);
}

export function TasksPage({ active, scope, onScope, onOpenTask }: {
  active: boolean;
  scope: RegistryScope;
  onScope: (scope: RegistryScope) => void;
  onOpenTask: (projectId: string, taskId: string) => void;
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

  const tab = REGISTRY_TABS.find((t) => t.key === filters.scope) ?? REGISTRY_TABS[0];
  const filterCount = activeFilterCount(request);
  const showWho: 'assignee' | 'manager' = filters.scope === 'delegated' ? 'assignee' : 'manager';

  return (
    <div className="page registry-page">
      <header className="registry-head">
        <div className="registry-title">
          <h1>Задачи</h1>
          <span className="registry-sub">{tab.hint}</span>
        </div>
        <nav className="registry-tabs" role="tablist">
          {REGISTRY_TABS.map((t) => (
            <button
              key={t.key}
              role="tab"
              aria-selected={t.key === filters.scope}
              className={`registry-tab${t.key === filters.scope ? ' active' : ''}`}
              title={t.hint}
              onClick={() => { onScope(t.key); patch({ scope: t.key }); }}
            >
              {t.label}
            </button>
          ))}
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
        <EmptyState icon="check-circle" title="Задач нет" hint={emptyHint(filters.scope, filterCount > 0)} />
      )}

      {rows.length > 0 && (
        <div className="registry-list" role="table">
          <div className="registry-row registry-header" role="row">
            <span role="columnheader">Задача</span>
            <span role="columnheader">Проект</span>
            <span role="columnheader">Статус</span>
            <span role="columnheader">{showWho === 'assignee' ? 'Исполнитель' : 'Постановщик'}</span>
            <span role="columnheader">Срок</span>
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
