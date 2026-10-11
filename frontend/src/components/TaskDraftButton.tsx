import { useEffect, useState } from 'react';
import { Icon } from './Icon';
import { useAuth } from '../state/auth';
import { useIsPhone } from '../hooks/useMediaQuery';
import { navigate } from '../lib/router';
import { clearDraft, isDraftEditing, loadDraft, requestDraftOpen, TASK_DRAFT_CHANGED, type TaskDraft } from '../lib/task-draft';

/**
 * Кнопка «Черновик» (#1534) — видна в любом разделе, пока есть несозданная задача.
 *
 * Нажатие ведёт на доску проекта, где задачу начали, и открывает окно с сохранённым
 * текстом. Крестик — «не нужно», черновик удаляется. Пока само окно открыто, кнопки нет.
 * Стили — встроенные: общий CSS упёрся в бюджет, а кнопка одна.
 */
export function TaskDraftButton() {
  const { user } = useAuth();
  const phone = useIsPhone();
  const [draft, setDraft] = useState<TaskDraft | null>(() => loadDraft(user?.id));
  const [hidden, setHidden] = useState(isDraftEditing());

  useEffect(() => {
    const sync = () => { setDraft(loadDraft(user?.id)); setHidden(isDraftEditing()); };
    sync();
    window.addEventListener(TASK_DRAFT_CHANGED, sync);
    // черновик из другой вкладки
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener(TASK_DRAFT_CHANGED, sync);
      window.removeEventListener('storage', sync);
    };
  }, [user?.id]);

  if (!draft || hidden) return null;
  const label = draft.title.trim() || 'задача без названия';

  return (
    <div
      role="status"
      style={{
        position: 'fixed', zIndex: 900, left: '50%', transform: 'translateX(-50%)',
        bottom: phone ? 'calc(var(--safe-bottom, 0px) + 76px)' : 20,
        display: 'flex', alignItems: 'center', gap: 2, maxWidth: 'calc(100vw - 32px)',
        background: 'var(--bg-elev)', border: '1px solid var(--accent-line, var(--border-2))',
        borderRadius: 999, boxShadow: 'var(--shadow)', padding: 3,
      }}
    >
      <button
        type="button"
        className="ui-btn ui-btn-ghost ui-btn-sm"
        style={{ borderRadius: 999, minWidth: 0 }}
        title="Продолжить заполнение задачи с того места, где окно закрылось"
        onClick={() => {
          requestDraftOpen(draft);
          navigate({ section: 'projects', projectId: draft.projectId });
        }}
      >
        <Icon name="edit" size={14} />
        <b>Черновик</b>
        <span className="dim" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: phone ? 140 : 260 }}>
          {label}
        </span>
      </button>
      <button
        type="button"
        className="ui-btn ui-btn-ghost ui-btn-sm"
        style={{ borderRadius: 999, padding: '0 8px' }}
        aria-label="Удалить черновик"
        title="Удалить черновик — эта задача не нужна"
        onClick={clearDraft}
      >
        <Icon name="close" size={13} />
      </button>
    </div>
  );
}
