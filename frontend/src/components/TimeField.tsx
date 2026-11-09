const pad = (n: number) => String(n).padStart(2, '0');
const HOURS = Array.from({ length: 24 }, (_, i) => pad(i));
const MINUTES = Array.from({ length: 60 }, (_, i) => pad(i));

/**
 * Время «ЧЧ:ММ» — всегда 24 часа (#4840).
 *
 * Нативный <input type="time"> рисует время по языку БРАУЗЕРА, а не страницы: у кого
 * Chrome на английском, видел «08:38 PM». Две выпадашки — часы и минуты — выглядят
 * одинаково у всех и не требуют набирать время с клавиатуры.
 */
export function TimeField({ value, onChange, onBlur, disabled, ariaLabel, className }: {
  value: string;
  onChange: (v: string) => void;
  onBlur?: () => void;
  disabled?: boolean;
  ariaLabel?: string;
  className?: string;
}) {
  const m = /^(\d{1,2}):(\d{2})/.exec(value || '');
  const hh = m ? pad(Number(m[1])) : '';
  const mm = m ? m[2] : '';
  const set = (h: string, mi: string) => onChange(`${h || '00'}:${mi || '00'}`);
  return (
    <span className={`time-field${className ? ` ${className}` : ''}`} role="group" aria-label={ariaLabel}>
      <select className="input time-field-part" value={hh} disabled={disabled} aria-label={ariaLabel ? `${ariaLabel}: часы` : 'Часы'}
        onChange={(e) => set(e.target.value, mm)} onBlur={onBlur}>
        {!hh && <option value="">--</option>}
        {HOURS.map((h) => <option key={h} value={h}>{h}</option>)}
      </select>
      <span aria-hidden="true">:</span>
      <select className="input time-field-part" value={mm} disabled={disabled} aria-label={ariaLabel ? `${ariaLabel}: минуты` : 'Минуты'}
        onChange={(e) => set(hh, e.target.value)} onBlur={onBlur}>
        {!mm && <option value="">--</option>}
        {MINUTES.map((x) => <option key={x} value={x}>{x}</option>)}
      </select>
    </span>
  );
}
