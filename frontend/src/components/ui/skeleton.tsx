import { cn } from './cn';

/** Заглушка содержимого при первой загрузке экрана. */
export function Skeleton({ className, width, height = 14 }: { className?: string; width?: number | string; height?: number | string }) {
  return <span className={cn('ui-skeleton', className)} style={{ width, height }} aria-hidden />;
}
