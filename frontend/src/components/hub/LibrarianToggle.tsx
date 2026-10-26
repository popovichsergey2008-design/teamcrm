import { useState } from 'react';
import { ApiError, request } from '../../lib/api';

/**
 * Выключатель ИИ-библиотекаря в настройках проекта (#4659).
 *
 * Отдельным ленивым куском: окно настроек грузится с первым экраном, а там бюджет
 * веса исчерпан. Модуль Инфоцентра (hub-api, колонку) не тянет — только один запрос.
 */
export function LibrarianToggle({ projectId, initial, onDone }: {
  projectId: string;
  initial: boolean;
  onDone: (msg: string, error?: boolean) => void;
}) {
  const [on, setOn] = useState(initial);
  const [busy, setBusy] = useState(false);
  const toggle = async (next: boolean) => {
    setBusy(true);
    setOn(next);
    try {
      await request('PATCH', `/projects/${projectId}/hub/passport`, { hubLibrarian: next });
      onDone(next ? 'Библиотекарь будет собирать Инфоцентр каждое утро' : 'Библиотекарь выключен — Инфоцентр пополняется только вручную');
    } catch (e) {
      setOn(!next);
      onDone(e instanceof ApiError ? e.message : 'Не удалось изменить', true);
    } finally { setBusy(false); }
  };
  return (
    <div className="drawer-section">
      <div className="drawer-section-title">Инфоцентр</div>
      <label className="notify-row">
        <input type="checkbox" checked={on} disabled={busy} onChange={(e) => void toggle(e.target.checked)} />
        ИИ-библиотекарь — каждое утро собирает ссылки, файлы и решения в Инфоцентр
      </label>
      <p className="dim">В 8:00 по времени компании разбирает созвоны, чаты и закрытые задачи за сутки. Добавленное помечено «ИИ» и снимается одним нажатием.</p>
    </div>
  );
}
