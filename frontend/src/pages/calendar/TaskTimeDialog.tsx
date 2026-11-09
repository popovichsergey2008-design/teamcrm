import { useEffect, useMemo, useState } from 'react';
import { Icon } from '../../components/Icon';
import { Button } from '../../components/ui/button';
import { Dialog } from '../../components/ui/dialog';
import { Input } from '../../components/ui/input';
import { api, ApiError, type BlockConflict, type CalBlock, type FindTimeResult, type PlanTask } from '../../lib/api';
import { toastSaved } from '../../lib/notifications';
import './calendar.css';
import { DateInput } from '../../components/DateInput';

export const DURATIONS = [25, 30, 50, 60, 90, 120];
const hhmm = (iso: string) => new Date(iso).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
export const dayLabel = (iso: string) => {
  const d = new Date(iso);
  const t0 = new Date(); t0.setHours(0, 0, 0, 0);
  const diff = Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() - t0.getTime()) / 86_400_000);
  if (diff === 0) return 'Сегодня';
  if (diff === 1) return 'Завтра';
  return d.toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' }).replace(/^./, (c) => c.toUpperCase());
};
export const fmtMinutes = (m: number) => (m >= 60 ? `${Math.floor(m / 60)} ч${m % 60 ? ` ${m % 60} мин` : ''}` : `${m} мин`);

/** Пересечение со встречей — подсветка конфликта (п. 19): блок стоит, но человек знает. */
export function warnConflicts(conflicts: BlockConflict[]) {
  if (!conflicts.length) return;
  const c = conflicts[0];
  toastSaved(`Пересекается со встречей «${c.title}» (${hhmm(c.startsAt)}–${hhmm(c.endsAt)})`);
}

/**
 * Время на задачу (#4787, п. 3–5).
 *
 * Задача → сколько времени выделить → «Найти время» (варианты с объяснением) или своё
 * время. Блок появляется только после выбора варианта. Срок задачи не меняется никогда.
 * С `block` — перенос существующего блока: тот же подбор, но двигается он, а не создаётся новый.
 */
