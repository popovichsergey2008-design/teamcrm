import { useEffect, useState } from 'react';
import { Icon } from './Icon';
import { Button } from './ui/button';
import { draftLabel, listDrafts, removeDraft, TASK_DRAFT_CHANGED, type TaskDraft } from '../lib/task-draft';
import './task-drafts.css';

/** «26.10, 14:30» — когда черновик правили последний раз. */
export function draftWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const today = new Date().toDateString() === d.toDateString();
  const time = d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  return today ? `сегодня, ${time}` : `${d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' })}, ${time}`;
}

/** Черновики человека, кроме открытого сейчас; обновляются, когда меняются. */
export function useOtherDrafts(userId: string | undefined, ownId: string): TaskDraft[] {
  const [list, setList] = useState<TaskDraft[]>(() => listDrafts(userId).filter((d) => d.id !== ownId));
  useEffect(() => {
    const sync = () => setList(listDrafts(userId).filter((d) => d.id !== ownId));
    sync();
    window.addEventListener(TASK_DRAFT_CHANGED, sync);
    window.addEventListener('storage', sync);
    return () => { window.removeEventListener(TASK_DRAFT_CHANGED, sync); window.removeEventListener('storage', sync); };
  }, [userId, ownId]);
  return list;
}

/** Список черновиков: открыть или удалить. Общий для предложения в окне и кнопки «Черновик». */
export function TaskDraftsList({ drafts, onPick }: { drafts: TaskDraft[]; onPick: (d: TaskDraft) => void }) {
  return (
    <ul className="tdo-list">
      {drafts.map((d) => (
        <li key={d.id} className="tdo-item">
          <button type="button" className="tdo-open" onClick={() => onPick(d)} title="Продолжить этот черновик">
            <Icon name={d.kind === 'quick' ? 'zap' : 'edit'} size={14} />
            <span className="tdo-title">{draftLabel(d)}</span>
            <span className="tdo-meta">
              {draftWhen(d.savedAt)}
              {d.kind === 'form' && d.columnName ? ` · «${d.columnName}»` : ''}
              {d.fileNames?.length ? ` · файлов: ${d.fileNames.length}` : ''}
            </span>
          </button>
          <Button variant="ghost" size="icon-sm" onClick={() => removeDraft(d.id)} aria-label={`Удалить черновик «${draftLabel(d)}»`} title="Удалить черновик">
            <Icon name="trash" size={14} />
          </Button>
        </li>
      ))}
    </ul>
  );
}

/**
 * «Есть черновик — продолжить?» в начале окна постановки (#4668).
 *
 * Показываем, только пока человек ничего не начал набирать: предлагать старое поверх
 * новой задачи — значит мешать. Один черновик — кнопка «Продолжить»; несколько — ещё
 * и список с датой и началом названия, лишние удаляются корзиной.
 */
export function TaskDraftsOffer({ drafts, onPick }: { drafts: TaskDraft[]; onPick: (d: TaskDraft) => void }) {
  const [open, setOpen] = useState(false);
  if (!drafts.length) return null;
  const last = drafts[0];
  return (
    <div className="tdo" role="status">
      <div className="tdo-head">
        <Icon name="edit" size={15} />
        <span className="tdo-text">
          Есть черновик: <b>{draftLabel(last)}</b> <span className="tdo-meta">{draftWhen(last.savedAt)}</span>
        </span>
      </div>
      <div className="tdo-actions">
        <Button size="sm" variant="outline" onClick={() => onPick(last)}>Продолжить черновик</Button>
        {drafts.length > 1 && (
          <Button size="sm" variant="ghost" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
            Все черновики ({drafts.length})
          </Button>
        )}
        {drafts.length === 1 && (
          <Button size="sm" variant="ghost" onClick={() => removeDraft(last.id)}>Удалить</Button>
        )}
      </div>
      {open && <TaskDraftsList drafts={drafts} onPick={onPick} />}
    </div>
  );
}
