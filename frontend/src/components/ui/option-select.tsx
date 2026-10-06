import { Children, isValidElement, useState, type CSSProperties, type MouseEvent, type ReactElement, type ReactNode } from 'react';
import { Select as Base } from '@base-ui/react/select';
import { Check, ChevronsUpDown } from 'lucide-react';
import { cn } from './cn';

/** То, что приходит в onChange: как у родного списка — `e.target.value`. */
export interface OptionSelectEvent {
  target: { value: string };
  /** Присвоить '' — сбросить выбор, как `e.currentTarget.value = ''` у родного списка. */
  currentTarget: { value: string };
}

interface Option { value: string; label: string; disabled: boolean }

/** Текст опции: строки и числа из детей, в том числе склеенные выражения. */
function textOf(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (isValidElement(node)) return textOf((node.props as { children?: ReactNode }).children);
  return '';
}

/** Собрать <option> из детей — с фрагментами и массивами из .map(). */
function collect(children: ReactNode, out: Option[] = []): Option[] {
  Children.forEach(children, (child) => {
    if (!isValidElement(child)) return;
    const el = child as ReactElement<{ value?: string | number; children?: ReactNode; disabled?: boolean }>;
    if (el.type === 'option') {
      const label = textOf(el.props.children);
      out.push({ value: el.props.value === undefined ? label : String(el.props.value), label, disabled: !!el.props.disabled });
    } else {
      collect(el.props.children, out);
    }
  });
  return out;
}

/**
 * Замена родного <select> «один в один» (ТЗ-15).
 *
 * Принимает те же <option> детьми и отдаёт onChange с `e.target.value`, поэтому перевод
 * экрана — смена тега, а не переписывание обработчиков. Внутри — Base UI: одинаковый
 * вид на всех системах, клавиатура, поиск по первым буквам, не обрезается у краёв.
 * Для нового кода удобнее `Select` с массивом options.
 */
export function OptionSelect({
  value, defaultValue, onChange, onClick, children, className, disabled, id, title, style,
  'aria-label': ariaLabel, 'aria-labelledby': ariaLabelledby,
}: {
  value?: string | number | null;
  defaultValue?: string | number;
  onChange?: (e: OptionSelectEvent) => void;
  /** Список внутри <label> с флажком: preventDefault не даёт щелчку переключить флажок. */
  onClick?: (e: MouseEvent<HTMLButtonElement>) => void;
  children: ReactNode;
  className?: string;
  disabled?: boolean;
  id?: string;
  title?: string;
  style?: CSSProperties;
  'aria-label'?: string;
  'aria-labelledby'?: string;
}) {
  const options = collect(children);
  const [inner, setInner] = useState<string>(defaultValue === undefined ? (options[0]?.value ?? '') : String(defaultValue));
  const controlled = value !== undefined;
  const current = controlled ? String(value ?? '') : inner;
  const items = Object.fromEntries(options.map((o) => [o.value, o.label]));

  // Прежний класс поля ввода растягивал список на всю ширину — сохраняем это поведение.
  const classes = (className ?? '').split(/\s+/).filter(Boolean);
  const fill = classes.includes('input');
  const rest = classes.filter((c) => c !== 'input').join(' ');

  const change = (next: string) => {
    if (!controlled) setInner(next);
    let picked = next;
    const box = {
      get value() { return picked; },
      set value(v: string) { picked = v; setInner(v); },
    };
    onChange?.({ target: box, currentTarget: box });
  };

  return (
    <Base.Root items={items} value={current} onValueChange={(v) => change(String(v ?? ''))} disabled={disabled}>
      <Base.Trigger
        id={id}
        title={title}
        onClick={onClick}
        style={style}
        className={cn('ui-select-trigger', 'ui-input-md', fill && 'ui-select-fill', rest)}
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledby}
      >
        <Base.Value className="ui-select-value" />
        <Base.Icon className="ui-select-icon"><ChevronsUpDown size={14} /></Base.Icon>
      </Base.Trigger>
      <Base.Portal>
        <Base.Positioner className="ui-positioner" sideOffset={4} align="start" alignItemWithTrigger={false}>
          <Base.Popup className="ui-popup ui-select-popup">
            <Base.List>
              {options.map((o) => (
                <Base.Item key={o.value} value={o.value} disabled={o.disabled} className="ui-menu-item">
                  <Base.ItemText className="ui-menu-label">{o.label}</Base.ItemText>
                  <Base.ItemIndicator className="ui-menu-check"><Check size={14} /></Base.ItemIndicator>
                </Base.Item>
              ))}
            </Base.List>
          </Base.Popup>
        </Base.Positioner>
      </Base.Portal>
    </Base.Root>
  );
}
