import { useCallback, useEffect, useState } from 'react';
import { Icon } from '../Icon';
import { api, ApiError } from '../../lib/api';
import type { AnthillActionRow, AnthillSchedule } from '../../lib/api';
import { stampLabel } from '../../lib/chat-text';

const GROUPS: { key: string; title: string }[] = [
  { key: 'active', title: 'Активные' },
  { key: 'paused', title: 'На паузе' },
  { key: 'done', title: 'Завершённые' },
];

/** Как назвать действие человеку: «create_task» ему ничего не говорит. */
const TOOL_TITLE: Record<string, string> = {
  create_task: 'Создать задачу',
  create_reminder: 'Поставить напоминание',
  create_scheduled_task: 'Делать регулярно',
  create_skill: 'Записать навык',
  create_document: 'Собрать документ',
  create_event: 'Поставить встречу',
  update_task: 'Изменить задачу',
  add_comment: 'Написать в задачу',
  send_message: 'Отправить сообщение',
  remember: 'Запомнить',
};

/** Короткая подпись действия по его параметрам — чтобы не гадать, о чём оно. */
function actionHint(a: AnthillActionRow): string {
  const i = a.input ?? {};
  const first = [i.title, i.text, (i.task as any)?.title, i.instruction, i.name, i.content]
    .find((x) => typeof x === 'string' && x.trim());
  return first ? String(first).slice(0, 120) : '';
}

/**
 * Регулярные задачи агента (ТЗ-6, разд. 15).
 *
 * «Каждый понедельник в 9:00 дай список просроченных» — обещание, которое агент
 * даёт на месяцы вперёд. Поэтому здесь видно не только расписание, но и когда
 * следующий запуск, что пришло в прошлый раз и не сломалось ли: молчащая задача
 * выглядит точно так же, как работающая, и это худший вид поломки.
 */
