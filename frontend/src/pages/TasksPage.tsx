import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '../components/Icon';
import { navigate } from '../lib/router';
import { forgetProject } from '../lib/last-project';
import { Avatar } from '../components/ui/avatar';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Select } from '../components/ui/select';
import { Skeleton } from '../components/ui/skeleton';
import { Spinner } from '../components/ui/spinner';
import { Toggle } from '../components/ui/toggle';
import { Tooltip } from '../components/ui/tooltip';
import { api, TagItem } from '../lib/api';
import { deadlineBadge, labelTextColor, priorityBadge } from '../lib/labels';
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

const PRIORITY_OPTIONS = [
  { value: '', label: 'Любой приоритет' },
  { value: 'urgent', label: 'Срочный' },
  { value: 'high', label: 'Высокий' },
  { value: 'normal', label: 'Обычный' },
  { value: 'low', label: 'Низкий' },
];
const DUE_OPTIONS = REGISTRY_DUES.map((d) => ({ value: d.key, label: d.label }));
const SORT_OPTIONS = REGISTRY_SORTS.map((d) => ({ value: d.key, label: d.label }));

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
        className="ui-sort"
        data-active={mark ? '' : undefined}
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
  /** Теги компании — для фильтра и плашек в строках. */
  const [tags, setTags] = useState<TagItem[]>([]);
  useEffect(() => { api.listTags().then((r) => setTags(r.items)).catch(() => setTags([])); }, []);

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

  const projectOptions = useMemo(
    () => [{ value: '', label: 'Все проекты' }, ...projects.map((p) => ({ value: String(p.id), label: p.name }))],
    [projects],
  );
  const peopleOptions = useMemo(
    () => [
      { value: '', label: 'Любой исполнитель' },
      { value: 'none', label: 'Без исполнителя' },
      ...people.map((u) => ({ value: String(u.id), label: u.full_name })),
    ],
    [people],
  );

  return (
    <div className="ui-page tasks-v2">
      <header className="ui-page-head">
        <div className="ui-page-title">
          <h1>Задачи</h1>
          <span className="ui-page-sub">{scopeHint(picked)}</span>
        </div>
        <div className="ui-page-actions">
          {/* Задачи живут в «Проектах»: обратный путь к таблице проектов — одним нажатием */}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => { forgetProject(); navigate({ section: 'projects' }); }}
            title="Таблица со всеми проектами"
          >
            <Icon name="list" size={15} /> Все проекты
          </Button>
          {/*
            Поставить задачу — прямо отсюда (просьба заказчика: ставить задачи там, где
            они живут). Реестр — одно из двух таких мест, второе — доска проекта.
          */}
          {onVoiceTask && (
            <Tooltip content="Продиктовать задачу голосом">
              <Button variant="outline" size="icon" onClick={onVoiceTask} aria-label="Продиктовать задачу голосом">
                <Icon name="mic" size={16} />
              </Button>
            </Tooltip>
          )}
          {onNewTask && (
            <Button variant="primary" onClick={onNewTask} title="Новая задача — текстом (клавиша C)">
              <Icon name="plus" size={16} /> Новая задача
            </Button>
          )}
        </div>
      </header>

      {/*
        Роли — переключателями, а не вкладками: человек хочет видеть свою работу
        целиком, поэтому по умолчанию включены все четыре, а выключая, он сужает список.
        «Все задачи компании» стоит особняком: это чужая работа, а не моя роль в ней,
        поэтому он выключает роли, а не складывается с ними.
      */}
      <nav className="ui-toolbar" aria-label="Мои роли в задачах">
        {ROLE_TABS.map((t) => (
          <Toggle key={t.key} pressed={picked.includes(t.key)} onPressedChange={(on) => toggleRole(t.key, on)} title={t.hint}>
            {t.label}
          </Toggle>
        ))}
        <span className="tasks-v2-sep" aria-hidden />
        <Toggle
          pressed={picked.includes('all')}
          onPressedChange={(on) => toggleAll(on)}
          title="Все задачи компании во всех проектах, включая чужие"
        >
          <Icon name="building" size={14} /> Все задачи компании
        </Toggle>
      </nav>

      <div className="ui-toolbar">
        <Input
          className="ui-toolbar-grow"
          value={filters.q}
          placeholder="Поиск по названию или номеру…"
          aria-label="Поиск по задачам"
          onChange={(e) => patch({ q: e.target.value })}
          leading={<Icon name="search" size={15} />}
          trailing={filters.q ? (
            <Button variant="ghost" size="icon-sm" aria-label="Очистить поиск" onClick={() => patch({ q: '' })}>
              <Icon name="close" size={14} />
            </Button>
          ) : undefined}
        />
        {/*
          На узком экране фильтры убираются под кнопку, но НЕ прячутся за наведение:
          спрятанного до наведения на телефоне не существует.
        */}
        <Button
          variant="outline"
          className="tasks-v2-filters-btn"
          aria-pressed={filtersOpen}
          onClick={() => setFiltersOpen((v) => !v)}
        >
          <Icon name="filter" size={15} /> Фильтры
          {filterCount > 0 && <Badge tone="info">{filterCount}</Badge>}
        </Button>
        <span className="ui-toolbar-end" aria-live="polite">
          {loading ? <Spinner size={14} label="Загрузка" /> : rangeLabel(meta.page, meta.pageSize, meta.total)}
        </span>
      </div>

      <div className={`ui-toolbar tasks-v2-filters${filtersOpen ? ' open' : ''}`}>
        <Select ariaLabel="Проект" size="sm" value={filters.projectId} onValueChange={(v) => patch({ projectId: v })} options={projectOptions} />
        <Select ariaLabel="Исполнитель" size="sm" value={filters.assigneeId} onValueChange={(v) => patch({ assigneeId: v })} options={peopleOptions} />
        <Select ariaLabel="Приоритет" size="sm" value={filters.priority} onValueChange={(v) => patch({ priority: v })} options={PRIORITY_OPTIONS} />
        <Select ariaLabel="Срок" size="sm" value={filters.due} onValueChange={(v) => patch({ due: v })} options={DUE_OPTIONS} />
        <Select ariaLabel="Сортировка" size="sm" value={filters.sort} onValueChange={(v) => patch({ sort: v })} options={SORT_OPTIONS} />
        {/*
          «В работе» — главный переключатель списка. Включён: только живая работа.
          Выключен: видно всё, что было, — завершённое и задачи из архивных проектов.
        */}
        <Toggle
          pressed={filters.inWork}
          onPressedChange={(on) => patch({ inWork: on })}
          title={filters.inWork
            ? 'Показаны только задачи в работе. Выключите, чтобы увидеть завершённые и архив'
            : 'Показано всё, включая завершённое и архивные проекты'}
        >
          <Icon name={filters.inWork ? 'play' : 'archive'} size={14} />
          {filters.inWork ? 'В работе' : 'Всё, включая архив'}
        </Toggle>
        {filterCount > 0 && (
          <Button variant="ghost" size="sm" onClick={() => setFilters({ ...EMPTY_FILTERS, scope: filters.scope })}>
            <Icon name="close" size={14} /> Сбросить
          </Button>
        )}

        {/*
          Теги отбором «любой из выбранных»: два-три отмечают, чтобы РАСШИРИТЬ выборку,
          а не сузить её до задач, помеченных всеми сразу, — таких обычно нет вовсе.
          Цвета тегов — данные компании, поэтому плашки остаются цветными.
        */}
        {tags.length > 0 && (
          <div className="tasks-v2-tags">
            {tags.slice(0, 12).map((t) => {
              const on = filters.tagIds.includes(String(t.id));
              return (
                <button
                  key={t.id}
                  className={`label-chip ${on ? '' : 'label-off'}`}
                  style={{
                    background: on ? t.color : 'transparent',
                    borderColor: t.color,
                    color: on ? labelTextColor(t.color) : undefined,
                  }}
                  aria-pressed={on}
                  onClick={() => patch({
                    tagIds: on
                      ? filters.tagIds.filter((x) => x !== String(t.id))
                      : [...filters.tagIds, String(t.id)],
                  })}
                >
                  {t.name}
                </button>
              );
            })}
          </div>
        )}
      </div>

      {error && (
        <div className="tasks-v2-error" role="alert">
          <Icon name="alert" size={16} /> {error}
          <Button variant="outline" size="sm" onClick={() => void load(request)}>Повторить</Button>
        </div>
      )}

      <div className="ui-card">
        {loading && rows.length === 0 && (
          <div className="ui-table" aria-busy>
            {Array.from({ length: 8 }, (_, i) => (
              <div key={i} className="ui-row tasks-v2-row" style={{ cursor: 'default' }}>
                <Skeleton width={`${55 + ((i * 17) % 35)}%`} />
                <Skeleton width="70%" /><Skeleton width="60%" /><Skeleton width="75%" /><Skeleton width="55%" /><Skeleton width="40%" />
              </div>
            ))}
          </div>
        )}

        {!loading && rows.length === 0 && !error && (
          <div className="ui-empty">
            <span className="ui-empty-icon"><Icon name="check-circle" size={22} /></span>
            <span className="ui-empty-title">Задач нет</span>
            <span className="ui-empty-hint">{emptyHint(picked[0] ?? 'doing', filterCount > 0)}</span>
            {filterCount > 0 && (
              <Button variant="outline" size="sm" onClick={() => setFilters({ ...EMPTY_FILTERS, scope: filters.scope })}>
                Сбросить фильтры
              </Button>
            )}
          </div>
        )}

        {rows.length > 0 && (
          <div className="ui-table" role="table" aria-busy={loading || undefined}>
            {/*
              Шапка сортирует нажатием: А→Я, Я→А, обычный порядок. Считает сервер —
              на экране лишь страница из пятидесяти строк, и «по алфавиту» на клиенте
              получилось бы в пределах страницы.
            */}
            <div className="ui-row ui-row-head tasks-v2-row" role="row">
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
              <span role="columnheader">Теги</span>
            </div>
            {rows.map((t) => {
              const prio = priorityBadge(t.priority);
              const due = deadlineBadge(t.deadline_at, !!t.closed_at);
              const who = showWho === 'assignee' ? t.assignee_name : t.manager_name;
              return (
                <button
                  key={t.id}
                  role="row"
                  className={`ui-row tasks-v2-row${t.overdue ? ' late' : ''}${t.closed_at ? ' done' : ''}`}
                  onClick={() => onOpenTask(String(t.project_id), String(t.id))}
                >
                  <span className="tasks-v2-title" role="cell">
                    {/*
                      Счётчик новых событий — только по МОИМ задачам (решение заказчика):
                      в YouGile краснеет вся доска, и через неделю на счётчики не смотрят.
                    */}
                    {t.unread > 0 && <span className="tasks-v2-new" title={`Новых событий: ${t.unread}`}>{t.unread}</span>}
                    {t.closed_at && <Icon name="check-circle" size={15} className="tasks-v2-done-icon" />}
                    <span className="tasks-v2-name">{t.title}</span>
                    <span className="tasks-v2-id">#{t.id}</span>
                    {prio && (
                      <Badge tone={prio.tone}>
                        {prio.tone === 'danger' && <Icon name="zap" size={11} />}
                        {prio.tone === 'warn' && <Icon name="arrow-up" size={11} />}
                        {prio.tone === 'neutral' && <Icon name="arrow-down" size={11} />}
                        {prio.label}
                      </Badge>
                    )}
                  </span>
                  <span className="ui-cell ui-cell-dim" role="cell">{t.project_name}</span>
                  <span className="ui-cell" role="cell"><Badge tone="outline">{t.column_name}</Badge></span>
                  <span className="tasks-v2-who" role="cell">
                    {who ? (
                      <>
                        <Avatar name={who} />
                        <span className="ui-cell">{who}</span>
                      </>
                    ) : (
                      <span className="ui-cell-dim">не назначен</span>
                    )}
                  </span>
                  <span className="ui-cell" role="cell">
                    {due
                      ? <Badge tone={due.tone} title={due.title}><Icon name="clock" size={11} />{due.label}</Badge>
                      : <span className="ui-cell-dim">{shortDate(t.deadline_at) || 'без срока'}</span>}
                  </span>
                  {/*
                    Теги плашками, не кнопками: строка сама кнопка, а кнопка в кнопке —
                    ловушка для клавиатуры. Больше двух не показываем: одна задача
                    с шестью тегами растягивала столбец и ломала таблицу.
                  */}
                  <span className="tasks-v2-tags-cell" role="cell">
                    {(t.tags ?? []).slice(0, 2).map((tag) => (
                      <span
                        key={tag.id}
                        className="label-chip label-chip-sm"
                        style={{ background: tag.color, color: labelTextColor(tag.color) }}
                      >
                        {tag.name}
                      </span>
                    ))}
                    {(t.tags?.length ?? 0) > 2 && (
                      <span className="ui-cell-dim" title={(t.tags ?? []).map((x) => x.name).join(', ')}>
                        +{(t.tags?.length ?? 0) - 2}
                      </span>
                    )}
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </div>

      {meta.pages > 1 && (
        <nav className="ui-pages" aria-label="Страницы">
          <Button
            variant="ghost"
            size="sm"
            disabled={meta.page <= 1}
            onClick={() => setFilters((f) => ({ ...f, page: f.page - 1 }))}
          >
            <Icon name="chevron-left" size={15} /> Назад
          </Button>
          {pageWindow(meta.page, meta.pages).map((n, i) => (
            n === 0
              ? <span key={`gap${i}`} className="ui-cell-dim">…</span>
              : (
                <button
                  key={n}
                  className="ui-page-btn"
                  aria-current={n === meta.page ? 'page' : undefined}
                  onClick={() => setFilters((f) => ({ ...f, page: n }))}
                >
                  {n}
                </button>
              )
          ))}
          <Button
            variant="ghost"
            size="sm"
            disabled={meta.page >= meta.pages}
            onClick={() => setFilters((f) => ({ ...f, page: f.page + 1 }))}
          >
            Далее <Icon name="chevron-right" size={15} />
          </Button>
        </nav>
      )}
    </div>
  );
}
