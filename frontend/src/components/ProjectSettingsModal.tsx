import { useState } from 'react';
import { Icon } from './Icon';
import { api, ApiError } from '../lib/api';
import { useEscape } from '../hooks/useEscape';
import { overlayProps } from '../lib/overlay';
import { PROJECTS_CHANGED } from './ProjectsNav';

/**
 * Настройки проекта.
 *
 * Здесь живёт то, что относится к доске целиком, а не к отдельной задаче. Первое —
 * место доски в списке: после импорта из YouGile и Битрикса свои доски тонут среди
 * десятков чужих.
 *
 * Почему не в левой панели, где это было сначала: панель — это переход между
 * досками, а не место, где их настраивают. Заказчик сказал ровно это.
 */
export function ProjectSettingsModal({ project, onClose, onChanged }: {
  project: { id: string; name: string; is_default?: boolean };
  onClose: () => void;
  onChanged: () => void;
}) {
  useEscape(onClose);
  const [isDefault, setIsDefault] = useState(project.is_default === true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [done, setDone] = useState('');

  /** Изменения применяются сразу: это переключатель, а не форма с сохранением. */
  const toggleDefault = async (next: boolean) => {
    setErr(''); setDone(''); setBusy(true);
    setIsDefault(next); // отклик мгновенный, откатим при ошибке
    try {
      await api.setProjectDefault(String(project.id), next);
      window.dispatchEvent(new Event(PROJECTS_CHANGED));
      onChanged();
      setDone(next ? 'Доска будет первой в списке' : 'Доска убрана из основных');
    } catch (e) {
      setIsDefault(!next);
      setErr(e instanceof ApiError ? e.message : 'Не удалось изменить');
    } finally { setBusy(false); }
  };

  const resetOrder = async () => {
    setErr(''); setDone(''); setBusy(true);
    try {
      await api.resetProjectOrder();
      window.dispatchEvent(new Event(PROJECTS_CHANGED));
      onChanged();
      setDone('Порядок восстановлен: основные доски наверху, остальные по алфавиту');
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Не удалось упорядочить');
    } finally { setBusy(false); }
  };

  return (
    <div className="modal-overlay" {...overlayProps(onClose)}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-head">
          <h3><Icon name="settings" size={16} /> Настройки проекта · {project.name}</h3>
          <button className="btn btn-ghost btn-sm" onClick={onClose} title="Закрыть" aria-label="Закрыть">
            <Icon name="close" size={16} />
          </button>
        </div>

        <div className="drawer-section">
          <div className="drawer-section-title">Место в списке досок</div>
          <label className="notify-row" title="Основные доски всегда идут первыми, что бы ни принёс очередной импорт">
            <input
              type="checkbox"
              checked={isDefault}
              disabled={busy}
              onChange={(e) => toggleDefault(e.target.checked)}
            />
            Основная доска компании — всегда первой в списке
          </label>
          <p className="dim">
            Порядок общий для всей компании: доски — общая рабочая поверхность, и «у меня
            по-другому» здесь только мешает договариваться, где что лежит. Переставить
            доски местами можно перетаскиванием в левой панели.
          </p>
        </div>

        <div className="drawer-section">
          <div className="drawer-section-title">Порядок по умолчанию</div>
          <p className="dim">
            После импорта из YouGile и Битрикса список превращается в кашу: чужие доски
            вперемешку со своими. Одно нажатие возвращает понятный вид. Задачи и сами
            доски при этом не трогаются — меняется только порядок в списке.
          </p>
          <button className="btn" onClick={resetOrder} disabled={busy}>
            <Icon name="list" size={14} /> Восстановить порядок по умолчанию
          </button>
        </div>

        {done && <div className="file-ok"><Icon name="check" size={13} /> {done}</div>}
        {err && <div className="error-text">{err}</div>}
      </div>
    </div>
  );
}
