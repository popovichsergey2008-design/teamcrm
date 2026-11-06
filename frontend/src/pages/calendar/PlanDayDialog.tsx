import { useEffect, useMemo, useState } from 'react';
import { Icon } from '../../components/Icon';
import { Button } from '../../components/ui/button';
import { Dialog } from '../../components/ui/dialog';
import { api, ApiError, type DayPlan, type PlanTask } from '../../lib/api';
import { toastSaved } from '../../lib/notifications';
import { fmtMinutes } from './TaskTimeDialog';
import './calendar.css';

const hhmm = (iso: string) => new Date(iso).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/**
 * «Помоги спланировать день» (#4787, п. 14): человек выбирает задачи — QEVO раскладывает
 * их между встречами в рабочих часах, с перерывами. План показывается ДО сохранения;
 * больше, чем вмещает день, не обещается: «На задачи нужно пять часов, свободно три».
 */
export function PlanDayDialog({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [tasks, setTasks] = useState<PlanTask[]>([]);
  const [picked, setPicked] = useState<Record<string, number>>({});
  const [date, setDate] = useState<'today' | 'tomorrow'>('today');
  const [plan, setPlan] = useState<DayPlan | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => { api.calendarPlanTasks().then(setTasks).catch(() => setTasks([])); }, []);

  const day = useMemo(() => { const d = new Date(); if (date === 'tomorrow') d.setDate(d.getDate() + 1); return ymd(d); }, [date]);
  const toggle = (t: PlanTask) => setPicked((p) => {
    const n = { ...p };
    if (n[t.id]) delete n[t.id]; else n[t.id] = t.estimateMin && t.estimateMin <= 480 ? t.estimateMin : 60;
    return n;
  });

  const propose = async () => {
    setBusy(true); setErr('');
    try { setPlan(await api.calendarPlanDay({ date: day, items: Object.entries(picked).map(([taskId, minutes]) => ({ taskId, minutes })) })); }
    catch (e) { setErr(e instanceof ApiError ? e.message : 'Не удалось составить план'); }
    finally { setBusy(false); }
  };

  const apply = async () => {
    if (!plan) return;
    setBusy(true); setErr('');
    try {
      await api.calendarApplyPlan(plan.plan.map((p) => ({ taskId: p.taskId, startsAt: p.startsAt, endsAt: p.endsAt })));
      toastSaved(`План применён: ${plan.plan.length} в календаре`);
      onSaved();
    } catch (e) { setErr(e instanceof ApiError ? e.message : 'Не удалось применить план'); }
    finally { setBusy(false); }
  };

  // встречи и задачи плана — одной лентой по времени
  const timeline = plan ? [
    ...plan.meetings.map((m) => ({ at: m.startsAt, end: m.endsAt, title: m.title, kind: 'meeting' as const })),
    ...plan.plan.map((p) => ({ at: p.startsAt, end: p.endsAt, title: p.title, kind: 'task' as const })),
  ].sort((a, b) => Date.parse(a.at) - Date.parse(b.at)) : [];

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }} size="md" title="Помоги спланировать день"
      description="Выберите задачи — QEVO учтёт встречи, рабочие часы, длительность задач и перерывы.">
      <div className="cal-tt">
        {!plan ? (
          <>
            <div className="kv2-seg" role="group" aria-label="День">
              <button className="kv2-seg-btn" aria-pressed={date === 'today'} onClick={() => setDate('today')}>Сегодня</button>
              <button className="kv2-seg-btn" aria-pressed={date === 'tomorrow'} onClick={() => setDate('tomorrow')}>Завтра</button>
            </div>
            <ul className="cal-tt-tasks cal-tt-tasks-multi" aria-label="Задачи на день">
              {tasks.map((t) => (
                <li key={t.id}>
                  <label className={`cal-tt-task${picked[t.id] ? ' on' : ''}`}>
                    <input type="checkbox" checked={!!picked[t.id]} onChange={() => toggle(t)} />
                    <span className="cal-tt-title">№{t.id} — {t.title}</span>
                    {picked[t.id] ? (
                      <input className="ui-input cal-plan-min" type="number" min={5} max={480} step={5} value={picked[t.id]}
                        onClick={(e) => e.preventDefault()}
                        onChange={(e) => setPicked((p) => ({ ...p, [t.id]: Math.max(5, Math.min(480, Number(e.target.value) || 5)) }))}
                        aria-label={`Сколько минут на №${t.id}`} />
                    ) : null}
                  </label>
                </li>
              ))}
              {!tasks.length && <li className="dim">Открытых задач, где вы исполнитель, нет</li>}
            </ul>
            <div className="cal-tt-actions">
              <Button variant="primary" onClick={() => void propose()} disabled={busy || !Object.keys(picked).length}>
                <Icon name="sparkles" size={15} /> Составить план
              </Button>
            </div>
          </>
        ) : (
          <>
            <ul className="cal-day-plan">
              {timeline.map((x, i) => (
                <li key={i} className={x.kind}>
                  <span className="cal-day-time">{hhmm(x.at)}–{hhmm(x.end)}</span>
                  <Icon name={x.kind === 'meeting' ? 'video' : 'check-circle'} size={13} />
                  <span>{x.title}</span>
                </li>
              ))}
              {!timeline.length && <li className="dim">В этот день свободного рабочего времени нет.</li>}
            </ul>
            {plan.message && (
              <div className="tv2-callout" role="status">
                <Icon name="info" size={15} /> {plan.message}
                {plan.unplaced.length > 0 && <div className="dim">Не поместились: {plan.unplaced.map((u) => `№${u.taskId}`).join(', ')}</div>}
              </div>
            )}
            <div className="dim cal-small">Нужно {fmtMinutes(plan.needMin)} · свободно {fmtMinutes(plan.freeMin)}</div>
            <div className="cal-tt-actions">
              <Button variant="primary" onClick={() => void apply()} disabled={busy || !plan.plan.length}>Применить план</Button>
              <Button variant="outline" onClick={() => setPlan(null)} disabled={busy}>Изменить</Button>
            </div>
          </>
        )}
        {err && <div className="tv2-callout tv2-callout-danger" role="alert"><Icon name="alert" size={15} /> {err}</div>}
      </div>
    </Dialog>
  );
}