export function AnthillTasks({ onOpenSession }: { onOpenSession?: (sessionId: string) => void }) {
  const [rows, setRows] = useState<AnthillSchedule[]>([]);
  /**
   * Действия, которые агент предложил, а человек не досмотрел (ТЗ-6, разд. 36).
   *
   * Карточка живёт в разговоре, но из разговора уходят: закрыли окно — и предложение
   * повисло. Здесь видно всё, что ждёт решения, и решить можно не возвращаясь.
   */
  const [pending, setPending] = useState<AnthillActionRow[]>([]);
  const [err, setErr] = useState('');
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState({ title: '', instruction: '', schedule: '' });
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api.anthillSchedules().then(setRows).catch(() => undefined);
    api.anthillActions()
      .then((list) => setPending(list.filter((a) => a.status === 'pending')))
      .catch(() => undefined);
  }, []);
  useEffect(() => load(), [load]);

  const add = async () => {
    setBusy(true); setErr('');
    try {
      await api.anthillAddSchedule({ title: draft.title.trim(), instruction: draft.instruction.trim(), schedule: draft.schedule.trim() });
      setDraft({ title: '', instruction: '', schedule: '' });
      setAdding(false);
      load();
    } catch (e) { setErr(e instanceof ApiError ? e.message : 'Не удалось создать'); }
    finally { setBusy(false); }
  };

  const patch = async (id: string, p: Parameters<typeof api.anthillPatchSchedule>[1]) => {
    setErr('');
    try { await api.anthillPatchSchedule(id, p); load(); }
    catch (e) { setErr(e instanceof ApiError ? e.message : 'Не удалось сохранить'); }
  };

  const remove = async (row: AnthillSchedule) => {
    if (!window.confirm(`Удалить «${row.title}»? Задача перестанет выполняться.`)) return;
    setErr('');
    try { await api.anthillDeleteSchedule(row.id); load(); }
    catch (e) { setErr(e instanceof ApiError ? e.message : 'Не удалось удалить'); }
  };

  return (
    <div className="anthill-pane">
      <div className="anthill-pane-head">
        <span className="dim">Агент делает это сам, по расписанию — и приносит результат в «Заметки».</span>
        <button className="btn btn-primary btn-sm" onClick={() => setAdding((v) => !v)}>
          <Icon name="plus" size={13} /> Новая
        </button>
      </div>

      {adding && (
        <div className="anthill-form anthill-card">
          <label className="anthill-form-row">
            <span className="dim">Название</span>
            <input className="input" value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} placeholder="Просроченные за неделю" />
          </label>
          <label className="anthill-form-row">
            <span className="dim">Что делать при каждом запуске</span>
            <textarea className="input" rows={2} value={draft.instruction} onChange={(e) => setDraft({ ...draft, instruction: e.target.value })} placeholder="дай список просроченных задач по всем проектам" />
          </label>
          <label className="anthill-form-row">
            <span className="dim">Когда</span>
            <input className="input" value={draft.schedule} onChange={(e) => setDraft({ ...draft, schedule: e.target.value })} placeholder="каждый понедельник в 9:00" />
          </label>
          <div className="anthill-form-acts">
            <button className="btn btn-primary btn-sm" onClick={() => { void add(); }} disabled={busy || !draft.title.trim() || draft.instruction.trim().length < 5 || !draft.schedule.trim()}>Создать</button>
            <button className="btn btn-ghost btn-sm" onClick={() => setAdding(false)} disabled={busy}>Отмена</button>
          </div>
        </div>
      )}

      {err && <div className="error-text">{err}</div>}

      {pending.length > 0 && (
        <div className="anthill-group">
          <div className="anthill-group-head">Ждут вашего решения</div>
          {pending.map((a) => (
            <div key={a.id} className="anthill-card anthill-task">
              <div className="anthill-task-top">
                <span className="anthill-task-title">{TOOL_TITLE[a.tool] ?? a.tool}</span>
                <span className="dim">{stampLabel(a.createdAt)}</span>
              </div>
              {actionHint(a) && <div className="dim anthill-task-what">{actionHint(a)}</div>}
              <div className="anthill-task-acts">
                <button
                  className="btn btn-primary btn-sm"
                  onClick={() => { setErr(''); api.anthillConfirm(a.id).then(load).catch((e) => setErr(e instanceof ApiError ? e.message : 'Не удалось выполнить')); }}
                >
                  <Icon name="check" size={13} /> Создать
                </button>
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={() => { api.anthillReject(a.id).then(load).catch(() => undefined); }}
                >Отмена</button>
              </div>
            </div>
          ))}
        </div>
      )}

      {rows.length === 0 && !adding && pending.length === 0 && (
        <div className="anthill-empty">
          <div className="anthill-empty-title">Регулярных задач пока нет</div>
          <div className="dim">Попросите прямо в разговоре: «каждый понедельник в 9:00 дай список просроченных» — или нажмите «Новая».</div>
        </div>
      )}

      {GROUPS.map((g) => {
        const list = rows.filter((r) => r.status === g.key);
        if (!list.length) return null;
        return (
          <div key={g.key} className="anthill-group">
            <div className="anthill-group-head">{g.title}</div>
            {list.map((row) => (
              <div key={row.id} className={`anthill-card anthill-task anthill-task-${row.status}`}>
                <div className="anthill-task-top">
                  <span className="anthill-task-title">{row.title}</span>
                  <span className="anthill-task-when">{row.label}</span>
                </div>
                <div className="dim anthill-task-what">{row.instruction}</div>
                <div className="dim anthill-task-meta">
                  {row.status === 'active' && row.nextRunAt && <span><Icon name="clock" size={11} /> следующий: {stampLabel(row.nextRunAt)}</span>}
                  {row.status === 'paused' && <span className="badge badge-muted">на паузе</span>}
                  {row.lastRunAt && <span>· последний: {stampLabel(row.lastRunAt)}</span>}
                  {row.runs > 0 && <span>· запусков: {row.runs}</span>}
                </div>
                {row.lastError && <div className="error-text anthill-task-err">Прошлый запуск не удался: {row.lastError}</div>}
                {row.lastResult && (
                  <details className="anthill-task-result">
                    <summary>Что пришло в прошлый раз</summary>
                    <div className="anthill-task-result-body">{row.lastResult}</div>
                  </details>
                )}

                {editing === row.id ? (
                  <EditTask row={row} onCancel={() => setEditing(null)} onSave={async (p) => { await patch(row.id, p); setEditing(null); }} />
                ) : (
                  <div className="anthill-task-acts">
                    <button className="btn btn-ghost btn-sm" onClick={() => { void patch(row.id, { status: row.status === 'active' ? 'paused' : 'active' }); }}>
                      <Icon name={row.status === 'active' ? 'pause' : 'play'} size={13} /> {row.status === 'active' ? 'Пауза' : 'Включить'}
                    </button>
                    <button className="btn btn-ghost btn-sm" onClick={() => setEditing(row.id)}><Icon name="edit" size={13} /> Править</button>
                    {row.sessionId && onOpenSession && (
                      <button className="btn btn-ghost btn-sm" onClick={() => onOpenSession(row.sessionId!)}><Icon name="chat" size={13} /> Нитка</button>
                    )}
                    <button className="msg-icon" onClick={() => { void remove(row); }} title="Удалить" aria-label="Удалить"><Icon name="trash" size={13} /></button>
                  </div>
                )}
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}

function EditTask({ row, onSave, onCancel }: {
  row: AnthillSchedule;
  onSave: (p: { title: string; instruction: string; schedule: string }) => Promise<void>;
  onCancel: () => void;
}) {
  const [v, setV] = useState({ title: row.title, instruction: row.instruction, schedule: row.label });
  const [busy, setBusy] = useState(false);
  return (
    <div className="anthill-form">
      <label className="anthill-form-row">
        <span className="dim">Название</span>
        <input className="input" value={v.title} onChange={(e) => setV({ ...v, title: e.target.value })} />
      </label>
      <label className="anthill-form-row">
        <span className="dim">Что делать</span>
        <textarea className="input" rows={2} value={v.instruction} onChange={(e) => setV({ ...v, instruction: e.target.value })} />
      </label>
      <label className="anthill-form-row">
        <span className="dim">Когда</span>
        <input className="input" value={v.schedule} onChange={(e) => setV({ ...v, schedule: e.target.value })} />
      </label>
      <div className="anthill-form-acts">
        <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => { setBusy(true); void onSave(v).finally(() => setBusy(false)); }}>Сохранить</button>
        <button className="btn btn-ghost btn-sm" disabled={busy} onClick={onCancel}>Не менять</button>
      </div>
    </div>
  );
}
