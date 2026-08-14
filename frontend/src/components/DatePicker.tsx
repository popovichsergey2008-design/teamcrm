import { useEffect, useMemo, useRef, useState } from 'react';

interface Props {
  /** «ГГГГ-ММ-ДД» или «ГГГГ-ММ-ДДTЧЧ:ММ» — тот же формат, что у нативного input, чтобы вызывающий код не менялся. */
  value: string;
  onChange: (value: string) => void;
  withTime?: boolean;
  placeholder?: string;
  /** Подсказка «просрочен» для дедлайнов: прошедшая дата подсвечивается красным. */
  warnPast?: boolean;
  disabled?: boolean;
}

const WEEKDAYS = ['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'];
const pad = (n: number) => String(n).padStart(2, '0');

/** Локальная дата → значение поля. Через toISOString нельзя: он уводит в UTC и сдвигает день. */
function toValue(d: Date, withTime: boolean): string {
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return withTime ? `${date}T${pad(d.getHours())}:${pad(d.getMinutes())}` : date;
}

function parseValue(v: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/.exec(v || '');
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] ?? '0'), Number(m[5] ?? '0'));
  return Number.isNaN(d.getTime()) ? null : d;
}

const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();

/**
 * Календарь в оформлении проекта — вместо нативного datetime-local, который в тёмной теме
 * выглядит чужеродно и по-разному в каждом браузере.
 * Без внешних зависимостей: в проекте нет библиотеки дат, и тащить её ради одного поля незачем.
 */
export function DatePicker({ value, onChange, withTime = false, placeholder = 'не задан', warnPast = false, disabled }: Props) {
  const selected = useMemo(() => parseValue(value), [value]);
  const [open, setOpen] = useState(false);
  const [view, setView] = useState(() => startOfDay(selected ?? new Date()));
  const box = useRef<HTMLDivElement>(null);

  // открыли — показываем месяц выбранной даты, а не тот, где остановились в прошлый раз
  useEffect(() => { if (open) setView(startOfDay(selected ?? new Date())); }, [open, selected]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open]);

  const today = startOfDay(new Date());
  const isPast = !!selected && startOfDay(selected) < today;

  /** Сетка месяца: всегда 6 недель, соседние месяцы приглушены — так календарь не «прыгает» по высоте. */
  const grid = useMemo(() => {
    const first = new Date(view.getFullYear(), view.getMonth(), 1);
    const offset = (first.getDay() + 6) % 7; // неделя с понедельника
    const start = new Date(first.getFullYear(), first.getMonth(), 1 - offset);
    return Array.from({ length: 42 }, (_, i) => new Date(start.getFullYear(), start.getMonth(), start.getDate() + i));
  }, [view]);

  const pick = (day: Date) => {
    const base = selected ?? new Date();
    const next = withTime
      ? new Date(day.getFullYear(), day.getMonth(), day.getDate(), base.getHours(), base.getMinutes())
      : day;
    onChange(toValue(next, withTime));
    if (!withTime) setOpen(false); // со временем оставляем открытым — обычно правят и часы
  };

  const setTime = (hhmm: string) => {
    const [h, m] = hhmm.split(':').map(Number);
    const day = selected ?? today;
    onChange(toValue(new Date(day.getFullYear(), day.getMonth(), day.getDate(), h || 0, m || 0), true));
  };

  const shiftDays = (days: number) => {
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() + days,
      selected?.getHours() ?? 18, selected?.getMinutes() ?? 0);
    onChange(toValue(d, withTime));
    if (!withTime) setOpen(false);
  };

  const label = selected
    ? selected.toLocaleDateString('ru-RU', { day: '2-digit', month: 'long', year: 'numeric' })
      + (withTime ? `, ${pad(selected.getHours())}:${pad(selected.getMinutes())}` : '')
    : placeholder;

  return (
    <div className="dp" ref={box}>
      <button
        type="button"
        className={`input dp-trigger ${selected ? '' : 'dp-empty'} ${warnPast && isPast ? 'dp-past' : ''}`}
        onClick={() => !disabled && setOpen((v) => !v)}
        disabled={disabled}
        title={selected ? 'Изменить дату' : 'Выбрать дату'}
      >
        <span>📅 {label}</span>
        {selected && !disabled && (
          <span
            className="dp-clear"
            role="button"
            tabIndex={-1}
            title="Убрать дату"
            onClick={(e) => { e.stopPropagation(); onChange(''); setOpen(false); }}
          >
            ✕
          </span>
        )}
      </button>

      {open && (
        <div className="dp-pop">
          <div className="dp-head">
            <button type="button" className="dp-nav" onClick={() => setView(new Date(view.getFullYear(), view.getMonth() - 1, 1))} aria-label="Предыдущий месяц">‹</button>
            <span className="dp-month">{view.toLocaleDateString('ru-RU', { month: 'long', year: 'numeric' })}</span>
            <button type="button" className="dp-nav" onClick={() => setView(new Date(view.getFullYear(), view.getMonth() + 1, 1))} aria-label="Следующий месяц">›</button>
          </div>

          <div className="dp-week">{WEEKDAYS.map((w) => <span key={w}>{w}</span>)}</div>
          <div className="dp-grid">
            {grid.map((d) => {
              const other = d.getMonth() !== view.getMonth();
              const weekend = d.getDay() === 0 || d.getDay() === 6;
              const cls = [
                'dp-day',
                other ? 'dp-other' : '',
                weekend ? 'dp-weekend' : '',
                sameDay(d, today) ? 'dp-today' : '',
                selected && sameDay(d, selected) ? 'dp-selected' : '',
              ].filter(Boolean).join(' ');
              return (
                <button type="button" key={d.toISOString()} className={cls} onClick={() => pick(d)}>
                  {d.getDate()}
                </button>
              );
            })}
          </div>

          {withTime && (
            <div className="dp-time">
              <span className="status-label">Время</span>
              <input
                className="input dp-time-input"
                type="time"
                value={selected ? `${pad(selected.getHours())}:${pad(selected.getMinutes())}` : '18:00'}
                onChange={(e) => setTime(e.target.value)}
              />
            </div>
          )}

          <div className="dp-quick">
            <button type="button" className="dp-chip" onClick={() => shiftDays(0)}>Сегодня</button>
            <button type="button" className="dp-chip" onClick={() => shiftDays(1)}>Завтра</button>
            <button type="button" className="dp-chip" onClick={() => shiftDays(7)}>Через неделю</button>
            <button type="button" className="dp-chip dp-chip-clear" onClick={() => { onChange(''); setOpen(false); }}>Убрать</button>
          </div>
        </div>
      )}
    </div>
  );
}