export function TaskTimeDialog({ taskId, block, at, onClose, onSaved }: {
  taskId?: string | null;
  block?: CalBlock | null;
  /** Начало, если время уже выбрано: щелчок по сетке или задача, перетащенная на сетку. */
  at?: Date | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [tasks, setTasks] = useState<PlanTask[]>([]);
  const [q, setQ] = useState('');
  const [picked, setPicked] = useState<string | null>(block?.taskId ?? taskId ?? null);
  const blockMin = block ? Math.round((Date.parse(block.endsAt) - Date.parse(block.startsAt)) / 60000) : 0;
  const [minutes, setMinutes] = useState<number>(blockMin || 0);
  const [found, setFound] = useState<FindTimeResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [manual, setManual] = useState(() => toLocalInput(at ?? null));

  useEffect(() => { api.calendarPlanTasks().then(setTasks).catch(() => setTasks([])); }, []);
  const task = tasks.find((t) => t.id === picked) ?? null;
  // длительность по умолчанию — оценка задачи, иначе час
  useEffect(() => { if (task && !minutes) setMinutes(task.estimateMin && task.estimateMin <= 480 ? task.estimateMin : 60); }, [task, minutes]);
  useEffect(() => { setFound(null); }, [picked, minutes]);

  const list = useMemo(() => {
    const s = q.trim().toLowerCase();
    return (s ? tasks.filter((t) => t.title.toLowerCase().includes(s) || t.id === s.replace(/^№|#/, '')) : tasks).slice(0, 30);
  }, [tasks, q]);

  const find = async () => {
    if (!picked) return;
    setBusy(true); setErr('');
    try { setFound(await api.calendarFindTime({ taskId: picked, minutes: minutes || undefined, exceptBlockId: block?.id })); }
    catch (e) { setErr(e instanceof ApiError ? e.message : 'Не удалось подобрать время'); }
    finally { setBusy(false); }
  };

  const save = async (startsAt: string, endsAt: string) => {
    if (!picked) return;
    setBusy(true); setErr('');
    try {
      const r = block
        ? await api.calendarBlockMove(block.id, startsAt, endsAt)
        : await api.calendarBlockCreate({ kind: 'task', taskId: picked, startsAt, endsAt });
      toastSaved(block ? 'Время работы перенесено — срок задачи не изменился' : `В календаре: ${hhmm(startsAt)}–${hhmm(endsAt)}`);
      warnConflicts(r.conflicts);
      onSaved();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Не удалось сохранить');
    } finally { setBusy(false); }
  };

  const saveManual = () => {
    const s = new Date(manual);
    if (Number.isNaN(s.getTime()) || !minutes) return;
    void save(s.toISOString(), new Date(s.getTime() + minutes * 60_000).toISOString());
  };

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }} title={block ? 'Перенести время работы' : 'Время на задачу'}
      description="Срок задачи остаётся прежним — здесь вы выбираете, когда будете ею заниматься." size="md">
      <div className="cal-tt">
        {!block && !taskId && (
          <>
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Найти задачу: название или номер" aria-label="Поиск задачи" />
            <ul className="cal-tt-tasks" role="listbox" aria-label="Задачи для планирования">
              {list.map((t) => (
                <li key={t.id}>
                  <button role="option" aria-selected={picked === t.id} className={`cal-tt-task${picked === t.id ? ' on' : ''}`} onClick={() => setPicked(t.id)}>
                    <span className="cal-tt-title">№{t.id} — {t.title}</span>
                    <span className="cal-tt-meta">
                      {t.projectName}
                      {t.deadlineAt && ` · срок ${new Date(t.deadlineAt).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })}`}
                      {t.estimateMin ? ` · ~${fmtMinutes(t.estimateMin)}` : ''}
                      {t.plannedMin ? ` · запланировано ${fmtMinutes(t.plannedMin)}` : ''}
                    </span>
                  </button>
                </li>
              ))}
              {!list.length && <li className="dim">Открытых задач, где вы исполнитель, не нашлось</li>}
            </ul>
          </>
        )}
        {task && (block || taskId) && (
          <div className="cal-tt-picked">
            <strong>№{task.id} — {task.title}</strong>
            <span className="dim">{task.projectName}{task.deadlineAt ? ` · срок ${new Date(task.deadlineAt).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}` : ' · без срока'}</span>
          </div>
        )}

        {picked && (
          <>
            <div className="cal-tt-label">Сколько времени выделить?</div>
            <div className="cal-chips" role="group" aria-label="Длительность">
              {DURATIONS.map((m) => (
                <button key={m} className={`cal-pill${minutes === m ? ' on' : ''}`} aria-pressed={minutes === m} onClick={() => setMinutes(m)}>{fmtMinutes(m)}</button>
              ))}
              <label className="cal-pill-input">
                <Input type="number" min={5} max={480} step={5} value={minutes || ''} onChange={(e) => setMinutes(Math.max(0, Math.min(480, Number(e.target.value) || 0)))} aria-label="Своя длительность, минут" />
                <span>мин</span>
              </label>
            </div>

            <div className="cal-tt-actions">
              <Button onClick={() => void find()} disabled={busy || !minutes}>
                <Icon name="search" size={15} /> Найти время
              </Button>
              <span className="cal-tt-or">или</span>
              <DateInput className="ui-input cal-tt-when" type="datetime-local" value={manual} onChange={(e) => setManual(e.target.value)} aria-label="Своё время начала" />
              <Button variant="outline" onClick={saveManual} disabled={busy || !manual || !minutes}>Поставить</Button>
            </div>
          </>
        )}

        {found && found.options.length > 0 && (
          <ul className="cal-tt-options">
            {found.options.map((o) => (
              <li key={o.startsAt}>
                <button className="cal-tt-option" onClick={() => void save(o.startsAt, o.endsAt)} disabled={busy}>
                  <strong>{dayLabel(o.startsAt)}, {hhmm(o.startsAt)}–{hhmm(o.endsAt)}</strong>
                  <span className="dim">{o.note}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {found && found.message && <div className="tv2-callout" role="status"><Icon name="info" size={15} /> {found.message}</div>}
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
