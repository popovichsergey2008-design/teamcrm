import { useEffect, useState } from 'react';
import { Icon } from '../Icon';
import { TaskChat } from '../TaskChat';
import { api, ApiError } from '../../lib/api';
import { navigate } from '../../lib/router';

/**
 * Чат задачи в мессенджере (ТЗ-5, этап 3; решение заказчика — адаптер).
 *
 * Та же переписка, что в карточке задачи, тем же компонентом `TaskChat`: одна
 * история, ноль копий, данные не переливаются. Сверху — шапка с номером,
 * названием, статусом и кнопкой «Открыть задачу»; всё остальное — карточка.
 */
export function TaskConversation({ taskId, onClose }: { taskId: string; onClose?: () => void }) {
  const [brief, setBrief] = useState<Awaited<ReturnType<typeof api.taskBrief>> | null>(null);
  const [err, setErr] = useState('');
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    setBrief(null); setErr('');
    api.taskBrief(taskId).then(setBrief).catch((e) => setErr(e instanceof ApiError ? e.message : 'Задача не найдена'));
  }, [taskId, nonce]);

  return (
    <section className="chat-view task-conversation">
      <div className="chat-view-head">
        <span className="task-conv-title">
          <Icon name="check-circle" size={15} />
          {brief ? (
            <>
              <span className="task-num">#{brief.id}</span>
              <b className="task-conv-name" title={brief.title}>{brief.title}</b>
              <span className={`badge ${brief.closed ? 'badge-muted' : 'badge-info'}`}>{brief.closed ? 'завершена' : brief.status}</span>
            </>
          ) : <b>Задача #{taskId}</b>}
        </span>
        {brief && (
          <button
            className="btn btn-ghost btn-sm"
            onClick={() => navigate({ section: 'projects', projectId: brief.projectId, taskId: brief.id })}
            title={brief.projectName ? `Открыть задачу в проекте «${brief.projectName}»` : 'Открыть задачу'}
          >
            <Icon name="board" size={14} /> Открыть задачу
          </button>
        )}
        {onClose && (
          <button className="btn btn-ghost btn-sm chat-overlay-close" onClick={onClose} title="Закрыть окно чата (Esc)" aria-label="Закрыть окно чата">
            <Icon name="close" size={16} />
          </button>
        )}
      </div>
      {err && <div className="error-text" style={{ padding: 12 }}>{err}</div>}
      {brief && (
        <div className="task-conv-body">
          <TaskChat
            taskId={brief.id}
            assigneeId={brief.assigneeId}
            creatorId={brief.createdBy}
            participants={brief.participants}
            onRefresh={() => setNonce((n) => n + 1)}
          />
        </div>
      )}
    </section>
  );
}
