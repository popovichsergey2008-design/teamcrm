import { Toggle as Base } from '@base-ui/react/toggle';
import type { ReactNode } from 'react';
import { cn } from './cn';

/** Кнопка-переключатель (фильтр «вкл/выкл», роль в списке). Состояние — aria-pressed. */
export function Toggle({ pressed, onPressedChange, children, title, className, size = 'sm' }: {
  pressed: boolean;
  onPressedChange: (pressed: boolean) => void;
  children: ReactNode;
  title?: string;
  className?: string;
  size?: 'sm' | 'md';
}) {
  return (
    <Base
      pressed={pressed}
      onPressedChange={onPressedChange}
      className={cn('ui-toggle', `ui-toggle-${size}`, className)}
      title={title}
    >
      {children}
    </Base>
  );
}
