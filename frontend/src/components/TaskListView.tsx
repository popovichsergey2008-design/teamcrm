import type { Board, Task, User } from '../types';
import { MONETIZATION_ENABLED } from '../config';

interface Props {
  board: Board;
  users: User[];
  canTrack: boolean;
  activeTimerTask: string | null;
  onOpenTask: (task: Task) => void;
  onToggleTimer: (taskId: string) => void;
}

const PRIO_LABEL: Record<string, string> = { urgent: '🔥 срочно', high: '↑ высокий', low: '↓ низкий' };

/** Списочный вид доски: задачи сгруппированы по колонкам, компактные строки. */
export function TaskListView({ board, users, canTrack, activeTimerTask, onOpenTask, onToggleTimer }: Props) {
  const nameOf = (t: Task) => t.assignee_name ?? users.find((u) => u.id === t.assignee_id)?.fullName ?? null;

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
            const cost = t.cost_current !== undefined ? Number(t.cost_current) : null;
            return (
              <div key={t.id} className="list-row" onClick={() => onOpenTask(t)}>
                <div className="list-main">
                  {t.risk_level && <span className={`risk-dot risk-${t.risk_level}`} title={`Риск срока: ${t.risk_level}`} />}
                  <span className="list-title">{t.title}</span>
                  {t.labels?.map((l) => <span key={l.id} className="label-chip" style={{ background: l.color }}>{l.name}</span>)}
                </div>
                <div className="list-side">
                  {t.is_blocked && <span className="badge badge-blocked">BLOCKED</span>}
                  {t.priority && PRIO_LABEL[t.priority] && (
                    <span className={`badge prio-${t.priority}`}>{PRIO_LABEL[t.priority]}</span>
                  )}
                  {!!t.commentsCount && <span className="badge" title="комментарии">💬 {t.commentsCount}</span>}
                  {!!t.attachmentsCount && <span className="badge" title="вложения">📎 {t.attachmentsCount}</span>}
                  {!!t.checklistTotal && <span className="badge" title="чеклист">✓ {t.checklistDone}/{t.checklistTotal}</span>}
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
                  {canTrack && (
                    <button
                      className={`btn btn-sm timer-btn ${activeTimerTask === t.id ? 'timer-on' : ''}`}
                      onClick={(e) => { e.stopPropagation(); onToggleTimer(t.id); }}
                    >
                      {activeTimerTask === t.id ? '⏸' : '▶'}
                    </button>
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
