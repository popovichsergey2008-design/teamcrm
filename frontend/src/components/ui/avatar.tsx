import { cn } from './cn';

/** Кружок с первой буквой имени — для строк списков, где фото не грузим. */
export function Avatar({ name, size = 22, className }: { name: string; size?: number; className?: string }) {
  return (
    <span className={cn('ui-avatar', className)} style={{ width: size, height: size, fontSize: Math.round(size * 0.45) }} aria-hidden>
      {(name.trim()[0] ?? '?').toUpperCase()}
    </span>
  );
}
