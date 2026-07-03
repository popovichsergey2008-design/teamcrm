import { useEffect, useState } from 'react';
import { api, ApiError } from '../lib/api';
import type { Task, User } from '../types';
import { Lightbox } from './Lightbox';
import { MONETIZATION_ENABLED } from '../config';

interface Props {
  task: Task;
  users: User[];
  timerActive: boolean;
  onToggleTimer: (taskId: string) => void;
  onClose: () => void;
  onRefresh: () => void;
}

type Tab = 'overview' | 'checklist' | 'files' | 'discussion';
const PRIORITIES = [['low', 'низкий'], ['normal', 'обычный'], ['high', 'высокий'], ['urgent', 'срочно']];

export function TaskDrawer({ task, users, timerActive, onToggleTimer, onClose, onRefresh }: Props) {
  const [tab, setTab] = useState<Tab>('overview');
  const [assigneeId, setAssigneeId] = useState(task.assignee_id ?? '');
  const [estimate, setEstimate] = useState(task.estimate_hours ?? '');
  const [deadline, setDeadline] = useState(task.deadline_at ? new Date(task.deadline_at).toISOString().slice(0, 16) : '');
  const [warn, setWarn] = useState<any>(null);
  const [err, setErr] = useState('');
  const [desc, setDesc] = useState(task.description ?? '');
  const [priority, setPriority] = useState(task.priority ?? 'normal');
  const [managerId, setManagerId] = useState(task.created_by ?? '');

  const userName = (id?: string | null) => users.find((u) => u.id === id)?.fullName ?? '—';
  const changeManager = async (id: string) => {
    setManagerId(id);
    await api.updateTask(task.id, { managerId: id || null });
    onRefresh();
  };

  const assign = async (confirmOverload: boolean) => {
    if (!assigneeId) return setErr('Выберите исполнителя');
    setErr('');
    try {
      const res = await api.assignTask(task.id, {
        assigneeId, confirmOverload,
        estimateHours: estimate ? Number(estimate) : undefined,
        deadlineAt: deadline ? new Date(deadline).toISOString() : undefined,
      });
      if (res.warning && !confirmOverload) setWarn(res);
      else { setWarn(null); onRefresh(); }
    } catch (e) { setErr(e instanceof ApiError ? e.message : 'Ошибка'); }
  };
  const saveDesc = async () => { await api.updateTask(task.id, { description: desc }); onRefresh(); };
  const changePriority = async (p: string) => { setPriority(p); await api.updateTask(task.id, { priority: p }); onRefresh(); };
  const toggleBlocked = async () => { await api.updateTask(task.id, { isBlocked: !task.is_blocked }); onRefresh(); };

  const cost = task.cost_current !== undefined ? Number(task.cost_current) : null;

  return (
    <div className="drawer-overlay" onClick={onClose}>
      <aside className="drawer drawer-wide" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-head">
          <h3>{task.title}</h3>
          <button className="btn btn-ghost btn-sm" onClick={onClose}>✕</button>
        </div>

        <div className="drawer-row">
          <span className="badge badge-role">{task.status}</span>
          {task.risk_level && <span className={`risk-dot risk-${task.risk_level}`} />}
          {MONETIZATION_ENABLED && cost !== null && <span className="badge">₽ {cost.toLocaleString('ru-RU')}</span>}
          {task.is_blocked && <span className="badge badge-blocked">BLOCKED</span>}
          <select className="input prio-select" value={priority} onChange={(e) => changePriority(e.target.value)}>
            {PRIORITIES.map(([v, l]) => <option key={v} value={v}>приоритет: {l}</option>)}
          </select>
        </div>
        <LabelsRow task={task} onRefresh={onRefresh} />

        <div className="tabs">
          <button className={`tab ${tab === 'overview' ? 'active' : ''}`} onClick={() => setTab('overview')}>Обзор</button>
          <button className={`tab ${tab === 'checklist' ? 'active' : ''}`} onClick={() => setTab('checklist')}>Чеклист</button>
          <button className={`tab ${tab === 'files' ? 'active' : ''}`} onClick={() => setTab('files')}>Файлы</button>
          <button className={`tab ${tab === 'discussion' ? 'active' : ''}`} onClick={() => setTab('discussion')}>Обсуждение</button>
        </div>

        {tab === 'overview' && (
          <>
            <button className={`btn btn-sm drawer-timer ${timerActive ? 'timer-on' : ''}`} onClick={() => onToggleTimer(task.id)}>
              {timerActive ? '⏸ Пауза' : '▶ В работу'}
            </button>
            <div className="field"><label>Описание (Markdown)</label>
              <textarea className="input" rows={5} value={desc} onChange={(e) => setDesc(e.target.value)} />
              <button className="btn btn-sm" style={{ marginTop: 6 }} onClick={saveDesc}>Сохранить описание</button>
            </div>
            <div className="drawer-section">
              <div className="drawer-section-title">Назначение и план</div>
              <div className="drawer-grid2">
                <div className="field"><label>Исполнитель</label>
                  <select className="input" value={assigneeId} onChange={(e) => setAssigneeId(e.target.value)}>
                    <option value="">— не назначен —</option>
                    {users.map((u) => <option key={u.id} value={u.id}>{u.fullName}</option>)}
                  </select>
                </div>
                <div className="field"><label>Руководитель</label>
                  <select className="input" value={managerId} onChange={(e) => changeManager(e.target.value)}>
                    <option value="">— не задан —</option>
                    {users.map((u) => <option key={u.id} value={u.id}>{u.fullName}</option>)}
                  </select>
                </div>
              </div>
              <div className="drawer-grid2">
                <div className="field"><label>Оценка, ч</label><input className="input" type="number" min="0" step="0.5" value={estimate} onChange={(e) => setEstimate(e.target.value)} /></div>
                <div className="field"><label>Дедлайн</label><input className="input" type="datetime-local" value={deadline} onChange={(e) => setDeadline(e.target.value)} /></div>
              </div>
              {warn && (
                <div className="overload-warn">⚠ Перегруз: риск {warn.riskPct ?? '—'}%, {warn.projectedHours}ч &gt; {warn.capacityHours}ч/нед.
                  <button className="btn btn-sm overload-confirm" onClick={() => assign(true)}>Всё равно назначить</button>
                </div>
              )}
              {err && <div className="error-text">{err}</div>}
              <button className="btn btn-primary drawer-assign" onClick={() => assign(false)}>Назначить</button>
            </div>
            <div className="drawer-section">
              <div className="drawer-section-title">Прогноз срока</div>
              <div className="drawer-row">
                {task.risk_level && <span className={`risk-dot risk-${task.risk_level}`} />}
                <span>{task.risk_level ? `риск ${task.risk_pct ?? '—'}% (${task.risk_level})` : 'нет прогноза'}</span>
              </div>
              {task.predicted_finish_at && <div className="dim">Прогноз: {new Date(task.predicted_finish_at).toLocaleString('ru-RU')}</div>}
              <div className="dim">Исполнитель: {userName(assigneeId || null)} · Руководитель: {userName(managerId || null)}</div>
            </div>
            <button className="btn btn-ghost btn-sm" onClick={toggleBlocked}>{task.is_blocked ? 'Снять блокер' : 'Отметить BLOCKED'}</button>
          </>
        )}

        {tab === 'checklist' && <ChecklistTab taskId={task.id} onRefresh={onRefresh} />}
        {tab === 'files' && <FilesTab taskId={task.id} onRefresh={onRefresh} />}
        {tab === 'discussion' && <DiscussionTab taskId={task.id} onRefresh={onRefresh} />}
      </aside>
    </div>
  );
}

