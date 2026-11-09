import { useEffect, useState } from 'react';
import { Icon } from '../../components/Icon';
import { Button } from '../../components/ui/button';
import { Dialog } from '../../components/ui/dialog';
import { api, ApiError, type PlanTask } from '../../lib/api';
import type { User } from '../../types';
import { setFocusSession } from '../../hooks/useFocusSession';
import { toastSaved } from '../../lib/notifications';
import './calendar.css';
import { dayLabel, warnConflicts } from './TaskTimeDialog';
import { DateInput } from '../../components/DateInput';

/** Быстрый выбор времени фокуса (#4787, п. 12). */
export const FOCUS_MINUTES = [10, 25, 50, 90, 120];
const hhmm = (iso: string) => new Date(iso).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });

/**
 * Глубокий фокус из календаря (п. 12): тот же режим, что из меню аккаунта, — сессия
 * фокуса сервера. «Сейчас» — запускает её; «Запланировать» — блок фокуса в календаре
 * (статус «В фокусе» сегодня он не включает).
 */
export function FocusDialog({ at, onClose, onSaved, preselect }: {
  at?: Date | null; onClose: () => void; onSaved: () => void;
  /** #4798 §16: «Начать фокус» из карточки — эта задача уже выбрана. */
  preselect?: string[];
}) {
  const [tasks, setTasks] = useState<PlanTask[]>([]);
  const [picked, setPicked] = useState<string[]>(preselect ?? []);
  const [minutes, setMinutes] = useState(50);
  const [mode, setMode] = useState<'now' | 'plan'>(at ? 'plan' : 'now');
  const [when, setWhen] = useState(() => toLocalInput(at ?? null));
  const [options, setOptions] = useState<{ startsAt: string; endsAt: string; note: string }[] | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  /** Кто может обратиться по срочному вопросу (п. 12): все с правом, выбранные или никто. */
  const [urgent, setUrgent] = useState<'all' | 'selected' | 'nobody'>('all');
  const [urgentIds, setUrgentIds] = useState<string[]>([]);
  const [people, setPeople] = useState<User[]>([]);
  /** #4782, п. 1: поиск по названию и номеру; п. 2: своё время 10–120 минут. */
  const [query, setQuery] = useState('');
  const [custom, setCustom] = useState('');

  useEffect(() => { api.calendarPlanTasks().then(setTasks).catch(() => setTasks([])); }, []);
  useEffect(() => { if (urgent === 'selected' && !people.length) api.listUsers().then(setPeople).catch(() => undefined); }, [urgent, people.length]);
  useEffect(() => { setOptions(null); setMsg(null); }, [minutes, mode]);

  const q = query.trim().toLowerCase().replace(/^[#№]/, '');
  const shown = q ? tasks.filter((t) => t.id.includes(q) || t.title.toLowerCase().includes(q)) : tasks;
  const endAt = new Date(Date.now() + minutes * 60_000).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  const pickCustom = (v: string) => {
    setCustom(v.replace(/\D/g, '').slice(0, 3));
    const n = Number(v);
    if (n >= 10 && n <= 120) setMinutes(n);
  };
  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : p.length >= 10 ? p : [...p, id]));

  const startNow = async () => {
    setBusy(true); setErr('');
    try {
      setFocusSession(await api.focusStart({ taskIds: picked, minutes, urgentMode: urgent, urgentUserIds: urgent === 'selected' ? urgentIds : [] }));
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
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }} title={mode === 'now' ? 'На чём сосредоточимся?' : 'Глубокий фокус'}
      description="Звонки и уведомления не отвлекают — работа над выбранными задачами." size="md">
      <div className="cal-tt">
        <div className="cal-tt-label">Мои активные задачи</div>
        {tasks.length > 0 && (
          <input className="ui-input" type="search" value={query} onChange={(e) => setQuery(e.target.value)}
            placeholder="Поиск по названию или номеру" aria-label="Поиск задачи для фокуса" />
        )}
        <ul className="cal-tt-tasks cal-tt-tasks-multi" aria-label="Задачи для фокуса">
          {shown.slice(0, 40).map((t) => (
            <li key={t.id}>
              <label className={`cal-tt-task${picked.includes(t.id) ? ' on' : ''}`}>
                <input type="checkbox" checked={picked.includes(t.id)} onChange={() => toggle(t.id)} />
                <span className="cal-tt-title">#{t.id} — {t.title}{t.projectName ? <span className="dim"> · {t.projectName}</span> : null}</span>
              </label>
            </li>
          ))}
          {tasks.length > 0 && !shown.length && <li className="dim">Ничего не нашлось — попробуйте номер задачи</li>}
          {!tasks.length && (
            <li className="dim">
              Активных задач пока нет.{' '}
              <button type="button" className="ui-btn ui-btn-ghost ui-btn-sm"
                onClick={() => { onClose(); window.dispatchEvent(new CustomEvent('teamcrm:quick-task', { detail: { text: '' } })); }}>
                <Icon name="plus" size={14} /> Создать задачу
              </button>
            </li>
          )}
        </ul>

        <div className="cal-tt-label">Сколько времени выделить</div>
        <div className="cal-chips" role="group" aria-label="Длительность фокуса">
          {FOCUS_MINUTES.map((m) => (
            <button key={m} className={`cal-pill${minutes === m && !custom ? ' on' : ''}`} aria-pressed={minutes === m && !custom} onClick={() => { setCustom(''); setMinutes(m); }}>{m}</button>
          ))}
          <input className="ui-input cal-tt-custom" inputMode="numeric" value={custom} onChange={(e) => pickCustom(e.target.value)}
            placeholder="Своё время" aria-label="Своё время, от 10 до 120 минут" style={{ width: 110 }} />
          <span className="dim">минут</span>
        </div>
        {custom && (Number(custom) < 10 || Number(custom) > 120) && <div className="dim cal-small">От 10 до 120 минут</div>}

        {/* #4799, макет 04: правила сессии видны до запуска — это не настройки, а то, что будет */}
        <div className="cal-tt-label">Во время фокуса</div>
        <ul className="cal-rules" aria-label="Правила фокус-сессии">
          <li><Icon name="check" size={14} /> Обычные звонки не прерывают сессию — звонящий видит, до скольки вы в фокусе</li>
          <li><Icon name="check" size={14} /> Уведомления без звука — копятся в ленте, сводка придёт после</li>
          <li><Icon name="check" size={14} /> Срочные исключения — по правилу ниже</li>
        </ul>
        <div className="cal-tt-label">Кто может обратиться по срочному вопросу</div>
        <div className="kv2-seg" role="group" aria-label="Срочные обращения">
          <button className="kv2-seg-btn" aria-pressed={urgent === 'all'} onClick={() => setUrgent('all')}>Все, кому разрешено</button>
          <button className="kv2-seg-btn" aria-pressed={urgent === 'selected'} onClick={() => setUrgent('selected')}>Только выбранные</button>
          <button className="kv2-seg-btn" aria-pressed={urgent === 'nobody'} onClick={() => setUrgent('nobody')}>Никто</button>
        </div>
        {urgent === 'selected' && (
          <div className="cal-chips" aria-label="Кто может обратиться">
            {people.filter((u) => u.role !== 'client').map((u) => {
              const on = urgentIds.includes(String(u.id));
              return (
                <button key={u.id} className={`cal-pill${on ? ' on' : ''}`} aria-pressed={on}
                  onClick={() => setUrgentIds((l) => (on ? l.filter((x) => x !== String(u.id)) : [...l, String(u.id)]))}>{u.fullName}</button>
              );
            })}
          </div>
        )}
        <div className="dim cal-small">Обычные звонки и уведомления фокус не прерывают — придут одной сводкой после. Срочное обращение — только с причиной.</div>

        <div className="kv2-seg" role="group" aria-label="Когда">
          <button className="kv2-seg-btn" aria-pressed={mode === 'now'} onClick={() => setMode('now')}>Начать сейчас</button>
          <button className="kv2-seg-btn" aria-pressed={mode === 'plan'} onClick={() => setMode('plan')}>Запланировать</button>
        </div>

        {mode === 'now' ? (
          <>
            {/* #4782, п. 2: итог до запуска */}
            <div className="tv2-callout" role="status">
              {picked.length ? `Задачи ${picked.map((id) => `#${id}`).join(', ')} · ` : ''}{minutes} минут · до {endAt}
            </div>
            <div className="cal-tt-actions">
              <Button variant="primary" onClick={() => void startNow()} disabled={busy}><Icon name="target" size={15} /> Начать фокус</Button>
            </div>
          </>
        ) : (
          <>
            <div className="cal-tt-actions">
              <Button variant="primary" onClick={() => void find()} disabled={busy}><Icon name="search" size={15} /> Найти время</Button>
              <span className="cal-tt-or">или</span>
              <DateInput className="ui-input cal-tt-when" type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} aria-label="Время начала фокуса" />
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
