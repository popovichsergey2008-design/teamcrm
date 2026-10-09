import { useCallback, useEffect, useMemo, useState } from 'react';
import './pulse.css';
import { Icon } from '../components/Icon';
import { SkeletonList } from '../components/Skeleton';
import { Button } from '../components/ui/button';
import { Badge } from '../components/ui/badge';
import { Dialog } from '../components/ui/dialog';
import { Select } from '../components/ui/select';
import { api, ApiError } from '../lib/api';
import type { PulseActionType, PulseSummary } from '../lib/api';
import { navigate } from '../lib/router';
import { getSocket } from '../lib/socket';
import { showToast } from '../lib/notifications';

/**
 * «Пульс команды» как командный центр руководителя (ТЗ-19).
 *
 * Экран отвечает на пять вопросов: здоровы ли процессы, где главный затык, что ждёт
 * моего решения, что будет, если ничего не менять, что можно исправить сейчас. Все
 * цифры считает сервер правилами; каждое действие — предпросмотр и подтверждение.
 */

type Data = PulseSummary;
type Bottleneck = Data['bottlenecks'][number];

const ZONE_TITLE: Record<Data['health']['zone'], string> = { healthy: 'Здорово', attention: 'Внимание', risk: 'Риск', critical: 'Критично' };
const COMPONENT_TITLE: Record<keyof Data['health']['components'], string> = {
  delivery: 'Закрываем столько, сколько приходит', deadlines: 'Сроки', flow: 'Движение задач', capacity: 'Загрузка', velocity: 'Скорость',
};
const ACTION_TITLE: Record<PulseActionType, string> = {
  TASK_NUDGE: 'Спросить статус', REVIEW_REMINDER: 'Напомнить о проверке', TASK_REASSIGN: 'Переназначить',
  TASK_RESCHEDULE: 'Сдвинуть срок', TASK_CREATE_MEETING: 'Созвон', TASK_FOCUS: 'В мой Фокус', PUBLISH_NEWS: 'Опубликовать',
};
const DECISION_TITLE: Record<string, string> = {
  approval: 'Согласование', review: 'Проверить работу', deadline_shift: 'Просят перенести срок', no_assignee: 'Назначить исполнителя',
  blocked: 'Блокер', client: 'Клиент ждёт', meeting: 'Итоги встречи',
};
const BAND_TITLE = { available: 'свободен', normal: 'норма', high: 'высокая', overloaded: 'выше нормы' } as const;
const NOT_PROBLEM: { key: string; label: string }[] = [
  { key: 'not_stuck', label: 'Задача не зависла' }, { key: 'load_wrong', label: 'Нагрузка посчитана неверно' },
  { key: 'not_critical', label: 'Срок не критичен' }, { key: 'outdated', label: 'Риск неактуален' }, { key: 'other', label: 'Другое' },
];

const dateRu = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' }) : '—');
const ago = (iso: string) => {
  const h = Math.floor((Date.now() - new Date(iso).getTime()) / 3_600_000);
  return h < 48 ? `${Math.max(1, h)} ч` : `${Math.floor(h / 24)} дн.`;
};

/** Прогрев по наведению на пункт меню — сводка тяжелее прочих экранов. */
export function prefetchPulse() { void api.pulse().catch(() => undefined); }