function LabelsRow({ task, onRefresh }: { task: Task; onRefresh: () => void }) {
  const [labels, setLabels] = useState<any[]>(task.labels ?? []);
  const [all, setAll] = useState<any[]>([]);
  const [open, setOpen] = useState(false);
  const reload = () => api.taskLabels(task.id).then(setLabels).catch(() => undefined);
  useEffect(() => { if (open) api.listLabels().then(setAll).catch(() => undefined); }, [open, task.id]);
  const toggle = async (id: string, has: boolean) => {
    if (has) await api.unassignLabel(task.id, id); else await api.assignLabel(task.id, id);
    reload(); onRefresh();
  };
  return (
    <div className="labels-row">
      {labels.map((l) => <span key={l.id} className="label-chip" style={{ background: l.color }}>{l.name}</span>)}
      <button className="btn btn-ghost btn-sm" onClick={() => setOpen(!open)}>+ метка</button>
      {open && (
        <div className="label-pick">
          {all.length === 0 && <span className="dim">Меток нет (создайте в «Команда»? — нет: метки общие, добавьте через API/доску)</span>}
          {all.map((l) => {
            const has = labels.some((x) => x.id === l.id);
            return <button key={l.id} className={`label-chip ${has ? '' : 'label-off'}`} style={{ background: has ? l.color : 'transparent', borderColor: l.color }} onClick={() => toggle(l.id, has)}>{l.name}</button>;
          })}
          <NewLabel onCreated={() => api.listLabels().then(setAll)} />
        </div>
      )}
    </div>
  );
}
function NewLabel({ onCreated }: { onCreated: () => void }) {
  const [name, setName] = useState('');
  return (
    <div className="team-rate" style={{ marginTop: 6 }}>
      <input className="input" placeholder="новая метка" value={name} onChange={(e) => setName(e.target.value)} />
      <button className="btn btn-sm" onClick={async () => { if (name.trim()) { await api.createLabel({ name: name.trim() }); setName(''); onCreated(); } }}>+</button>
    </div>
  );
}

