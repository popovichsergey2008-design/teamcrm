import { useEffect, useState } from 'react';
import { Icon } from './Icon';
import { api, ApiError } from '../lib/api';
import { useEscape } from '../hooks/useEscape';

/**
 * Задача из сообщения — то, ради чего чат живёт внутри CRM, а не рядом с ней.
 *
 * Самый частый способ появления задачи — фраза в переписке: «на мобильной версии блок
 * съезжает и кнопка закрывает текст». Раньше её переписывали руками в форму создания,
 * теряя половину смысла и весь контекст. Теперь ИИ раскладывает фразу на постановку,
 * шаги и срок, а человек правит и подтверждает.
 *
 * ИИ здесь не ставит задачи за человека: он готовит черновик. Разница принципиальная —
 * ответственность за формулировку остаётся на том, кто нажал «Создать».
 */
export function MessageToTask({ chatId, messageId, messageText, onClose, onCreated }: {
  chatId: string;
  messageId: string;
  /** Исходная фраза: она же запасной вариант, если разбор не удался. */
  messageText: string;
  onClose: () => void;
  onCreated: (taskId: string, title: string, projectId: string) => void;
}) {
  useEscape(onClose);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [projectId, setProjectId] = useState('');
  const [assigneeId, setAssigneeId] = useState('');
  const [deadline, setDeadline] = useState('');
  const [priority, setPriority] = useState('normal');
  const [checklist, setChecklist] = useState<string[]>([]);
  /** Что приедет в задачу из самого сообщения: автор, файл и подсказка по исполнителю. */
  const [source, setSource] = useState<{
    authorName: string | null; fileName: string | null; assigneeReason: string | null;
  }>({ authorName: null, fileName: null, assigneeReason: null });
  const [ctx, setCtx] = useState<{ projects: { id: string; name: string }[]; users: { id: string; name: string }[] }>({
    projects: [], users: [],
  });

  useEffect(() => {
    let dead = false;
    api.messageTaskDraft(chatId, messageId)
      .then((d: any) => {
        if (dead) return;
        const t = d.task ?? {};
        // Разбор мог не сработать (нет ключа, модель вернула мусор) — но человек уже
        // нажал «Создать задачу», и пустое окно был бы худший ответ. Ставим саму фразу.
        setTitle(String(t.title ?? messageText).slice(0, 255));
        setDescription(String(t.description ?? ''));
        setProjectId(t.projectId ? String(t.projectId) : '');
        /*
          Исполнитель подставляется, только когда он назван однозначно: позвали через
          @ либо это личная переписка (адресат — второй собеседник). Автор фразы
          исполнителем НЕ становится: он просит, то есть ставит задачу.

          Догадки разбора здесь не годятся — назначенная не тому задача выглядит как
          поручение, которого человек не получал, и разбирать это приходится людям.
        */
        setAssigneeId(String(d.source?.assigneeId ?? ''));
        setSource({
          authorName: d.source?.authorName ?? null,
          fileName: d.source?.fileName ?? null,
          assigneeReason: d.source?.assigneeReason ?? null,
        });
        setDeadline(t.deadline ? String(t.deadline) : '');
        setPriority(String(t.priority ?? 'normal'));
        setChecklist(Array.isArray(t.checklist) ? t.checklist.map(String) : []);
        setCtx({ projects: d.context?.projects ?? [], users: d.context?.users ?? [] });
      })
      .catch((e) => { if (!dead) setErr(e instanceof ApiError ? e.message : 'Не удалось разобрать сообщение'); })
      .finally(() => { if (!dead) setLoading(false); });
    return () => { dead = true; };
  }, [chatId, messageId, messageText]);

  const create = async () => {
    if (!projectId) return setErr('Выберите проект');
    if (!title.trim()) return setErr('Назовите задачу');
    setBusy(true); setErr('');
    try {
      const res = await api.createTaskFromMessage(chatId, messageId, {
        projectId,
        title: title.trim(),
        description: description.trim() || undefined,
        assigneeId: assigneeId || undefined,
        deadline: deadline || undefined,
        priority,
        checklist: checklist.filter((x) => x.trim()),
      });
      onCreated(String(res.taskId), res.title, String(res.projectId ?? projectId));
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Задача не создалась');
    } finally { setBusy(false); }
  };

  return (
    <div className="drawer-overlay" onClick={onClose}>
      <aside className="drawer" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-head">
          <h3><Icon name="sparkles" size={16} /> Задача из сообщения</h3>
          <button className="drawer-close" onClick={onClose} title="Закрыть" aria-label="Закрыть">
            <Icon name="close" size={20} />
          </button>
        </div>

        {/* Исходная фраза перед глазами: правя формулировку, легко уехать от того,
            о чём вообще была речь. */}
        <div className="msg-quote-src">«{messageText.slice(0, 300)}»</div>
        {/* Файл из сообщения уедет во вложения задачи — об этом надо сказать до
            нажатия «Создать», иначе скриншот приложат руками второй раз. */}
        {source.fileName && (
          <div className="dim msg-quote-file">
            <Icon name="paperclip" size={12} /> {source.fileName} — приложится к задаче
          </div>
        )}

        {loading && <div className="dim">ИИ раскладывает фразу на постановку и шаги…</div>}

        {!loading && (
          <>
            <div className="field">
              <label>Название</label>
              <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={255} />
            </div>
            <div className="field">
              <label>Описание</label>
              <textarea className="input" rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />
            </div>
            <div className="field">
              <label>Проект</label>
              <select className="input" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
                <option value="">— выберите —</option>
                {ctx.projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </div>
            <div className="drawer-row">
              <div className="field" style={{ flex: 1 }}>
                <label>Исполнитель{source.assigneeReason ? ` · ${source.assigneeReason}` : ''}</label>
                <select className="input" value={assigneeId} onChange={(e) => setAssigneeId(e.target.value)}>
                  <option value="">— не назначен —</option>
                  {ctx.users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
                </select>
              </div>
              <div className="field" style={{ flex: 1 }}>
                <label>Срок</label>
                <input className="input" type="date" value={deadline} onChange={(e) => setDeadline(e.target.value)} />
              </div>
              <div className="field" style={{ flex: 1 }}>
                <label>Приоритет</label>
                <select className="input" value={priority} onChange={(e) => setPriority(e.target.value)}>
                  <option value="low">Низкий</option>
                  <option value="normal">Обычный</option>
                  <option value="high">Высокий</option>
                  <option value="urgent">Срочный</option>
                </select>
              </div>
            </div>

            {/* Шаги правятся здесь же: чек-лист, который нельзя поправить до создания,
                приходится переделывать в карточке — то же время, только позже. */}
            <div className="field">
              <label>Шаги</label>
              {checklist.map((step, i) => (
                <div key={i} className="drawer-row">
                  <input
                    className="input"
                    value={step}
                    onChange={(e) => setChecklist((prev) => prev.map((x, k) => (k === i ? e.target.value : x)))}
                  />
                  <button
                    className="btn btn-ghost btn-sm"
                    onClick={() => setChecklist((prev) => prev.filter((_, k) => k !== i))}
                    title="Убрать шаг"
                    aria-label="Убрать шаг"
                  >
                    <Icon name="close" size={14} />
                  </button>
                </div>
              ))}
              <button className="btn btn-ghost btn-sm" onClick={() => setChecklist((prev) => [...prev, ''])}>
                <Icon name="plus" size={13} /> Шаг
              </button>
            </div>

            {err && <div className="error-text">{err}</div>}
            <button className="btn btn-primary" onClick={create} disabled={busy}>
              {busy ? 'Создаю…' : 'Создать задачу'}
            </button>
          </>
        )}
        {loading && err && <div className="error-text">{err}</div>}
      </aside>
    </div>
  );
}
