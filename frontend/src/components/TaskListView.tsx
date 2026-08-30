import type { Board, Task, User } from '../types';
import { Icon } from './Icon';
import { MONETIZATION_ENABLED } from '../config';
import { deadlineBadge, labelTextColor, priorityBadge } from '../lib/labels';

interface Props {
  board: Board;
  users: User[];
  activeTimerTask: string | null;
  onOpenTask: (task: Task) => void;
}

/** Списочный вид доски: задачи сгруппированы по колонкам, компактные строки. */
export function TaskListView({ board, users, activeTimerTask, onOpenTask }: Props) {
  const nameOf = (t: Task) => t.assignee_name ?? users.find((u) => u.id === t.assignee_id)?.fullName ?? null;
  /** Постановщик: в списке он нужен ровно затем же, зачем на доске — знать, с кого спросят. */
  const managerOf = (t: Task) => t.manager_name ?? users.find((u) => u.id === t.created_by)?.fullName ?? null;

  return (
    <div className="task-list">
      {board.columns.map((col) => (
        <div key={col.id} className="list-group">
          <div className="list-group-head">
            <span>{col.name}</span>
            <span className="badge">{col.tasks.length}</span>
          </div>
          {col.tasks.map((t) => {
            const assignee = nameOf(t);
            const manager = managerOf(t);
            const cost = t.cost_current !== undefined ? Number(t.cost_current) : null;
            const prio = priorityBadge(t.priority);
            const due = deadlineBadge(t.deadline_at, !!t.closed_at);
            return (
              <div key={t.id} className={`list-row ${activeTimerTask === t.id ? 'task-tracking' : ''}`}
                   role="button" tabIndex={0}
                   onClick={() => onOpenTask(t)}
                   onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpenTask(t); } }}>
                <div className="list-main">
                  {t.risk_level && <span className={`risk-dot risk-${t.risk_level}`} title={`Риск срока: ${t.risk_level}`} />}
                  <span className="list-title">{t.title}</span>
                  {t.labels?.map((l) => <span key={l.id} className="label-chip" style={{ background: l.color, color: labelTextColor(l.color) }}>{l.name}</span>)}
                </div>
                <div className="list-side">
                  {t.approval_state === 'pending' && (
                    <span className="badge badge-warn" title="Работа сдана, ждёт решения постановщика">На согласовании</span>
                  )}
                  {t.is_blocked && <span className="badge badge-blocked">BLOCKED</span>}
                  {prio && <span className={prio.cls} title="Приоритет">{prio.text}</span>}
                  {due && <span className={due.cls} title={due.title}>{due.text}</span>}
                  {!!t.commentsCount && <span className="badge" title="комментарии"><Icon name="chat" size={12} /> {t.commentsCount}</span>}
                  {!!t.attachmentsCount && <span className="badge" title="вложения"><Icon name="paperclip" size={12} /> {t.attachmentsCount}</span>}
                  {!!t.checklistTotal && <span className="badge" title="чеклист"><Icon name="check" size={12} /> {t.checklistDone}/{t.checklistTotal}</span>}
                  {MONETIZATION_ENABLED && cost !== null && (
                    <span className="badge" title="Себестоимость">₽ {cost.toLocaleString('ru-RU', { maximumFractionDigits: 0 })}</span>
                  )}
                  {assignee ? (
                    <span className="assignee-chip" title={`Исполнитель: ${assignee}`}>
                      <span className="avatar-xs avatar-ph">{assignee[0]?.toUpperCase()}</span>
                      {assignee}
                    </span>
                  ) : (
                    <span className="dim list-noassignee">— не назначен —</span>
                  )}
                  {manager && (
                    <span className="manager-chip" title={`Постановщик: ${manager}`}>
                      <Icon name="send" size={11} /> от {manager}
                    </span>
                  )}
                </div>
              </div>
            );
          })}
          {col.tasks.length === 0 && <div className="muted list-empty">Нет задач</div>}
        </div>
      ))}
    </div>
  );
}
