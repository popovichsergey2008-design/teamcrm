import { useCallback, useState } from 'react';
import { Icon } from '../Icon';
import { Button } from '../ui/button';
import { Checkbox } from '../ui/checkbox';
import { Select } from '../ui/select';
import { useDismiss } from '../../hooks/useDismiss';
import { TASK_VIEWS, type TaskView } from '../../lib/task-views';
import type { QuickKey } from '../../lib/board-filter';
import {
  ALL_ROLES, BoardQuery, hasConditions, QUICK, QUICK_ON_BAR, resetConditions, showAll,
} from '../../lib/board-query';
import './board.css';

const PRIORITY = [
  { value: '', label: 'Любой приоритет' },
  { value: 'urgent', label: 'Срочный' },
  { value: 'high', label: 'Высокий' },
  { value: 'normal', label: 'Обычный' },
  { value: 'low', label: 'Низкий' },
];

export interface BoardCounts {
  /** Итог после всех условий — «Показано N». */
  shown: number;
  /** Сколько задач в режиме и ролях — число на кнопке «Мои задачи» (макет 01). */
  mine: number;
  /** Каждое быстрое условие отдельно — в текущем режиме, ролях и фильтрах. */
  quick: Record<QuickKey, number>;
  active: number;
  done: number;
}

/**
 * Панель доски (#4799 §2.4, §3; #4798 §1, §12): три уровня, которые раньше были
 * перемешаны в одной строке.
 *
 * 1. Действия ЭТОЙ доски: «+ Задача», голос, поиск по доске, Доска/Список, Фильтры,
 *    Настройки. Контекст проекта (название, избранное, «Все проекты», «Общие
 *    задачи») — в шапке выше и фильтрами не притворяется.
 * 2. Быстрые условия: «Мои задачи» с ролями (ИЛИ) и три подборки (И), у каждой —
 *    своё число.
 * 3. Что сейчас на экране: «Показано N», режим, чипы условий со снятием по одному,
 *    «Сбросить условия». Пустой результат объясняется, а не подменяется «всем».
 */
