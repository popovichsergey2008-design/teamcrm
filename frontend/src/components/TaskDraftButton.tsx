import { useEffect, useState } from 'react';
import { Icon } from './Icon';
import { useAuth } from '../state/auth';
import { useIsPhone } from '../hooks/useMediaQuery';
import { navigate } from '../lib/router';
import { lazyComponent } from '../lib/lazy';
import { draftLabel, isDraftEditing, listDrafts, openDraft, removeDraft, TASK_DRAFT_CHANGED, type TaskDraft } from '../lib/task-draft';

// список нескольких черновиков нужен редко — не утяжеляем первый экран
const TaskDraftsList = lazyComponent(() => import('./TaskDraftsOffer').then((m) => m.TaskDraftsList));

/**
 * Кнопка «Черновик» (#1534, #4668) — видна в любом разделе, пока есть несозданная задача.
 *
 * Нажатие открывает окно там, где задачу начали (доска проекта или быстрая
 * постановка), с сохранённым текстом. Черновиков несколько — рядом число, по нему
 * список с датой и началом названия. Крестик — «не нужно», черновик удаляется. Пока
 * само окно открыто, кнопки нет. Стили — встроенные: общий CSS упёрся в бюджет.
 */
export function TaskDraftButton() {
  const { user } = useAuth();
  const phone = useIsPhone();
  const [drafts, setDrafts] = useState<TaskDraft[]>(() => listDrafts(user?.id));
  const [hidden, setHidden] = useState(isDraftEditing());
  const [listOpen, setListOpen] = useState(false);

  useEffect(() => {
    const sync = () => { setDrafts(listDrafts(user?.id)); setHidden(isDraftEditing()); };
    sync();
    window.addEventListener(TASK_DRAFT_CHANGED, sync);
    // черновик из другой вкладки
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener(TASK_DRAFT_CHANGED, sync);
      window.removeEventListener('storage', sync);
    };
  }, [user?.id]);

  const draft = drafts[0];
  if (!draft || hidden) return null;
  const open = (d: TaskDraft) => { setListOpen(false); openDraft(d, (projectId) => navigate({ section: 'projects', projectId })); };

  return (
    <div
      role="status"
      style={{
        position: 'fixed', zIndex: 900, left: '50%', transform: 'translateX(-50%)',
        bottom: phone ? 'calc(var(--safe-bottom, 0px) + 76px)' : 20,
        maxWidth: 'calc(100vw - 32px)', width: listOpen ? 420 : undefined,
        background: 'var(--bg-elev)', border: '1px solid var(--accent-line, var(--border-2))',
        borderRadius: listOpen ? 'var(--radius-lg)' : 999, boxShadow: 'var(--shadow)', padding: 3,
      }}
    >
      {listOpen && (
        <div style={{ padding: 6, maxHeight: '50vh', overflowY: 'auto' }}>
          <TaskDraftsList drafts={drafts} onPick={open} />
        </div>
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
        <button
          type="button"
          className="ui-btn ui-btn-ghost ui-btn-sm"
          style={{ borderRadius: 999, minWidth: 0, flex: listOpen ? 1 : undefined }}
          title="Продолжить заполнение задачи с того места, где окно закрылось"
          onClick={() => open(draft)}
        >
          <Icon name="edit" size={14} />
          <b>Черновик</b>
          <span className="dim" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: phone ? 120 : 240 }}>
            {draftLabel(draft)}
          </span>
        </button>
        {drafts.length > 1 && (
          <button
            type="button"
            className="ui-btn ui-btn-ghost ui-btn-sm"
            style={{ borderRadius: 999, padding: '0 8px' }}
            aria-expanded={listOpen}
            aria-label={`Все черновики: ${drafts.length}`}
            title="Все черновики"
            onClick={() => setListOpen((v) => !v)}
          >
            <Icon name="list" size={13} /> {drafts.length}
          </button>
        )}
        <button
          type="button"
          className="ui-btn ui-btn-ghost ui-btn-sm"
          style={{ borderRadius: 999, padding: '0 8px' }}
          aria-label="Удалить черновик"
          title="Удалить черновик — эта задача не нужна"
          onClick={() => removeDraft(draft.id)}
        >
          <Icon name="close" size={13} />
        </button>
      </div>
    </div>
  );
}
