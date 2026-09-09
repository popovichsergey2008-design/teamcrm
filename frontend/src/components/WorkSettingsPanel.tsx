import { useEffect, useMemo, useState } from 'react';
import { Icon } from './Icon';
import { DatePicker } from './DatePicker';
import { api, ApiError } from '../lib/api';
import { useEscape } from '../hooks/useEscape';
import { humanDate, mergeHolidays, ruHolidays, WEEK_DAYS } from '../lib/holidays';
import { overlayProps } from '../lib/overlay';

/**
 * Рабочее время компании: часы, выходные и праздники.
 *
 * До этого экрана настройки правились только через API, а зависит от них уже многое:
 * приглушённые часы в сетке календаря, подсказка занятости и — главное — тихие часы
 * ассистента. Пока их нельзя было изменить, «не писать людям вне рабочего дня»
 * означало «не писать вне 9:00–18:00», кто бы и как ни работал.
 *
 * Правит владелец, видят все: по этим часам людям приходят напоминания, и знать их
 * человек вправе.
 */

interface Work {
  workStart: string;
  workEnd: string;
  weekendDays: number[];
  holidays: string[];
}

const DEFAULT_WORK: Work = { workStart: '09:00', workEnd: '18:00', weekendDays: [0, 6], holidays: [] };

export function WorkSettingsPanel({ canManage, onClose }: { canManage: boolean; onClose: () => void }) {
  useEscape(onClose);
  const [work, setWork] = useState<Work | null>(null);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');
  const [ok, setOk] = useState(false);
  const [newHoliday, setNewHoliday] = useState('');

  useEffect(() => {
    api.calendarWork()
      .then((w) => setWork({ ...DEFAULT_WORK, ...w }))
      .catch(() => setErr('Не удалось загрузить рабочее время'));
  }, []);

  const year = useMemo(() => new Date().getFullYear(), []);

  const save = async (next: Work) => {
    setWork(next);
    if (!canManage) return;
    setSaving(true);
    setErr('');
    setOk(false);
    try {
      const saved = await api.saveCalendarWork(next);
      setWork({ ...DEFAULT_WORK, ...saved });
      setOk(true);
      // «Сохранено» гаснет само: постоянная зелёная плашка перестаёт что-либо значить
      setTimeout(() => setOk(false), 2000);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Не удалось сохранить');
      api.calendarWork().then((w) => setWork({ ...DEFAULT_WORK, ...w })).catch(() => undefined);
    } finally {
      setSaving(false);
    }
  };

  if (!work) {
    return (
      <div className="drawer-overlay" {...overlayProps(onClose)}>
        <aside className="drawer" onClick={(e) => e.stopPropagation()}>
          <div className="drawer-head">
            <h3><Icon name="clock" size={18} /> Рабочее время</h3>
            <button className="btn btn-ghost btn-sm" onClick={onClose} title="Закрыть"><Icon name="close" /></button>
          </div>
          {err ? <div className="error-text">{err}</div> : <div className="dim">Загружаю…</div>}
        </aside>
      </div>
    );
  }

  const toggleDay = (day: number) => {
    const weekendDays = work.weekendDays.includes(day)
      ? work.weekendDays.filter((d) => d !== day)
      : [...work.weekendDays, day].sort();
    save({ ...work, weekendDays });
  };

  const addHoliday = (date: string) => {
    if (!date) return;
    setNewHoliday('');
    if (work.holidays.includes(date)) return;
    save({ ...work, holidays: mergeHolidays(work.holidays, [date]) });
  };

  const addYear = (y: number) => {
    save({ ...work, holidays: mergeHolidays(work.holidays, ruHolidays(y).map((h) => h.date)) });
  };

  return (
    <div className="drawer-overlay" {...overlayProps(onClose)}>
      <aside className="drawer" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-head">
          <h3><Icon name="clock" size={18} /> Рабочее время</h3>
          <button className="btn btn-ghost btn-sm" onClick={onClose} title="Закрыть"><Icon name="close" /></button>
        </div>

        <div className="dim gate-panel-hint">
          По этим часам календарь приглушает нерабочее время, а ассистент молчит: напоминания
          не приходят ночью, в выходной и в праздник. Часы считаются по поясу того, кому пишут.
        </div>

        {err && <div className="error-text">{err}</div>}
        {ok && <div className="dim work-saved"><Icon name="check" size={13} /> Сохранено</div>}

        <div className="drawer-section-title">Рабочий день</div>
        <div className="work-hours">
          <label>
            <span className="dim">с</span>
            <input
              className="input"
              type="time"
              value={work.workStart}
              disabled={!canManage || saving}
              onChange={(e) => setWork({ ...work, workStart: e.target.value })}
              onBlur={() => work.workStart < work.workEnd
                ? save(work)
                : setErr('Начало рабочего дня должно быть раньше конца')}
            />
          </label>
          <label>
            <span className="dim">до</span>
            <input
              className="input"
              type="time"
              value={work.workEnd}
              disabled={!canManage || saving}
              onChange={(e) => setWork({ ...work, workEnd: e.target.value })}
              onBlur={() => work.workStart < work.workEnd
                ? save(work)
                : setErr('Начало рабочего дня должно быть раньше конца')}
            />
          </label>
        </div>

        <div className="drawer-section-title">Выходные дни</div>
        <div className="chip-row">
          {WEEK_DAYS.map((d) => (
            <button
              key={d.value}
              className={`group-chip${work.weekendDays.includes(d.value) ? ' group-chip-on' : ''}`}
              disabled={!canManage || saving}
              onClick={() => toggleDay(d.value)}
              title={work.weekendDays.includes(d.value) ? 'Сделать рабочим' : 'Сделать выходным'}
            >
              {d.short}
            </button>
          ))}
        </div>
        <div className="dim gate-panel-hint">
          Выходной не запрещает ставить встречи — в сетке он приглушён, а ассистент в такой
          день молчит. Люди работают и в субботу, когда горит.
        </div>

        <div className="drawer-section-title">Праздники</div>
        {canManage && (
          <div className="work-holiday-add">
            <DatePicker value={newHoliday} onChange={addHoliday} placeholder="добавить день" disabled={saving} />
            <button className="btn btn-sm" disabled={saving} onClick={() => addYear(year)}>
              Нерабочие дни {year}
            </button>
            <button className="btn btn-sm" disabled={saving} onClick={() => addYear(year + 1)}>
              и {year + 1}
            </button>
          </div>
        )}
        <div className="dim gate-panel-hint">
          Кнопки подставляют даты из статьи 112 ТК. Переносы правительство утверждает каждый год
          отдельно — их добавьте вручную, зашитая таблица переносов молча устарела бы.
        </div>

        {work.holidays.length === 0 && <div className="dim">Праздники не заданы.</div>}
        <div className="chip-row">
          {work.holidays.map((date) => (
            <button
              key={date}
              className="member-chip"
              disabled={!canManage || saving}
              onClick={() => save({ ...work, holidays: work.holidays.filter((d) => d !== date) })}
              title={canManage ? 'Убрать из праздников' : undefined}
            >
              {humanDate(date)} {canManage && <Icon name="close" size={11} />}
            </button>
          ))}
        </div>

        {!canManage && (
          <div className="dim gate-panel-hint">Рабочее время задаёт владелец компании.</div>
        )}
      </aside>
    </div>
  );
}
