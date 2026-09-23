import { useCallback, useEffect, useState } from 'react';
import { Icon } from '../components/Icon';
import { EmptyState } from '../components/EmptyState';
import { SkeletonList } from '../components/Skeleton';
import { api, ApiError, TaskBatch } from '../lib/api';
import { navigate } from '../lib/router';
import { plural } from '../lib/chat-text';

/**
 * Результат пакетного создания задач — по адресу `/tasks/batch/:id` (ТЗ-10, этап 2).
 *
 * Раньше итог жил только в памяти окна быстрой команды: перезагрузил страницу — и уже
 * не узнать, что именно создалось. Теперь страница сама забирает пакет с сервера:
 * переживает F5, «назад», ссылку коллеге и открытие с телефона.
 *
 * Что здесь важно человеку: сколько создано на самом деле, куда попала каждая задача,
 * и что именно не получилось — с возможностью повторить только это, не создавая
 * заново уже созданное.
 */
export function TaskBatchPage({ batchId }: { batchId: string }) {
  const [batch, setBatch] = useState<TaskBatch | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api.taskBatch(batchId)
      .then(setBatch)
      .catch((e) => setErr(e instanceof ApiError ? e.message : 'Не удалось открыть результат'));
  }, [batchId]);
  useEffect(load, [load]);

  const retry = async (itemId: string) => {
    setBusy(true); setErr('');
    try { setBatch(await api.retryBatchItem(batchId, itemId)); }
    catch (e) { setErr(e instanceof ApiError ? e.message : 'Повторить не удалось'); }
    finally { setBusy(false); }
  };

  if (err && !batch) {
    return (
      <div className="page">
        <EmptyState icon="alert" title="Результат не найден" hint={err} />
      </div>
    );
  }
  if (!batch) return <div className="page"><SkeletonList rows={4} /></div>;

  const projects = new Set(batch.tasks.map((t) => t.projectId));
  const head = batch.failedCount > 0
    ? `Создано ${batch.created} из ${batch.requested} ${plural(batch.requested, 'задачи', 'задач', 'задач')}`
    : `Создано ${batch.created} ${plural(batch.created, 'задача', 'задачи', 'задач')}`;

  return (
    <div className="page batch-page">
      <div className="page-head">
        <h2>
          <Icon name={batch.failedCount ? 'alert' : 'check'} size={18} /> {head}
        </h2>
        <div className="page-head-actions">
          {projects.size === 1 && batch.tasks.length > 0 && (
            <button
              className="btn btn-sm"
              onClick={() => navigate({ section: 'projects', projectId: batch.tasks[0].projectId })}
            >
              <Icon name="board" size={14} /> Открыть доску
            </button>
          )}
          <button className="btn btn-sm" onClick={() => navigate({ section: 'tasks' })}>
            <Icon name="list" size={14} /> Все задачи
          </button>
        </div>
      </div>

      {batch.sourceText && (
        <div className="batch-source">
          <Icon name={batch.sourceType === 'voice' ? 'mic' : 'zap'} size={13} />
          <span>{batch.sourceText}</span>
        </div>
      )}
      {err && <div className="error-text">{err}</div>}

      <div className="batch-list">
        {batch.tasks.map((t) => (
          <button
            key={t.taskId}
            className="batch-item"
            onClick={() => navigate({ section: 'projects', projectId: t.projectId, taskId: t.taskId })}
            title="Открыть задачу"
          >
            <span className="batch-item-title"><Icon name="check" size={14} /> {t.title}</span>
            <span className="dim batch-item-sub">
              {[
                t.projectName,
                t.assigneeName ?? 'без исполнителя',
                t.deadlineAt ? `до ${new Date(t.deadlineAt).toLocaleDateString('ru-RU')}` : 'без срока',
                t.status,
              ].filter(Boolean).join(' · ')}
            </span>
          </button>
        ))}

        {/* Не получилось — видно отдельно и с причиной: человек решает, повторять или бросить. */}
        {batch.failed.map((f) => (
          <div key={f.itemId} className="batch-item batch-item-failed">
            <span className="batch-item-title"><Icon name="alert" size={14} /> {f.title}</span>
            <span className="batch-item-sub error-text">{f.error ?? 'Не удалось создать'}</span>
            <button className="btn btn-sm" disabled={busy} onClick={() => void retry(f.itemId)}>
              <Icon name="refresh" size={13} /> {busy ? 'Повторяю…' : 'Повторить'}
            </button>
          </div>
        ))}
      </div>

      {batch.tasks.length === 0 && batch.failed.length === 0 && (
        <EmptyState icon="list" title="Пакет пуст" hint="В нём нет ни созданных задач, ни ошибок." />
      )}
    </div>
  );
}
