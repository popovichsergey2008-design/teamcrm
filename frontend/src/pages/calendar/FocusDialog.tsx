import { useEffect, useState } from 'react';
import { Icon } from '../../components/Icon';
import { Button } from '../../components/ui/button';
import { Dialog } from '../../components/ui/dialog';
import { api, ApiError, type PlanTask } from '../../lib/api';
import { toastSaved } from '../../lib/notifications';
import { dayLabel, warnConflicts } from './TaskTimeDialog';

/** Быстрый выбор времени фокуса (#4787, п. 12). */
export const FOCUS_MINUTES = [10, 25, 50, 90, 120];
const hhmm = (iso: string) => new Date(iso).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });

/**
 * Глубокий фокус из календаря (п. 12): тот же режим, что из меню аккаунта, — сессия
 * фокуса сервера. «Сейчас» — запускает её; «Запланировать» — блок фокуса в календаре
 * (статус «В фокусе» сегодня он не включает).
 */
export function FocusDialog({ at, onClose, onSaved }: { at?: Date | null; onClose: () => void; onSaved: () => void }) {
  const [tasks, setTasks] = useState<PlanTask[]>([]);
  const [picked, setPicked] = useState<string[]>([]);
  const [minutes, setMinutes] = useState(50);
  const [mode, setMode] = useState<'now' | 'plan'>(at ? 'plan' : 'now');
  const [when, setWhen] = useState(() => toLocalInput(at ?? null));
  const [options, setOptions] = useState<{ startsAt: string; endsAt: string; note: string }[] | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => { api.calendarPlanTasks().then(setTasks).catch(() => setTasks([])); }, []);
  useEffect(() => { setOptions(null); setMsg(null); }, [minutes, mode]);

  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : p.length >= 10 ? p : [...p, id]));

  const startNow = async () => {
    setBusy(true); setErr('');
    try {
      await api.focusStart({ taskId: picked[0] ?? null, minutes });
      toastSaved(`Фокус до ${new Date(Date.now() + minutes * 60_000).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}`);
      window.dispatchEvent(new Event('qevo:focus-changed'));
      onSaved();
    } catch (e) { setErr(e instanceof ApiError ? e.message : 'Не удалось начать фокус'); }
    finally { setBusy(false); }
  };

  const plan = async (startsAt: string, endsAt: string) => {
    setBusy(true); setErr('');
    try {
      const r = await api.calendarBlockCreate({ kind: 'focus', taskIds: picked, startsAt, endsAt });
      toastSaved(`Фокус в календаре: ${dayLabel(startsAt)}, ${hhmm(startsAt)}–${hhmm(endsAt)}`);
      warnConflicts(r.conflicts);
      onSaved();
    } catch (e) { setErr(e instanceof ApiError ? e.message : 'Не удалось запланировать'); }
    finally { setBusy(false); }
  };

  const find = async () => {
    setBusy(true); setErr('');
    try {
      const r = await api.calendarFindTime({ minutes });
      setOptions(r.options); setMsg(r.message);
    } catch (e) { setErr(e instanceof ApiError ? e.message : 'Не удалось подобрать время'); }
    finally { setBusy(false); }
  };

  const planManual = () => {
    const s = new Date(when);
    if (Number.isNaN(s.getTime())) return;
    void plan(s.toISOString(), new Date(s.getTime() + minutes * 60_000).toISOString());
  };

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }} title="Глубокий фокус"
      description="Звонки и уведомления не отвлекают — работа над выбранными задачами." size="md">
      <div className="cal-tt">
        <div className="cal-tt-label">Какие задачи выполнять</div>
        <ul className="cal-tt-tasks cal-tt-tasks-multi" aria-label="Задачи для фокуса">
          {tasks.slice(0, 40).map((t) => (
            <li key={t.id}>
              <label className={`cal-tt-task${picked.includes(t.id) ? ' on' : ''}`}>
                <input type="checkbox" checked={picked.includes(t.id)} onChange={() => toggle(t.id)} />
                <span className="cal-tt-title">№{t.id} — {t.title}</span>
              </label>
            </li>
          ))}
          {!tasks.length && <li className="dim">Открытых задач нет — фокус можно начать и без задачи</li>}
        </ul>

        <div className="cal-tt-label">Сколько времени выделить</div>
        <div className="cal-chips" role="group" aria-label="Длительность фокуса">
          {FOCUS_MINUTES.map((m) => (
            <button key={m} className={`cal-pill${minutes === m ? ' on' : ''}`} aria-pressed={minutes === m} onClick={() => setMinutes(m)}>{m}</button>
          ))}
          <span className="dim">минут</span>
        </div>

        <div className="kv2-seg" role="group" aria-label="Когда">
          <button className="kv2-seg-btn" aria-pressed={mode === 'now'} onClick={() => setMode('now')}>Начать сейчас</button>
          <button className="kv2-seg-btn" aria-pressed={mode === 'plan'} onClick={() => setMode('plan')}>Запланировать</button>
        </div>

        {mode === 'now' ? (
          <div className="cal-tt-actions">
            <Button variant="primary" onClick={() => void startNow()} disabled={busy}><Icon name="target" size={15} /> Начать фокус на {minutes} мин</Button>
          </div>
        ) : (
          <>
            <div className="cal-tt-actions">
              <Button variant="primary" onClick={() => void find()} disabled={busy}><Icon name="search" size={15} /> Найти время</Button>
              <span className="cal-tt-or">или</span>
              <input className="ui-input cal-tt-when" type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} aria-label="Время начала фокуса" />
              <Button variant="outline" onClick={planManual} disabled={busy || !when}>Запланировать</Button>
            </div>
            {options && options.length > 0 && (
              <ul className="cal-tt-options">
                {options.map((o) => (
                  <li key={o.startsAt}>
                    <button className="cal-tt-option" onClick={() => void plan(o.startsAt, o.endsAt)} disabled={busy}>
                      <strong>{dayLabel(o.startsAt)}, {hhmm(o.startsAt)}–{hhmm(o.endsAt)}</strong>
                      <span className="dim">{o.note}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {msg && <div className="tv2-callout" role="status"><Icon name="info" size={15} /> {msg}</div>}
          </>
        )}
        {err && <div className="tv2-callout tv2-callout-danger" role="alert"><Icon name="alert" size={15} /> {err}</div>}
      </div>
    </Dialog>
  );
}

function toLocalInput(d: Date | null): string {
  if (!d) return '';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
