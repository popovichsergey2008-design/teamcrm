import { Menu } from '@base-ui/react/menu';
import type { ReactElement, ReactNode } from 'react';
import { cn } from './cn';

/**
 * Меню действий (ТЗ-15): «⋯» у строки, у карточки, у сообщения.
 *
 * Пункт с destructive — красный и всегда последним, отделён чертой: так удаление
 * выглядит одинаково во всех разделах (§82 плана). Подтверждение — confirmAction.
 */
export function DropdownMenu({ trigger, children, align = 'end' }: {
  /** Элемент-кнопка, открывающая меню (обычно <Button size="icon-sm">). */
  trigger: ReactElement;
  children: ReactNode;
  align?: 'start' | 'center' | 'end';
}) {
  return (
    <Menu.Root>
      <Menu.Trigger render={trigger} />
      <Menu.Portal>
        <Menu.Positioner className="ui-positioner" sideOffset={4} align={align}>
          <Menu.Popup className="ui-popup ui-menu">{children}</Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

export function MenuItem({ onSelect, icon, children, destructive, disabled, shortcut }: {
  onSelect: () => void;
  icon?: ReactNode;
  children: ReactNode;
  destructive?: boolean;
  disabled?: boolean;
  shortcut?: string;
}) {
  return (
    <Menu.Item
      className={cn('ui-menu-item', destructive && 'ui-menu-item-danger')}
      onClick={onSelect}
      disabled={disabled}
    >
      {icon && <span className="ui-menu-icon">{icon}</span>}
      <span className="ui-menu-label">{children}</span>
      {shortcut && <kbd className="ui-kbd">{shortcut}</kbd>}
    </Menu.Item>
  );
}

export function MenuSeparator() {
  return <Menu.Separator className="ui-menu-sep" />;
}
