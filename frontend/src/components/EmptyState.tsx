import { Icon, IconName } from './Icon';

/**
 * Пустое состояние.
 *
 * Пустой экран без объяснения читается как поломка: человек не понимает, данные
 * не загрузились или их правда нет. Поэтому здесь всегда три части: что произошло,
 * почему это нормально и что сделать дальше — последнее кнопкой, если действие есть.
 */
export function EmptyState({ icon, title, hint, action, compact }: {
  icon: IconName;
  title: string;
  hint?: string;
  action?: { label: string; onClick: () => void };
  /** Внутри панели или колонки — без крупных отступов. */
  compact?: boolean;
}) {
  return (
    <div className={`empty-state ${compact ? 'empty-compact' : ''}`}>
      <span className="empty-icon"><Icon name={icon} size={compact ? 18 : 24} /></span>
      <div className="empty-title">{title}</div>
      {hint && <div className="empty-hint">{hint}</div>}
      {action && (
        <button className="btn btn-primary btn-sm" style={{ marginTop: 10 }} onClick={action.onClick}>
          {action.label}
        </button>
      )}
    </div>
  );
}
