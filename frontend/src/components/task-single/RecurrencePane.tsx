import { useEffect, useState } from 'react';
import { Icon } from '../Icon';
import { Button } from '../ui/button';
import { confirmAction } from '../ui/dialog';
import { api, ApiError, type TaskRecurrence as Recurrence } from '../../lib/api';
import { toastSaved } from '../../lib/notifications';

type Unit = 'day' | 'week' | 'month';
type End = 'manual' | 'count' | 'date';
const WEEKDAYS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
const DUE_OPTIONS: { v: string; label: string }[] = [
  { v: '', label: 'в момент создания' },
  { v: '0', label: 'в тот же день' },
  { v: '1', label: '+1 день' },
  { v: '2', label: '+2 дня' },
  { v: '3', label: '+3 дня' },
  { v: '5', label: '+5 дней' },
  { v: '7', label: '+7 дней' },
  { v: '14', label: '+14 дней' },
];

/** Повтор словами для нижней строки «главного»: «Каждый пн, 10:00». */
export function repeatShort(r: Recurrence | null): string | null {
  if (!r) return null;
  const at = r.atTime;
  const n = r.every ?? 1;
  if (r.freq === 'daily') return `Каждый день, ${at}`;
  if (r.freq === 'days') return `Каждые ${r.intervalDays} дн., ${at}`;
  if (r.freq === 'weekly') {
    const days = (r.weekdays ?? []).map((d) => WEEKDAYS[d - 1]?.toLowerCase()).join(', ');
    return `${n > 1 ? `Раз в ${n} нед.` : 'Каждый'} ${days}, ${at}`;
  }
  return `${n > 1 ? `Раз в ${n} мес.` : 'Каждое'} ${r.monthday}-е, ${at}`;
}

/**
 * Вкладка «Повтор» (#5016, ТЗ п. 6, a-4): сверху «Повтор включён, следующая — …» и красная
 * «Снять повтор»; ниже — каждые N (день / неделю / месяц), дни недели, создавать в,
 * срок новой задачи, закончить (вручную / после N раз / по дате), «Отмена» и «Сохранить».
 *
 * ГЛАВНОЕ ПРАВИЛО прежнее и сказано прямо: пока прежняя задача не закрыта, новая не
 * создаётся — у неё сдвигается срок. Иначе доска забивается одинаковыми копиями.
 */
