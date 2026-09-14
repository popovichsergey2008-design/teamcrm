import { useCallback, useEffect, useState } from 'react';
import { EmptyState } from '../components/EmptyState';
import { GuestMeetsPanel } from '../components/GuestMeetsPanel';
import { Icon } from '../components/Icon';
import { SkeletonList } from '../components/Skeleton';
import { api, ApiError } from '../lib/api';
import { navigate } from '../lib/router';
import type { Project, User } from '../types';
import { toastSaved } from '../lib/notifications';

const STATUS_LABEL: Record<string, string> = {
  queued: 'В очереди',
  transcribing: 'Расшифровываю…',
  analyzing: 'Разбираю…',
  done: 'Готово',
  error: 'Ошибка',
};

const stamp = (sec: number) => {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
};

/**
 * Встречи: загрузили запись → получили стенограмму, сводку и черновики задач.
 * Задачи создаются только по подтверждению — ИИ ничего не заводит молча.
 */
export function MeetingsPage({ onEnterGuestMeet }: { onEnterGuestMeet: (roomId: string) => void }) {
  const [list, setList] = useState<any[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [projects, setProjects] = useState<Project[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  // «Открыть мит» из сайдбара чата: раздел уже открыт, остаётся развернуть разбор
  useEffect(() => {
    const onOpen = (e: Event) => {
      const id = (e as CustomEvent<{ id: string }>).detail?.id;
      if (id) setOpenId(String(id));
    };
    window.addEventListener('teamcrm:meeting-open', onOpen);
    return () => window.removeEventListener('teamcrm:meeting-open', onOpen);
  }, []);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ title: '', projectId: '' });

  const reload = useCallback(
    () => api.listMeetings().then(setList).catch(() => undefined).finally(() => setLoaded(true)),
    [],
  );
  useEffect(() => {
    reload();
    api.listProjects().then(setProjects).catch(() => undefined);
    api.listUsers().then(setUsers).catch(() => undefined);
  }, [reload]);

  // пока встреча обрабатывается — подтягиваем статус: расшифровка часовой записи идёт минуты
  useEffect(() => {
    if (!list.some((m) => ['queued', 'transcribing', 'analyzing'].includes(m.status))) return;
    const t = setInterval(reload, 5000);
    return () => clearInterval(t);
  }, [list, reload]);

  const submit = async (file: File) => {
    if (!form.title.trim()) return setErr('Назовите встречу');
    setErr(''); setBusy(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('title', form.title.trim());
      if (form.projectId) fd.append('projectId', form.projectId);
      const m = await api.uploadMeeting(fd);
      setForm({ title: '', projectId: '' });
      setOpenId(m.id);
      reload();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Не удалось загрузить запись');
    } finally { setBusy(false); }
  };

  return (
    <div className="mytasks">
      {/* Гостевые встречи идут первыми: это то, что назначают на будущее,
          тогда как разбор записей — работа с уже прошедшим. */}
      <GuestMeetsPanel onEnter={onEnterGuestMeet} />

      <div className="drawer-section-title"><Icon name="record" size={16} /> Разбор встреч</div>
      <div className="dim" style={{ fontSize: 12, marginBottom: 10 }}>
        Загрузите запись встречи из Meet, Zoom или диктофона — получите стенограмму, сводку и предложенные задачи.
        Файл субтитров <b>.vtt/.srt</b> предпочтительнее: там платформа уже разметила, кто что сказал.
      </div>

      <div className="add-user" style={{ maxWidth: 620 }}>
        <input className="input add-user-input" placeholder="Название встречи" value={form.title}
               onChange={(e) => setForm({ ...form, title: e.target.value })} />
        <select className="input" value={form.projectId} onChange={(e) => setForm({ ...form, projectId: e.target.value })}>
          <option value="">— проект для задач (необязательно) —</option>
          {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <label className={`btn btn-primary btn-sm ${busy ? 'disabled' : ''}`} style={{ width: '100%', textAlign: 'center', cursor: 'pointer' }}>
          {busy ? 'Загружаю…' : <><Icon name="paperclip" size={15} /> Выбрать файл записи или субтитров</>}
          <input type="file" hidden disabled={busy} accept="audio/*,video/*,.vtt,.srt"
                 onChange={(e) => { const f = e.target.files?.[0]; if (f) submit(f); e.currentTarget.value = ''; }} />
        </label>
      </div>
      {err && <div className="error-text">{err}</div>}

      <div className="drawer-section-title" style={{ marginTop: 16 }}>Встречи ({list.length})</div>
      {!loaded && <SkeletonList rows={3} />}
      {loaded && list.length === 0 && (
        <EmptyState
          icon="record"
          title="Разборов пока нет"
          hint="Загрузите первую запись формой выше. Через несколько минут здесь появится стенограмма с именами, краткая сводка и задачи, которые ИИ предложит завести по итогам."
        />
      )}

      <div className="task-list">
        {list.map((m) => (
          <div key={m.id}>
            <div className="list-row" role="button" tabIndex={0}
                 onClick={() => setOpenId(openId === m.id ? null : m.id)}
                 onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpenId(openId === m.id ? null : m.id); } }}>
              <div className="list-main">
                <span className="list-title">{m.title}</span>
                {m.duration_sec > 0 && <span className="badge badge-muted">{Math.round(m.duration_sec / 60)} мин</span>}
                {m.source === 'transcript' && <span className="badge badge-muted" title="Загружены готовые субтитры">с именами</span>}
              </div>
              <div className="list-side">
                {m.drafts_pending > 0 && <span className="badge badge-warn">задач к подтверждению: {m.drafts_pending}</span>}
                <span className={`badge ${m.status === 'done' ? 'badge-ok' : m.status === 'error' ? 'badge-danger' : 'badge-info'}`}>
                  {STATUS_LABEL[m.status] ?? m.status}
                </span>
              </div>
            </div>
            {openId === m.id && <MeetingDetails id={m.id} projects={projects} users={users} onChanged={reload} />}
          </div>
        ))}
      </div>
    </div>
  );
}

