import { useEffect, useState } from 'react';
import { Icon } from './Icon';
import { api, ApiError } from '../lib/api';
import { useEscape } from '../hooks/useEscape';
import { overlayProps } from '../lib/overlay';
import type { Industry } from '../types';

interface Suggested {
  name: string;
  checked: boolean;
  /** Отдел с таким именем в компании уже есть: повторно его не заведут. */
  exists: boolean;
}

/**
 * Шаг «Создать отделы» (ТЗ-11, разд. 20–22).
 *
 * Спрашиваем одно — чем занимается компания — и предлагаем структуру, которую остаётся
 * подтвердить. Придумывать отделы с нуля в первый день мало кто хочет, а пустая форма
 * «добавьте отдел» на этом шаге обычно и заканчивается ничем.
 *
 * Отмечено заранее только то, что есть почти у всех компаний отрасли. Ставить галочки
 * везде нельзя: пустой отдел, заведённый на всякий случай, потом мешает при назначении
 * исполнителя и в отборах.
 */
export function DepartmentsStepDialog({ industry, onClose, onDone }: {
  industry: string | null;
  onClose: () => void;
  onDone: () => void;
}) {
  useEscape(onClose);
  const [industries, setIndustries] = useState<Industry[]>([]);
  const [code, setCode] = useState(industry ?? 'other');
  const [rows, setRows] = useState<Suggested[]>([]);
  const [custom, setCustom] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => { api.onboardingIndustries().then(setIndustries).catch(() => setIndustries([])); }, []);

  useEffect(() => {
    api.onboardingDepartments(code)
      .then((r) => setRows(r.departments))
      .catch(() => setRows([]));
  }, [code]);

  const toggle = (name: string) => setRows((prev) => prev.map((r) => (r.name === name ? { ...r, checked: !r.checked } : r)));

  const addCustom = () => {
    const value = custom.trim();
    if (value.length < 2) return;
    setRows((prev) => (prev.some((r) => r.name.toLowerCase() === value.toLowerCase())
      ? prev
      : [...prev, { name: value, checked: true, exists: false }]));
    setCustom('');
  };

  const chosen = rows.filter((r) => r.checked && !r.exists);

  const create = async () => {
    setBusy(true); setErr('');
    try {
      await api.createDepartments(rows.filter((r) => r.checked).map((r) => r.name));
      onDone();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Отделы не создались');
      setBusy(false);
    }
  };

  return (
    <div className="modal-overlay" {...overlayProps(onClose)}>
      <div className="modal-card onb-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-head">
          <h3><Icon name="users" size={16} /> Отделы компании</h3>
          <button className="drawer-close" onClick={onClose} title="Закрыть" aria-label="Закрыть">
            <Icon name="close" size={20} />
          </button>
        </div>

        <div className="field">
          <label htmlFor="onb-dep-industry">Чем занимается компания</label>
          <select id="onb-dep-industry" className="input" value={code} onChange={(e) => setCode(e.target.value)}>
            {industries.map((i) => <option key={i.code} value={i.code}>{i.title}</option>)}
          </select>
          <span className="dim tpl-hint">Смените отрасль — предложим другой набор.</span>
        </div>

        <div className="onb-deps">
          {rows.map((r) => (
            <label key={r.name} className={`onb-dep${r.exists ? ' onb-dep-exists' : ''}`}>
              <input type="checkbox" checked={r.checked} disabled={r.exists} onChange={() => toggle(r.name)} />
              <span>{r.name}</span>
              {r.exists && <span className="dim onb-dep-note">уже есть</span>}
            </label>
          ))}
        </div>

        <div className="field">
          <label htmlFor="onb-dep-custom">Свой отдел</label>
          <div className="tpl-pick-row">
            <input
              id="onb-dep-custom"
              className="input"
              value={custom}
              maxLength={96}
              placeholder="Например: Отдел качества"
              onChange={(e) => setCustom(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addCustom(); } }}
            />
            <button className="ui-btn ui-btn-outline ui-btn-sm" onClick={addCustom} disabled={custom.trim().length < 2}>Добавить</button>
          </div>
        </div>

        {err && <div className="error-text">{err}</div>}

        <div className="modal-actions">
          <button className="ui-btn ui-btn-ghost ui-btn-md" onClick={onClose} disabled={busy}>Отмена</button>
          <button className="ui-btn ui-btn-primary ui-btn-md" onClick={create} disabled={busy || chosen.length === 0}>
            {busy ? 'Создаю…' : chosen.length ? `Создать отделы (${chosen.length})` : 'Выберите отделы'}
          </button>
        </div>
      </div>
    </div>
  );
}