export function RecurrencePane({ taskId, onRefresh, onSaved }: { taskId: string; onRefresh: () => void; onSaved?: (label: string | null) => void }) {
  const [current, setCurrent] = useState<Recurrence | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const [n, setN] = useState(1);
  const [unit, setUnit] = useState<Unit>('week');
  const [weekdays, setWeekdays] = useState<number[]>([1]);
  const [monthday, setMonthday] = useState(1);
  const [atTime, setAtTime] = useState('10:00');
  const [dueDays, setDueDays] = useState('');
  const [dueTime, setDueTime] = useState('16:00');
  const [end, setEnd] = useState<End>('manual');
  const [endsAfter, setEndsAfter] = useState(10);
  const [endsOn, setEndsOn] = useState('');

  const fill = (r: Recurrence | null) => {
    setErr('');
    if (!r) {
      setN(1); setUnit('week'); setWeekdays([((new Date().getDay() + 6) % 7) + 1]); setMonthday(new Date().getDate());
      setAtTime('10:00'); setDueDays(''); setDueTime('16:00'); setEnd('manual'); return;
    }
    if (r.freq === 'daily') { setUnit('day'); setN(1); }
    else if (r.freq === 'days') { setUnit('day'); setN(r.intervalDays ?? 1); }
    else if (r.freq === 'weekly') { setUnit('week'); setN(r.every ?? 1); }
    else { setUnit('month'); setN(r.every ?? 1); }
    setWeekdays(r.weekdays?.length ? r.weekdays : [1]);
    setMonthday(r.monthday ?? 1);
    setAtTime(r.atTime);
    setDueDays(r.dueDays != null ? String(r.dueDays) : '');
    setDueTime(r.dueTime ?? r.atTime);
    if (r.endsAfter) { setEnd('count'); setEndsAfter(r.endsAfter); }
    else if (r.endsOn) { setEnd('date'); setEndsOn(r.endsOn); }
    else setEnd('manual');
  };

  useEffect(() => {
    let alive = true;
    setLoading(true);
    api.taskRecurrence(taskId)
      .then((r) => { if (alive) { setCurrent(r); fill(r); } })
      .catch(() => undefined)
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [taskId]);

  const toggleDay = (d: number) => setWeekdays((prev) => (prev.includes(d) ? prev.filter((x) => x !== d) : [...prev, d].sort()));

  const save = async () => {
    setErr('');
    if (unit === 'week' && !weekdays.length) { setErr('Выберите хотя бы один день недели'); return; }
    if (end === 'date' && !endsOn) { setErr('Укажите дату окончания'); return; }
    const step = Math.max(1, Math.min(unit === 'day' ? 365 : 52, Math.trunc(n) || 1));
    setBusy(true);
    try {
      const saved = await api.setTaskRecurrence(taskId, {
        freq: unit === 'day' ? (step === 1 ? 'daily' : 'days') : unit === 'week' ? 'weekly' : 'monthly',
        weekdays: unit === 'week' ? weekdays : undefined,
        monthday: unit === 'month' ? monthday : undefined,
        intervalDays: unit === 'day' && step > 1 ? step : undefined,
        every: unit !== 'day' && step > 1 ? step : undefined,
        atTime,
        // пояс берём у браузера: «в 10 утра» человек имеет в виду своё утро
        tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
        dueDays: dueDays === '' ? null : Number(dueDays),
        dueTime: dueDays === '' ? null : dueTime,
        endsAfter: end === 'count' ? Math.max(1, Math.trunc(endsAfter) || 1) : null,
        endsOn: end === 'date' ? endsOn : null,
      });
      setCurrent(saved);
      fill(saved);
      onSaved?.(repeatShort(saved));
      onRefresh();
      toastSaved('Повтор сохранён', 'Задача будет создаваться по расписанию');
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Не удалось сохранить повтор');
    } finally { setBusy(false); }
  };

  const clear = async () => {
    if (!(await confirmAction({ title: 'Снять повтор?', description: 'Уже созданные задачи останутся.', danger: true }))) return;
    setBusy(true);
    try {
      await api.clearTaskRecurrence(taskId);
      setCurrent(null);
      fill(null);
      onSaved?.(null);
      onRefresh();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Не удалось снять повтор');
    } finally { setBusy(false); }
  };

  if (loading) return <div className="ts-empty">Загружаю…</div>;
  const next = current ? new Date(current.nextRunAt).toLocaleString('ru-RU', { weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';

  return (
    <>
      <div className="ts-pane-h">
        {current
          ? <><span className="ts-h">{current.active ? 'Повтор включён' : 'Повтор закончился'}</span>{current.active && <span className="ts-hint">следующая — {next}</span>}</>
          : <><span className="ts-h">Повтора нет</span><span className="ts-hint">настройте — задача будет создаваться по расписанию</span></>}
        <span className="ts-sp" />
        {current && <button type="button" className="ts-link ts-link-danger" onClick={() => void clear()} disabled={busy}>Снять повтор</button>}
      </div>
      <div className="ts-row">
        <span className="ts-k">Повторять каждые</span>
        <span className="ts-v-inline">
          <input className="ui-input ui-input-sm ts-input ts-input-num" type="number" min={1} max={unit === 'day' ? 365 : 52} value={n}
            onChange={(e) => setN(Number(e.target.value))} aria-label="Каждые сколько" />
          <span className="ts-seg" role="radiogroup" aria-label="Единица повтора">
            {([['day', 'День'], ['week', 'Неделю'], ['month', 'Месяц']] as [Unit, string][]).map(([k, l]) => (
              <button key={k} type="button" role="radio" aria-checked={unit === k} className={unit === k ? 'is-on' : ''} onClick={() => setUnit(k)}>{l}</button>
            ))}
          </span>
        </span>
      </div>
      {unit === 'week' && (
        <div className="ts-row">
          <span className="ts-k">В дни</span>
          <span className="ts-seg" role="group" aria-label="Дни недели">
            {WEEKDAYS.map((l, i) => (
              <button key={l} type="button" aria-pressed={weekdays.includes(i + 1)} className={weekdays.includes(i + 1) ? 'is-on' : ''} onClick={() => toggleDay(i + 1)}>{l}</button>
            ))}
          </span>
        </div>
      )}
      {unit === 'month' && (
        <div className="ts-row">
          <span className="ts-k">Число месяца</span>
          <span className="ts-v-inline">
            <input className="ui-input ui-input-sm ts-input ts-input-num" type="number" min={1} max={31} value={monthday} onChange={(e) => setMonthday(Number(e.target.value))} aria-label="Число месяца" />
            {monthday > 28 && <span className="ts-meta">в коротком месяце — последний день</span>}
          </span>
        </div>
      )}
      <div className="ts-row">
        <span className="ts-k">Создавать в</span>
        <input className="ui-input ui-input-sm ts-input" type="time" value={atTime} onChange={(e) => setAtTime(e.target.value)} aria-label="Во сколько создавать" />
      </div>
      <div className="ts-row">
        <span className="ts-k">Срок новой задачи</span>
        <span className="ts-v-inline">
          <select className="ui-input ui-input-sm ts-input" value={dueDays} onChange={(e) => setDueDays(e.target.value)} aria-label="Срок новой задачи">
            {DUE_OPTIONS.map((o) => <option key={o.v} value={o.v}>{o.label}</option>)}
          </select>
          {dueDays !== '' && <input className="ui-input ui-input-sm ts-input" type="time" value={dueTime} onChange={(e) => setDueTime(e.target.value)} aria-label="Время срока новой задачи" />}
        </span>
      </div>
      <div className="ts-row">
        <span className="ts-k">Закончить</span>
        <span className="ts-v-inline">
          <span className="ts-seg" role="radiogroup" aria-label="Когда закончить">
            {([['manual', 'Вручную'], ['count', 'После N раз'], ['date', 'По дате']] as [End, string][]).map(([k, l]) => (
              <button key={k} type="button" role="radio" aria-checked={end === k} className={end === k ? 'is-on' : ''} onClick={() => setEnd(k)}>{l}</button>
            ))}
          </span>
          {end === 'count' && <input className="ui-input ui-input-sm ts-input ts-input-num" type="number" min={1} max={1000} value={endsAfter} onChange={(e) => setEndsAfter(Number(e.target.value))} aria-label="Сколько раз" />}
          {end === 'date' && <input className="ui-input ui-input-sm ts-input" type="date" value={endsOn} onChange={(e) => setEndsOn(e.target.value)} aria-label="Дата окончания" />}
          {end === 'count' && current?.runs ? <span className="ts-meta">уже {current.runs}</span> : null}
        </span>
      </div>
      <div className="ts-note">
        <Icon name="info" size={13} /> Пока прежняя задача не завершена, новая не создаётся — у неё сдвигается срок. Так доска не забивается копиями.
      </div>
      {err && <div className="ts-note error-text" role="alert">{err}</div>}
      <div className="ts-foot">
        <span className="ts-sp" />
        <Button size="sm" variant="outline" onClick={() => fill(current)} disabled={busy}>Отмена</Button>
        <Button size="sm" variant="primary" onClick={() => void save()} loading={busy}>Сохранить</Button>
      </div>
    </>
  );
}
