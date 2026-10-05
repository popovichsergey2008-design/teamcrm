import { Tabs as Base } from '@base-ui/react/tabs';
import type { ReactNode } from 'react';
import { cn } from './cn';

export interface TabItem<T extends string> {
  value: T;
  label: ReactNode;
  /** Цифра справа: файлов, пунктов, непрочитанного. Ноль не показываем. */
  count?: number;
}

/**
 * Вкладки (ТЗ-15): подчёркивание едет под активной, стрелки ←/→ переключают.
 *
 * Содержимое вкладок рисует сам экран, как и раньше: у карточки задачи вкладка
 * «Чат» перестраивает раскладку окна целиком, и прятать её в Tabs.Panel нельзя.
 */
export function Tabs<T extends string>({ value, onValueChange, items, className, ariaLabel }: {
  value: T;
  onValueChange: (value: T) => void;
  items: TabItem<T>[];
  className?: string;
  ariaLabel?: string;
}) {
  return (
    <Base.Root value={value} onValueChange={(v) => onValueChange(v as T)} className={cn('ui-tabs', className)}>
      <Base.List className="ui-tabs-list" aria-label={ariaLabel}>
        {items.map((t) => (
          <Base.Tab key={t.value} value={t.value} className="ui-tab">
            {t.label}
            {!!t.count && <span className="ui-tab-count">{t.count}</span>}
          </Base.Tab>
        ))}
        <Base.Indicator className="ui-tabs-indicator" />
      </Base.List>
    </Base.Root>
  );
}
