import { useEffect, useState } from 'react';
import { lazyComponent } from '../lib/lazy';
import { TimeField } from './TimeField';

/*
  #4840: замена нативных <input type="date | datetime-local | time">.

  Нативное поле рисует дату по языку БРАУЗЕРА, а не страницы: у кого Chrome на
  английском, видел «11/10/2026 08:38 PM» — месяц впереди дня, время с AM/PM.
  Здесь всегда дд.мм.гг и 24 часа: календарь проекта (DatePicker, неделя с
  понедельника) и время двумя выпадашками.

  Интерфейс — как у input: value в том же формате («ГГГГ-ММ-ДД», «ГГГГ-ММ-ДДTЧЧ:ММ»,
  «ЧЧ:ММ»), onChange получает { target: { value } } — места использования почти не
  меняются. Календарь грузится по первому показу: он не нужен первому экрану.
*/
// до загрузки — пустая кнопка того же вида: поле не «прыгает» и не пропадает на миг
const DatePicker = lazyComponent(
  () => import('./DatePicker').then((m) => m.DatePicker),
  <button type="button" className="input dp-trigger dp-empty" disabled>…</button>,
);

type Ev = { target: { value: string }; currentTarget: { value: string } };
const ev = (value: string): Ev => ({ target: { value }, currentTarget: { value } });

export function DateInput({ type, value, onChange, onBlur, disabled, name, placeholder, title, className, ...rest }: {
  type: 'date' | 'datetime-local' | 'time';
  value?: string;
  onChange?: (e: Ev) => void;
  /** Поле сохраняли по уходу фокуса — у календаря выбор и есть «ушли из поля». */
  onBlur?: (e: Ev) => void;
  disabled?: boolean;
  /** Для форм, читающих значение по имени поля. */
  name?: string;
  placeholder?: string;
  title?: string;
  className?: string;
  required?: boolean;
  min?: string;
  max?: string;
  'aria-label'?: string;
}) {
  // без value — поле само держит значение (как неуправляемый input)
  const [own, setOwn] = useState('');
  // календарь — заранее, как только поле появилось: открыть его можно уже через миг
  useEffect(() => { if (type !== 'time') DatePicker.preload(); }, [type]);
  const v = value ?? own;
  const set = (next: string) => {
    if (value === undefined) setOwn(next);
    onChange?.(ev(next));
  };
  const label = rest['aria-label'];
  // классы самого поля (рамка, отступы) у обёртки не нужны — их рисует календарь; раскладка — остаётся
  const cls = (className ?? '').split(/\s+/).filter((c) => c && !/^(input|ui-input(-\w+)?)$/.test(c)).join(' ');
  return (
    <span className={`date-input${cls ? ` ${cls}` : ''}`} title={title}>
      {type === 'time'
        ? <TimeField value={v} onChange={set} onBlur={() => onBlur?.(ev(v))} disabled={disabled} ariaLabel={label} />
        : (
          <DatePicker
            value={v}
            withTime={type === 'datetime-local'}
            onChange={(next: string) => { set(next); onBlur?.(ev(next)); }}
            disabled={disabled}
            ariaLabel={label}
            placeholder={placeholder ?? (type === 'date' ? 'выбрать дату' : 'выбрать дату и время')}
          />
        )}
      {name && <input type="hidden" name={name} value={v} />}
    </span>
  );
}
