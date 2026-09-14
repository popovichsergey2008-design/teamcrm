import { useCallback, useEffect, useState } from 'react';
import { Icon } from '../Icon';
import { api, ApiError } from '../../lib/api';
import type { AnthillResponse } from '../../lib/api';

const SCOPE_LABEL: Record<string, string> = { all: 'везде', channels: 'в группах и каналах', dms: 'в личных' };
const EMPTY = {
  trigger: '', answer: '', matchKind: 'keyword' as 'keyword' | 'exact',
  scope: 'all' as 'all' | 'channels' | 'dms', auto: false,
};

/**
 * Быстрые ответы (ТЗ-6, разд. 38) — хозяйство руководства.
 *
 * На «где инструкция по VPN» компания обязана отвечать одинаково каждому. Здесь
 * ответ задаётся один раз и приходит слово в слово — мгновенно и без модели.
 * «Без упоминания» по умолчанию выключено: бот, влезающий в живой разговор по
 * первому совпавшему слову, раздражает сильнее, чем помогает.
 */
export function AnthillResponses() {
  const [rows, setRows] = useState<AnthillResponse[]>([]);
  const [err, setErr] = useState('');
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState(EMPTY);
  const [editing, setEditing] = useState<string | null>(null);

  const load = useCallback(() => { api.anthillResponses().then(setRows).catch(() => undefined); }, []);
  useEffect(() => load(), [load]);

  const act = async (fn: Promise<unknown>) => {
    setErr('');
    try { await fn; load(); }
    catch (e) { setErr(e instanceof ApiError ? e.message : 'Не получилось'); }
  };

  return (
    <div className="anthill-pane">
      <div className="anthill-pane-head">
        <span className="dim">Ответ на частый вопрос — слово в слово, мгновенно и без модели.</span>
        <button className="btn btn-primary btn-sm" onClick={() => setAdding((v) => !v)}><Icon name="plus" size={13} /> Новый</button>
      </div>

      {adding && (
        <div className="anthill-form anthill-card">
          <label className="anthill-form-row">
            <span className="dim">Триггер — ключевые слова через запятую</span>
            <input className="input" value={draft.trigger} onChange={(e) => setDraft({ ...draft, trigger: e.target.value })} placeholder="vpn, впн" />
          </label>
          <label className="anthill-form-row">
            <span className="dim">Ответ</span>
            <textarea className="input" rows={3} value={draft.answer} onChange={(e) => setDraft({ ...draft, answer: e.target.value })} placeholder="Инструкция по VPN: https://…" />
          </label>
          <div className="anthill-resp-opts">
            <label className="anthill-form-row">
              <span className="dim">Как сравнивать</span>
              <select className="input" value={draft.matchKind} onChange={(e) => setDraft({ ...draft, matchKind: e.target.value as 'keyword' | 'exact' })}>
                <option value="keyword">по ключевым словам</option>
                <option value="exact">точное совпадение фразы</option>
              </select>
            </label>
            <label className="anthill-form-row">
              <span className="dim">Где</span>
              <select className="input" value={draft.scope} onChange={(e) => setDraft({ ...draft, scope: e.target.value as 'all' | 'channels' | 'dms' })}>
                <option value="all">везде</option>
                <option value="channels">в группах и каналах</option>
                <option value="dms">в личных</option>
              </select>
            </label>
          </div>
          <label className="anthill-ctx" title="Иначе ответ приходит только когда бота позвали через @">
            <input type="checkbox" checked={draft.auto} onChange={(e) => setDraft({ ...draft, auto: e.target.checked })} />
            Отвечать без упоминания бота
          </label>
          <div className="anthill-form-acts">
            <button
              className="btn btn-primary btn-sm"
              disabled={draft.trigger.trim().length < 2 || draft.answer.trim().length < 2}
              onClick={() => { void act(api.anthillAddResponse(draft)).then(() => { setDraft(EMPTY); setAdding(false); }); }}
            >Сохранить</button>
            <button className="btn btn-ghost btn-sm" onClick={() => setAdding(false)}>Отмена</button>
          </div>
        </div>
      )}

      {err && <div className="error-text">{err}</div>}

      {rows.length === 0 && !adding && (
        <div className="anthill-empty">
          <div className="anthill-empty-title">Быстрых ответов пока нет</div>
          <div className="dim">Заведите первый — например, «vpn» и ссылку на инструкцию. Дальше бот ответит сам.</div>
        </div>
      )}

      {rows.map((row) => (
        <div key={row.id} className={`anthill-card anthill-resp${row.enabled ? '' : ' anthill-task-paused'}`}>
          {editing === row.id ? (
            <EditResponse row={row} onCancel={() => setEditing(null)} onSave={async (p) => { await act(api.anthillEditResponse(row.id, p)); setEditing(null); }} />
          ) : (
            <>
              <div className="anthill-skill-top">
                <span className="anthill-mem-title">{row.trigger}</span>
                <span className="dim">{row.matchKind === 'exact' ? 'точная фраза' : 'ключевые слова'} · {SCOPE_LABEL[row.scope] ?? row.scope}</span>
                {row.auto && <span className="badge badge-info" title="Отвечает, даже когда бота не звали">без упоминания</span>}
                {!row.enabled && <span className="badge badge-muted">выключен</span>}
                {row.hits > 0 && <span className="dim">сработал {row.hits} раз</span>}
              </div>
              <div className="anthill-mem-body">{row.answer}</div>
              <div className="anthill-task-acts">
                <button className="btn btn-ghost btn-sm" onClick={() => { void act(api.anthillEditResponse(row.id, { enabled: !row.enabled })); }}>
                  <Icon name={row.enabled ? 'pause' : 'play'} size={13} /> {row.enabled ? 'Выключить' : 'Включить'}
                </button>
                <button className="btn btn-ghost btn-sm" onClick={() => setEditing(row.id)}><Icon name="edit" size={13} /> Править</button>
                <button
                  className="msg-icon"
                  onClick={() => { if (window.confirm(`Удалить быстрый ответ «${row.trigger}»?`)) void act(api.anthillDeleteResponse(row.id)); }}
                  title="Удалить" aria-label="Удалить"
                ><Icon name="trash" size={13} /></button>
              </div>
            </>
          )}
        </div>
      ))}
    </div>
  );
}

function EditResponse({ row, onSave, onCancel }: {
  row: AnthillResponse;
  onSave: (p: { trigger: string; answer: string; auto: boolean }) => Promise<void>;
  onCancel: () => void;
}) {
  const [v, setV] = useState({ trigger: row.trigger, answer: row.answer, auto: row.auto });
  return (
    <div className="anthill-form">
      <label className="anthill-form-row">
        <span className="dim">Триггер</span>
        <input className="input" value={v.trigger} onChange={(e) => setV({ ...v, trigger: e.target.value })} />
      </label>
      <label className="anthill-form-row">
        <span className="dim">Ответ</span>
        <textarea className="input" rows={3} value={v.answer} onChange={(e) => setV({ ...v, answer: e.target.value })} />
      </label>
      <label className="anthill-ctx">
        <input type="checkbox" checked={v.auto} onChange={(e) => setV({ ...v, auto: e.target.checked })} />
        Отвечать без упоминания бота
      </label>
      <div className="anthill-form-acts">
        <button className="btn btn-primary btn-sm" onClick={() => { void onSave({ trigger: v.trigger.trim(), answer: v.answer.trim(), auto: v.auto }); }}>Сохранить</button>
        <button className="btn btn-ghost btn-sm" onClick={onCancel}>Не менять</button>
      </div>
    </div>
  );
}
