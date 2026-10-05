import { Select as Base } from '@base-ui/react/select';
import { Check, ChevronsUpDown } from 'lucide-react';
import { cn } from './cn';

export interface SelectOption { value: string; label: string }

/**
 * Выпадающий список (ТЗ-15) вместо родного <select>.
 *
 * Родной список на каждой системе свой: на Windows — серый прямоугольник, на Android —
 * лист во весь экран. Здесь — одинаковый везде, с клавиатурой (стрелки, поиск по
 * первым буквам, Escape) и не обрезается у краёв экрана: положение считает Base UI.
 */
export function Select({ value, onValueChange, options, ariaLabel, placeholder, className, size = 'md', disabled }: {
  value: string;
  onValueChange: (value: string) => void;
  options: SelectOption[];
  ariaLabel: string;
  placeholder?: string;
  className?: string;
  size?: 'sm' | 'md';
  disabled?: boolean;
}) {
  const items = Object.fromEntries(options.map((o) => [o.value, o.label]));
  return (
    <Base.Root
      items={items}
      value={value}
      onValueChange={(v) => onValueChange(String(v ?? ''))}
      disabled={disabled}
    >
      <Base.Trigger className={cn('ui-select-trigger', `ui-input-${size}`, className)} aria-label={ariaLabel}>
        <Base.Value className="ui-select-value" placeholder={placeholder} />
        <Base.Icon className="ui-select-icon"><ChevronsUpDown size={14} /></Base.Icon>
      </Base.Trigger>
      <Base.Portal>
        <Base.Positioner className="ui-positioner" sideOffset={4} align="start" alignItemWithTrigger={false}>
          <Base.Popup className="ui-popup ui-select-popup">
            <Base.List>
              {options.map((o) => (
                <Base.Item key={o.value} value={o.value} className="ui-menu-item">
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
