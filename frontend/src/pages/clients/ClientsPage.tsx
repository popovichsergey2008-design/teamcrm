import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import '../clients.css';
import { Icon } from '../../components/Icon';
import { EmptyState } from '../../components/EmptyState';
import { SkeletonList } from '../../components/Skeleton';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { Checkbox } from '../../components/ui/checkbox';
import { OptionSelect } from '../../components/ui/option-select';
import { Tabs } from '../../components/ui/tabs';
import { promptText } from '../../components/ui/dialog';
import { api, ApiError, ClientCan, ClientRow, tokens } from '../../lib/api';
import { apiUrl } from '../../lib/origin';
import { navigate } from '../../lib/router';
import { getSocket } from '../../lib/socket';
import { toastSaved } from '../../lib/notifications';
import { ago, HEALTH, money, SOURCE, STATUS, STATUS_KEYS, TYPE } from './labels';
import { NewClientDialog } from './NewClientDialog';
import { ImportDialog } from './ImportDialog';
import { ClientCardPage } from './ClientCardPage';

type View = 'all' | 'mine' | 'attention' | 'no_owner' | 'archive';
type Filters = Record<string, string>;

const EMPTY: Filters = {};

/**
 * Раздел «Клиенты» (ТЗ-17): список и карточка.
 *
 * Список — страницами с сервера (п. 63): поиск, фильтры и сортировка считаются там,
 * в браузер всех клиентов не тянем. Карточка открывается по адресу `/clients/:id`.
 */
export function ClientsPage({ clientId }: { clientId?: string }) {
  if (clientId) return <ClientCardPage key={clientId} clientId={clientId} />;
  return <ClientsList />;
}

