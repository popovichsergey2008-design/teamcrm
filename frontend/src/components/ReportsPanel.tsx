import { useEffect, useMemo, useState } from 'react';
import { Icon } from './Icon';
import { DatePicker } from './DatePicker';
import { api, ApiError, ReportKpi, ReportSummary } from '../lib/api';
import { useEscape } from '../hooks/useEscape';
import { overlayProps } from '../lib/overlay';
import { platform } from '../platform';

type Preset = 'week' | 'prevweek' | 'month' | 'prevmonth' | 'quarter' | 'prevquarter' | 'year' | 'custom';

const PRESETS: { key: Preset; label: string }[] = [
  { key: 'week', label: 'Эта неделя' },
  { key: 'prevweek', label: 'Прошлая неделя' },
  { key: 'month', label: 'Этот месяц' },
  { key: 'prevmonth', label: 'Прошлый месяц' },
  { key: 'quarter', label: 'Квартал' },
  { key: 'prevquarter', label: 'Прошлый квартал' },
  { key: 'year', label: 'С начала года' },
  { key: 'custom', label: 'Свои даты' },
];

const pad = (n: number) => String(n).padStart(2, '0');
const iso = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** Границы готовых периодов. Неделя — с понедельника, как в календаре. */
function presetRange(p: Preset, now = new Date()): { from: string; to: string } | null {
  const y = now.getFullYear(); const m = now.getMonth();
  const monday = new Date(y, m, now.getDate() - ((now.getDay() + 6) % 7));
  const q = Math.floor(m / 3) * 3;
  switch (p) {
    case 'week': return { from: iso(monday), to: iso(new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 6)) };
    case 'prevweek': {
      const s = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() - 7);
      return { from: iso(s), to: iso(new Date(s.getFullYear(), s.getMonth(), s.getDate() + 6)) };
    }
    case 'month': return { from: iso(new Date(y, m, 1)), to: iso(new Date(y, m + 1, 0)) };
    case 'prevmonth': return { from: iso(new Date(y, m - 1, 1)), to: iso(new Date(y, m, 0)) };
    case 'quarter': return { from: iso(new Date(y, q, 1)), to: iso(new Date(y, q + 3, 0)) };
    case 'prevquarter': return { from: iso(new Date(y, q - 3, 1)), to: iso(new Date(y, q, 0)) };
    case 'year': return { from: iso(new Date(y, 0, 1)), to: iso(now) };
    default: return null;
  }
}

function kpiValue(k: ReportKpi): string {
  if (k.value === null) return '—';
  const v = String(k.value).replace('.', ',');
  return k.unit === 'pct' ? `${v}%` : k.unit === 'days' ? `${v} дн.` : k.unit === 'hours' ? `${v} ч` : v;
}

function kpiDelta(k: ReportKpi): { text: string; tone: string } | null {
  if (k.value === null || k.prev === null || k.value === k.prev) return null;
  const up = k.value > k.prev;
  const tone = k.goodWhenUp === null ? '' : up === k.goodWhenUp ? 'good' : 'bad';
  const diff = Math.round(Math.abs(k.value - k.prev) * 10) / 10;
  return { text: `${up ? '▲' : '▼'} ${String(diff).replace('.', ',')}${k.unit === 'pct' ? ' п.п.' : ''}`, tone };
}

/**
 * «Отчёты» в личном кабинете: PDF по задачам за период.
 *
 * Отчёт собирается на сервере — здесь только условия и короткая сводка тех же цифр,
 * чтобы до скачивания было видно, что окажется внутри. Сотрудник видит только свой
 * отчёт (сервер всё равно не даст чужой), руководитель — по компании, проекту или
 * любому сотруднику.
 */
