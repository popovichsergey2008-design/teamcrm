import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '../components/Icon';
import { Button } from '../components/ui/button';
import { DropdownMenu, MenuItem } from '../components/ui/dropdown-menu';
import { ReviewQueue } from '../components/review/ReviewQueue';
import { api, ApiError } from '../lib/api';
import { flowApi, type QueueItem } from '../lib/flow-api';
import { INBOX_CHANGED, inboxApi, snoozeTime, type InboxCounters, type InboxItem, type InboxKind, type InboxTab } from '../lib/inbox-api';
import { navigate, parsePath } from '../lib/router';
import { getSocket } from '../lib/socket';
import { diag } from '../lib/diag';
import { toastSaved } from '../lib/notifications';
import { useMediaQuery } from '../hooks/useMediaQuery';
import './inbox.css';

const TABS: { key: InboxTab; label: string }[] = [
  { key: 'important', label: 'Важное' },
  { key: 'ai', label: 'ИИ предлагает' },
  { key: 'all', label: 'Все' },
  { key: 'snoozed', label: 'Отложенные' },
  { key: 'done', label: 'Готово' },
];

const KIND_ICON: Record<InboxKind, Parameters<typeof Icon>[0]['name']> = {
  decision: 'check-circle', mention: 'chat', assigned: 'user-plus', ai: 'sparkles',
  meeting: 'video', comment: 'chat', change: 'refresh', system: 'info',
};

/** Решения из очереди, отложенные «Готово» до новой версии (объект не меняется). */
const HIDDEN_KEY = 'qevo.inbox.hiddenDecisions';
const readHidden = (): string[] => { try { return JSON.parse(localStorage.getItem(HIDDEN_KEY) ?? '[]') as string[]; } catch { return []; } };

const hm = (iso: string) => new Date(iso).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
function dayOf(iso: string): 'Сегодня' | 'Вчера' | 'Ранее' {
  const d = new Date(iso); const t = new Date(); t.setHours(0, 0, 0, 0);
  if (d >= t) return 'Сегодня';
  t.setDate(t.getDate() - 1);
  return d >= t ? 'Вчера' : 'Ранее';
}
/** «ждёт 2 дня», «ждёт 5 ч» — с какого момента сдано. */
function waiting(iso: string | null): string {
  if (!iso) return '';
  const h = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 3600_000));
  if (h < 24) return `ждёт ${Math.max(1, h)} ч`;
  const d = Math.floor(h / 24);
  return `ждёт ${d} ${d % 10 === 1 && d % 100 !== 11 ? 'день' : d % 10 >= 2 && d % 10 <= 4 && (d % 100 < 12 || d % 100 > 14) ? 'дня' : 'дней'}`;
}

type Row = { type: 'decision'; key: string; q: QueueItem } | { type: 'item'; key: string; it: InboxItem };

/**
 * «Входящие» (#4807 §6): всё, что ждёт моей реакции, — в одном месте. Слева список,
 * справа предпросмотр с действиями; на узком экране — только список.
 */
