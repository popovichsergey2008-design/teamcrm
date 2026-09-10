import { useEffect, useState } from 'react';
import { Icon } from './Icon';
import { api } from '../lib/api';
import { useEscape } from '../hooks/useEscape';
import type { GateSettings } from '../types';
import { overlayProps } from '../lib/overlay';
import { toastSaved } from '../lib/notifications';

/**
 * Условия приёмки работы — общие для компании.
 *
 * Видят все: правило, по которому у тебя не примут работу, не должно быть тайным.
 * Меняет владелец — как и рабочие часы. Гейт мягкий: он спрашивает и пускает,
 * а обход остаётся в истории задачи, поэтому «выключить, чтобы не мешало»
 * почти никогда не нужно — но возможность оставлена, задачи бывают разные.
 */

const ITEMS: { key: keyof GateSettings; title: string; hint: string }[] = [
  {
    key: 'checklist',
    title: 'Чек-лист закрыт',
    hint: 'Если в задаче есть пункты и часть не отмечена. Задачи без чек-листа проходят свободно.',
  },
  {
    key: 'comment',
    title: 'Есть отчёт исполнителя',
    hint: 'Хотя бы один комментарий от того, кто делал. Чаще всего именно этого не хватает проверяющему.',
  },
  {
    key: 'attachment',
    title: 'Приложен результат',
    hint: 'Хотя бы один файл в задаче. Подходит не всякой работе: у звонков и встреч результат не в файле.',
  },
];

export function HandoffGatePanel({ canManage, onClose }: { canManage: boolean; onClose: () => void }) {
  useEscape(onClose);
  const [gate, setGate] = useState<GateSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => { api.handoffGate().then(setGate).catch(() => setErr('Не удалось загрузить условия приёмки')); }, []);

  const toggle = async (key: keyof GateSettings) => {
    if (!gate || !canManage || saving) return;
    const next = { ...gate, [key]: !gate[key] };
    setGate(next); // сразу: галочка, которая думает, ощущается как сломанная
    setSaving(true);
    setErr('');
    try { setGate(await api.saveHandoffGate(next)); toastSaved('Настройка сохранена'); }
    catch { setGate(gate); setErr('Не удалось сохранить'); }
    finally { setSaving(false); }
  };

  return (
    <div className="drawer-overlay" {...overlayProps(onClose)}>
      <aside className="drawer" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-head">
          <h3><Icon name="check" size={18} /> Приёмка работы</h3>
          <button className="btn btn-ghost btn-sm" onClick={onClose} title="Закрыть"><Icon name="close" /></button>
        </div>

        <div className="dim gate-panel-hint">
          Что система спросит у исполнителя, когда он сдаёт задачу — переносит её на проверку
          или завершает. Сдать всё равно можно: отметка об этом останется в истории задачи.
        </div>

        {err && <div className="error-text">{err}</div>}

        {gate && ITEMS.map((it) => (
          <label key={it.key} className={`gate-item${canManage ? '' : ' gate-item-ro'}`}>
            <input
              type="checkbox"
              checked={gate[it.key]}
              disabled={!canManage || saving}
              onChange={() => toggle(it.key)}
            />
            <span>
              <span className="gate-item-title">{it.title}</span>
              <span className="dim gate-item-hint">{it.hint}</span>
            </span>
          </label>
        ))}

        {!canManage && <div className="dim gate-panel-hint">Условия приёмки задаёт владелец компании.</div>}
      </aside>
    </div>
  );
}