function ChecklistTab({ taskId, onRefresh }: { taskId: string; onRefresh: () => void }) {
  const [items, setItems] = useState<any[]>([]);
  const [text, setText] = useState('');
  const reload = () => api.listChecklist(taskId).then(setItems).catch(() => undefined);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { reload(); }, [taskId]);
  const done = items.filter((i) => i.is_done).length;
  return (
    <>
      {items.length > 0 && <div className="dim">{done} / {items.length} выполнено</div>}
      {items.map((i) => (
        <label key={i.id} className="notify-row">
          <input type="checkbox" checked={i.is_done} onChange={async () => { await api.patchChecklist(taskId, i.id, { isDone: !i.is_done }); reload(); onRefresh(); }} />
          <span style={{ flex: 1, textDecoration: i.is_done ? 'line-through' : 'none' }}>{i.text}</span>
          <button className="btn btn-ghost btn-sm" onClick={async () => { await api.deleteChecklist(taskId, i.id); reload(); onRefresh(); }}>✕</button>
        </label>
      ))}
      <div className="team-rate" style={{ marginTop: 10 }}>
        <input className="input" placeholder="новый пункт" value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && text.trim() && (async () => { await api.addChecklist(taskId, text.trim()); setText(''); reload(); onRefresh(); })()} />
        <button className="btn btn-primary btn-sm" onClick={async () => { if (text.trim()) { await api.addChecklist(taskId, text.trim()); setText(''); reload(); onRefresh(); } }}>+</button>
      </div>
    </>
  );
}

function FilesTab({ taskId, onRefresh }: { taskId: string; onRefresh: () => void }) {
  const [files, setFiles] = useState<any[]>([]);
  const [preview, setPreview] = useState<{ url: string; name: string; mime: string } | null>(null);
  const [err, setErr] = useState('');
  const reload = () => api.listAttachments(taskId).then(setFiles).catch(() => undefined);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { reload(); }, [taskId]);
  const upload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]; if (!f) return;
    try { await api.uploadAttachment(taskId, f); reload(); onRefresh(); } catch { /* */ }
  };
  // файлы за авторизацией: тянем blob с токеном, картинку показываем в попапе, остальное скачиваем
  const open = async (f: any) => {
    setErr('');
    try {
      const blob = await api.authedBlob(`/api/files/${f.file_id}`);
      const url = URL.createObjectURL(blob);
      if (blob.type.startsWith('image/') || blob.type.startsWith('video/')) {
        setPreview({ url, name: f.file_name, mime: blob.type });
      } else {
        const a = document.createElement('a');
        a.href = url; a.download = f.file_name; a.click();
        setTimeout(() => URL.revokeObjectURL(url), 5000);
      }
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Не удалось открыть файл');
    }
  };
  const closePreview = () => {
    if (preview) URL.revokeObjectURL(preview.url);
    setPreview(null);
  };
  return (
    <>
      <label className="btn btn-sm" style={{ display: 'inline-block', cursor: 'pointer' }}>
        Загрузить файл<input type="file" hidden onChange={upload} />
      </label>
      {err && <div className="error-text" style={{ marginTop: 8 }}>{err}</div>}
      {files.map((f) => (
        <div key={f.id} className="team-row team-head">
          <button className="file-link" onClick={() => open(f)}>{f.file_name}</button>
          <button className="btn btn-ghost btn-sm" onClick={async () => { await api.deleteAttachment(taskId, f.id); reload(); onRefresh(); }}>✕</button>
        </div>
      ))}
      {files.length === 0 && <div className="muted" style={{ marginTop: 10 }}>Файлов нет</div>}
      {preview && <Lightbox url={preview.url} name={preview.name} mime={preview.mime} onClose={closePreview} />}
    </>
  );
}

function DiscussionTab({ taskId, onRefresh }: { taskId: string; onRefresh: () => void }) {
  const [comments, setComments] = useState<any[]>([]);
  const [activity, setActivity] = useState<any[]>([]);
  const [body, setBody] = useState('');
  const reload = () => { api.listComments(taskId).then(setComments).catch(() => undefined); api.taskActivity(taskId).then(setActivity).catch(() => undefined); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { reload(); }, [taskId]);
  const send = async () => { if (!body.trim()) return; await api.addComment(taskId, body.trim()); setBody(''); reload(); onRefresh(); };
  return (
    <>
      <div className="drawer-section-title">Комментарии</div>
      {comments.map((c) => (
        <div key={c.id} className="comment">
          <div className="comment-head"><b>{c.author_name}</b> <span className="dim">{new Date(c.created_at).toLocaleString('ru-RU')}</span></div>
          <div>{c.body}</div>
        </div>
      ))}
      <div className="comment-input">
        <textarea className="input" rows={2} placeholder="Написать комментарий…" value={body} onChange={(e) => setBody(e.target.value)} />
        <button className="btn btn-primary btn-sm" onClick={send}>Отправить</button>
      </div>
      <div className="drawer-section-title" style={{ marginTop: 16 }}>История</div>
      {activity.map((a) => (
        <div key={a.id} className="dim activity-row">{new Date(a.created_at).toLocaleString('ru-RU')} · {a.actor_name ?? 'система'} · {a.kind}</div>
      ))}
    </>
  );
}