function ClientsList() {
  const [view, setView] = useState<View>('all');
  const [q, setQ] = useState('');
  const [qLive, setQLive] = useState('');
  const [filters, setFilters] = useState<Filters>(EMPTY);
  const [sort, setSort] = useState<{ sort: string; dir: string }>({ sort: 'activity', dir: 'desc' });
  const [page, setPage] = useState(1);
  const [data, setData] = useState<{ items: ClientRow[]; total: number; pageSize: number; counters: { mine: number; no_owner: number; overdue: number; total: number }; can: ClientCan } | null>(null);
  const [err, setErr] = useState('');
  const [showFilters, setShowFilters] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [creating, setCreating] = useState(false);
  const [importing, setImporting] = useState(false);
  const [options, setOptions] = useState<{ users: { id: string; name: string }[]; segments: string[] } | null>(null);
  const [views, setViews] = useState<{ id: string; name: string; filter: Record<string, string>; sort: Record<string, string> }[]>([]);
  const [bulk, setBulk] = useState<{ action: string; value: string } | null>(null);

  // поиск по мере набора, с паузой (п. 13)
  const debounce = useRef<number | null>(null);
  const onSearch = (v: string) => {
    setQLive(v);
    if (debounce.current) window.clearTimeout(debounce.current);
    debounce.current = window.setTimeout(() => { setQ(v); setPage(1); }, 300);
  };

  const query = useMemo(() => {
    const p = new URLSearchParams({ view, sort: sort.sort, dir: sort.dir, page: String(page) });
    if (q.trim()) p.set('q', q.trim());
    for (const [k, v] of Object.entries(filters)) if (v) p.set(k, v);
    return p.toString();
  }, [view, q, filters, sort, page]);

  const load = useCallback(async () => {
    setErr('');
    try { setData(await api.clients(query)); }
    catch (e) { setErr(e instanceof ApiError ? e.message : 'Не удалось загрузить клиентов'); }
  }, [query]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    api.clientOptions().then(setOptions).catch(() => undefined);
    api.clientViews().then(setViews).catch(() => undefined);
    const s = getSocket();
    const refresh = () => { void load(); };
    s.on('client.created', refresh);
    s.on('client.updated', refresh);
    s.on('client.archived', refresh);
    return () => { s.off('client.created', refresh); s.off('client.updated', refresh); s.off('client.archived', refresh); };
  }, [load]);

  const setFilter = (k: string, v: string) => { setFilters((f) => ({ ...f, [k]: v })); setPage(1); };
  const toggleSort = (key: string) => setSort((s) => (s.sort === key ? { sort: key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { sort: key, dir: key === 'name' ? 'asc' : 'desc' }));
  const sortMark = (key: string) => (sort.sort === key ? <Icon name={sort.dir === 'asc' ? 'arrow-up' : 'arrow-down'} size={12} /> : null);

  const toggle = (id: string) => setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const allOnPage = data?.items.length ? data.items.every((c) => selected.has(c.id)) : false;

  const runBulk = async () => {
    if (!bulk) return;
    try {
      const r = await api.clientsBulk([...selected], bulk.action, bulk.value || null);
      toastSaved(`Изменено клиентов: ${r.updated}`);
      setSelected(new Set()); setBulk(null); void load();
    } catch (e) { setErr(e instanceof ApiError ? e.message : 'Не получилось'); }
  };

  const saveView = async () => {
    const name = await promptText({ title: 'Сохранить вид', placeholder: 'Например: VIP без активности 30 дней', confirmLabel: 'Сохранить', singleLine: true, minLength: 2 });
    if (!name) return;
    setViews(await api.addClientView(name, { ...filters, view, q }, sort));
    toastSaved('Вид сохранён');
  };

  const applyView = (v: { filter: Record<string, string>; sort: Record<string, string> }) => {
    const { view: vv, q: qq, ...rest } = v.filter;
    setView((vv as View) || 'all'); setQ(qq ?? ''); setQLive(qq ?? ''); setFilters(rest); setPage(1);
    if (v.sort?.sort) setSort({ sort: v.sort.sort, dir: v.sort.dir ?? 'desc' });
  };

  const exportCsv = async () => {
    // Выгрузка через fetch с токеном: прямой ссылкой файл не отдать — нужен вход.
    try {
      const p = new URLSearchParams(query); p.delete('page');
      const res = await fetch(apiUrl(`/api/clients/export?${p}`), { headers: tokens.access ? { Authorization: `Bearer ${tokens.access}` } : {} });
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.error?.message ?? 'Выгрузка не удалась');
      const blob = await res.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob); a.download = `clients-${new Date().toISOString().slice(0, 10)}.csv`; a.click();
      URL.revokeObjectURL(a.href);
    } catch (e) { setErr(e instanceof Error ? e.message : 'Выгрузка не удалась'); }
  };

  const can = data?.can;
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  const activeFilters = Object.values(filters).filter(Boolean).length;

  return (
    <div className="page cl-page">
      <div className="page-head cl-head">
        <h2><Icon name="building" size={18} /> Клиенты</h2>
        <div className="page-head-actions">
          {can?.export && <Button variant="ghost" size="sm" onClick={() => void exportCsv()}><Icon name="download" size={14} /> Выгрузить</Button>}
          {can?.create && <Button variant="outline" size="sm" onClick={() => setImporting(true)}><Icon name="upload" size={14} /> Импорт</Button>}
          {can?.create && <Button variant="primary" size="sm" onClick={() => setCreating(true)}><Icon name="plus" size={14} /> Новый клиент</Button>}
        </div>
      </div>

      <div className="cl-body">
        <Tabs<View>
          value={view}
          onValueChange={(v) => { setView(v); setPage(1); setSelected(new Set()); }}
          ariaLabel="Быстрые представления"
          items={[
            { value: 'all', label: 'Все', count: data?.counters.total },
            { value: 'mine', label: 'Мои', count: data?.counters.mine },
            { value: 'attention', label: 'Требуют внимания' },
            { value: 'no_owner', label: 'Без ответственного', count: data?.counters.no_owner },
            { value: 'archive', label: 'Архив' },
          ]}
        />

        <div className="cl-toolbar">
          <label className="cl-search">
            <Icon name="search" size={15} />
            <input className="input" value={qLive} onChange={(e) => onSearch(e.target.value)} placeholder="Название, телефон, почта, ИНН, контакт, сделка…" aria-label="Поиск клиентов" />
          </label>
          <Button variant={showFilters || activeFilters ? 'secondary' : 'ghost'} size="sm" aria-expanded={showFilters} onClick={() => setShowFilters((v) => !v)}>
            <Icon name="filter" size={14} /> Фильтры{activeFilters ? ` · ${activeFilters}` : ''}
          </Button>
          {views.length > 0 && (
            <OptionSelect value="" onChange={(e) => { const v = views.find((x) => x.id === e.target.value); if (v) applyView(v); }} aria-label="Сохранённые виды">
              <option value="">Сохранённые виды…</option>
              {views.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
            </OptionSelect>
          )}
          <Button variant="ghost" size="sm" onClick={() => void saveView()} title="Сохранить текущие фильтры как вид"><Icon name="star" size={14} /> Сохранить вид</Button>
        </div>

        {showFilters && (
          <div className="cl-filters">
            <OptionSelect value={filters.status ?? ''} onChange={(e) => setFilter('status', e.target.value)} aria-label="Статус">
              <option value="">Любой статус</option>
              {STATUS_KEYS.map((k) => <option key={k} value={k}>{STATUS[k].label}</option>)}
            </OptionSelect>
            <OptionSelect value={filters.type ?? ''} onChange={(e) => setFilter('type', e.target.value)} aria-label="Тип">
              <option value="">Любой тип</option>
              <option value="company">Компании</option>
              <option value="person">Частные лица</option>
            </OptionSelect>
            <OptionSelect value={filters.segment ?? ''} onChange={(e) => setFilter('segment', e.target.value)} aria-label="Сегмент">
              <option value="">Любой сегмент</option>
              {(options?.segments ?? []).map((s) => <option key={s} value={s}>{s}</option>)}
            </OptionSelect>
            <OptionSelect value={filters.ownerId ?? ''} onChange={(e) => setFilter('ownerId', e.target.value)} aria-label="Ответственный">
              <option value="">Любой ответственный</option>
              <option value="none">Без ответственного</option>
              {(options?.users ?? []).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
            </OptionSelect>
            <OptionSelect value={filters.source ?? ''} onChange={(e) => setFilter('source', e.target.value)} aria-label="Источник">
              <option value="">Любой источник</option>
              {Object.entries(SOURCE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </OptionSelect>
            <OptionSelect value={filters.inactiveDays ?? ''} onChange={(e) => setFilter('inactiveDays', e.target.value)} aria-label="Последняя активность">
              <option value="">Любая активность</option>
              <option value="14">Нет активности 14+ дней</option>
              <option value="30">Нет активности 30+ дней</option>
              <option value="90">Нет активности 90+ дней</option>
            </OptionSelect>
            <Checkbox checked={filters.hasDeals === '1'} onCheckedChange={(v) => setFilter('hasDeals', v ? '1' : '')} label="Есть открытые сделки" />
            <Checkbox checked={filters.hasOverdue === '1'} onCheckedChange={(v) => setFilter('hasOverdue', v ? '1' : '')} label="Есть просрочки" />
            <Checkbox checked={filters.hasOpenTasks === '1'} onCheckedChange={(v) => setFilter('hasOpenTasks', v ? '1' : '')} label="Есть открытые задачи" />
            <label className="cl-date">Создан с <input className="input" type="date" value={filters.createdFrom ?? ''} onChange={(e) => setFilter('createdFrom', e.target.value)} /></label>
            <label className="cl-date">по <input className="input" type="date" value={filters.createdTo ?? ''} onChange={(e) => setFilter('createdTo', e.target.value)} /></label>
            {activeFilters > 0 && <Button variant="ghost" size="sm" onClick={() => { setFilters(EMPTY); setPage(1); }}>Сбросить</Button>}
          </div>
        )}

        {selected.size > 0 && (
          <div className="cl-bulk" role="toolbar" aria-label="Действия с выбранными">
            <b>Выбрано: {selected.size}</b>
            <OptionSelect value={bulk?.action ?? ''} onChange={(e) => setBulk(e.target.value ? { action: e.target.value, value: '' } : null)} aria-label="Действие">
              <option value="">Действие…</option>
              {can?.edit && <option value="owner">Назначить ответственного</option>}
              {can?.edit && <option value="status">Изменить статус</option>}
              {can?.edit && <option value="segment">Задать сегмент</option>}
              {can?.archive && <option value="archive">В архив</option>}
            </OptionSelect>
            {bulk?.action === 'owner' && (
              <OptionSelect value={bulk.value} onChange={(e) => setBulk({ ...bulk, value: e.target.value })} aria-label="Ответственный">
                <option value="">Кому…</option>
                {(options?.users ?? []).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
              </OptionSelect>
            )}
            {bulk?.action === 'status' && (
              <OptionSelect value={bulk.value} onChange={(e) => setBulk({ ...bulk, value: e.target.value })} aria-label="Статус">
                <option value="">Статус…</option>
                {STATUS_KEYS.map((k) => <option key={k} value={k}>{STATUS[k].label}</option>)}
              </OptionSelect>
            )}
            {bulk?.action === 'segment' && (
              <input className="input" list="cl-segments" value={bulk.value} onChange={(e) => setBulk({ ...bulk, value: e.target.value })} placeholder="Сегмент" aria-label="Сегмент" />
            )}
            <datalist id="cl-segments">{(options?.segments ?? []).map((s) => <option key={s} value={s} />)}</datalist>
            <Button variant="primary" size="sm" disabled={!bulk || (bulk.action !== 'archive' && !bulk.value)} onClick={() => void runBulk()}>Применить</Button>
            <Button variant="ghost" size="sm" onClick={() => { setSelected(new Set()); setBulk(null); }}>Снять выбор</Button>
          </div>
        )}

        {err && (
          <div className="tv2-callout tv2-callout-danger" role="alert">
            <Icon name="alert" size={15} /> {err}
            <Button variant="ghost" size="sm" onClick={() => void load()}>Повторить</Button>
          </div>
        )}

        {!data && !err && <SkeletonList rows={8} />}
        {data && data.items.length === 0 && (
          view === 'all' && !q && !activeFilters ? (
            <EmptyState icon="building" title="У вас пока нет клиентов" hint="Заведите первого вручную или загрузите список из таблицы — CSV или Excel."
              action={can?.create ? { label: 'Добавить клиента', onClick: () => setCreating(true) } : undefined} />
          ) : <EmptyState icon="search" compact title="Никого не нашлось" hint="Попробуйте другое слово или снимите фильтры." />
        )}

        {data && data.items.length > 0 && (
          <div className="cl-table-wrap">
            <table className="cl-table">
              <thead>
                <tr>
                  <th className="cl-check"><Checkbox checked={allOnPage} onCheckedChange={(v) => setSelected(v ? new Set(data.items.map((c) => c.id)) : new Set())} /></th>
                  <th><button type="button" className="cl-th" onClick={() => toggleSort('name')}>Клиент {sortMark('name')}</button></th>
                  <th className="cl-hide-sm">Контакт</th>
                  <th><button type="button" className="cl-th" onClick={() => toggleSort('owner')}>Ответственный {sortMark('owner')}</button></th>
                  <th><button type="button" className="cl-th" onClick={() => toggleSort('status')}>Статус {sortMark('status')}</button></th>
                  {can?.deals && <th className="cl-hide-sm"><button type="button" className="cl-th" onClick={() => toggleSort('deals')}>Сделки {sortMark('deals')}</button></th>}
                  <th className="cl-hide-sm">Задачи</th>
                  <th><button type="button" className="cl-th" onClick={() => toggleSort('activity')}>Активность {sortMark('activity')}</button></th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((c) => (
                  <tr key={c.id} className={c.archived ? 'cl-archived' : ''}>
                    <td className="cl-check"><Checkbox checked={selected.has(c.id)} onCheckedChange={() => toggle(c.id)} /></td>
                    <td>
                      <button type="button" className="cl-name" onClick={() => navigate({ section: 'clients', clientId: c.id })}>
                        <Icon name={c.type === 'person' ? 'user' : 'building'} size={14} /> {c.name}
                      </button>
                      <div className="cl-sub">
                        {c.segment && <Badge tone="outline">{c.segment}</Badge>}
                        {c.city && <span className="dim">{c.city}</span>}
                        {c.health.level && c.health.level !== 'healthy' && (
                          <Badge tone={HEALTH[c.health.level].tone} title={c.health.signals.join(' · ')}>{HEALTH[c.health.level].label}</Badge>
                        )}
                      </div>
                    </td>
                    <td className="cl-hide-sm">{c.primaryContact ?? <span className="dim">—</span>}{c.contacts > 1 && <span className="dim"> +{c.contacts - 1}</span>}</td>
                    <td>{c.ownerName ?? <span className="dim">не назначен</span>}</td>
                    <td><Badge tone={STATUS[c.status]?.tone ?? 'neutral'}>{STATUS[c.status]?.label ?? c.status}</Badge></td>
                    {can?.deals && <td className="cl-hide-sm">{c.openDeals ? <>{c.openDeals} · {money(c.dealsAmount)}</> : <span className="dim">—</span>}</td>}
                    <td className="cl-hide-sm">{c.openTasks ? <>{c.openTasks}{c.overdueTasks ? <span className="cl-late"> · {c.overdueTasks} просроч.</span> : null}</> : <span className="dim">—</span>}</td>
                    <td>
                      <span title={c.activityAt ? new Date(c.activityAt).toLocaleString('ru-RU') : ''}>{ago(c.activityAt)}</span>
                      {c.nextAction && <div className="cl-sub dim">→ {c.nextAction}</div>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {data && pages > 1 && (
          <div className="cl-pager">
            <Button variant="ghost" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}><Icon name="chevron-left" size={14} /> Назад</Button>
            <span className="dim">Страница {page} из {pages} · всего {data.total}</span>
            <Button variant="ghost" size="sm" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>Дальше <Icon name="chevron-right" size={14} /></Button>
          </div>
        )}

        {views.length > 0 && (
          <div className="cl-views dim">
            Сохранённые виды: {views.map((v) => (
              <span key={v.id} className="cl-view-chip">
                <button type="button" onClick={() => applyView(v)}>{v.name}</button>
                <button type="button" aria-label={`Удалить вид ${v.name}`} onClick={() => void api.removeClientView(v.id).then(setViews)}><Icon name="close" size={11} /></button>
              </span>
            ))}
          </div>
        )}
      </div>

      {creating && <NewClientDialog onClose={() => setCreating(false)} users={options?.users ?? []} onCreated={(id) => { setCreating(false); navigate({ section: 'clients', clientId: id }); }} />}
      {importing && <ImportDialog onClose={() => { setImporting(false); void load(); }} />}
      {/* подписи типов — для читателей экрана: в таблице иконка */}
      <span hidden>{Object.values(TYPE).join(' ')}</span>
    </div>
  );
}

