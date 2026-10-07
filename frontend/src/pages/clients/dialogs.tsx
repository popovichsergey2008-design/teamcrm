import { useEffect, useState } from 'react';
import { Icon } from '../../components/Icon';
import { Button } from '../../components/ui/button';
import { Dialog } from '../../components/ui/dialog';
import { Field } from '../../components/ui/field';
import { OptionSelect } from '../../components/ui/option-select';
import { api, ApiError, ClientRow } from '../../lib/api';
import { toastSaved } from '../../lib/notifications';
import { useAuth } from '../../state/auth';

const errText = (e: unknown, f: string) => (e instanceof ApiError ? e.message : f);

/** Задача прямо из карточки: клиент подставляется сам (п. 32). */
export function QuickTaskDialog({ clientId, clientName, users, onClose, onDone }: {
  clientId: string; clientName: string; users: { id: string; name: string }[]; onClose: () => void; onDone: () => void;
}) {
  const { user } = useAuth();
  const [projects, setProjects] = useState<{ id: string; name: string; client: boolean }[]>([]);
  const [v, setV] = useState({ title: '', projectId: '', assigneeId: String(user?.id ?? ''), deadline: '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => {
    Promise.all([api.listProjects(), api.clientProjects(clientId)]).then(([all, mine]: [any[], { id: string }[]]) => {
      const own = new Set(mine.map((p) => p.id));
      // проекты клиента — первыми: задача про клиента чаще всего живёт там
      const list = all.filter((p) => p.status !== 'archived').map((p) => ({ id: String(p.id), name: p.name, client: own.has(String(p.id)) }))
        .sort((a, b) => Number(b.client) - Number(a.client));
      setProjects(list);
      setV((x) => ({ ...x, projectId: x.projectId || list[0]?.id || '' }));
    }).catch(() => undefined);
  }, [clientId]);
  const save = async () => {
    setBusy(true); setErr('');
    try {
      await api.createTask({
        projectId: v.projectId, title: v.title.trim(), clientId, assigneeId: v.assigneeId || undefined,
        deadlineAt: v.deadline ? new Date(`${v.deadline}T18:00:00`).toISOString() : undefined,
      });
      window.dispatchEvent(new Event('teamcrm:tasks-changed'));
      toastSaved('Задача создана', clientName);
      onDone();
    } catch (e) { setErr(errText(e, 'Задача не создалась')); }
    finally { setBusy(false); }
  };
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }} title={`Задача по клиенту «${clientName}»`}
      footer={<><Button variant="ghost" onClick={onClose}>Отмена</Button><Button variant="primary" disabled={busy || !v.title.trim() || !v.projectId} onClick={() => void save()}>Создать</Button></>}>
      <div className="cl-form">
        <Field label="Что сделать"><input className="input" autoFocus value={v.title} onChange={(e) => setV({ ...v, title: e.target.value })} placeholder="Отправить КП" /></Field>
        <Field label="Проект" hint="Сверху — проекты этого клиента">
          <OptionSelect className="input" value={v.projectId} onChange={(e) => setV({ ...v, projectId: e.target.value })} aria-label="Проект">
            {projects.map((p) => <option key={p.id} value={p.id}>{p.client ? '★ ' : ''}{p.name}</option>)}
          </OptionSelect>
        </Field>
        <div className="cl-form-row">
          <Field label="Исполнитель">
            <OptionSelect className="input" value={v.assigneeId} onChange={(e) => setV({ ...v, assigneeId: e.target.value })} aria-label="Исполнитель">
              <option value="">Не назначен</option>
              {users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
            </OptionSelect>
          </Field>
          <Field label="Срок"><input className="input" type="date" value={v.deadline} onChange={(e) => setV({ ...v, deadline: e.target.value })} /></Field>
        </div>
        {err && <div className="error-text" role="alert">{err}</div>}
      </div>
    </Dialog>
  );
}

