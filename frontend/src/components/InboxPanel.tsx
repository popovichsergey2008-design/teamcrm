import { useEffect, useRef, useState } from 'react';
import { Icon } from './Icon';
import { api, ApiError } from '../lib/api';

/** Авто-задачи из переписок: каналы приёма (вебхук) + голосовые заметки + ревью черновиков задач. */
export function InboxPanel({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<'items' | 'sources'>('items');
  const [sources, setSources] = useState<any[]>([]);
  const [items, setItems] = useState<any[]>([]);
  const [projects, setProjects] = useState<any[]>([]);
  const [users, setUsers] = useState<any[]>([]);
  const [edits, setEdits] = useState<Record<string, any>>({});
  const [form, setForm] = useState({ label: '', defaultProjectId: '' });
  const [msg, setMsg] = useState('');
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const recRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const flash = (m: string) => { setMsg(m); setTimeout(() => setMsg(''), 3500); };

  const loadSources = () => api.inboxSources().then(setSources).catch(() => undefined);
  const loadItems = () => api.inboxItems('pending').then((rows) => {
    setItems(rows);
    setEdits((prev) => {
      const next = { ...prev };
      for (const it of rows) {
        if (next[it.id]) continue;
        const t = it.draft?.task ?? {};
        next[it.id] = {
          title: t.title ?? it.subject ?? '', description: t.description ?? (it.body ?? '').slice(0, 500),
          projectId: t.projectId ?? '', assigneeId: t.assigneeId ?? '', priority: t.priority ?? 'normal', deadline: t.deadline ?? '',
        };
      }
      return next;
    });
  }).catch(() => undefined);

  useEffect(() => {
    loadSources(); loadItems();
    api.listProjects().then(setProjects).catch(() => undefined);
    api.listUsers().then(setUsers).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const createSource = async () => {
    try {
      await api.inboxCreateSource(form.label.trim() || undefined, form.defaultProjectId || undefined);
      setForm({ label: '', defaultProjectId: '' }); flash('Канал создан'); loadSources();
    } catch (e) { flash(e instanceof ApiError ? e.message : 'Ошибка'); }
  };
  const deleteSource = async (id: string) => {
    if (!window.confirm('Удалить канал? Его вебхук перестанет принимать письма.')) return;
    try { await api.inboxDeleteSource(id); loadSources(); } catch { /* */ }
  };

  const setEdit = (id: string, patch: any) => setEdits((s) => ({ ...s, [id]: { ...s[id], ...patch } }));
  const confirmItem = async (id: string) => {
    const t = edits[id];
    if (!t?.projectId) return flash('Выберите проект');
    if (!t?.title?.trim()) return flash('Укажите название');
    try { await api.inboxConfirm(id, t); flash('Задача создана'); loadItems(); loadSources(); }
    catch (e) { flash(e instanceof ApiError ? e.message : 'Ошибка создания'); }
  };
  const dismissItem = async (id: string) => {
    try { await api.inboxDismiss(id); loadItems(); loadSources(); } catch { /* */ }
  };

  // голосовая заметка → черновик задачи на ревью (тот же список «Черновики»)
  const startRec = async () => {
    setMsg('');
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') return flash('Браузер не поддерживает запись с микрофона');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mr = new MediaRecorder(stream);
      chunksRef.current = [];
      mr.ondataavailable = (e) => { if (e.data.size) chunksRef.current.push(e.data); };
      mr.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        setRecording(false);
        const blob = new Blob(chunksRef.current, { type: mr.mimeType || 'audio/webm' });
        if (!blob.size) return;
        setTranscribing(true);
        try {
          await api.inboxVoice(blob);
          flash('Заметка распознана — черновик в списке');
          loadItems();
        } catch (e) { flash(e instanceof ApiError ? e.message : 'Ошибка распознавания речи'); }
        finally { setTranscribing(false); }
      };
      mr.start();
      recRef.current = mr;
      setRecording(true);
    } catch { flash('Нет доступа к микрофону'); }
  };
  const toggleRec = () => (recording ? recRef.current?.stop() : startRec());
  useEffect(() => () => { if (recRef.current && recRef.current.state !== 'inactive') recRef.current.stop(); }, []);

  const hookUrl = (token: string) => `${window.location.origin}/api/inbox/hook/${token}`;

  return (
    <div className="drawer-overlay" onClick={onClose}>
      <aside className="drawer drawer-wide" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-head"><h3><Icon name="inbox" size={18} /> Входящие → задачи</h3><button className="btn btn-ghost btn-sm" onClick={onClose} title="Закрыть"><Icon name="close" /></button></div>
        <div className="dim" style={{ fontSize: 12 }}>Пересылайте письма/сообщения на вебхук канала — ИИ предложит черновик задачи, вы подтверждаете.</div>
        {msg && <div className="dim">{msg}</div>}
        <div className="tabs">
          <button className={`tab ${tab === 'items' ? 'active' : ''}`} onClick={() => { setTab('items'); loadItems(); }}>Черновики ({items.length})</button>
          <button className={`tab ${tab === 'sources' ? 'active' : ''}`} onClick={() => setTab('sources')}>Каналы</button>
        </div>

        {tab === 'items' && (
          <>
            <button
              className={`btn btn-sm ${recording ? 'btn-primary' : 'btn-ghost'}`}
              style={{ width: '100%', marginTop: 8 }}
              onClick={toggleRec}
              disabled={transcribing}
              title="Продиктовать задачу голосом — ИИ распознает и предложит черновик"
            >
              {recording ? <><Icon name="stop" size={14} /> Остановить и распознать</> : transcribing ? 'Распознаю речь…' : <><Icon name="mic" size={14} /> Надиктовать задачу</>}
            </button>
            {items.length === 0 && <div className="muted" style={{ marginTop: 10 }}>Черновиков нет. Надиктуйте задачу или пришлите письмо на вебхук канала — здесь появится предложенная задача.</div>}
            {items.map((it) => {
              const e = edits[it.id] ?? {};
              return (
                <div key={it.id} className="team-row" style={{ marginBottom: 8 }}>
                  <div className="dim" style={{ fontSize: 12 }}>
                    {it.source_label ? `[${it.source_label}] ` : ''}{it.sender ? `от ${it.sender}` : ''} {it.subject ? `· ${it.subject}` : ''}
                  </div>
                  <div className="dim" style={{ fontSize: 12, whiteSpace: 'pre-wrap', maxHeight: 80, overflow: 'auto', margin: '4px 0', opacity: 0.7 }}>{(it.body ?? '').slice(0, 400)}</div>
                  <input className="input" placeholder="Название задачи" value={e.title ?? ''} onChange={(ev) => setEdit(it.id, { title: ev.target.value })} />
                  <div className="team-rate" style={{ marginTop: 6 }}>
                    <select className="input" value={e.projectId ?? ''} onChange={(ev) => setEdit(it.id, { projectId: ev.target.value })}>
                      <option value="">— проект —</option>
                      {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                    </select>
                    <select className="input" value={e.assigneeId ?? ''} onChange={(ev) => setEdit(it.id, { assigneeId: ev.target.value })}>
                      <option value="">— исполнитель —</option>
                      {users.map((u) => <option key={u.id} value={u.id}>{u.fullName}</option>)}
                    </select>
                    <select className="input" value={e.priority ?? 'normal'} onChange={(ev) => setEdit(it.id, { priority: ev.target.value })}>
                      <option value="low">Низкий</option><option value="normal">Обычный</option><option value="high">Высокий</option><option value="urgent">Срочный</option>
                    </select>
                  </div>
                  <div className="team-rate" style={{ marginTop: 6 }}>
                    <button className="btn btn-primary btn-sm" onClick={() => confirmItem(it.id)}>Создать задачу</button>
                    <button className="btn btn-ghost btn-sm" onClick={() => dismissItem(it.id)}>Отклонить</button>
                  </div>
                </div>
              );
            })}
          </>
        )}

        {tab === 'sources' && (
          <>
            <div className="drawer-section-title">Новый канал приёма</div>
            <div className="add-user">
              <input className="input add-user-input" placeholder="Название (напр. «Почта продаж»)" value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} />
              <select className="input" value={form.defaultProjectId} onChange={(e) => setForm({ ...form, defaultProjectId: e.target.value })}>
                <option value="">Проект по умолчанию (необязательно)</option>
                {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
              <button className="btn btn-primary btn-sm" style={{ width: '100%' }} onClick={createSource}>Создать канал</button>
            </div>
            <div className="drawer-section-title">Каналы ({sources.length})</div>
            {sources.length === 0 && <div className="muted">Пока нет каналов</div>}
            {sources.map((s) => (
              <div key={s.id} className="team-row">
                <div className="team-head">
                  <span>{s.label || 'Без названия'} {s.default_project_name && <span className="badge" title="Проект по умолчанию"><Icon name="folder" size={12} /> {s.default_project_name}</span>} {s.pending ? <span className="badge badge-warn">{s.pending} на ревью</span> : null}</span>
                  <button className="btn btn-ghost btn-sm" onClick={() => deleteSource(s.id)}>Удалить</button>
                </div>
                <div className="invite-box">
                  Вебхук (укажите в почтовом провайдере / Zapier / n8n как приёмник входящих):
                  <input className="input" readOnly value={hookUrl(s.token)} onFocus={(e) => e.currentTarget.select()} />
                  <div className="dim" style={{ fontSize: 11 }}>Провайдер шлёт JSON или form с полями from/subject/body (поддержаны Mailgun/Postmark и др.).</div>
                </div>
              </div>
            ))}
          </>
        )}
      </aside>
    </div>
  );
}
