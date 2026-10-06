import { cn } from './cn';
import { initialsOf } from '../../lib/initials';

/** Кружок с двумя буквами имени — для строк списков, где фото не грузим. */
export function Avatar({ name, size = 22, className }: { name: string; size?: number; className?: string }) {
  return (
    <span className={cn('ui-avatar', className)} style={{ width: size, height: size, fontSize: Math.round(size * 0.4) }} aria-hidden>
      {initialsOf(name)}
    </span>
  );
}