function MeetingDetails({ id, projects, users, onChanged }: { id: string; projects: Project[]; users: User[]; onChanged: () => void }) {
  const [data, setData] = useState<any>(null);
  const [err, setErr] = useState('');
  const [showAll, setShowAll] = useState(false);
  const [bulk, setBulk] = useState(false);

  const load = useCallback(() => api.meetingDetails(id).then(setData).catch(() => undefined), [id]);
  useEffect(() => { load(); }, [load]);

  if (!data) return <div style={{ padding: 10 }}><SkeletonList rows={3} /></div>;
  const { meeting, segments, summary, drafts, tasks = [] } = data;
  const pending = drafts.filter((d: any) => d.status === 'pending');
  // Готовы к созданию только те, у кого есть проект: без него задаче некуда лечь.
  const readyCount = pending.filter((d: any) => d.project_id).length;

  const apply = async (d: any, patch: { assigneeId?: string; projectId?: string }) => {
    setErr('');
    try { await api.applyMeetingDraft(d.id, patch); await load(); onChanged(); }
    catch (e) { setErr(e instanceof ApiError ? e.message : 'Не удалось создать задачу'); }
  };
  const reject = async (d: any) => {
    try { await api.rejectMeetingDraft(d.id); await load(); onChanged(); } catch { /* */ }
  };

  /**
   * Создать все проверенные разом.
   *
   * По одному запросу на черновик, а не одним пакетом: применение задачи — обычный
   * путь со всеми проверками, и упавшая на середине пачка не должна отменять уже
   * созданное. Что не прошло — остаётся в списке с объяснением.
   */
  const applyAll = async () => {
    const ready = pending.filter((d: any) => d.project_id);
    if (!ready.length) return;
    setBulk(true); setErr('');
    let failed = 0;
    for (const d of ready) {
      try { await api.applyMeetingDraft(d.id, {}); } catch { failed++; }
    }
    setBulk(false);
    if (failed) setErr(`Не удалось создать: ${failed} из ${ready.length}. Остальные на доске.`);
    await load();
    onChanged();
  };

  return (
    <div className="invite-box" style={{ marginBottom: 10 }}>
      {meeting.status === 'error' && (
        <div className="error-text" style={{ fontSize: 12 }}>
          {meeting.error}
          <button className="btn btn-ghost btn-sm" style={{ marginLeft: 8 }}
                  onClick={async () => { await api.retryMeeting(id); onChanged(); }}>Повторить обработку</button>
        </div>
      )}

      {summary && (
        <>
          <div className="drawer-section-title">Сводка</div>
          <div style={{ fontSize: 13, whiteSpace: 'pre-wrap' }}>{summary.summary}</div>
          {summary.decisions?.length > 0 && (
            <div style={{ marginTop: 6 }}>
              <div className="dim" style={{ fontSize: 12 }}>Решения:</div>
              <ul style={{ margin: '4px 0', paddingLeft: 18, fontSize: 13 }}>
                {summary.decisions.map((d: string, i: number) => <li key={i}>{d}</li>)}
              </ul>
            </div>
          )}
          {summary.risks?.length > 0 && (
            <div style={{ marginTop: 6 }}>
              <div className="dim" style={{ fontSize: 12 }}>Риски:</div>
              <ul style={{ margin: '4px 0', paddingLeft: 18, fontSize: 13 }}>
                {summary.risks.map((r: string, i: number) => <li key={i}>{r}</li>)}
              </ul>
            </div>
          )}
        </>
      )}

      {pending.length > 0 && (
        <>
          <div className="drawer-section-title" style={{ marginTop: 10 }}>Предложенные задачи ({pending.length})</div>
          <div className="dim" style={{ fontSize: 12 }}>
            Это черновики: ИИ услышал поручение так, а не иначе. Поправьте формулировку
            и исполнителя — на доске появится уже ваша версия.
          </div>
          {err && <div className="error-text" style={{ fontSize: 12 }}>{err}</div>}
          {pending.map((d: any) => (
            <DraftRow key={d.id} draft={d} projects={projects} users={users}
                      onApply={apply} onReject={reject} onSaved={load} />
          ))}
          {/* «Создать все» — только для готовых строк: без проекта задачу создать нельзя,
              и молча пропустить половину списка хуже, чем сказать об этом заранее. */}
          {pending.length > 1 && (
            <div className="team-rate" style={{ marginTop: 8 }}>
              <button className="btn btn-primary btn-sm" onClick={applyAll} disabled={bulk || readyCount === 0}>
                {bulk ? 'Создаю…' : `Создать все (${readyCount})`}
              </button>
              {readyCount < pending.length && (
                <span className="dim" style={{ fontSize: 12 }}>
                  {pending.length - readyCount} без проекта — их пропущу
                </span>
              )}
            </div>
          )}
        </>
      )}
      {/*
        Задачи по итогам встречи.
        Раньше здесь стояло только «создано задач: 3» — по этой строке нельзя было ни
        понять, что именно поручили, ни дойти до задачи. Теперь список со ссылками:
        через месяц человек открывает старую встречу и видит, чем она закончилась.
      */}
      {tasks.length > 0 && (
        <>
          <div className="drawer-section-title" style={{ marginTop: 10 }}>Задачи по итогам встречи ({tasks.length})</div>
          {tasks.map((t: any) => (
            <div key={t.draft_id} className="meeting-task">
              {t.title ? (
                <>
                  <button
                    className="link-btn meeting-task-title"
                    onClick={() => navigate({ section: 'projects', projectId: t.project_id, taskId: t.task_id })}
                    title="Открыть задачу"
                  >
                    {t.title}
                  </button>
                  <div className="dim meeting-task-meta">
                    {t.assignee_name ? `Исполнитель: ${t.assignee_name}` : 'Исполнитель не назначен'}
                    {t.manager_name ? ` · Поставил: ${t.manager_name}` : ''}
                    {' · '}
                    {t.closed ? 'Завершена' : t.column_name || 'В работе'}
                  </div>
                </>
              ) : (
                // задачу удалили — ведём человека в никуда только через собственную беспечность
                <span className="dim">Задача удалена</span>
              )}
            </div>
          ))}
        </>
      )}

      <div className="drawer-section-title" style={{ marginTop: 10 }}>Стенограмма ({segments.length})</div>
      {segments.length === 0 && (
        <EmptyState
          compact
          icon={meeting.status === 'error' ? 'alert' : 'clock'}
          title={meeting.status === 'error' ? 'Стенограммы не будет' : 'Расшифровка ещё идёт'}
          hint={meeting.status === 'error'
            ? 'Обработка прервалась — причина указана выше. Нажмите «Повторить обработку».'
            : 'Час записи разбирается несколько минут. Страницу обновлять не нужно — текст появится сам.'}
        />
      )}
      <div style={{ maxHeight: showAll ? 'none' : 220, overflow: 'hidden', fontSize: 13, lineHeight: 1.6 }}>
        {segments.map((s: any) => (
          <div key={s.idx}>
            <span className="dim" style={{ fontSize: 11 }}>[{stamp(Number(s.start_sec))}]</span>{' '}
            {s.speaker && <b>{s.speaker}: </b>}{s.text}
          </div>
        ))}
      </div>
      {segments.length > 6 && (
        <button className="btn btn-ghost btn-sm" onClick={() => setShowAll((v) => !v)}>
          {showAll ? 'Свернуть' : 'Показать всю стенограмму'}
        </button>
      )}
    </div>
  );
}

