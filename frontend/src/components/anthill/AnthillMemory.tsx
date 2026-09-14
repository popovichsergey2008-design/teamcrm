import { useCallback, useEffect, useState } from 'react';
import { Icon } from '../Icon';
import { api, ApiError } from '../../lib/api';
import type { AnthillMemory as Memory } from '../../lib/api';
import { useAuth } from '../../state/auth';
import { stampLabel } from '../../lib/chat-text';

const TYPE_TITLE: Record<string, string> = { preference: 'Предпочтения', topic: 'Рабочие темы' };
const TYPE_HINT: Record<string, string> = {
  preference: 'как вам отвечать и как вы работаете',
  topic: 'над чем вы работаете сейчас',
};

/**
 * Память агента (ТЗ-6, разд. 20–21).
 *
 * Правило ТЗ прямое: скрытно хранить о человеке ничего нельзя. Поэтому здесь
 * лежит всё, что агент запомнил, каждая строка правится и удаляется, а автосбор
 * выключается одной галочкой — и тогда память пополняется только по просьбе
 * «запомни, что…».
 */
export function AnthillMemory() {
  const { user } = useAuth();
  const [rows, setRows] = useState<Memory[]>([]);
  const [err, setErr] = useState('');
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState<{ type: 'preference' | 'topic'; title: string; content: string }>({ type: 'preference', title: '', content: '' });
  const [editing, setEditing] = useState<string | null>(null);
  /*
    Выключатель держим у себя.

    Правда о нём — на сервере (агент спрашивает его перед тем, как что-то
    запомнить), но в токене профиль обновляется не сразу, и галочка «отскакивала»
    бы назад на глазах у человека.
  */
  const [auto, setAuto] = useState(user?.uiPrefs?.anthill?.memoryAuto !== false);

  const load = useCallback(() => { api.anthillMemories().then(setRows).catch(() => undefined); }, []);
  useEffect(() => load(), [load]);

  const toggleAuto = () => {
    const next = !auto;
    setAuto(next);
    void api.saveUiPrefs({ anthill: { memoryAuto: next } }).catch(() => setAuto(!next));
  };

  const add = async () => {
    setErr('');
    try {
      await api.anthillRemember(draft.type, draft.title.trim(), draft.content.trim());
      setDraft({ type: 'preference', title: '', content: '' });
      setAdding(false);
      load();
    } catch (e) { setErr(e instanceof ApiError ? e.message : 'Не удалось сохранить'); }
  };

  const forget = async (row: Memory) => {
    setErr('');
    try { await api.anthillForget(row.id); load(); }
    catch (e) { setErr(e instanceof ApiError ? e.message : 'Не удалось удалить'); }
  };

  return (
    <div className="anthill-pane">
      <div className="anthill-pane-head">
        <label className="anthill-ctx" title="Агент сам подмечает ваши предпочтения и рабочие темы">
          <input type="checkbox" checked={auto} onChange={toggleAuto} />
          Запоминать самому
        </label>
        <button className="btn btn-primary btn-sm" onClick={() => setAdding((v) => !v)}>
          <Icon name="plus" size={13} /> Добавить
        </button>
      </div>

      {adding && (
        <div className="anthill-form anthill-card">
          <label className="anthill-form-row">
            <span className="dim">Что это</span>
            <select className="input" value={draft.type} onChange={(e) => setDraft({ ...draft, type: e.target.value as 'preference' | 'topic' })}>
              <option value="preference">Предпочтение — {TYPE_HINT.preference}</option>
              <option value="topic">Рабочая тема — {TYPE_HINT.topic}</option>
            </select>
          </label>
          <label className="anthill-form-row">
            <span className="dim">О чём это</span>
            <input className="input" value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} placeholder="Часовой пояс" />
          </label>
          <label className="anthill-form-row">
            <span className="dim">Что запомнить</span>
            <textarea className="input" rows={2} value={draft.content} onChange={(e) => setDraft({ ...draft, content: e.target.value })} placeholder="Работаю по Новосибирску, отчёты нужны к 9 утра по местному" />
          </label>
          <div className="anthill-form-acts">
            <button className="btn btn-primary btn-sm" onClick={() => { void add(); }} disabled={draft.title.trim().length < 2 || draft.content.trim().length < 2}>Запомнить</button>
            <button className="btn btn-ghost btn-sm" onClick={() => setAdding(false)}>Отмена</button>
          </div>
        </div>
      )}

      {err && <div className="error-text">{err}</div>}

      {rows.length === 0 && !adding && (
        <div className="anthill-empty">
          <div className="anthill-empty-title">Пока агент о вас ничего не запомнил</div>
          <div className="dim">Скажите в разговоре «запомни, что…» — или добавьте сами. Всё, что здесь окажется, можно исправить и удалить.</div>
        </div>
      )}

      {['preference', 'topic'].map((type) => {
        const list = rows.filter((r) => r.type === type);
        if (!list.length) return null;
        return (
          <div key={type} className="anthill-group">
            <div className="anthill-group-head">{TYPE_TITLE[type]} <span className="dim">· {TYPE_HINT[type]}</span></div>
            {list.map((row) => (
              <div key={row.id} className="anthill-card anthill-mem">
                {editing === row.id ? (
                  <EditMemory
                    row={row}
                    onCancel={() => setEditing(null)}
                    onSave={async (title, content) => {
                      try { await api.anthillEditMemory(row.id, title, content); setEditing(null); load(); }
                      catch (e) { setErr(e instanceof ApiError ? e.message : 'Не удалось сохранить'); }
                    }}
                  />
                ) : (
                  <>
                    <div className="anthill-mem-top">
                      <span className="anthill-mem-title">{row.title}</span>
                      {row.source === 'auto' && <span className="badge badge-muted" title="Агент подметил это сам">сам</span>}
                    </div>
                    <div className="anthill-mem-body">{row.content}</div>
                    <div className="anthill-mem-acts">
                      <span className="dim">{stampLabel(row.updatedAt)}</span>
                      <button className="msg-icon" onClick={() => setEditing(row.id)} title="Исправить" aria-label="Исправить"><Icon name="edit" size={13} /></button>
                      <button className="msg-icon" onClick={() => { void forget(row); }} title="Забыть" aria-label="Забыть"><Icon name="trash" size={13} /></button>
                    </div>
                  </>
                )}
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}

function EditMemory({ row, onSave, onCancel }: {
  row: Memory;
  onSave: (title: string, content: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState(row.title);
  const [content, setContent] = useState(row.content);
  return (
    <div className="anthill-form">
      <label className="anthill-form-row">
        <span className="dim">О чём это</span>
        <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} />
      </label>
      <label className="anthill-form-row">
        <span className="dim">Что запомнить</span>
        <textarea className="input" rows={2} value={content} onChange={(e) => setContent(e.target.value)} />
      </label>
      <div className="anthill-form-acts">
        <button className="btn btn-primary btn-sm" onClick={() => { void onSave(title.trim(), content.trim()); }}>Сохранить</button>
        <button className="btn btn-ghost btn-sm" onClick={onCancel}>Не менять</button>
      </div>
    </div>
  );
}
