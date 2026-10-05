import { Checkbox as Base } from '@base-ui/react/checkbox';
import { Check, Minus } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from './cn';

/** Флажок (ТЗ-15) на Base UI: клавиатура, состояние «частично» и подпись из коробки. */
export function Checkbox({ checked, onCheckedChange, label, indeterminate, disabled, className }: {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  label?: ReactNode;
  indeterminate?: boolean;
  disabled?: boolean;
  className?: string;
}) {
  const box = (
    <Base.Root
      className="ui-checkbox"
      checked={checked}
      indeterminate={indeterminate}
      disabled={disabled}
      onCheckedChange={(v) => onCheckedChange(!!v)}
    >
      <Base.Indicator className="ui-checkbox-mark">
        {indeterminate ? <Minus size={12} strokeWidth={3} /> : <Check size={12} strokeWidth={3} />}
      </Base.Indicator>
    </Base.Root>
  );
  if (!label) return box;
  return (
    <label className={cn('ui-checkbox-label', className)} data-disabled={disabled || undefined}>
      {box}
      <span>{label}</span>
    </label>
  );
}
