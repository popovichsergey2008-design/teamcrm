import type { HTMLAttributes } from 'react';
import { cn } from './cn';

export type BadgeTone = 'neutral' | 'info' | 'ok' | 'warn' | 'danger' | 'outline';

/** Плашка статуса или признака. Тон — смысл, а не цвет: цвет берётся из токенов темы. */
export function Badge({ tone = 'neutral', className, ...rest }: HTMLAttributes<HTMLSpanElement> & { tone?: BadgeTone }) {
  return <span className={cn('ui-badge', `ui-badge-${tone}`, className)} {...rest} />;
}