export function PulsePage() {
  const [data, setData] = useState<Data | null>(null);
  const [err, setErr] = useState('');
  const [why, setWhy] = useState(false);
  const [action, setAction] = useState<null | { type: PulseActionType; taskId?: string; title?: string; text?: string }>(null);
  const [rebalanceFor, setRebalanceFor] = useState<string | null>(null);
  const [triage, setTriage] = useState<number | null>(null);
  const [allBottlenecks, setAllBottlenecks] = useState(false);

  const load = useCallback(() => {
    api.pulse().then((d) => { setData(d); setErr(''); }).catch((e) => setErr(e instanceof ApiError ? e.message : 'Не удалось собрать «Пульс»'));
  }, []);
  useEffect(() => {
    load();
    const socket = getSocket();
    const on = () => load();
    socket.on('radar.changed', on);
    // раз в две минуты, пока экран на виду: задачи меняются, а «Пульс» — снимок
    const t = window.setInterval(() => { if (!document.hidden) load(); }, 120_000);
    return () => { socket.off('radar.changed', on); window.clearInterval(t); };
  }, [load]);

  const notProblem = async (kind: string, ref: string, reason: string) => {
    await api.pulseFeedback(kind, ref, reason).catch(() => undefined);
    showToast({ kind: 'saved', title: 'Скрыто на неделю', body: 'Спасибо — по таким отметкам правила становятся точнее' });
    load();
  };

  if (!data) {
    return (
      <div className="page pulse-page">
        <div className="page-head"><h2><Icon name="chart" size={18} /> Пульс команды</h2></div>
        {err ? <div className="error-text">{err}</div> : <SkeletonList rows={8} />}
      </div>
    );
  }

  const h = data.health;
  const top = data.bottlenecks[0];
  const shownBottlenecks = allBottlenecks ? data.bottlenecks : data.bottlenecks.slice(0, 6);
  const forecasts = data.allProjects.filter((p) => p.open > 0).sort((a, b) => (b.forecast.delayDays ?? -999) - (a.forecast.delayDays ?? -999));

  return (
    <div className="page pulse-page">
      <div className="page-head">
        <h2><Icon name="chart" size={18} /> Пульс команды</h2>
        <span className="dim">обновлено {new Date(data.generatedAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}</span>
        <Button variant="ghost" size="sm" onClick={load} aria-label="Обновить"><Icon name="refresh" size={14} /></Button>
      </div>

      {/* 1. Вердикт */}
      <section className={`pulse-card pulse-verdict pz-${h.zone}`}>
        <div className="pulse-score" aria-label={`Индекс здоровья ${h.score} из 100`}>
          <svg viewBox="0 0 64 64" aria-hidden="true">
            <circle cx="32" cy="32" r="28" className="pulse-ring-bg" />
            <circle cx="32" cy="32" r="28" className="pulse-ring" strokeDasharray={`${(h.score / 100) * 175.9} 175.9`} />
          </svg>
          <b>{h.score}</b>
          <span>{ZONE_TITLE[h.zone]}</span>
        </div>
        <div className="pulse-verdict-text">
          <div className="pulse-headline">{data.verdict.headline}</div>
          {data.verdict.lines.map((l) => <p key={l}>{l}</p>)}
          <div className="dim pulse-sources">
            Основано на: {data.verdict.sources.projects} проектах · {data.verdict.sources.tasks} открытых задачах ·
            {' '}{data.verdict.sources.people} сотрудниках · скорость {data.verdict.sources.last7} против {data.verdict.sources.prev7}
          </div>
          <div className="pulse-acts">
            <Button size="sm" variant="ghost" onClick={() => setWhy((v) => !v)} aria-expanded={why}>Почему {h.score}?</Button>
            {top && data.can.act && (
              <Button size="sm" variant="primary" onClick={() => setAction({ type: top.actions[0], taskId: top.taskId, title: top.title })}>
                Разрулить главное: #{top.taskId}
              </Button>
            )}
          </div>
          {why && (
            <div className="pulse-why">
              {(Object.keys(h.components) as (keyof typeof h.components)[]).map((k) => (
                <div key={k} className="pulse-why-row">
                  <span>{COMPONENT_TITLE[k]}</span>
                  <span className="pulse-bar"><i style={{ width: `${h.components[k]}%` }} className={h.components[k] >= 85 ? 'ok' : h.components[k] >= 70 ? 'mid' : 'bad'} /></span>
                  <b>{h.components[k]}</b>
                </div>
              ))}
              <div className="dim">Формула {h.version}: доставка 25% · сроки 20% · движение 20% · загрузка 20% · скорость 15%.</div>
            </div>
          )}
        </div>
      </section>

      {/* победы — не только проблемы (§70) */}
      {data.victories.length > 0 && (
        <section className="pulse-card pulse-win">
          <Icon name="sparkles" size={16} />
          <div className="pulse-win-text">{data.victories.map((v) => <div key={v}>{v}</div>)}</div>
          {data.can.publish && <Button size="sm" onClick={() => setAction({ type: 'PUBLISH_NEWS', text: data.victories.join('\n') })}>Опубликовать победу</Button>}
        </section>
      )}

      <div className="pulse-grid">
        {/* 2. Решения */}
        <section className="pulse-card pulse-span">
          <div className="pulse-card-head">
            <h3>Требуют вашего решения — {data.decisions.length}</h3>
            {data.decisions.length > 0 && <Button size="sm" variant="primary" onClick={() => setTriage(0)}>Разобрать всё</Button>}
          </div>
          {data.decisions.length === 0 && <div className="dim">Решений от вас никто не ждёт.</div>}
          {data.decisions.slice(0, 5).map((d) => (
            <div key={d.id} className="pulse-row">
              <Badge tone={d.urgent || d.kind === 'blocked' ? 'danger' : d.kind === 'client' ? 'warn' : 'neutral'}>{DECISION_TITLE[d.kind] ?? d.kind}</Badge>
              <button className="pulse-link" onClick={() => openDecision(d)}>{d.title}</button>
              <span className="dim">{d.who ? `${d.who} · ` : ''}ждёт {ago(d.since)}</span>
            </div>
          ))}
        </section>

        {/* 3. Узкие места */}
        <section className="pulse-card">
          <div className="pulse-card-head"><h3>Узкие места — {data.bottlenecks.length}</h3></div>
          {data.bottlenecks.length === 0 && <div className="dim">Критичных узких мест нет.</div>}
          {shownBottlenecks.map((b) => (
            <BottleneckRow key={b.taskId} b={b} canAct={data.can.act}
              onAction={(type) => setAction({ type, taskId: b.taskId, title: b.title })}
              onNotProblem={(reason) => { void notProblem('bottleneck', b.taskId, reason); }} />
          ))}
          {data.bottlenecks.length > 6 && (
            <Button size="sm" variant="ghost" onClick={() => setAllBottlenecks((v) => !v)}>{allBottlenecks ? 'Свернуть' : `Показать все (${data.bottlenecks.length})`}</Button>
          )}
        </section>

        {/* 4. Загрузка */}
        <section className="pulse-card">
          <div className="pulse-card-head"><h3>Загрузка</h3><span className="dim">по задачам, не по часам</span></div>
          {data.workload.length === 0 && <div className="dim">Открытых задач у команды нет.</div>}
          {data.workload.map((w) => (
            <div key={w.id} className={`pulse-load pb-${w.band}`}>
              <div className="pulse-load-top">
                <b>{w.name}</b>{!w.available && <Badge tone="outline">в отпуске</Badge>}
                <span className="pulse-load-pct">{w.pct}%</span>
              </div>
              <span className="pulse-bar"><i style={{ width: `${Math.min(100, w.pct)}%` }} /></span>
              <div className="dim pulse-load-meta">
                {w.active} задач · {w.urgent} срочных · {w.overdue} просрочено{w.reviews ? ` · проверить ${w.reviews}` : ''}{w.meetingHours ? ` · встречи ${w.meetingHours} ч` : ''}
                {' '}· {BAND_TITLE[w.band]} · риск задержек {w.risk}
              </div>
              <div className="pulse-acts">
                {w.band === 'overloaded' && data.can.rebalance && <Button size="sm" onClick={() => setRebalanceFor(w.id)}>Балансировать</Button>}
                {data.can.editNorms && <NormEdit userId={w.id} norm={w.norm} onSaved={load} />}
              </div>
            </div>
          ))}
        </section>

        {/* 5. Прогноз */}
        <section className="pulse-card pulse-span">
          <div className="pulse-card-head"><h3>Прогноз сроков</h3><span className="dim">по темпу последних 4 недель</span></div>
          {forecasts.length === 0 && <div className="dim">Открытых проектов нет.</div>}
          {forecasts.slice(0, 8).map((p) => <ForecastRow key={p.id} p={p} onSaved={load} />)}
        </section>

        {/* 6. Скорость */}
        <section className="pulse-card">
          <div className="pulse-card-head"><h3>Скорость</h3></div>
          <div className="pulse-velocity">
            <b>{data.velocity.last7}</b>
            <span>против {data.velocity.prev7}</span>
            {data.velocity.delta !== null && <Badge tone={data.velocity.delta >= 0 ? 'ok' : 'warn'}>{data.velocity.delta > 0 ? '+' : ''}{data.velocity.delta}%</Badge>}
          </div>
          <div className="dim">{data.velocity.label}: эта неделя против прошлой</div>
        </section>

        {/* 7. Проекты под риском */}
        <section className="pulse-card">
          <div className="pulse-card-head"><h3>Проекты под риском</h3></div>
          {data.projects.filter((p) => p.risk.level !== 'low').length === 0 && <div className="dim">Все проекты в допустимом диапазоне.</div>}
          {data.projects.filter((p) => p.risk.level !== 'low').map((p) => (
            <div key={p.id} className="pulse-row pulse-project">
              <Badge tone={p.risk.level === 'high' ? 'danger' : 'warn'}>{p.risk.level === 'high' ? 'Высокий' : 'Средний'}</Badge>
              <button className="pulse-link" onClick={() => navigate({ section: 'projects', projectId: p.id })}>{p.name}</button>
              <span className="dim">готово {p.progress}% · просрочено {p.overdue} · без движения {p.stuck}{p.forecast.delayDays && p.forecast.delayDays > 0 ? ` · опоздание ${p.forecast.delayDays} дн.` : ''}</span>
            </div>
          ))}
        </section>
      </div>

      {action && <ActionDialog action={action} people={data.workload} onClose={() => setAction(null)} onDone={load} />}
      {rebalanceFor && <RebalanceDialog userId={rebalanceFor} onClose={() => setRebalanceFor(null)} onDone={load} />}
      {triage !== null && data.decisions[triage] && (
        <Dialog open onOpenChange={(o) => { if (!o) setTriage(null); }} title={`Решение ${triage + 1} из ${data.decisions.length}`} size="md"
          footer={(
            <>
              <Button variant="ghost" onClick={() => { void notProblem('decision', data.decisions[triage].id, 'other'); setTriage(triage + 1 < data.decisions.length ? triage + 1 : null); }}>Не проблема</Button>
              {data.decisions[triage].taskId && data.can.act && (
                <Button variant="ghost" onClick={() => setAction({ type: 'TASK_FOCUS', taskId: data.decisions[triage].taskId!, title: data.decisions[triage].title })}>В мой Фокус</Button>
              )}
              <Button onClick={() => openDecision(data.decisions[triage])}>Открыть</Button>
              <Button variant="primary" onClick={() => setTriage(triage + 1 < data.decisions.length ? triage + 1 : null)}>{triage + 1 < data.decisions.length ? 'Дальше' : 'Готово'}</Button>
            </>
          )}>
          <Badge tone="neutral">{DECISION_TITLE[data.decisions[triage].kind]}</Badge>
          <div className="pulse-headline">{data.decisions[triage].title}</div>
          <div className="dim">{data.decisions[triage].who ? `${data.decisions[triage].who} · ` : ''}ждёт {ago(data.decisions[triage].since)}{data.decisions[triage].dueAt ? ` · срок ${dateRu(data.decisions[triage].dueAt)}` : ''}</div>
        </Dialog>
      )}
    </div>
  );
}

function openDecision(d: PulseSummary['decisions'][number]) {
  if (d.clientId) navigate({ section: 'clients', clientId: d.clientId });
  else if (d.taskId && d.projectId) navigate({ section: 'projects', projectId: d.projectId, taskId: d.taskId });
  else if (d.kind === 'meeting') navigate({ section: 'chat', view: 'meetings' });
  else if (d.kind === 'approval') navigate({ section: 'focus' });
}

function BottleneckRow({ b, canAct, onAction, onNotProblem }: {
  b: Bottleneck; canAct: boolean; onAction: (t: PulseActionType) => void; onNotProblem: (reason: string) => void;
}) {
  const [menu, setMenu] = useState(false);
  return (
    <div className="pulse-bn">
      <div className="pulse-bn-top">
        <Badge tone={b.type === 'OVERDUE' || b.type === 'BLOCKED' ? 'danger' : 'warn'}>{b.typeTitle}</Badge>
        <button className="pulse-link" onClick={() => navigate({ section: 'projects', projectId: b.projectId, taskId: b.taskId })}>#{b.taskId} {b.title}</button>
      </div>
      <div className="dim">{b.why} · {b.assignee ?? 'без исполнителя'} · {b.projectName}</div>
      <div className="pulse-acts">
        {canAct && b.actions.slice(0, 3).map((t) => <Button key={t} size="sm" variant={t === b.actions[0] ? 'primary' : 'secondary'} onClick={() => onAction(t)}>{ACTION_TITLE[t]}</Button>)}
        <Button size="sm" variant="ghost" onClick={() => setMenu((v) => !v)} aria-expanded={menu}>Это не проблема</Button>
      </div>
      {menu && (
        <div className="pulse-reasons">
          {NOT_PROBLEM.map((r) => <button key={r.key} className="pulse-chip" onClick={() => { setMenu(false); onNotProblem(r.key); }}>{r.label}</button>)}
        </div>
      )}
    </div>
  );
}

function NormEdit({ userId, norm, onSaved }: { userId: string; norm: number; onSaved: () => void }) {
  const [v, setV] = useState(String(norm));
  const [open, setOpen] = useState(false);
  if (!open) return <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>Норма: {norm}</Button>;
  return (
    <span className="pulse-acts">
      <input className="input pulse-num" inputMode="numeric" value={v} onChange={(e) => setV(e.target.value)} aria-label="Норма нагрузки в очках" />
      <Button size="sm" onClick={() => {
        api.pulseNorm(userId, v.trim() ? Number(v) : null).then(() => { setOpen(false); onSaved(); })
          .catch((e) => showToast({ kind: 'info', title: 'Не сохранилось', body: e instanceof ApiError ? e.message : '' }));
      }}>Сохранить</Button>
    </span>
  );
}

function ForecastRow({ p, onSaved }: { p: PulseSummary['allProjects'][number]; onSaved: () => void }) {
  const [plan, setPlan] = useState(p.targetDate ?? '');
  const [open, setOpen] = useState(false);
  const f = p.forecast;
  const late = f.delayDays !== null && f.delayDays > 0;
  return (
    <div className="pulse-fc">
      <div className="pulse-fc-top">
        <button className="pulse-link" onClick={() => navigate({ section: 'projects', projectId: p.id })}>{p.name}</button>
        {late && <Badge tone="danger">+{f.delayDays} дн.</Badge>}
        {f.delayDays !== null && f.delayDays <= 0 && <Badge tone="ok">успевает</Badge>}
      </div>
      <div className="pulse-fc-grid">
        <label className="pulse-fc-cell"><span className="dim">План</span>
          <input type="date" className="input" value={plan} aria-label={`Срок проекта ${p.name}`}
            onChange={(e) => { setPlan(e.target.value); void api.pulseTarget(p.id, e.target.value || null).then(onSaved).catch(() => undefined); }} />
        </label>
        <div className="pulse-fc-cell"><span className="dim">Прогноз</span><b>{f.date ? dateRu(f.date) : 'не назвать'}</b></div>
        <div className="pulse-fc-cell"><span className="dim">Уверенность</span><b>{f.reliable ? `${f.confidence}%` : 'мало данных'}</b></div>
        <div className="pulse-fc-cell"><span className="dim">Осталось</span><b>{p.open}</b></div>
      </div>
      <div className="dim">Причины: {f.factors.join(' · ')}</div>
      {p.catchUp.length > 0 && (
        <>
          <Button size="sm" variant="ghost" onClick={() => setOpen((v) => !v)} aria-expanded={open}>Что сделать, чтобы успеть?</Button>
          {open && <ol className="pulse-plan">{p.catchUp.map((s) => <li key={s}>{s}</li>)}</ol>}
        </>
      )}
    </div>
  );
}

/** Любое действие: сначала предпросмотр с сервера, потом подтверждение (§47). */
function ActionDialog({ action, people, onClose, onDone }: {
  action: { type: PulseActionType; taskId?: string; title?: string; text?: string };
  people: PulseSummary['workload']; onClose: () => void; onDone: () => void;
}) {
  const needsPerson = action.type === 'TASK_REASSIGN';
  const needsDate = action.type === 'TASK_RESCHEDULE';
  const needsText = action.type === 'PUBLISH_NEWS';
  const [toUserId, setTo] = useState('');
  const [date, setDate] = useState('');
  const [text, setText] = useState(action.text ?? '');
  const [pv, setPv] = useState<{ id: string; preview: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const ready = (!needsPerson || toUserId) && (!needsDate || date) && (!needsText || text.trim().length > 4);
  const sorted = useMemo(() => [...people].sort((a, b) => a.pct - b.pct), [people]);

  const preview = useCallback(async () => {
    setBusy(true); setErr('');
    try {
      setPv(await api.pulsePreview({
        type: action.type, taskId: action.taskId, toUserId: toUserId || undefined,
        date: date ? new Date(`${date}T18:00:00`).toISOString() : undefined, text: needsText ? text : undefined,
      }));
    } catch (e) { setErr(e instanceof ApiError ? e.message : 'Не удалось подготовить'); }
    finally { setBusy(false); }
  }, [action.type, action.taskId, toUserId, date, text, needsText]);

  useEffect(() => { if (!needsPerson && !needsDate && !needsText) void preview(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const confirm = async () => {
    if (!pv) return;
    setBusy(true); setErr('');
    try {
      const r = await api.pulseConfirm(pv.id);
      showToast({ kind: 'saved', title: ACTION_TITLE[action.type], body: r.text });
      onDone(); onClose();
    } catch (e) { setErr(e instanceof ApiError ? e.message : 'Не получилось'); }
    finally { setBusy(false); }
  };

  return (
    <Dialog open onOpenChange={(o) => { if (!o) { if (pv) void api.pulseReject(pv.id).catch(() => undefined); onClose(); } }}
      title={ACTION_TITLE[action.type]} description={action.title ? `#${action.taskId} ${action.title}` : undefined}
      footer={(
        <>
          <Button variant="ghost" onClick={() => { if (pv) void api.pulseReject(pv.id).catch(() => undefined); onClose(); }}>Отмена</Button>
          {!pv && <Button variant="primary" disabled={!ready} loading={busy} onClick={() => { void preview(); }}>Показать, что будет</Button>}
          {pv && <Button variant="primary" loading={busy} onClick={() => { void confirm(); }}>Подтвердить</Button>}
        </>
      )}>
      {needsPerson && !pv && (
        <Select ariaLabel="Кому передать" value={toUserId} onValueChange={setTo} placeholder="Кому передать"
          options={sorted.filter((p) => p.available).map((p) => ({ value: p.id, label: `${p.name} — загрузка ${p.pct}%` }))} />
      )}
      {needsDate && !pv && <input type="date" className="input" value={date} onChange={(e) => setDate(e.target.value)} aria-label="Новый срок" />}
      {needsText && !pv && <textarea className="input pulse-text" rows={4} value={text} onChange={(e) => setText(e.target.value)} aria-label="Текст поста" />}
      {pv && <div className="pulse-preview">{pv.preview}</div>}
      {busy && !pv && <div className="dim">Готовлю…</div>}
      {err && <div className="error-text">{err}</div>}
    </Dialog>
  );
}

function RebalanceDialog({ userId, onClose, onDone }: { userId: string; onClose: () => void; onDone: () => void }) {
  const [r, setR] = useState<Awaited<ReturnType<typeof api.pulseRebalance>> | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { api.pulseRebalance(userId).then(setR).catch((e) => setErr(e instanceof ApiError ? e.message : 'Не удалось подобрать')); }, [userId]);
  const close = () => { if (r?.id) void api.pulseReject(r.id).catch(() => undefined); onClose(); };
  return (
    <Dialog open onOpenChange={(o) => { if (!o) close(); }} title={`Балансировка${r?.fromName ? `: ${r.fromName}` : ''}`} size="md"
      footer={(
        <>
          <Button variant="ghost" onClick={close}>Отмена</Button>
          {r?.id && <Button variant="primary" loading={busy} onClick={async () => {
            setBusy(true);
            try { const x = await api.pulseConfirm(r.id!); showToast({ kind: 'saved', title: 'Балансировка', body: x.text }); onDone(); onClose(); }
            catch (e) { setErr(e instanceof ApiError ? e.message : 'Не получилось'); }
            finally { setBusy(false); }
          }}>Применить</Button>}
        </>
      )}>
      {!r && !err && <div className="dim">Подбираю, кому передать…</div>}
      {r && !r.moves.length && <div className="dim">{r.note}</div>}
      {r && r.moves.length > 0 && (
        <>
          {r.moves.map((m) => (
            <div key={m.taskId} className="pulse-move">
              <b>#{m.taskId} {m.title}</b>
              <span>→ {m.toName}</span>
              <span className="dim">{m.reason}</span>
            </div>
          ))}
          <div className="pulse-preview">
            Нагрузка {r.fromName}: {r.before}% → {r.after}%
            {r.loads.filter((l) => l.id !== userId).map((l) => <div key={l.id}>{l.name}: {l.before}% → {l.after}%</div>)}
          </div>
        </>
      )}
      {err && <div className="error-text">{err}</div>}
    </Dialog>
  );
}
