import { useCallback, useEffect, useState } from 'react';
import { Icon } from '../../components/Icon';
import { Button } from '../../components/ui/button';
import { Dialog } from '../../components/ui/dialog';
import { Select } from '../../components/ui/select';
import { api, ApiError } from '../../lib/api';
import type { ChangeEvent, ChangeKindKey, ChangeSummary } from '../../lib/api';
import { navigate } from '../../lib/router';

/**
 * Изменения по задачам (ТЗ-32) — блок «Пульса команды».
 *
 * Агрегированная картина движения работы: сколько ушло в тест, вернулось, закрыто,
 * переоткрыто — и кто двигал. Не лента «Сергей перевёл задачу №…» (§14): цифры, а
 * конкретные переходы — по клику. Считает сервер по журналу переходов; экран только
 * показывает.
 */

type Preset = 'today' | 'yesterday' | 'd7' | 'd30' | 'month' | 'custom';
const PRESETS: { key: Preset; label: string }[] = [
  { key: 'today', label: 'Сегодня' }, { key: 'yesterday', label: 'Вчера' }, { key: 'd7', label: '7 дней' },
  { key: 'd30', label: '30 дней' }, { key: 'month', label: 'Этот месяц' }, { key: 'custom', label: 'Период' },
];
const MAIN: ChangeKindKey[] = ['entered_testing', 'returned_to_work', 'moved_to_done', 'reopened'];
const SHORT: Record<ChangeKindKey, string> = {
  entered_testing: '→ тест', returned_to_work: '← из теста', moved_to_done: 'готово', reopened: 'переоткрыто',
  blocked: 'заблок.', unblocked: 'разблок.',
};

const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
function range(p: Preset, custom: { from: string; to: string }): { from: string; to: string } {
  const now = new Date();
  const back = (n: number) => { const d = new Date(now); d.setDate(d.getDate() - n); return ymd(d); };
  switch (p) {
    case 'today': return { from: ymd(now), to: ymd(now) };
    case 'yesterday': return { from: back(1), to: back(1) };
    case 'd7': return { from: back(6), to: ymd(now) };
    case 'd30': return { from: back(29), to: ymd(now) };
    case 'month': return { from: ymd(new Date(now.getFullYear(), now.getMonth(), 1)), to: ymd(now) };
    default: return custom;
  }
}
const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/Moscow';
const time = (iso: string) => new Date(iso).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

