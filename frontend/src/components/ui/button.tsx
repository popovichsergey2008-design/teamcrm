import { forwardRef, type ButtonHTMLAttributes } from 'react';
import { cn } from './cn';
import { Spinner } from './spinner';

export type ButtonVariant = 'primary' | 'secondary' | 'outline' | 'ghost' | 'destructive' | 'link';
export type ButtonSize = 'sm' | 'md' | 'lg' | 'icon' | 'icon-sm';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Действие идёт: кнопка недоступна и показывает крутилку на месте иконки. */
  loading?: boolean;
}

/**
 * Кнопка ANTHILL (ТЗ-15). Одна на всё приложение: варианты — смысл действия,
 * размеры — плотность. Цвета только из токенов, кольцо фокуса — общее для ui-*.
 */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', loading, disabled, className, children, type = 'button', ...rest }, ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cn('ui-btn', `ui-btn-${variant}`, `ui-btn-${size}`, className)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading && <Spinner size={size === 'sm' || size === 'icon-sm' ? 12 : 14} />}
      {children}
    </button>
  );
});