export function ReportsPanel({ canManage, onClose }: { canManage: boolean; onClose: () => void }) {
  useEscape(onClose);
  const [preset, setPreset] = useState<Preset>('prevmonth');
  const initial = presetRange('prevmonth')!;
  const [from, setFrom] = useState(initial.from);
  const [to, setTo] = useState(initial.to);
  const [projectId, setProjectId] = useState('');
  const [userId, setUserId] = useState('');
  const [projects, setProjects] = useState<{ id: string; name: string }[]>([]);
  const [people, setPeople] = useState<{ id: string; name: string }[]>([]);
  const [summary, setSummary] = useState<ReportSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    api.listProjects(true).then((list) => setProjects(list.map((p) => ({ id: String(p.id), name: p.name })))).catch(() => undefined);
    if (canManage) {
      api.listUsers().then((list) => setPeople(list
        .filter((u) => u.role !== 'client' && u.isActive !== false)
        .map((u) => ({ id: String(u.id), name: u.fullName ?? u.full_name ?? u.email }))
        .sort((a, b) => a.name.localeCompare(b.name, 'ru')))).catch(() => undefined);
    }
  }, [canManage]);

  const pick = (p: Preset) => {
    setPreset(p);
    const r = presetRange(p);
    if (r) { setFrom(r.from); setTo(r.to); }
  };

  const query = useMemo(() => ({ from, to, projectId: projectId || undefined, userId: userId || undefined }), [from, to, projectId, userId]);
  const valid = !!from && !!to && from <= to;

  // сводка — по тем же правилам, что и PDF; с задержкой, чтобы не дёргать сервер на каждый щелчок
  useEffect(() => {
    if (!valid) { setSummary(null); return; }
    let alive = true;
    setLoading(true); setErr('');
    const t = window.setTimeout(() => {
      api.reportSummary(query)
        .then((s) => { if (alive) setSummary(s); })
        .catch((e) => { if (alive) { setSummary(null); setErr(e instanceof ApiError ? e.message : 'Не удалось посчитать отчёт'); } })
        .finally(() => { if (alive) setLoading(false); });
    }, 300);
    return () => { alive = false; window.clearTimeout(t); };
  }, [query, valid]);

  const download = async () => {
    if (!valid) return;
    setBusy(true); setErr('');
    try {
      const blob = await api.reportPdf(query);
      const scope = [projects.find((p) => p.id === projectId)?.name, people.find((p) => p.id === userId)?.name].filter(Boolean).join(', ');
      const name = `Отчёт по задачам — ${summary?.periodLabel ?? `${from}–${to}`}${scope ? ` — ${scope}` : ''}.pdf`.replace(/[\\/:*?"<>|«»]/g, ' ');
      await platform.filesystem.save(name, blob);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Не удалось собрать PDF — попробуйте ещё раз');
    } finally { setBusy(false); }
  };

  return (
    <div className="drawer-overlay" {...overlayProps(onClose)}>
      <aside className="drawer drawer-wide reports-panel" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-head">
          <h3><Icon name="chart" size={18} /> Отчёты</h3>
          <button className="btn btn-ghost btn-sm" onClick={onClose} title="Закрыть"><Icon name="close" /></button>
        </div>

        <p className="dim reports-lead">
          PDF-отчёт по задачам за период: что поставили и выполнили, соблюдение сроков, разбивка по проектам
          и {canManage ? 'исполнителям' : 'вашим задачам'}, просроченное и под риском, затраченное время —
          со сравнением с прошлым таким же периодом.
        </p>

        <div className="drawer-section-title">Период</div>
        <div className="reports-presets" role="radiogroup" aria-label="Период отчёта">
          {PRESETS.map((p) => (
            <button
              key={p.key}
              className={`chip-btn${preset === p.key ? ' active' : ''}`}
              role="radio"
              aria-checked={preset === p.key}
              onClick={() => pick(p.key)}
            >
              {p.label}
            </button>
          ))}
        </div>
        <div className="reports-dates">
          <label><span className="dim">с</span>
            <DatePicker value={from} onChange={(v) => { setFrom(v); setPreset('custom'); }} />
          </label>
          <label><span className="dim">по</span>
            <DatePicker value={to} onChange={(v) => { setTo(v); setPreset('custom'); }} />
          </label>
        </div>
        {!valid && <div className="error-text">{!from || !to ? 'Укажите обе даты периода.' : 'Дата «с» позже даты «по».'}</div>}

        <div className="drawer-section-title">Что включить</div>
        <div className="reports-filters">
          <select className="input" value={projectId} onChange={(e) => setProjectId(e.target.value)} aria-label="Проект">
            <option value="">Все проекты</option>
            {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          {canManage ? (
            <select className="input" value={userId} onChange={(e) => setUserId(e.target.value)} aria-label="Исполнитель">
              <option value="">Все сотрудники</option>
              {people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          ) : (
            <div className="dim reports-mine"><Icon name="user" size={14} /> Только ваши задачи</div>
          )}
        </div>

        <div className="drawer-section-title">
          Что будет в отчёте{summary ? <span className="dim"> · {summary.periodLabel} · {summary.scopeLabel}</span> : null}
        </div>
        {loading && !summary && <div className="dim">Считаю…</div>}
        {summary && summary.empty && (
          <div className="dim reports-empty">За этот период по выбранным условиям задач нет — PDF получится пустым.</div>
        )}
        {summary && !summary.empty && (
          <>
            <div className={`reports-kpis${loading ? ' is-stale' : ''}`}>
              {summary.kpis.map((k) => {
                const d = kpiDelta(k);
                return (
                  <div className="reports-kpi" key={k.key} title={k.hint}>
                    <div className="reports-kpi-l">{k.label}</div>
                    <div className="reports-kpi-v">{kpiValue(k)}</div>
                    {d && <div className={`reports-kpi-d ${d.tone}`}>{d.text}</div>}
                  </div>
                );
              })}
            </div>
            <ul className="reports-insights">
              {summary.insights.slice(0, 4).map((x) => <li key={x}>{x}</li>)}
            </ul>
            <div className="dim reports-counts">
              В PDF ещё: график динамики, разбивка по проектам и людям, выполненные
              ({summary.counts.completed}), просроченные ({summary.counts.overdue}), под риском ({summary.counts.soon})
              {summary.counts.review ? `, ждут приёмки (${summary.counts.review})` : ''}. Сравнение — с периодом {summary.prevLabel}.
            </div>
          </>
        )}

        {err && <div className="error-text">{err}</div>}
        <div className="reports-actions">
          <button className="btn btn-primary" onClick={() => void download()} disabled={!valid || busy}>
            <Icon name="download" size={16} /> {busy ? 'Собираю PDF…' : 'Скачать PDF'}
          </button>
          <span className="dim">Собирается за несколько секунд</span>
        </div>
      </aside>
    </div>
  );
}
