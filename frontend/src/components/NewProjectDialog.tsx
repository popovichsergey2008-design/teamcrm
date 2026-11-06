import { useState } from 'react';
import { Dialog } from './ui/dialog';
import { api, ApiError } from '../lib/api';
import { PROJECTS_CHANGED } from './ProjectsNav';

/**
 * Новый проект (#1580): по описанию и ключевым словам ИИ узнаёт проект в переписке
 * («крипта» → проект про криптовалюту) и не переспрашивает, к какому проекту задача.
 * #4779, п. 11: обязательно только название — остальное заставляло писать лишнее.
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
          <span>Описание</span>
          <textarea className="ui-textarea" rows={3} value={about} maxLength={2000}
            placeholder="О чём проект: продукт, клиент, чем занимаемся. Например: биржевой бот для криптовалюты, кошельки и стейкинг"
            onChange={(e) => setAbout(e.target.value)} />
        </label>
        <label className="projects-new-field">
          <span>Ключевые слова</span>
          <input className="input" value={keywords} placeholder="Через запятую: крипта, бот, Alpha"
            onChange={(e) => setKeywords(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void create(); }} />
        </label>
        {/* #4779, п. 11.2 */}
        <div className="dim nl-hint">Необязательно. Описание и ключевые слова помогут ИИ находить проект в переписке.</div>
        {err && <div className="error-text" role="alert">{err}</div>}
      </div>
    </Dialog>
  );
}
