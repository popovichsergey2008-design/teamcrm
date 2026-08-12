import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../lib/api';
import { deadlineBadge, priorityBadge } from '../lib/labels';
import type { Task } from '../types';

type Scope = 'mine' | 'delegated';

/** Задача из сквозной выборки — с именем проекта и колонки (доска не одна). */
type CrossTask = Task & { project_name: string; column_name: string };

/**
 * «Мои задачи» и «Порученные» — срез по всем проектам сразу, без выбора доски.
 * Мои — где я исполнитель; порученные — где я руководитель, а делает кто-то другой.
 */
export function MyTasksPage({ onOpenProject }: { onOpenProject: (projectId: string, taskId: string) => void }) {
  const [scope, setScope] = useState<Scope>('mine');
  const [showClosed, setShowClosed] = useState(false);
  const [tasks, setTasks] = useState<CrossTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');

  const load = useCallback(async () => {
    setLoading(true); setErr('');
    try { setTasks(await api.myTasks(scope, showClosed)); }
    catch (e) { setErr(e instanceof ApiError ? e.message : 'Не удалось загрузить задачи'); }
    finally { setLoading(false); }
  }, [scope, showClosed]);
  useEffect(() => { load(); }, [load]);

  const overdue = tasks.filter((t) => !t.closed_at && t.deadline_at && new Date(t.deadline_at) < new Date()).length;

  return (
    <div className="mytasks">
      <div className="tabs">
        <button className={`tab ${scope === 'mine' ? 'active' : ''}`} onClick={() => setScope('mine')}>🙋 Мои задачи</button>
        <button className={`tab ${scope === 'delegated' ? 'active' : ''}`} onClick={() => setScope('delegated')}>📤 Порученные</button>
      </div>

      <div className="mytasks-bar">
        <span className="dim">
          {loading ? 'Загружаю…' : `Задач: ${tasks.length}`}
          {!loading && overdue > 0 && <span className="error-text"> · просрочено: {overdue}</span>}
        </span>
        <label className="notify-row" style={{ cursor: 'pointer' }}>
          <input type="checkbox" checked={showClosed} onChange={(e) => setShowClosed(e.target.checked)} />
          <span className="dim">Показывать завершённые</span>
        </label>
      </div>

      {err && <div className="error-text">{err}</div>}
      {!loading && tasks.length === 0 && (
        <div className="muted" style={{ padding: 16 }}>
          {scope === 'mine' ? 'На вас сейчас ничего не назначено.' : 'Вы никому не поручали задач.'}
        </div>
      )}

      <div className="task-list">
        {tasks.map((t) => {
          const prio = priorityBadge(t.priority);
          const due = deadlineBadge(t.deadline_at, !!t.closed_at);
          const who = scope === 'mine' ? t.manager_name : t.assignee_name;
          return (
            <div
              key={t.id}
              className={`list-row ${t.closed_at ? 'row-done' : ''}`}
              onClick={() => onOpenProject(t.project_id, t.id)}
              title="Открыть задачу на доске проекта"
            >
              <div className="list-main">
                {t.risk_level && <span className={`risk-dot risk-${t.risk_level}`} title={`Риск срока: ${t.risk_level}`} />}
                <span className="list-title">{t.title}</span>
                <span className="badge badge-muted" title="Проект">{t.project_name}</span>
                <span className="badge" title="Колонка">{t.column_name}</span>
              </div>
              <div className="list-side">
                {t.is_blocked && <span className="badge badge-blocked">BLOCKED</span>}
                {prio && <span className={prio.cls} title="Приоритет">{prio.text}</span>}
                {due && <span className={due.cls} title={due.title}>{due.text}</span>}
                {t.closed_at && <span className="badge badge-ok">✓ завершена</span>}
                {who && (
                  <span className="assignee-chip" title={scope === 'mine' ? `Руководитель: ${who}` : `Исполнитель: ${who}`}>
                    <span className="avatar-xs avatar-ph">{who[0]?.toUpperCase()}</span>
                    {who}
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
