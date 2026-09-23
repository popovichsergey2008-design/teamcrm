import { useEffect, useState } from 'react';
import { Icon } from './Icon';
import { api, ApiError } from '../lib/api';
import { useEscape } from '../hooks/useEscape';
import { overlayProps } from '../lib/overlay';
import { humanSize } from '../lib/attachments';

/** Черновик задачи из сообщения — то, что отдаёт сервер и правит человек. */
export interface MessageTaskDraft {
  draftId: string;
  chatId: string;
  messageId: string;
  status: 'analyzing' | 'needs_clarification' | 'ready' | 'created' | 'cancelled' | 'failed';
  title: string;
  description: string;
  projectId: string | null;
  assigneeId: string | null;
  assigneeReason: string | null;
  deadline: string | null;
  priority: string;
  checklist: string[];
  files: { fileId: string; name: string | null; mime: string | null; include: boolean; size?: number }[];
  analysis: Record<string, unknown>;
  authorId: string | null;
  initiatorId: string;
  taskId: string | null;
}

/**
 * Задача из сообщения — то, ради чего чат живёт внутри CRM, а не рядом с ней.
 *
 * Самый частый способ появления задачи — фраза в переписке: «на мобильной версии блок
 * съезжает и кнопка закрывает текст». Раньше её переписывали руками в форму создания,
 * теряя половину смысла и весь контекст. Теперь ИИ раскладывает фразу на постановку,
 * шаги и срок, подбирает проект и исполнителя, а человек правит и подтверждает.
 *
 * Чего в переписке чаще всего не хватает — проекта: «поправь фильтр» сказано в общем
 * чате, а проектов семь. Тогда черновик ждёт: бот спрашивает автора прямо в чате, и
 * как только тот отвечает названием, окно дозаполняется само. Поэтому черновик живёт
 * на сервере и переживает перезагрузку страницы.
 *
 * ИИ здесь не ставит задачи за человека: он готовит черновик. Разница принципиальная —
 * ответственность за формулировку остаётся на том, кто нажал «Создать».
 */
