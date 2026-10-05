import { forwardRef, type InputHTMLAttributes, type ReactNode } from 'react';
import { cn } from './cn';

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  /** Иконка слева внутри поля (поиск, почта). */
  leading?: ReactNode;
  /** Что-то справа внутри поля: кнопка очистки, единица измерения. */
  trailing?: ReactNode;
  invalid?: boolean;
  inputSize?: 'sm' | 'md';
}

/** Поле ввода (ТЗ-15). С иконками рисуется группой: рамка общая, фокус — на всей группе. */
export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { leading, trailing, invalid, inputSize = 'md', className, ...rest }, ref,
) {
  if (!leading && !trailing) {
    return <input ref={ref} className={cn('ui-input', `ui-input-${inputSize}`, className)} aria-invalid={invalid || undefined} {...rest} />;
  }
  return (
    <span className={cn('ui-input', 'ui-input-group', `ui-input-${inputSize}`, className)} data-invalid={invalid || undefined}>
      {leading && <span className="ui-input-addon">{leading}</span>}
      <input ref={ref} aria-invalid={invalid || undefined} {...rest} />
      {trailing && <span className="ui-input-addon">{trailing}</span>}
    </span>
  );
});