export function TaskChanges() {
  const [preset, setPreset] = useState<Preset>('today');
  const [custom, setCustom] = useState(() => ({ from: ymd(new Date()), to: ymd(new Date()) }));
  const [projectId, setProjectId] = useState('');
  const [userId, setUserId] = useState('');
  const [by, setBy] = useState<'actor' | 'assignee'>('actor');
  const [projects, setProjects] = useState<{ id: string; name: string }[]>([]);
  const [people, setPeople] = useState<{ id: string; name: string }[]>([]);
  const [data, setData] = useState<ChangeSummary | null>(null);
  const [err, setErr] = useState('');
  const [drill, setDrill] = useState<{ kind: ChangeKindKey; userId?: string | null; title: string } | null>(null);

  useEffect(() => {
    api.listProjects().then((ps: any[]) => setProjects(ps.map((p) => ({ id: String(p.id), name: p.name })))).catch(() => undefined);
    api.listUsers().then((us: any[]) => setPeople(us.filter((u) => u.isActive !== false).map((u) => ({ id: String(u.id), name: u.fullName ?? u.full_name })))).catch(() => undefined);
  }, []);

  const params = useCallback(() => {
    const r = range(preset, custom);
    return { from: r.from, to: r.to, tz: TZ, projectId: projectId || undefined, userId: userId || undefined, by };
  }, [preset, custom, projectId, userId, by]);

  const load = useCallback(async () => {
    setErr('');
    try { setData(await api.radarChanges(params())); }
    catch (e) { setErr(e instanceof ApiError ? e.message : 'Не удалось загрузить изменения'); }
  }, [params]);

  useEffect(() => { void load(); }, [load]);
  // за экраном следят днём — освежаем раз в минуту и при возвращении на вкладку
  useEffect(() => {
    const t = window.setInterval(() => { if (document.visibilityState === 'visible') void load(); }, 60_000);
    const onVis = () => { if (document.visibilityState === 'visible') void load(); };
    document.addEventListener('visibilitychange', onVis);
    return () => { window.clearInterval(t); document.removeEventListener('visibilitychange', onVis); };
  }, [load]);

  const exportCsv = async () => {
    const q = new URLSearchParams(Object.entries(params()).filter(([, v]) => v) as [string, string][]);
    const blob = await api.authedBlob(`/api/radar/changes/export?${q}`);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `изменения-${range(preset, custom).from}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  };

  const since = data?.journalSince ? new Date(data.journalSince) : null;
  const label = (k: ChangeKindKey) => data?.kinds.find((x) => x.key === k)?.label ?? k;

  return (
    <section className="pulse-card pulse-span tch">
      <div className="pulse-card-head">
        <h3>Изменения по задачам</h3>
        <span className="dim">по истории переходов, а не по текущему статусу</span>
      </div>

      <div className="tch-filters">
        <span className="view-switch" role="group" aria-label="Период">
          {PRESETS.map((p) => (
            <button key={p.key} className={`view-btn ${preset === p.key ? 'active' : ''}`} onClick={() => setPreset(p.key)}>{p.label}</button>
          ))}
        </span>
        {preset === 'custom' && (
          <span className="tch-range">
            <input type="date" className="input" aria-label="С" value={custom.from} onChange={(e) => setCustom({ ...custom, from: e.target.value })} />
            <input type="date" className="input" aria-label="По" value={custom.to} onChange={(e) => setCustom({ ...custom, to: e.target.value })} />
          </span>
        )}
        <Select size="sm" ariaLabel="Проект" value={projectId} onValueChange={setProjectId}
          options={[{ value: '', label: 'Все проекты' }, ...projects.map((p) => ({ value: p.id, label: p.name }))]} />
        <Select size="sm" ariaLabel="Сотрудник" value={userId} onValueChange={setUserId}
          options={[{ value: '', label: 'Все сотрудники' }, ...people.map((p) => ({ value: p.id, label: p.name }))]} />
        <span className="view-switch" role="group" aria-label="Как считать людей">
          <button className={`view-btn ${by === 'actor' ? 'active' : ''}`} onClick={() => setBy('actor')} title="Кто перенёс задачу">По действию</button>
          <button className={`view-btn ${by === 'assignee' ? 'active' : ''}`} onClick={() => setBy('assignee')} title="Чья это задача">По исполнителю</button>
        </span>
        <Button size="sm" variant="ghost" onClick={() => void exportCsv()} disabled={!data?.transitions}>
          <Icon name="download" size={14} /> CSV
        </Button>
      </div>

      {err && <div className="error-text"><Icon name="alert" size={12} /> {err}</div>}
      {data && (
        <>
          <div className="tch-totals">
            {MAIN.map((k) => (
              <button key={k} className="tch-total" onClick={() => data.totals[k] && setDrill({ kind: k, title: label(k) })} disabled={!data.totals[k]}>
                <span className="tch-num">{data.totals[k]}</span>
                <span className="tch-label">{label(k)}</span>
                {data.unique[k] !== data.totals[k] && <span className="dim tch-uniq">задач: {data.unique[k]}</span>}
              </button>
            ))}
          </div>
          {(data.totals.blocked > 0 || data.totals.unblocked > 0) && (
            <div className="dim tch-extra">
              Заблокировано: {data.totals.blocked} · разблокировано: {data.totals.unblocked}
            </div>
          )}
          {data.returnRate !== null && data.totals.entered_testing >= 5 && (
            <div className="dim tch-extra">Вернулось из теста {data.returnRate}% — это движение процесса, а не оценка работы.</div>
          )}

          {data.users.length > 0 && (
            <div className="tch-users" role="table" aria-label={by === 'actor' ? 'Кто переносил' : 'Чьи задачи'}>
              <div className="tch-urow tch-uhead" role="row">
                <span role="columnheader">{by === 'actor' ? 'Кто переносил' : 'Чьи задачи'}</span>
                {MAIN.map((k) => <span key={k} role="columnheader">{SHORT[k]}</span>)}
              </div>
              {data.users.map((u) => (
                <div key={u.userId ?? 'none'} className="tch-urow" role="row">
                  <span role="cell">{u.name}</span>
                  {MAIN.map((k) => (
                    <span key={k} role="cell">
                      {u.counts[k]
                        ? <button className="pulse-link" onClick={() => setDrill({ kind: k, userId: u.userId, title: `${label(k)} · ${u.name}` })}>{u.counts[k]}</button>
                        : <span className="dim">—</span>}
                    </span>
                  ))}
                </div>
              ))}
            </div>
          )}
          {!data.transitions && <div className="dim">За этот период переходов нет.</div>}
          {since && (
            <div className="dim tch-extra">Данные доступны с {since.toLocaleDateString('ru-RU')} — с начала журнала переходов.</div>
          )}
        </>
      )}

      {drill && (
        <ChangeList
          title={drill.title}
          query={{ ...params(), kind: drill.kind, ...(drill.userId !== undefined ? { userId: drill.userId ?? undefined } : {}) }}
          onClose={() => setDrill(null)}
        />
      )}
    </section>
  );
}

/** Конкретные переходы по клику (§13): задача, проект, кто, чья, откуда → куда, когда. */
function ChangeList({ title, query, onClose }: { title: string; query: Record<string, string | undefined>; onClose: () => void }) {
  const [items, setItems] = useState<ChangeEvent[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const more = async (from: string | null) => {
    setBusy(true);
    try {
      const r = await api.radarChangeEvents({ ...query, ...(from ? { cursor: from } : {}) });
      setItems((prev) => (from ? [...prev, ...r.items] : r.items));
      setCursor(r.nextCursor);
    } finally { setBusy(false); }
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { void more(null); }, []);
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }} title={title} size="lg"
      footer={cursor ? <Button variant="ghost" loading={busy} onClick={() => void more(cursor)}>Показать ещё</Button> : undefined}>
      {!items.length && !busy && <div className="dim">Нет переходов.</div>}
      {items.map((e) => (
        <div key={e.id} className="pulse-row tch-event">
          <button className="pulse-link" onClick={() => { onClose(); navigate({ section: 'projects', projectId: String(e.projectId), taskId: e.taskId }); }}>
            #{e.taskId} {e.title}
          </button>
          <span className="dim">
            {e.projectName} · {e.fromLabel} → {e.toLabel} · {e.actorName ?? (e.actorType === 'SYSTEM_AGENT' ? 'ИИ' : e.sourceLabel)}
            {e.assigneeName && e.assigneeName !== e.actorName ? ` · исполнитель ${e.assigneeName}` : ''} · {time(e.changedAt)}
          </span>
        </div>
      ))}
    </Dialog>
  );
}