function DraftRow({ draft, projects, users, onApply, onReject, onSaved }: {
  draft: any; projects: Project[]; users: User[];
  onApply: (d: any, patch: { assigneeId?: string; projectId?: string }) => void;
  onReject: (d: any) => void;
  onSaved: () => void;
}) {
  const [assigneeId, setAssigneeId] = useState(draft.assignee_id ?? '');
  const [projectId, setProjectId] = useState(draft.project_id ?? '');
  /**
   * Правка черновика.
   *
   * ИИ слышит имя неточно и сжимает поручение до неузнаваемости — до создания задачи
   * это надо уметь исправить. Иначе остаётся один путь: создать заведомо кривую задачу
   * и переписывать её уже на доске, объясняя исполнителю, что имелось в виду.
   */
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(draft.title ?? '');
  const [description, setDescription] = useState(draft.description ?? '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const save = async () => {
    if (!title.trim()) return setErr('Название не может быть пустым');
    setBusy(true); setErr('');
    try {
      await api.updateMeetingDraft(draft.id, {
        title: title.trim(),
        description: description.trim() || null,
        assigneeId: assigneeId || null,
        projectId: projectId || null,
      });
      setEditing(false);
      onSaved(); // список перечитывается: человек видит уже исправленную версию
      toastSaved('Изменения сохранены');
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Не удалось сохранить');
    } finally { setBusy(false); }
  };

  const cancel = () => {
    setTitle(draft.title ?? '');
    setDescription(draft.description ?? '');
    setAssigneeId(draft.assignee_id ?? '');
    setProjectId(draft.project_id ?? '');
    setEditing(false);
    setErr('');
  };

  return (
    <div className="team-row draft-row">
      {editing ? (
        <>
          <input
            className="input"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Название задачи"
            aria-label="Название задачи"
            autoFocus
          />
          <textarea
            className="input"
            rows={2}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Описание (необязательно)"
            aria-label="Описание задачи"
            style={{ marginTop: 4 }}
          />
        </>
      ) : (
        <>
          <div className="team-head"><span>{draft.title}</span></div>
          {draft.description && <div className="dim" style={{ fontSize: 12 }}>{draft.description}</div>}
        </>
      )}

      {draft.quote && (
        // цитата-источник: по ней видно, откуда взялось предложение, и заметно, если ИИ выдумал
        <div className="dim draft-quote">«{draft.quote}»</div>
      )}
      {draft.assignee_hint && !assigneeId && (
        <div className="dim" style={{ fontSize: 12 }}>На встрече прозвучало имя «{draft.assignee_hint}» — сотрудник не опознан, выберите вручную.</div>
      )}
      {err && <div className="error-text" style={{ fontSize: 12 }}>{err}</div>}

      <div className="drawer-grid2" style={{ marginTop: 4 }}>
        <select className="input" value={assigneeId} onChange={(e) => setAssigneeId(e.target.value)} aria-label="Исполнитель">
          <option value="">— исполнитель —</option>
          {users.map((u) => <option key={u.id} value={u.id}>{u.fullName}</option>)}
        </select>
        <select className="input" value={projectId} onChange={(e) => setProjectId(e.target.value)} aria-label="Проект">
          <option value="">— проект —</option>
          {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </div>

      <div className="team-rate" style={{ marginTop: 4 }}>
        {editing ? (
          <>
            <button className="btn btn-primary btn-sm" onClick={save} disabled={busy}>Сохранить</button>
            <button className="btn btn-ghost btn-sm" onClick={cancel} disabled={busy}>Отмена</button>
          </>
        ) : (
          <>
            <button
              className="btn btn-primary btn-sm"
              onClick={() => onApply(draft, { assigneeId: assigneeId || undefined, projectId: projectId || undefined })}
              disabled={busy}
            >
              Создать задачу
            </button>
            <button className="btn btn-sm" onClick={() => setEditing(true)} disabled={busy}>
              <Icon name="edit" size={13} /> Редактировать
            </button>
            <button className="btn btn-ghost btn-sm" onClick={() => onReject(draft)} disabled={busy}>Отклонить</button>
          </>
        )}
      </div>
    </div>
  );
}
