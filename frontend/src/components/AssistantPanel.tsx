import { useEffect, useState } from 'react';
import { Icon } from './Icon';
import { api } from '../lib/api';
import { useEscape } from '../hooks/useEscape';
import type { AssistantMode } from '../types';
import { overlayProps } from '../lib/overlay';
import { toastSaved } from '../lib/notifications';

/**
 * Режим автономности ассистента.
 *
 * Решение о нём — не про технику, а про то, как компания разговаривает с людьми,
 * поэтому его принимает владелец, а видят все: человек вправе знать, кто ему пишет —
 * система сама или руководитель с её подсказки.
 *
 * По умолчанию «копилот». Система, которая начинает сама писать сотрудникам сразу
 * после обновления, — плохой сосед: сначала пусть владелец увидит, о чём именно
 * ассистент собирается напоминать.
 */

const MODES: { key: AssistantMode; title: string; hint: string; icon: 'moon' | 'user' | 'zap' }[] = [
  {
    key: 'off',
    title: 'Выключен',
    hint: 'Ассистент не напоминает ни о чём. Просроченное и зависшее по-прежнему видно в «Пульсе команды».',
    icon: 'moon',
  },
  {
    key: 'copilot',
    title: 'Копилот — предлагает',
    hint: 'Ассистент собирает поводы и показывает их постановщику: напомнить или не стоит. Людям сам не пишет.',
    icon: 'user',
  },
  {
    key: 'autopilot',
    title: 'Автопилот — напоминает сам',
    hint: 'Напоминания уходят исполнителям без подтверждения — в рабочие часы, не чаще раза в сутки по одному поводу.',
    icon: 'zap',
  },
];

export function AssistantPanel({ canManage, onClose }: { canManage: boolean; onClose: () => void }) {
  useEscape(onClose);
  const [mode, setMode] = useState<AssistantMode | null>(null);
  const [autoTasks, setAutoTasks] = useState(true);
  const [maintenance, setMaintenance] = useState(true);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    api.assistantMode()
      .then((r) => { setMode(r.mode); setAutoTasks(r.autoTasks); setMaintenance(r.maintenance); })
      .catch(() => setErr('Не удалось загрузить режим'));
  }, []);

  const toggleTasks = async () => {
    if (!canManage || saving) return;
    const next = !autoTasks;
    setAutoTasks(next);
    setSaving(true);
    setErr('');
    try { setAutoTasks((await api.setMeetingAutoTasks(next)).autoTasks); }
    catch { setAutoTasks(!next); setErr('Не удалось сохранить'); }
    finally { setSaving(false); }
  };

  const toggleMaintenance = async () => {
    if (!canManage || saving) return;
    const next = !maintenance;
    setMaintenance(next);
    setSaving(true);
    setErr('');
    try { setMaintenance((await api.setMaintenanceEnabled(next)).maintenance); }
    catch { setMaintenance(!next); setErr('Не удалось сохранить'); }
    finally { setSaving(false); }
  };

  const choose = async (next: AssistantMode) => {
    if (!canManage || saving || next === mode) return;
    const before = mode;
    setMode(next);
    setSaving(true);
    setErr('');
    try { setMode((await api.setAssistantMode(next)).mode); toastSaved('Настройка сохранена'); }
    catch { setMode(before); setErr('Не удалось сохранить'); }
    finally { setSaving(false); }
  };

  return (
    <div className="drawer-overlay" {...overlayProps(onClose)}>
      <aside className="drawer" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-head">
          <h3><Icon name="sparkles" size={18} /> Напоминания ассистента</h3>
          <button className="btn btn-ghost btn-sm" onClick={onClose} title="Закрыть"><Icon name="close" /></button>
        </div>

        <div className="dim gate-panel-hint">
          О чём ассистент напоминает: просроченный срок, срок в ближайшие сутки, работа,
          которая ждёт проверки больше суток, и задача без срока, которую не трогали пять дней.
        </div>

        {err && <div className="error-text">{err}</div>}

        {mode && MODES.map((m) => (
          <button
            key={m.key}
            className={`mode-row${mode === m.key ? ' mode-row-on' : ''}`}
            disabled={!canManage || saving}
            onClick={() => choose(m.key)}
          >
            <Icon name={m.icon} size={16} />
            <span>
              <span className="mode-title">{m.title}</span>
              <span className="dim mode-hint">{m.hint}</span>
            </span>
            {mode === m.key && <Icon name="check" size={15} />}
          </button>
        ))}

        <div className="drawer-section-title" style={{ marginTop: 18 }}>
          <Icon name="calendar" size={14} /> Модератор встреч
        </div>
        <div className="dim gate-panel-hint">
          За пять минут до встречи участники получают повестку: зачем собрались, о чём
          договорились в прошлый раз и что висит между ними. После встречи ассистент
          рассылает итог разбора всем, кто на ней был.
        </div>
        <label className={`gate-item${canManage ? '' : ' gate-item-ro'}`}>
          <input type="checkbox" checked={autoTasks} disabled={!canManage || saving} onChange={toggleTasks} />
          <span>
            <span className="gate-item-title">Создавать задачи со встречи сразу</span>
            <span className="dim gate-item-hint">
              Сами создаются только те, где ИИ уверенно назвал и исполнителя, и проект —
              остальное остаётся черновиком на подтверждение. Выключено — черновиками станут все.
            </span>
          </span>
        </label>

        <div className="drawer-section-title" style={{ marginTop: 18 }}>
          <Icon name="archive" size={14} /> Уборка брошенного
        </div>
        <div className="dim gate-panel-hint">
          Ассистент замечает, что все давно бросили: задачи без движения два месяца,
          проекты, где всё закрыто и тихо месяц, черновики со встреч, которых никто
          не подтвердил. Сам он не убирает ничего — только предлагает, и всё убранное
          возвращается кнопкой «Вернуть» в панели секретаря.
        </div>
        <label className={`gate-item${canManage ? '' : ' gate-item-ro'}`}>
          <input type="checkbox" checked={maintenance} disabled={!canManage || saving} onChange={toggleMaintenance} />
          <span>
            <span className="gate-item-title">Предлагать уборку</span>
            <span className="dim gate-item-hint">
              Решение всегда за человеком: владелец или руководитель нажимает «Убрать» или «Не надо».
              Сказали «не надо» — про этот объект больше не спросим.
            </span>
          </span>
        </label>

        {!canManage && <div className="dim gate-panel-hint">Режим ассистента задаёт владелец компании.</div>}
      </aside>
    </div>
  );
}
