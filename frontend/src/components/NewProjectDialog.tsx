import { useState } from 'react';
import { Dialog } from './ui/dialog';
import { api, ApiError } from '../lib/api';
import { PROJECTS_CHANGED } from './ProjectsNav';

/**
 * Новый проект (#1580): название, описание и ключевые слова — все три обязательны.
 * По описанию и ключевым словам ИИ узнаёт проект в переписке («крипта» → проект про
 * криптовалюту) и не переспрашивает, к какому проекту задача.
 */
export default function NewProjectDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const [name, setName] = useState('');
  const [about, setAbout] = useState('');
  const [keywords, setKeywords] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const keywordList = keywords.split(',').map((k) => k.trim()).filter(Boolean);

  const create = async () => {
    const title = name.trim();
    if (!title) return setErr('Введите название проекта');
    if (about.trim().length < 10) return setErr('Опишите проект хотя бы одним предложением — по описанию ИИ узнаёт его в переписке');
    if (!keywordList.length) return setErr('Добавьте хотя бы одно ключевое слово — как проект называют в чатах');
    setBusy(true); setErr('');
    try {
      const created = await api.createProject({ name: title, description: about.trim(), aliases: keywordList });
      window.dispatchEvent(new Event(PROJECTS_CHANGED));
      onCreated(String(created.id));
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Не удалось создать проект');
    } finally { setBusy(false); }
  };

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }} title="Новый проект"
      footer={(
        <>
          <button className="ui-btn ui-btn-ghost ui-btn-md" onClick={onClose}>Отмена</button>
          <button className="ui-btn ui-btn-primary ui-btn-md" disabled={busy} onClick={() => void create()}>Создать проект</button>
        </>
      )}>
      <div className="projects-new-form">
        <label className="projects-new-field">
          <span>Название <b aria-hidden="true">*</b></span>
          <input className="input" value={name} autoFocus maxLength={255} placeholder="Например: Alphabet"
            onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="projects-new-field">
          <span>Описание <b aria-hidden="true">*</b></span>
          <textarea className="ui-textarea" rows={3} value={about} maxLength={2000}
            placeholder="О чём проект: продукт, клиент, чем занимаемся. Например: биржевой бот для криптовалюты, кошельки и стейкинг"
            onChange={(e) => setAbout(e.target.value)} />
        </label>
        <label className="projects-new-field">
          <span>Ключевые слова <b aria-hidden="true">*</b></span>
          <input className="input" value={keywords} placeholder="Через запятую: крипта, бот, Alpha"
            onChange={(e) => setKeywords(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void create(); }} />
        </label>
        <div className="dim nl-hint">
          Как проект называют в чатах и голосом. Когда в сообщении встречается такое слово или особые слова из описания,
          QEVO сам относит задачу к этому проекту и не переспрашивает.
        </div>
        {err && <div className="error-text" role="alert">{err}</div>}
      </div>
    </Dialog>
  );
}
