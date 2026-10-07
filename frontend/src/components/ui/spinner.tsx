import { cn } from './cn';

/** Крутилка для действия в процессе: кнопка, строка, небольшая область. */
export function Spinner({ size = 14, className, label }: { size?: number; className?: string; label?: string }) {
  return (
    <span
      className={cn('ui-spinner', className)}
      style={{ width: size, height: size }}
      role={label ? 'status' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    />
  );
}