export function MessageToTask({ chatId, messageId, messageText, draft: outside, onClose, onCreated }: {
  chatId: string;
  messageId: string;
  /** Исходная фраза: она же запасной вариант, если разбор не удался. */
  messageText: string;
  /** Черновик, приехавший событием, — окно открыто и показывает свежее состояние. */
  draft?: MessageTaskDraft | null;
  onClose: () => void;
  onCreated: (taskId: string, title: string, projectId: string) => void;
}) {
  useEscape(onClose);
  const [draft, setDraft] = useState<MessageTaskDraft | null>(null);
  const [ctx, setCtx] = useState<{ projects: { id: string; name: string }[]; users: { id: string; name: string }[] }>({
    projects: [], users: [],
  });
  const [already, setAlready] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [asked, setAsked] = useState(false);

  useEffect(() => {
    let dead = false;
    api.startMessageTaskDraft(chatId, messageId)
      .then((r) => {
        if (dead) return;
        setDraft(r.draft); setCtx(r.context); setAlready(r.already ?? null);
      })
      .catch((e) => { if (!dead) setErr(e instanceof ApiError ? e.message : 'Не удалось разобрать сообщение'); })
      .finally(() => { if (!dead) setLoading(false); });
    return () => { dead = true; };
  }, [chatId, messageId]);

  /*
    Ответ автора о проекте приходит событием. Подхватываем его прямо в открытом окне:
    человек, который ждёт ответа, не должен закрывать и открывать окно, чтобы узнать,
    что ответ уже был.
  */
  useEffect(() => {
    if (outside && draft && outside.draftId === draft.draftId) setDraft(outside);
  }, [outside, draft]);

  /** Правку отправляем сразу: черновик на сервере, и вкладка может закрыться в любой момент. */
  const patch = async (body: Record<string, unknown>) => {
    if (!draft) return;
    setDraft({ ...draft, ...(body as Partial<MessageTaskDraft>) });
    try {
      const r = await api.patchMessageTaskDraft(draft.draftId, body);
      setDraft(r.draft);
    } catch (e) { setErr(e instanceof ApiError ? e.message : 'Правка не сохранилась'); }
  };

  const ask = async () => {
    if (!draft) return;
    setBusy(true); setErr('');
    try {
      const r = await api.askMessageTaskDraft(draft.draftId);
      setDraft(r.draft); setAsked(true);
    } catch (e) { setErr(e instanceof ApiError ? e.message : 'Вопрос не отправился'); }
    finally { setBusy(false); }
  };

  const create = async () => {
    if (!draft) return;
    if (!draft.projectId) return setErr('Выберите проект или спросите автора');
    if (!draft.title.trim()) return setErr('Назовите задачу');
    setBusy(true); setErr('');
    try {
      const res = await api.confirmMessageTaskDraft(draft.draftId);
      onCreated(String(res.taskId), res.title, String(res.projectId ?? draft.projectId));
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Задача не создалась');
    } finally { setBusy(false); }
  };

  /*
    Закрыть окно — не то же самое, что отказаться от задачи.

    Черновик может ждать ответа автора о проекте; человек закрывает окно и идёт
    работать дальше — отменять начатое за него нельзя. Отказ — отдельная кнопка, после
    неё строка под сообщением исчезает.
  */
  const cancel = async () => {
    if (!draft) return onClose();
    setBusy(true);
    try { await api.cancelMessageTaskDraft(draft.draftId); } catch { /* нет сети — закроем окно */ }
    setBusy(false);
    onClose();
  };

  const toggleFile = (fileId: string, include: boolean) => {
    if (!draft) return;
    void patch({ files: draft.files.map((f) => (f.fileId === fileId ? { ...f, include } : f)) });
  };

  return (
    <div className="drawer-overlay" {...overlayProps(onClose)}>
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

        {/* По этому сообщению задача уже была: молча заводить вторую нельзя. */}
        {already && (
          <div className="dim msg-quote-file">
            <Icon name="alert" size={12} /> По этому сообщению уже создана задача #{already} — эта будет второй.
          </div>
        )}

        {loading && <div className="dim">ИИ раскладывает фразу на постановку и шаги…</div>}

        {!loading && draft && (
          <>
            {/*
              Проект не определился — это и есть тот случай, ради которого черновик
              живёт на сервере: бот спрашивает автора в чате, а окно ждёт ответа.
            */}
            {draft.status === 'needs_clarification' && (
              <div className="task-draft-ask">
                <Icon name="alert" size={14} />
                <div>
                  <b>Не понял, к какому проекту это относится.</b>
                  <div className="dim">
                    {asked
                      ? 'Спросил автора в чате — как ответит, черновик дозаполнится сам. Можно и выбрать проект руками.'
                      : 'Выберите проект ниже или попросите автора уточнить — вопрос уйдёт в тот же чат.'}
                  </div>
                </div>
                {!asked && (
                  <button className="btn btn-sm" onClick={() => void ask()} disabled={busy}>
                    <Icon name="chat" size={13} /> Спросить автора
                  </button>
                )}
              </div>
            )}

            <div className="field">
              <label>Название</label>
              <input
                className="input"
                value={draft.title}
                onChange={(e) => setDraft({ ...draft, title: e.target.value })}
                onBlur={(e) => void patch({ title: e.target.value })}
                maxLength={255}
              />
            </div>
            <div className="field">
              <label>Описание</label>
              <textarea
                className="input"
                rows={3}
                value={draft.description}
                onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                onBlur={(e) => void patch({ description: e.target.value })}
              />
            </div>
            <div className="field">
              <label>Проект</label>
              <select className="input" value={draft.projectId ?? ''} onChange={(e) => void patch({ projectId: e.target.value || null })}>
                <option value="">— выберите —</option>
                {ctx.projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </div>
            <div className="drawer-row">
              <div className="field" style={{ flex: 1 }}>
                <label>Исполнитель{draft.assigneeReason ? ` · ${draft.assigneeReason}` : ''}</label>
                <select className="input" value={draft.assigneeId ?? ''} onChange={(e) => void patch({ assigneeId: e.target.value || null })}>
                  <option value="">— не назначен —</option>
                  {ctx.users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
                </select>
              </div>
              <div className="field" style={{ flex: 1 }}>
                <label>Срок</label>
                <input
                  className="input"
                  type="date"
                  value={draft.deadline ?? ''}
                  onChange={(e) => void patch({ deadline: e.target.value || null })}
                />
              </div>
              <div className="field" style={{ flex: 1 }}>
                <label>Приоритет</label>
                <select className="input" value={draft.priority} onChange={(e) => void patch({ priority: e.target.value })}>
                  <option value="low">Низкий</option>
                  <option value="normal">Обычный</option>
                  <option value="high">Высокий</option>
                  <option value="urgent">Срочный</option>
                </select>
              </div>
            </div>

            {/*
              Вложения сообщения. Скриншоты и видео отмечены сразу: обычно они и есть
              половина постановки. Файл не копируется — в задаче он тот же самый.
            */}
            {draft.files.length > 0 && (
              <div className="field">
                <label>Вложения сообщения</label>
                {draft.files.map((f) => (
                  <label key={f.fileId} className="notify-row" style={{ cursor: 'pointer' }}>
                    <input
                      type="checkbox"
                      checked={f.include !== false}
                      onChange={(e) => toggleFile(f.fileId, e.target.checked)}
                    />
                    <span>
                      {f.name ?? 'вложение'}
                      {f.size ? <span className="dim"> · {humanSize(f.size)}</span> : null}
                    </span>
                  </label>
                ))}
              </div>
            )}

            {/* Шаги правятся здесь же: чек-лист, который нельзя поправить до создания,
                приходится переделывать в карточке — то же время, только позже. */}
            <div className="field">
              <label>Шаги</label>
              {draft.checklist.map((step, i) => (
                <div key={i} className="drawer-row">
                  <input
                    className="input"
                    value={step}
                    onChange={(e) => setDraft({
                      ...draft, checklist: draft.checklist.map((x, k) => (k === i ? e.target.value : x)),
                    })}
                    onBlur={() => void patch({ checklist: draft.checklist })}
                  />
                  <button
                    className="btn btn-ghost btn-sm"
                    onClick={() => void patch({ checklist: draft.checklist.filter((_, k) => k !== i) })}
                    title="Убрать шаг"
                    aria-label="Убрать шаг"
                  >
                    <Icon name="close" size={14} />
                  </button>
                </div>
              ))}
              <button className="btn btn-ghost btn-sm" onClick={() => setDraft({ ...draft, checklist: [...draft.checklist, ''] })}>
                <Icon name="plus" size={13} /> Шаг
              </button>
            </div>

            {err && <div className="error-text">{err}</div>}
            <div className="drawer-row">
              <button className="btn btn-primary" style={{ flex: 1 }} onClick={() => void create()} disabled={busy}>
                {busy ? 'Создаю…' : 'Создать задачу'}
              </button>
              {/* Отказ — явным действием: закрытое окно черновик не отменяет, он может ждать ответа. */}
              <button className="btn btn-ghost" onClick={() => void cancel()} disabled={busy} title="Не создавать задачу по этому сообщению">
                Отказаться
              </button>
            </div>
          </>
        )}
        {loading && err && <div className="error-text">{err}</div>}
      </aside>
    </div>
  );
}