export function BoardBar({
  query, onChange, counts, view, onView, onCreate, createHint, onVoice, onOpenSettings, onOpenReview,
  users, columns, labels, creators, viewsSlot, extraActions, stages, onJump, onAllStages, hubSlot,
}: {
  query: BoardQuery;
  onChange: (q: BoardQuery) => void;
  counts: BoardCounts;
  view: 'board' | 'list';
  onView: (v: 'board' | 'list') => void;
  onCreate?: () => void;
  createHint?: string;
  onVoice?: () => void;
  onOpenSettings?: () => void;
  /** Очередь решений: проверить сданное по одной, не возвращаясь к доске. */
  onOpenReview?: () => void;
  users: { id: string; fullName: string }[];
  columns: { id: string; name: string }[];
  labels: { id: string; name: string }[];
  creators: [string, string][];
  /** Сохранённые виды — внутри «Фильтров» (BOARD06: «Фильтры → Сохранить вид»). */
  viewsSlot?: React.ReactNode;
  extraActions?: React.ReactNode;
  /** Ряд этапов под условиями (макет 01): видимые колонки подсвечены, нажатие — к колонке. */
  stages?: { id: string; name: string; visible: boolean; count: number }[];
  onJump?: (columnId: string) => void;
  onAllStages?: () => void;
  /** Справа в строке «Показано N» — вход в Инфоцентр проекта. */
  hubSlot?: React.ReactNode;
}) {
  const [rolesOpen, setRolesOpen] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const closeRoles = useCallback(() => setRolesOpen(false), []);
  const closeFilters = useCallback(() => setFiltersOpen(false), []);
  useDismiss(rolesOpen, closeRoles, '.bb-roles-btn');
  useDismiss(filtersOpen, closeFilters, '.bb-filters-btn');

  const set = (patch: Partial<BoardQuery>) => onChange({ ...query, ...patch });
  const toggleQuick = (k: QuickKey) => set({ quick: query.quick.includes(k) ? query.quick.filter((x) => x !== k) : [...query.quick, k] });
  const toggleRole = (r: TaskView) => {
    const next = query.roles.includes(r) ? query.roles.filter((x) => x !== r) : [...query.roles, r];
    // все галочки сняты — это не «ничего» и не «всё на доске»: возвращаем четыре роли
    set({ scope: 'mine', roles: next.length ? next : [...ALL_ROLES] });
  };
  const allRoles = query.roles.length === ALL_ROLES.length;
  const rolesLabel = query.scope === 'all' ? 'Все задачи на доске'
    : allRoles ? 'Мои задачи' : query.roles.map((r) => TASK_VIEWS.find((v) => v.key === r)?.label).join(' + ');
  const nameOf = (list: { id: string; name?: string; fullName?: string }[], id: string) => {
    const x = list.find((u) => String(u.id) === String(id));
    return x?.name ?? x?.fullName ?? '';
  };
  const filtersCount = [query.assigneeId, query.creatorId, query.columnId, query.priority, query.labelId].filter(Boolean).length
    + query.quick.filter((k) => !QUICK_ON_BAR.includes(k)).length;

  // Чипы активных условий — каждое снимается отдельно (#4799 §3.4).
  const chips: { key: string; label: string; clear: () => void }[] = [];
  for (const k of query.quick) {
    chips.push({ key: `q-${k}`, label: QUICK.find((x) => x.key === k)?.label ?? k, clear: () => toggleQuick(k) });
  }
  if (query.assigneeId) chips.push({ key: 'a', label: `Исполнитель: ${nameOf(users, query.assigneeId)}`, clear: () => set({ assigneeId: '' }) });
  if (query.creatorId) chips.push({ key: 'c', label: `Поставил: ${creators.find(([id]) => id === query.creatorId)?.[1] ?? ''}`, clear: () => set({ creatorId: '' }) });
  if (query.columnId) chips.push({ key: 'col', label: `Колонка: ${nameOf(columns, query.columnId)}`, clear: () => set({ columnId: '' }) });
  if (query.priority) chips.push({ key: 'p', label: `Приоритет: ${PRIORITY.find((p) => p.value === query.priority)?.label ?? ''}`, clear: () => set({ priority: '' }) });
  if (query.labelId) chips.push({ key: 'l', label: `Тег: ${nameOf(labels, query.labelId)}`, clear: () => set({ labelId: '' }) });
  if (query.search.trim()) chips.push({ key: 's', label: `Поиск «${query.search.trim()}» — только эта доска`, clear: () => set({ search: '' }) });

  return (
    <div className="bb">
      <div className="bb-row bb-actions">
        {onCreate && (
          <Button variant="primary" size="sm" onClick={onCreate} title={createHint} data-tour="board-new">
            <Icon name="plus" size={15} /> Задача
          </Button>
        )}
        {onVoice && (
          <Button variant="outline" size="sm" onClick={onVoice} title="Сказать задачу голосом: получится черновик, его можно поправить до создания">
            <Icon name="mic" size={15} /> <span className="bb-lbl">Сказать голосом</span>
          </Button>
        )}
        <label className="bb-search" title="Ищет только задачи этой доски — по номеру, названию и описанию">
          <Icon name="search" size={14} />
          <input
            className="bb-search-input"
            value={query.search}
            onChange={(e) => set({ search: e.target.value })}
            onKeyDown={(e) => { if (e.key === 'Escape') set({ search: '' }); }}
            placeholder="Поиск по этой доске"
            aria-label="Поиск по этой доске"
          />
          {query.search && (
            <button className="bb-x" onClick={() => set({ search: '' })} aria-label="Очистить поиск"><Icon name="close" size={12} /></button>
          )}
        </label>
        <span className="kv2-seg" role="group" aria-label="Вид доски">
          <button className="kv2-seg-btn" aria-pressed={view === 'board'} onClick={() => onView('board')} title="Канбан-доска — тот же отбор задач" aria-label="Доска"><Icon name="board" size={15} /> <span className="bb-lbl">Доска</span></button>
          <button className="kv2-seg-btn" aria-pressed={view === 'list'} onClick={() => onView('list')} title="Список — тот же отбор задач" aria-label="Список"><Icon name="list" size={15} /> <span className="bb-lbl">Список</span></button>
        </span>
        <span className="bb-pop-wrap">
          <Button variant={filtersCount ? 'secondary' : 'outline'} size="sm" className="bb-filters-btn" aria-expanded={filtersOpen} onClick={() => setFiltersOpen((v) => !v)}>
            <Icon name="filter" size={15} /> Фильтры{filtersCount ? ` · ${filtersCount}` : ''}
          </Button>
          {filtersOpen && (
            <div className="bb-pop bb-pop-right" data-pop role="dialog" aria-label="Фильтры доски">
              <div className="bb-pop-head">Подборки</div>
              {QUICK.filter((q) => !QUICK_ON_BAR.includes(q.key)).map((q) => (
                <Checkbox key={q.key} checked={query.quick.includes(q.key)} onCheckedChange={() => toggleQuick(q.key)} label={`${q.label} · ${counts.quick[q.key]}`} />
              ))}
              <div className="bb-pop-head">Условия — работают вместе</div>
              <div className="bb-fields">
                <Select ariaLabel="Исполнитель" size="sm" value={query.assigneeId} onValueChange={(v) => set({ assigneeId: v })}
                  options={[{ value: '', label: 'Любой исполнитель' }, ...users.map((u) => ({ value: String(u.id), label: u.fullName }))]} />
                <Select ariaLabel="Кто поставил" size="sm" value={query.creatorId} onValueChange={(v) => set({ creatorId: v })}
                  options={[{ value: '', label: 'Любой постановщик' }, ...creators.map(([id, n]) => ({ value: id, label: n }))]} />
                <Select ariaLabel="Колонка" size="sm" value={query.columnId} onValueChange={(v) => set({ columnId: v })}
                  options={[{ value: '', label: 'Все колонки' }, ...columns.map((c) => ({ value: String(c.id), label: c.name }))]} />
                <Select ariaLabel="Приоритет" size="sm" value={query.priority} onValueChange={(v) => set({ priority: v })} options={PRIORITY} />
                {labels.length > 0 && (
                  <Select ariaLabel="Тег" size="sm" value={query.labelId} onValueChange={(v) => set({ labelId: v })}
                    options={[{ value: '', label: 'Любой тег' }, ...labels.map((l) => ({ value: String(l.id), label: l.name }))]} />
                )}
              </div>
              <p className="bb-note">Исполнитель и «Кто поставил» — разные поля. Счётчики считают только задачи, которые вам видны.</p>
              {viewsSlot && (<><div className="bb-pop-head">Сохранённые виды</div>{viewsSlot}</>)}
            </div>
          )}
        </span>
        {onOpenSettings && (
          <Button variant="ghost" size="sm" onClick={onOpenSettings} title="Настройки этой доски">
            <Icon name="settings" size={15} /> Настройки
          </Button>
        )}
        {extraActions}
      </div>

      <div className="bb-row bb-quick" role="group" aria-label="Быстрые условия">
        <span className="bb-pop-wrap">
          <button
            className={`bb-chip bb-roles-btn is-main${query.scope === 'mine' ? ' is-on' : ''}`}
            aria-expanded={rolesOpen}
            onClick={() => setRolesOpen((v) => !v)}
            title="Мои роли в задачах: можно выбрать несколько — подойдёт любая"
          >
            {rolesLabel} <span className="bb-n bb-n-big">{query.scope === 'all' ? counts.shown : counts.mine}</span>
            <Icon name="chevron-down" size={13} />
          </button>
          {rolesOpen && (
            <div className="bb-pop" data-pop role="dialog" aria-label="Мои роли на задачах">
              <div className="bb-seg2">
                <button className={query.scope === 'mine' ? 'is-on' : ''} onClick={() => set({ scope: 'mine', roles: query.roles.length ? query.roles : [...ALL_ROLES] })}>Мои задачи</button>
                <button className={query.scope === 'all' ? 'is-on' : ''} onClick={() => set({ scope: 'all' })}>Все задачи на доске</button>
              </div>
              <div className="bb-pop-head">Мои роли — подойдёт любая из отмеченных</div>
              {TASK_VIEWS.map((v) => (
                <Checkbox key={v.key} checked={query.scope === 'mine' && query.roles.includes(v.key)} onCheckedChange={() => toggleRole(v.key)} label={`${v.label} — ${v.hint}`} />
              ))}
              <div className="bb-pop-sep" />
              <Checkbox checked={query.hideDone} onCheckedChange={(c) => set({ hideDone: !!c })} label="Скрыть завершённые задачи" />
              <button className="bb-link" onClick={() => { onChange(showAll(query)); setRolesOpen(false); }}>Показать все задачи</button>
            </div>
          )}
        </span>
        {QUICK_ON_BAR.map((k) => {
          const q = QUICK.find((x) => x.key === k)!;
          const on = query.quick.includes(k);
          return (
            <button key={k} className={`bb-chip${on ? ' is-on' : ''}${k === 'decide' && counts.quick[k] ? ' is-hot' : ''}`} aria-pressed={on} onClick={() => toggleQuick(k)} title={q.hint}>
              {q.short ?? q.label} <span className="bb-n">{counts.quick[k]}</span>
            </button>
          );
        })}
      </div>

      <div className="bb-row bb-status" aria-live="polite">
        <b>Показано {counts.shown} {taskWord(counts.shown)}</b>
        <span className="bb-dim">· {query.scope === 'all' ? 'Все задачи на доске' : allRoles ? 'Мои задачи' : rolesLabel}</span>
        {query.hideDone && <span className="bb-dim">· Завершённые скрыты</span>}
        <span className="bb-dim bb-totals">· Активные: {counts.active} · Завершённые: {counts.done}</span>
        {chips.map((c) => (
          <span key={c.key} className="bb-tag">
            {c.label}
            <button onClick={c.clear} aria-label={`Снять условие «${c.label}»`}><Icon name="close" size={11} /></button>
          </span>
        ))}
        {hasConditions(query) && (
          <button className="bb-link" onClick={() => onChange(resetConditions(query))} title="Снять быстрые условия, поля фильтров и поиск; режим и роли останутся">
            Сбросить условия
          </button>
        )}
        <span className="bb-spacer" />
        {onOpenReview && counts.quick.decide > 0 && (
          <button className="bb-link" onClick={onOpenReview} title="Открыть сданную работу по одной: принять, вернуть или задать вопрос">
            Проверить по очереди →
          </button>
        )}
        {hubSlot}
      </div>
      {!!stages?.length && (
        <div className="bb-row bb-stages" role="group" aria-label="Этапы доски">
          {stages.map((s) => (
            <button key={s.id} className={`bb-stage${s.visible ? ' is-vis' : ''}`} onClick={() => onJump?.(s.id)} title={`Перейти к колонке «${s.name}» · задач: ${s.count}`}>
              {s.name}
            </button>
          ))}
          <span className="bb-spacer" />
          {onAllStages && <button className="bb-link" onClick={onAllStages} title="Развернуть свёрнутые колонки и показать доску с начала">Все этапы ↗</button>}
        </div>
      )}
    </div>
  );
}

/** «1 задача», «2 задачи», «5 задач». */
function taskWord(n: number): string {
  const m10 = n % 10; const m100 = n % 100;
  return m10 === 1 && m100 !== 11 ? 'задача' : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? 'задачи' : 'задач';
}
