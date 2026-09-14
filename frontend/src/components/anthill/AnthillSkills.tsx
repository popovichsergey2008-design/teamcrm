import { useCallback, useEffect, useState } from 'react';
import { Icon } from '../Icon';
import { api, ApiError } from '../../lib/api';
import type { AnthillSkill } from '../../lib/api';

const EMPTY = { name: '', whenToUse: '', steps: '', output: '', visibility: 'private' as 'private' | 'company' };

/**
 * Каталог навыков (ТЗ-6, разд. 16–19).
 *
 * Навык — записанный порядок работы: «еженедельный отчёт по проекту», «подготовка
 * к миту». Агент берёт подходящий сам, но здесь его видно целиком — из каких шагов
 * он состоит и когда применяется. Это и есть ответ на вопрос «почему отчёт вышел
 * такой формы»: не «модель так решила», а вот эти шаги.
 *
 * Общие навыки компании правит их владелец; чужой берут копией под себя — так
 * никто не сломает другим то, чем они пользуются каждую неделю.
 */
export function AnthillSkills({ onRun }: { onRun?: (skill: AnthillSkill) => void }) {
  const [rows, setRows] = useState<AnthillSkill[]>([]);
  const [err, setErr] = useState('');
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState(EMPTY);
  const [editing, setEditing] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  const load = useCallback(() => { api.anthillSkills().then(setRows).catch(() => undefined); }, []);
  useEffect(() => load(), [load]);

  const toSteps = (text: string) => text.split('\n').map((x) => x.trim()).filter(Boolean).slice(0, 15);

  const add = async () => {
    setErr('');
    try {
      await api.anthillAddSkill({
        name: draft.name.trim(), whenToUse: draft.whenToUse.trim(),
        steps: toSteps(draft.steps), output: draft.output.trim(), visibility: draft.visibility,
      });
      setDraft(EMPTY); setAdding(false); load();
    } catch (e) { setErr(e instanceof ApiError ? e.message : 'Не удалось сохранить навык'); }
  };

  const act = async (fn: Promise<unknown>) => {
    setErr('');
    try { await fn; load(); }
    catch (e) { setErr(e instanceof ApiError ? e.message : 'Не получилось'); }
  };

  const mine = rows.filter((r) => r.mine);
  const company = rows.filter((r) => !r.mine);

  const card = (row: AnthillSkill) => (
    <div key={row.id} className="anthill-card anthill-skill">
      {editing === row.id ? (
        <EditSkill
          row={row}
          onCancel={() => setEditing(null)}
          onSave={async (p) => { await act(api.anthillEditSkill(row.id, p)); setEditing(null); }}
        />
      ) : (
        <>
          <div className="anthill-skill-top">
            <button className="anthill-skill-name" onClick={() => setOpen(open === row.id ? null : row.id)} aria-expanded={open === row.id}>
              <Icon name={open === row.id ? 'chevron-down' : 'chevron-right'} size={12} /> {row.name}
            </button>
            {row.shared && <span className="badge badge-info" title="Навык компании — виден всем">компании</span>}
            {row.uses > 0 && <span className="dim">применён {row.uses} раз</span>}
          </div>
          {row.whenToUse && <div className="dim anthill-skill-when">Когда: {row.whenToUse}</div>}
          {open === row.id && (
            <>
              {row.description && <div className="anthill-skill-desc">{row.description}</div>}
              <ol className="anthill-skill-steps">{row.steps.map((st, i) => <li key={i}>{st}</li>)}</ol>
              {row.output && <div className="dim">Результат: {row.output}</div>}
            </>
          )}
          <div className="anthill-task-acts">
            {onRun && (
              <button className="btn btn-ghost btn-sm" onClick={() => onRun(row)} title="Задать вопрос этим навыком">
                <Icon name="play" size={13} /> Применить
              </button>
            )}
            {row.mine ? (
              <>
                <button className="btn btn-ghost btn-sm" onClick={() => setEditing(row.id)}><Icon name="edit" size={13} /> Править</button>
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={() => { void act(api.anthillEditSkill(row.id, { visibility: row.shared ? 'private' : 'company' })); }}
                  title={row.shared ? 'Оставить только себе' : 'Поделиться с компанией'}
                >
                  <Icon name={row.shared ? 'lock' : 'users'} size={13} /> {row.shared ? 'Только мне' : 'Поделиться'}
                </button>
                <button
                  className="msg-icon"
                  onClick={() => { if (window.confirm(`Удалить навык «${row.name}»?`)) void act(api.anthillDeleteSkill(row.id)); }}
                  title="Удалить" aria-label="Удалить"
                ><Icon name="trash" size={13} /></button>
              </>
            ) : (
              <button className="btn btn-ghost btn-sm" onClick={() => { void act(api.anthillForkSkill(row.id)); }} title="Сделать свою копию и править её">
                <Icon name="copy" size={13} /> Копия под себя
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );

  return (
    <div className="anthill-pane">
      <div className="anthill-pane-head">
        <span className="dim">Агент берёт подходящий навык сам — или выберите его в разговоре.</span>
        <button className="btn btn-primary btn-sm" onClick={() => setAdding((v) => !v)}><Icon name="plus" size={13} /> Новый</button>
      </div>

      {adding && (
        <div className="anthill-form anthill-card">
          <label className="anthill-form-row">
            <span className="dim">Название</span>
            <input className="input" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="Релизный отчёт" />
          </label>
          <label className="anthill-form-row">
            <span className="dim">Когда применять — словами запроса</span>
            <input className="input" value={draft.whenToUse} onChange={(e) => setDraft({ ...draft, whenToUse: e.target.value })} placeholder="просят отчёт о релизе, итоги спринта" />
          </label>
          <label className="anthill-form-row">
            <span className="dim">Шаги — по одному в строке</span>
            <textarea className="input" rows={4} value={draft.steps} onChange={(e) => setDraft({ ...draft, steps: e.target.value })} placeholder={'Собрать закрытые задачи за период\nНайти незакрытые с этого релиза\nСобрать список изменений по проектам'} />
          </label>
          <label className="anthill-form-row">
            <span className="dim">Каким должен быть результат</span>
            <input className="input" value={draft.output} onChange={(e) => setDraft({ ...draft, output: e.target.value })} placeholder="Список изменений и то, что не успели" />
          </label>
          <label className="anthill-ctx">
            <input type="checkbox" checked={draft.visibility === 'company'} onChange={(e) => setDraft({ ...draft, visibility: e.target.checked ? 'company' : 'private' })} />
            Сделать навыком компании — им смогут пользоваться все
          </label>
          <div className="anthill-form-acts">
            <button className="btn btn-primary btn-sm" onClick={() => { void add(); }} disabled={draft.name.trim().length < 2 || toSteps(draft.steps).length === 0}>Сохранить</button>
            <button className="btn btn-ghost btn-sm" onClick={() => setAdding(false)}>Отмена</button>
          </div>
        </div>
      )}

      {err && <div className="error-text">{err}</div>}

      {mine.length > 0 && (
        <div className="anthill-group">
          <div className="anthill-group-head">Мои навыки</div>
          {mine.map(card)}
        </div>
      )}
      {company.length > 0 && (
        <div className="anthill-group">
          <div className="anthill-group-head">Навыки компании</div>
          {company.map(card)}
        </div>
      )}
    </div>
  );
}

function EditSkill({ row, onSave, onCancel }: {
  row: AnthillSkill;
  onSave: (p: { name: string; whenToUse: string; steps: string[]; output: string }) => Promise<void>;
  onCancel: () => void;
}) {
  const [v, setV] = useState({ name: row.name, whenToUse: row.whenToUse, steps: row.steps.join('\n'), output: row.output });
  return (
    <div className="anthill-form">
      <label className="anthill-form-row">
        <span className="dim">Название</span>
        <input className="input" value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} />
      </label>
      <label className="anthill-form-row">
        <span className="dim">Когда применять</span>
        <input className="input" value={v.whenToUse} onChange={(e) => setV({ ...v, whenToUse: e.target.value })} />
      </label>
      <label className="anthill-form-row">
        <span className="dim">Шаги — по одному в строке</span>
        <textarea className="input" rows={5} value={v.steps} onChange={(e) => setV({ ...v, steps: e.target.value })} />
      </label>
      <label className="anthill-form-row">
        <span className="dim">Результат</span>
        <input className="input" value={v.output} onChange={(e) => setV({ ...v, output: e.target.value })} />
      </label>
      <div className="anthill-form-acts">
        <button
          className="btn btn-primary btn-sm"
          onClick={() => {
            void onSave({
              name: v.name.trim(), whenToUse: v.whenToUse.trim(), output: v.output.trim(),
              steps: v.steps.split('\n').map((x) => x.trim()).filter(Boolean).slice(0, 15),
            });
          }}
        >Сохранить</button>
        <button className="btn btn-ghost btn-sm" onClick={onCancel}>Не менять</button>
      </div>
    </div>
  );
}
