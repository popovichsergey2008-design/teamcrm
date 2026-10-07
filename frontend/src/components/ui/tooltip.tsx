import { Tooltip as Base } from '@base-ui/react/tooltip';
import type { ReactElement, ReactNode } from 'react';

/**
 * Подсказка при наведении и фокусе с клавиатуры (ТЗ-15).
 * Только пояснение: действие, которое видно лишь в подсказке, на телефоне не существует.
 */
export function Tooltip({ content, children, side = 'top' }: {
  content: ReactNode;
  children: ReactElement;
  side?: 'top' | 'bottom' | 'left' | 'right';
}) {
  return (
    <Base.Root>
      <Base.Trigger render={children} />
      <Base.Portal>
        <Base.Positioner className="ui-positioner" side={side} sideOffset={6}>
          <Base.Popup className="ui-tooltip">{content}</Base.Popup>
        </Base.Positioner>
      </Base.Portal>
    </Base.Root>
  );
}

/** Одна задержка на всё приложение: подсказки соседних кнопок открываются без ожидания. */
export const TooltipProvider = Base.Provider;
