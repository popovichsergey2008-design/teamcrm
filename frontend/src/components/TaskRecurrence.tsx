import { useEffect, useState } from 'react';
import { Icon } from './Icon';
import { api, ApiError, TaskRecurrence as Recurrence } from '../lib/api';

/**
 * Повтор задачи.
 *
 * «Отчёт каждый понедельник» заводится один раз, а не 52 раза в год. Расписание живёт
 * при задаче — там же, где его будут искать, — и с этого момента система сама создаёт
 * копию к нужному дню.
 *
 * ГЛАВНОЕ ПРАВИЛО, и о нём сказано прямо в интерфейсе: ПО РАСПИСАНИЮ, НО НЕ ПЛОДИТЬ.
 * Пока прежняя задача не закрыта, новая не появится — у старой сдвинется срок. Иначе
 * к концу месяца на доске висит тридцать одинаковых «Отчётов», и человек перестаёт
 * видеть их вовсе. Правило неочевидное, поэтому оно написано под переключателем, а не
 * спрятано в поведении.
 */

type Freq = 'daily' | 'weekly' | 'monthly' | 'days';

const FREQS: { key: Freq; label: string }[] = [
  { key: 'daily', label: 'Каждый день' },
  { key: 'weekly', label: 'По дням недели' },
  { key: 'monthly', label: 'Раз в месяц' },
  { key: 'days', label: 'Каждые N дней' },
];

/** Короткие подписи дней: неделя начинается с понедельника, как в календаре. */
const WEEKDAYS = [
  { n: 1, label: 'Пн' }, { n: 2, label: 'Вт' }, { n: 3, label: 'Ср' }, { n: 4, label: 'Чт' },
  { n: 5, label: 'Пт' }, { n: 6, label: 'Сб' }, { n: 7, label: 'Вс' },
];

export function TaskRecurrenceBlock({ taskId, onRefresh }: { taskId: string; onRefresh: () => void }) {
  const [current, setCurrent] = useState<Recurrence | null>(null);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const [freq, setFreq] = useState<Freq>('weekly');
  const [weekdays, setWeekdays] = useState<number[]>([1]);
  const [monthday, setMonthday] = useState(1);
  const [intervalDays, setIntervalDays] = useState(7);
  const [atTime, setAtTime] = useState('10:00');

  useEffect(() => {
    let alive = true;
    setLoading(true);
    api.taskRecurrence(taskId)
      .then((r) => {
        if (!alive) return;
        setCurrent(r);
        if (r) {
          // форма открывается на том, что уже настроено: править легче, чем набирать заново
          setFreq(r.freq);
          setWeekdays(r.weekdays?.length ? r.weekdays : [1]);
          setMonthday(r.monthday ?? 1);
          setIntervalDays(r.intervalDays ?? 7);
          setAtTime(r.atTime);
        }
      })
      .catch(() => undefined)
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [taskId]);

  const toggleDay = (n: number) =>
    setWeekdays((prev) => (prev.includes(n) ? prev.filter((d) => d !== n) : [...prev, n].sort()));

  const save = async () => {
    setErr('');
    if (freq === 'weekly' && !weekdays.length) return setErr('Выберите хотя бы один день недели');
    setBusy(true);
    try {
      const saved = await api.setTaskRecurrence(taskId, {
        freq,
        weekdays: freq === 'weekly' ? weekdays : undefined,
        monthday: freq === 'monthly' ? monthday : undefined,
        intervalDays: freq === 'days' ? intervalDays : undefined,
        atTime,
        // пояс берём у браузера: «в 10 утра» человек имеет в виду своё утро
        tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
      });
      setCurrent(saved);
      setOpen(false);
      onRefresh();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Не удалось сохранить повтор');
    } finally {
      setBusy(false);
    }
  };

  const clear = async () => {
    if (!window.confirm('Снять повтор? Уже созданные задачи останутся.')) return;
    setBusy(true);
    try {
      await api.clearTaskRecurrence(taskId);
      setCurrent(null);
      setOpen(false);
      onRefresh();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Не удалось снять повтор');
    } finally {
      setBusy(false);
    }
  };

  if (loading) return null;

  return (
    <div className="drawer-section">
      <div className="drawer-section-title">Повторение</div>

      {current && !open && (
        <div className="repeat-current">
          <span className="badge badge-repeat"><Icon name="refresh" size={12} /> {current.description}</span>
          <span className="dim">
            следующая — {new Date(current.nextRunAt).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' })}
          </span>
          <span className="repeat-actions">
            <button className="btn btn-ghost btn-sm" onClick={() => setOpen(true)}>Изменить</button>
            <button className="btn btn-ghost btn-sm" onClick={clear} disabled={busy}>Снять</button>
          </span>
        </div>
      )}

      {!current && !open && (
        <button className="btn btn-sm" onClick={() => setOpen(true)}>
          <Icon name="refresh" size={14} /> Повторять эту задачу
        </button>
      )}

      {open && (
        <div className="repeat-form">
          <div className="drawer-grid2">
            <div className="field"><label>Как часто</label>
              <select className="input" value={freq} onChange={(e) => setFreq(e.target.value as Freq)}>
                {FREQS.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
              </select>
            </div>
            <div className="field"><label title="Время срока новой задачи в вашем часовом поясе">Во сколько</label>
              <input className="input" type="time" value={atTime} onChange={(e) => setAtTime(e.target.value)} />
            </div>
          </div>

          {freq === 'weekly' && (
            <div className="field"><label>Дни недели</label>
              <div className="repeat-days">
                {WEEKDAYS.map((d) => (
                  <button
                    key={d.n}
                    type="button"
                    className={`repeat-day${weekdays.includes(d.n) ? ' active' : ''}`}
                    onClick={() => toggleDay(d.n)}
                    aria-pressed={weekdays.includes(d.n)}
                  >
                    {d.label}
                  </button>
                ))}
              </div>
            </div>
          )}

          {freq === 'monthly' && (
            <div className="field"><label>Число месяца</label>
              <input
                className="input" type="number" min={1} max={31} value={monthday}
                onChange={(e) => setMonthday(Number(e.target.value))}
              />
              {monthday > 28 && (
                <span className="dim">
                  В коротком месяце задача появится в последний день — 30-е и 31-е есть не везде.
                </span>
              )}
            </div>
          )}

          {freq === 'days' && (
            <div className="field"><label>Шаг, дней</label>
              <input
                className="input" type="number" min={1} max={365} value={intervalDays}
                onChange={(e) => setIntervalDays(Number(e.target.value))}
              />
            </div>
          )}

          {/* Правило неочевидное — говорим о нём прямо, а не оставляем догадываться. */}
          <div className="dim repeat-note">
            <Icon name="info" size={13} /> Пока прежняя задача не завершена, новая не создаётся —
            у неё просто сдвигается срок. Так доска не забивается одинаковыми копиями.
          </div>

          {err && <div className="error-text">{err}</div>}
          <div className="repeat-actions">
            <button className="btn btn-primary btn-sm" onClick={save} disabled={busy}>
              {busy ? 'Сохраняю…' : 'Сохранить повтор'}
            </button>
            <button className="btn btn-ghost btn-sm" onClick={() => { setOpen(false); setErr(''); }}>Отмена</button>
            {current && <button className="btn btn-ghost btn-sm" onClick={clear} disabled={busy}>Снять повтор</button>}
          </div>
        </div>
      )}
    </div>
  );
}