/** Встреча из карточки (п. 35): по умолчанию зовём ответственного и себя. */
export function QuickMeetingDialog({ clientId, clientName, ownerId, users, onClose, onDone }: {
  clientId: string; clientName: string; ownerId: string | null; users: { id: string; name: string }[]; onClose: () => void; onDone: () => void;
}) {
  const { user } = useAuth();
  const tomorrow = new Date(Date.now() + 864e5);
  const [v, setV] = useState({
    title: `Встреча с ${clientName}`, date: tomorrow.toISOString().slice(0, 10), time: '11:00', minutes: '60', call: true,
  });
  const [people, setPeople] = useState<Set<string>>(new Set([String(user?.id ?? ''), ...(ownerId ? [ownerId] : [])].filter(Boolean)));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const save = async () => {
    setBusy(true); setErr('');
    try {
      const starts = new Date(`${v.date}T${v.time}:00`);
      const ends = new Date(starts.getTime() + Number(v.minutes) * 60_000);
      await api.calendarCreate({
        title: v.title.trim(), startsAt: starts.toISOString(), endsAt: ends.toISOString(), clientId,
        participantIds: [...people], isCall: v.call,
      });
      toastSaved('Встреча назначена', clientName);
      onDone();
    } catch (e) { setErr(errText(e, 'Встреча не создалась')); }
    finally { setBusy(false); }
  };
  const toggle = (id: string) => setPeople((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }} title="Новая встреча"
      footer={<><Button variant="ghost" onClick={onClose}>Отмена</Button><Button variant="primary" disabled={busy || !v.title.trim()} onClick={() => void save()}>Назначить</Button></>}>
      <div className="cl-form">
        <Field label="Тема"><input className="input" autoFocus value={v.title} onChange={(e) => setV({ ...v, title: e.target.value })} /></Field>
        <div className="cl-form-row">
          <Field label="Дата"><input className="input" type="date" value={v.date} onChange={(e) => setV({ ...v, date: e.target.value })} /></Field>
          <Field label="Время"><input className="input" type="time" value={v.time} onChange={(e) => setV({ ...v, time: e.target.value })} /></Field>
          <Field label="Длится">
            <OptionSelect className="input" value={v.minutes} onChange={(e) => setV({ ...v, minutes: e.target.value })} aria-label="Длительность">
              {['15', '30', '45', '60', '90', '120'].map((m) => <option key={m} value={m}>{m} мин</option>)}
            </OptionSelect>
          </Field>
        </div>
        <label className="cl-check-row"><input type="checkbox" checked={v.call} onChange={(e) => setV({ ...v, call: e.target.checked })} /> Со ссылкой на созвон</label>
        <Field label="Кто участвует">
          <div className="cl-people">
            {users.map((u) => (
              <button key={u.id} type="button" className={`fd-chip${people.has(u.id) ? ' on' : ''}`} aria-pressed={people.has(u.id)} onClick={() => toggle(u.id)}>{u.name}</button>
            ))}
          </div>
        </Field>
        {err && <div className="error-text" role="alert">{err}</div>}
      </div>
    </Dialog>
  );
}

/** Объединить дубликаты (п. 49): поиск второго, предпросмотр, что переедет, и только потом — объединение. */
export function MergeDialog({ keepId, keepName, onClose, onDone }: { keepId: string; keepName: string; onClose: () => void; onDone: () => void }) {
  const [q, setQ] = useState('');
  const [found, setFound] = useState<ClientRow[]>([]);
  const [pre, setPre] = useState<{ keep: any; drop: any } | null>(null);
  const [nameFrom, setNameFrom] = useState<'keep' | 'drop'>('keep');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (q.trim().length < 2) { setFound([]); return; }
    const t = window.setTimeout(() => {
      api.clients(new URLSearchParams({ q: q.trim(), view: 'all' }).toString()).then((r) => setFound(r.items.filter((c) => c.id !== keepId))).catch(() => setFound([]));
    }, 300);
    return () => window.clearTimeout(t);
  }, [q, keepId]);
  const preview = async (dropId: string) => {
    setErr('');
    try { setPre(await api.clientMergePreview(keepId, dropId)); } catch (e) { setErr(errText(e, 'Не получилось')); }
  };
  const merge = async () => {
    if (!pre) return;
    setBusy(true);
    try { await api.clientMerge(keepId, pre.drop.id, nameFrom); toastSaved('Клиенты объединены'); onDone(); }
    catch (e) { setErr(errText(e, 'Объединить не получилось')); }
    finally { setBusy(false); }
  };
  const row = (label: string, k: string) => <tr><td>{label}</td><td>{pre?.keep[k] ?? '—'}</td><td>{pre?.drop[k] ?? '—'}</td></tr>;
  return (
    <Dialog open size="lg" onOpenChange={(o) => { if (!o) onClose(); }} title={`Объединить с «${keepName}»`}
      description="Всё со второго клиента переедет сюда: контакты, сделки, проекты, задачи, встречи, заметки, файлы. Второй уйдёт в архив."
      footer={<><Button variant="ghost" onClick={onClose}>Отмена</Button>{pre && <Button variant="primary" disabled={busy} onClick={() => void merge()}><Icon name="copy" size={14} /> Объединить</Button>}</>}>
      <div className="cl-form">
        {!pre && (
          <>
            <Field label="Какого клиента присоединить"><input className="input" autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Название, телефон, почта…" /></Field>
            {found.map((c) => (
              <button key={c.id} type="button" className="cl-item cl-item-btn" onClick={() => void preview(c.id)}>
                <div className="cl-item-main"><b>{c.name}</b>{c.archived && <span className="dim">в архиве</span>}</div>
                <div className="cl-fields dim">{[c.primaryContact, c.ownerName, c.city].filter(Boolean).join(' · ')}</div>
              </button>
            ))}
          </>
        )}
        {pre && (
          <>
            <table className="cl-merge">
              <thead><tr><th /><th>Остаётся</th><th>Присоединяется</th></tr></thead>
              <tbody>
                {row('Название', 'name')}{row('Сайт', 'website')}{row('Ответственный', 'ownerName')}
                {row('Контактов', 'contacts')}{row('Сделок', 'deals')}{row('Проектов', 'projects')}{row('Задач', 'tasks')}{row('Заметок', 'notes')}{row('Файлов', 'files')}
              </tbody>
            </table>
            <Field label="Какое название оставить">
              <OptionSelect className="input" value={nameFrom} onChange={(e) => setNameFrom(e.target.value as 'keep' | 'drop')} aria-label="Название">
                <option value="keep">{pre.keep.name}</option>
                <option value="drop">{pre.drop.name}</option>
              </OptionSelect>
            </Field>
            <Button variant="ghost" size="sm" onClick={() => setPre(null)}>Выбрать другого</Button>
          </>
        )}
        {err && <div className="error-text" role="alert">{err}</div>}
      </div>
    </Dialog>
  );
}
