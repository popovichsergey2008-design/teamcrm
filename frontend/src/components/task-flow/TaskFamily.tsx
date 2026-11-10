import { useCallback, useEffect, useState } from 'react';
import { Icon } from '../Icon';
import { Avatar } from '../Avatar';
import { Button } from '../ui/button';
import { lazyComponent } from '../../lib/lazy';
import { ApiError } from '../../lib/api';
import { flowApi, type FamilyTask, type TaskFamily as Family } from '../../lib/flow-api';
import { initialsOf } from '../../lib/initials';
import { navigate } from '../../lib/router';
import type { Task, User } from '../../types';

const TaskCreateModal = lazyComponent(() => import('../TaskCreateModal').then((m) => m.TaskCreateModal));

const dueLabel = (iso: string | null) => (iso
  ? new Date(iso).toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })
  : null);

/**
 * Подзадачи и родительская задача (#4846) — как в Битрикс24.
 *
 * Два блока карточки: «Подзадачи: N» со списком (название-ссылка, исполнитель, срок)
 * и кнопкой «Добавить подзадачу», и «Родительская задача» — ссылка наверх. Существующую
 * задачу можно поставить подзадачей или указать родителя по номеру.
 */
export function TaskFamily({ task, columns, users, onRefresh }: {
  task: Task;
  columns: { id: string; name: string; stage_type?: string }[];
  users: User[];
  onRefresh: () => void;
}) {
  const [family, setFamily] = useState<Family>({ parent: null, children: [] });
  const [err, setErr] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [childInput, setChildInput] = useState<string | null>(null);
  const [parentInput, setParentInput] = useState<string | null>(null);

  const load = useCallback(() => {
    flowApi.family(String(task.id)).then(setFamily).catch(() => setFamily({ parent: null, children: [] }));
  }, [task.id]);
  useEffect(() => { load(); }, [load, task.version]);

  const run = async (fn: () => Promise<unknown>) => {
    setErr('');
    try { await fn(); load(); onRefresh(); return true; }
    catch (e) { setErr(e instanceof ApiError ? e.message : 'Не получилось'); return false; }
  };
  const num = (v: string) => v.trim().replace(/^#/, '');
  // подзадача встаёт в первую колонку доски, как новая задача из «+» над колонкой
  const firstCol = columns[0];
  const done = family.children.filter((c) => c.closed).length;

  const row = (t: FamilyTask, onDrop: () => void, dropLabel: string) => {
    const u = t.assignee_id ? users.find((x) => String(x.id) === String(t.assignee_id)) : undefined;
    const due = dueLabel(t.deadline_at);
    return (
      <div key={`${t.rel}${t.id}`} className={`tf-row tfam-row${t.closed ? ' is-closed' : ''}`}>
        <button className="bb-link tfam-title" onClick={() => navigate({ section: 'projects', projectId: t.project_id, taskId: t.id })} title={t.column_name ? `Колонка «${t.column_name}»` : undefined}>
          {t.closed && <Icon name="check" size={12} />} #{t.id} — {t.title}
        </button>
        {t.assignee_name && (
          <span title={`Исполнитель: ${t.assignee_name}`} aria-label={`Исполнитель: ${t.assignee_name}`}>
            <Avatar path={u?.avatarUrl ?? null} fallback={initialsOf(t.assignee_name)} className="avatar-xs" />
          </span>
        )}
        {due && <span className="tfam-due">{due}</span>}
        <Button variant="ghost" size="icon-sm" aria-label={dropLabel} title={dropLabel} onClick={onDrop}><Icon name="close" size={13} /></Button>
      </div>
    );
  };

  return (
    <>
      <div className="tf-block tfam">
        <h4 className="tfam-head">
          <Icon name="list" size={14} /> Подзадачи: {family.children.length}
          {family.children.length > 0 && <span className="dim"> · выполнено {done}</span>}
        </h4>
        {family.children.map((c) => row(c, () => void run(() => flowApi.setParent(c.id, null)), `Убрать #${c.id} из подзадач`))}
        <div className="tf-row">
          {firstCol && <Button size="sm" variant="outline" onClick={() => setCreateOpen(true)}><Icon name="plus" size={13} /> Добавить подзадачу</Button>}
          {childInput === null
            ? <Button size="sm" variant="ghost" onClick={() => setChildInput('')}>Сделать подзадачей существующую</Button>
            : (
              <form className="tf-row" onSubmit={(e) => { e.preventDefault(); const v = num(childInput); if (!v) return; void run(() => flowApi.setParent(v, String(task.id))).then((ok) => { if (ok) setChildInput(null); }); }}>
                <input className="ui-input ui-input-sm" style={{ maxWidth: 200 }} autoFocus value={childInput} onChange={(e) => setChildInput(e.target.value)} placeholder="Номер задачи, например #120" aria-label="Номер задачи, которая станет подзадачей" />
                <Button size="sm" type="submit">Добавить</Button>
                <Button size="sm" variant="ghost" type="button" onClick={() => setChildInput(null)}>Отмена</Button>
              </form>
            )}
        </div>
      </div>

      <div className="tf-block tfam">
        <h4 className="tfam-head"><Icon name="arrow-up" size={14} /> Родительская задача</h4>
        {family.parent
          ? row(family.parent, () => void run(() => flowApi.setParent(String(task.id), null)), 'Убрать родительскую задачу')
          : parentInput === null && (
            <div className="tf-row">
              <span className="dim">Нет — это самостоятельная задача.</span>
              <Button size="sm" variant="ghost" onClick={() => setParentInput('')}><Icon name="plus" size={13} /> Указать</Button>
            </div>
          )}
        {parentInput !== null && (
          <form className="tf-row" onSubmit={(e) => { e.preventDefault(); const v = num(parentInput); if (!v) return; void run(() => flowApi.setParent(String(task.id), v)).then((ok) => { if (ok) setParentInput(null); }); }}>
            <input className="ui-input ui-input-sm" style={{ maxWidth: 200 }} autoFocus value={parentInput} onChange={(e) => setParentInput(e.target.value)} placeholder="Номер задачи, например #120" aria-label="Номер родительской задачи" />
            <Button size="sm" type="submit">{family.parent ? 'Заменить' : 'Указать'}</Button>
            <Button size="sm" variant="ghost" type="button" onClick={() => setParentInput(null)}>Отмена</Button>
          </form>
        )}
        {family.parent && parentInput === null && (
          <div className="tf-row"><Button size="sm" variant="ghost" onClick={() => setParentInput('')}>Сменить родительскую</Button></div>
        )}
        {err && <p className="error-text" role="alert" style={{ margin: '6px 0 0' }}>{err}</p>}
      </div>

      {createOpen && firstCol && (
        <TaskCreateModal
          projectId={String(task.project_id)}
          columnId={String(firstCol.id)}
          columnName={firstCol.name}
          users={users}
          parent={{ id: String(task.id), title: task.title }}
          onClose={() => setCreateOpen(false)}
          onCreated={() => { load(); onRefresh(); }}
        />
      )}
    </>
  );
}