export function InboxPage({ tab: tabFromRoute }: { tab?: string }) {
  const tab: InboxTab = TABS.some((t) => t.key === tabFromRoute) ? (tabFromRoute as InboxTab) : 'important';
  const wide = useMediaQuery('(min-width: 980px)');
  const [items, setItems] = useState<InboxItem[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [hidden, setHidden] = useState<string[]>(readHidden);
  const [counters, setCounters] = useState<InboxCounters | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [dateFor, setDateFor] = useState<string | null>(null);
  const [aiToday, setAiToday] = useState<string>('');

  const load = useCallback(async () => {
    setErr('');
    try {
      const [page, c, q] = await Promise.all([
        inboxApi.list(tab),
        inboxApi.counters(),
        tab === 'important' ? flowApi.queue().catch(() => [] as QueueItem[]) : Promise.resolve([] as QueueItem[]),
      ]);
      setItems(page.items); setNext(page.next); setCounters(c); setQueue(q);
    } catch (e) { setErr(e instanceof ApiError ? e.message : 'Не удалось загрузить «Входящие»'); setItems([]); }
  }, [tab]);

  useEffect(() => { setItems(null); setSel(null); setChecked(new Set()); void load(); }, [load]);
  useEffect(() => { diag('app', 'inbox_open', undefined, { tab }); }, [tab]);
  // реальное время: новое событие или прочтение на другом устройстве — перечитать (≤ 3 с)
  useEffect(() => {
    const s = getSocket();
    let t = 0;
    const re = () => { window.clearTimeout(t); t = window.setTimeout(() => void load(), 400); };
    s.on('inbox.item', re); s.on('inbox.read', re); s.on('assistant.proposal', re);
    return () => { window.clearTimeout(t); s.off('inbox.item', re); s.off('inbox.read', re); s.off('assistant.proposal', re); };
  }, [load]);
  useEffect(() => {
    api.secretarySummary().then((s) => setAiToday(s.actions ? `Сегодня ИИ сделал за вас: ${s.actions} ${s.actions % 10 === 1 && s.actions % 100 !== 11 ? 'действие' : 'действий'}` : '')).catch(() => undefined);
  }, []);

  const decisions = useMemo(() => queue.filter((q) => !hidden.includes(`${q.id}:${q.handoff?.version ?? 0}`)), [queue, hidden]);
  const rows: Row[] = useMemo(() => [
    ...decisions.map((q) => ({ type: 'decision' as const, key: `d${q.id}`, q })),
    ...(items ?? []).map((it) => ({ type: 'item' as const, key: `i${it.id}`, it })),
  ], [decisions, items]);
  const current = rows.find((r) => r.key === sel) ?? null;

  const changed = (c?: InboxCounters) => { if (c) setCounters(c); window.dispatchEvent(new Event(INBOX_CHANGED)); };
  const act = async (ids: string[], action: 'read' | 'unread' | 'done' | 'snooze', until?: Date) => {
    setBusy(true); setErr('');
    try {
      const r = await inboxApi.bulk(ids, action, until?.toISOString());
      diag('app', 'inbox_action', undefined, { action, n: ids.length });
      if (action === 'done' || action === 'snooze') {
        setItems((list) => (list ?? []).filter((x) => !x.ids.some((id) => ids.includes(id))));
        if (action === 'snooze') toastSaved('Отложено', `до ${until!.toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })}`);
      } else {
        setItems((list) => (list ?? []).map((x) => (x.ids.some((id) => ids.includes(id)) ? { ...x, unread: action === 'unread' } : x)));
      }
      setChecked(new Set());
      changed(r.counters);
      if ((items ?? []).length && tab !== 'snoozed' && tab !== 'done' && !rows.length) diag('app', 'inbox_zero');
    } catch (e) { setErr(e instanceof ApiError ? e.message : 'Не получилось'); } finally { setBusy(false); }
  };
  const hideDecision = (q: QueueItem) => {
    const next = [...hidden, `${q.id}:${q.handoff?.version ?? 0}`].slice(-300);
    setHidden(next);
    try { localStorage.setItem(HIDDEN_KEY, JSON.stringify(next)); } catch { /* без хранилища — до перезагрузки */ }
    changed();
  };

  const open = (it: InboxItem) => {
    if (it.unread) void act(it.ids, 'read');
    if (!it.path) return;
    // «/secretary/ID» — предложение ИИ: App сам откроет панель агента с ним
    if (it.path.startsWith('/secretary')) navigate(it.path);
    else navigate(parsePath(it.path));
  };
  const openTask = (t: { id: string; project_id: string }) => navigate({ section: 'projects', projectId: String(t.project_id), taskId: String(t.id) });

  /** «Принять в работу»: задача — в колонку «В работе» её доски, строка — «Готово». */
  const takeToWork = async (it: InboxItem) => {
    if (!it.task?.projectId) return open(it);
    setBusy(true);
    try {
      const board = await api.getBoard(it.task.projectId);
      const col = board.columns.find((c) => c.stage_type === 'work' && c.position > 0) ?? board.columns.find((c) => /в работе/i.test(c.name));
      if (col) await api.moveTask(it.task.id, { columnId: String(col.id), position: 0 });
      window.dispatchEvent(new Event('teamcrm:tasks-changed'));
      toastSaved('Взято в работу', `#${it.task.id}${col ? ` → «${col.name}»` : ''}`);
      await act(it.ids, 'done');
    } catch (e) { setErr(e instanceof ApiError ? e.message : 'Не удалось взять в работу'); } finally { setBusy(false); }
  };
  /** «Отклонить» предложение ИИ — и строка уходит в «Готово». */
  const rejectAi = async (it: InboxItem) => {
    const id = it.path?.match(/^\/secretary\/(\d+)/)?.[1];
    if (id) await api.proposalDismiss(id, { reason: 'not_needed' }).catch(() => undefined);
    await act(it.ids, 'done');
  };

  // горячие клавиши (6.3): J/K, Enter, E — готово, R — ответить, S — отложить
  const rowsRef = useRef(rows); rowsRef.current = rows;
  const selRef = useRef(sel); selRef.current = sel;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) || e.ctrlKey || e.metaKey || e.altKey) return;
      const list = rowsRef.current; const i = list.findIndex((r) => r.key === selRef.current);
      const k = e.key.toLowerCase();
      const cur = i >= 0 ? list[i] : null;
      if (k === 'j' || k === 'о') { e.preventDefault(); setSel(list[Math.min(list.length - 1, i + 1)]?.key ?? null); }
      else if (k === 'k' || k === 'л') { e.preventDefault(); setSel(list[Math.max(0, i - 1)]?.key ?? null); }
      else if (!cur) return;
      else if (k === 'enter' || k === 'r' || k === 'к') { e.preventDefault(); if (cur.type === 'item') open(cur.it); else openTask(cur.q); }
      else if (k === 'e' || k === 'у') { e.preventDefault(); if (cur.type === 'item') void act(cur.it.ids, 'done'); else hideDecision(cur.q); }
      else if ((k === 's' || k === 'ы') && cur.type === 'item') { e.preventDefault(); void act(cur.it.ids, 'snooze', snoozeTime('tomorrow')); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const snoozeMenu = (it: InboxItem) => (
    <DropdownMenu trigger={<Button variant="ghost" size="sm"><Icon name="clock" size={14} /> Отложить</Button>}>
      <MenuItem icon={<Icon name="clock" size={15} />} onSelect={() => void act(it.ids, 'snooze', snoozeTime('hour'))}>На 1 час</MenuItem>
      <MenuItem icon={<Icon name="sun" size={15} />} onSelect={() => void act(it.ids, 'snooze', snoozeTime('tomorrow'))}>Завтра, 9:00</MenuItem>
      <MenuItem icon={<Icon name="calendar" size={15} />} onSelect={() => void act(it.ids, 'snooze', snoozeTime('monday'))}>В понедельник, 9:00</MenuItem>
      <MenuItem icon={<Icon name="edit" size={15} />} onSelect={() => setDateFor(it.id)}>Выбрать дату…</MenuItem>
    </DropdownMenu>
  );

  /** Быстрые действия; в списке — тихие (#4807 §9.1: одна синяя кнопка на экране), синяя — в предпросмотре. */
  const quick = (it: InboxItem, inList = false) => {
    const b = (label: string, fn: () => void, primary = false) => (
      <Button key={label} size="sm" variant={primary && !inList ? 'primary' : 'outline'} disabled={busy} onClick={(e) => { e.stopPropagation(); fn(); }}>{label}</Button>
    );
    if (tab === 'done') return [b('Вернуть в список', () => void inboxApi.undone(it.id).then((r) => { setItems((l) => (l ?? []).filter((x) => x.id !== it.id)); changed(r.counters); }))];
    switch (it.kind) {
      case 'mention': case 'comment': return [b('Ответить', () => open(it), true), b('Открыть', () => open(it))];
      case 'assigned': return [b('Принять в работу', () => void takeToWork(it), true), b('Открыть', () => open(it))];
      case 'ai': return [b('Проверить и создать', () => open(it), true), b('Отклонить', () => void rejectAi(it))];
      case 'meeting': return [b('Открыть протокол', () => open(it), true)];
      default: return [b('Открыть', () => open(it))];
    }
  };

  const decisionRow = (q: QueueItem) => (
    <div key={`d${q.id}`} className={`ib-row is-unread${sel === `d${q.id}` ? ' is-sel' : ''}`} role="button" tabIndex={0}
      onClick={() => (wide ? setSel(`d${q.id}`) : openTask(q))} onKeyDown={(e) => { if (e.key === 'Enter') setSel(`d${q.id}`); }}>
      <span className="ib-ico k-decision"><Icon name="check-circle" size={16} /></span>
      <div className="ib-main">
        <div className="ib-title"><b>{q.handoff?.author ?? q.assignee_name ?? 'Исполнитель'} сдал результат</b>{q.submitted_at && <span className="ib-wait">{waiting(q.submitted_at)}</span>}</div>
        <div className="ib-sub">#{q.id} {q.title}{q.handoff ? ` · версия ${q.handoff.version}` : ''} · {q.project_name}</div>
        <div className="ib-acts">
          <Button size="sm" variant="outline" onClick={(e) => { e.stopPropagation(); setSel(`d${q.id}`); if (!wide) openTask(q); }}>Принять</Button>
          <Button size="sm" variant="outline" onClick={(e) => { e.stopPropagation(); setSel(`d${q.id}`); if (!wide) openTask(q); }}>Вернуть</Button>
          <Button size="sm" variant="outline" onClick={(e) => { e.stopPropagation(); hideDecision(q); }}>Готово</Button>
        </div>
      </div>
      <span className="ib-time">{q.submitted_at ? hm(q.submitted_at) : ''}</span>
    </div>
  );

  const itemRow = (it: InboxItem) => (
    <div key={`i${it.id}`} className={`ib-row${it.unread ? ' is-unread' : ''}${sel === `i${it.id}` ? ' is-sel' : ''}`} role="button" tabIndex={0}
      onClick={() => (wide ? (setSel(`i${it.id}`), it.unread && void act(it.ids, 'read')) : open(it))}
      onKeyDown={(e) => { if (e.key === 'Enter') open(it); }}>
      <input type="checkbox" className="ib-check" checked={checked.has(it.id)} aria-label="Выбрать"
        onClick={(e) => e.stopPropagation()}
        onChange={() => setChecked((s) => { const n = new Set(s); if (n.has(it.id)) n.delete(it.id); else n.add(it.id); return n; })} />
      <span className={`ib-ico k-${it.kind}`}><Icon name={KIND_ICON[it.kind]} size={16} /></span>
      <div className="ib-main">
        <div className="ib-title"><b>{it.title}</b></div>
        <div className="ib-sub">
          {it.count > 1 && it.task ? `#${it.task.id} ${it.task.title}` : it.body || (it.task ? `#${it.task.id} ${it.task.title}` : '')}
          {it.actors.length > 0 && it.count > 1 ? ` · ${it.actors.slice(0, 3).join(', ')}` : ''}
          {tab === 'snoozed' && it.snoozedUntil ? ` · до ${new Date(it.snoozedUntil).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}` : ''}
        </div>
        <div className="ib-acts">{quick(it, true)}</div>
      </div>
      <span className="ib-time">{dayOf(it.createdAt) === 'Сегодня' ? hm(it.createdAt) : new Date(it.createdAt).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })}</span>
    </div>
  );

  // «Сегодня / Вчера / Ранее» после группы решений
  const byDay = useMemo(() => {
    const out: [string, InboxItem[]][] = [];
    for (const it of items ?? []) {
      const d = dayOf(it.createdAt);
      const last = out[out.length - 1];
      if (last && last[0] === d) last[1].push(it); else out.push([d, [it]]);
    }
    return out;
  }, [items]);

  const importantN = (counters?.important ?? 0) + decisions.length;
  const empty = items !== null && !rows.length;
  const checkedIds = (items ?? []).filter((x) => checked.has(x.id)).flatMap((x) => x.ids);

  return (
    <div className="ib">
      <section className="ib-list" aria-label="Входящие">
        <header className="ib-head">
          <h1>Входящие</h1>
          {wide && <span className="ib-keys">J/K — вверх/вниз · E — готово · R — ответить · S — отложить</span>}
        </header>
        <nav className="ib-tabs" aria-label="Вкладки «Входящих»">
          {TABS.map((t) => (
            <button key={t.key} className={`ib-tab${tab === t.key ? ' is-on' : ''}`} aria-current={tab === t.key} onClick={() => navigate({ section: 'inbox', tab: t.key })}>
              {t.label}
              {t.key === 'important' && importantN > 0 && <span className={`ib-n${decisions.length || counters?.decisions ? ' is-warn' : ''}`}>{importantN}</span>}
              {t.key === 'ai' && !!counters?.ai && <span className="ib-n">{counters.ai}</span>}
            </button>
          ))}
        </nav>
        {checked.size > 0 && (
          <div className="ib-bulk" role="toolbar" aria-label="Действия с выбранными">
            <span>Выбрано: {checked.size}</span>
            <Button size="sm" variant="outline" disabled={busy} onClick={() => void act(checkedIds, 'done')}>Готово</Button>
            <Button size="sm" variant="outline" disabled={busy} onClick={() => void act(checkedIds, 'snooze', snoozeTime('tomorrow'))}>Отложить до завтра</Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => void act(checkedIds, 'read')}>Прочитано</Button>
            <Button size="sm" variant="ghost" onClick={() => setChecked(new Set())}>Снять выбор</Button>
          </div>
        )}
        {err && <div className="tv2-callout tv2-callout-danger" role="alert"><Icon name="alert" size={15} /> {err}</div>}
        <div className="ib-scroll">
          {items === null && <p className="dim ib-pad">Загружаю…</p>}
          {tab === 'important' && decisions.length > 0 && (
            <>
              <div className="ib-group is-warn">Ждут вашего решения · {decisions.length}</div>
              {decisions.map(decisionRow)}
            </>
          )}
          {byDay.map(([day, list]) => (
            <div key={day}>
              <div className="ib-group">{day}</div>
              {list.map(itemRow)}
            </div>
          ))}
          {empty && (
            <div className="ib-empty">
              <Icon name="check-circle" size={28} />
              <b>Всё разобрано ✓</b>
              {aiToday && <span className="dim">{aiToday}</span>}
            </div>
          )}
          {next && <Button variant="ghost" size="sm" className="ib-more" onClick={() => void inboxApi.list(tab, next).then((p) => { setItems((l) => [...(l ?? []), ...p.items]); setNext(p.next); })}>Показать ещё</Button>}
        </div>
      </section>

      {wide && (
        <section className="ib-preview" aria-label="Предпросмотр">
          {!current && <div className="ib-empty dim"><Icon name="inbox" size={28} /> Выберите строку слева</div>}
          {current?.type === 'decision' && (
            <ReviewQueue
              key={current.q.id}
              embedTaskId={String(current.q.id)}
              onClose={() => setSel(null)}
              onOpenTask={openTask}
              onDecided={() => { setQueue((list) => list.filter((x) => x.id !== current.q.id)); setSel(null); changed(); }}
            />
          )}
          {current?.type === 'item' && (
            <div className="ib-pv">
              <div className="dim">{current.it.task ? `#${current.it.task.id}` : ''} {dayOf(current.it.createdAt)} · {hm(current.it.createdAt)}</div>
              <h2>{current.it.task?.title || current.it.title}</h2>
              <p className="ib-pv-title">{current.it.title}</p>
              {current.it.body && <p className="ib-pv-body">{current.it.body}</p>}
              {Array.isArray(current.it.details?.fields) && (
                <dl className="ib-pv-fields">
                  {(current.it.details!.fields as [string, string][]).map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}
                </dl>
              )}
              {current.it.actors.length > 1 && <p className="dim">От: {current.it.actors.join(', ')}</p>}
              {dateFor === current.it.id && (
                <form className="ib-date" onSubmit={(e) => { e.preventDefault(); const v = (e.currentTarget.elements.namedItem('until') as HTMLInputElement).value; if (v) { setDateFor(null); void act(current.it.ids, 'snooze', new Date(v)); } }}>
                  <input name="until" type="datetime-local" className="ui-input ui-input-sm" aria-label="Отложить до" required />
                  <Button size="sm" type="submit">Отложить</Button>
                  <Button size="sm" variant="ghost" type="button" onClick={() => setDateFor(null)}>Отмена</Button>
                </form>
              )}
              <div className="ib-pv-acts">
                {quick(current.it)}
                {tab !== 'done' && <Button size="sm" variant="outline" disabled={busy} onClick={() => void act(current.it.ids, 'done')}><Icon name="check" size={14} /> Готово</Button>}
                {tab !== 'done' && snoozeMenu(current.it)}
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => void act(current.it.ids, current.it.unread ? 'read' : 'unread')}>
                  {current.it.unread ? 'Прочитано' : 'Не прочитано'}
                </Button>
              </div>
              <p className="dim ib-pv-note">«Готово» убирает строку из списка, сама задача не меняется.</p>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
