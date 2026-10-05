import { forwardRef, useId, type ReactNode, type TextareaHTMLAttributes } from 'react';
import { cn } from './cn';

/**
 * Поле формы (ТЗ-15): подпись, само поле, подсказка, ошибка — одинаково во всех формах.
 *
 * `action` — кнопка справа от подписи («Редактировать», «Подобрать»): ей место у
 * подписи, а не под полем, где она теряется среди подсказок.
 */
export function Field({ label, hint, error, action, children, className, htmlFor }: {
  label?: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  htmlFor?: string;
}) {
  return (
    <div className={cn('ui-field', className)} data-invalid={error ? '' : undefined}>
      {(label || action) && (
        <div className="ui-field-head">
          {label && <label className="ui-field-label" htmlFor={htmlFor}>{label}</label>}
          {action && <span className="ui-field-action">{action}</span>}
        </div>
      )}
      {children}
      {hint && !error && <span className="ui-field-hint">{hint}</span>}
      {error && <span className="ui-field-error" role="alert">{error}</span>}
    </div>
  );
}

/** Многострочное поле в стиле Input. */
export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement> & { invalid?: boolean }>(
  function Textarea({ className, invalid, ...rest }, ref) {
    return <textarea ref={ref} className={cn('ui-textarea', className)} aria-invalid={invalid || undefined} {...rest} />;
  },
);

/** id для связки подписи с полем, когда его не задали снаружи. */
export const useFieldId = useId;
