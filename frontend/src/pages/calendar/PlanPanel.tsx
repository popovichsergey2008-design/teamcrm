import { useEffect, useState } from 'react';
import { Icon } from '../../components/Icon';
import { api, type PlanTask } from '../../lib/api';
import { fmtMinutes } from './TaskTimeDialog';

/** Тип данных при перетаскивании задачи на сетку календаря. */
export const DRAG_TASK = 'application/x-qevo-task';

/**
 * «Задачи для планирования» (#4787, п. 4): справа от календаря на компьютере.
 *
 * В карточке — номер и название, проект, срок, примерная длительность и «Найти время».
 * Карточку можно перетащить на свободное место сетки — тогда спросим, сколько времени
 * выделить. На телефоне вместо перетаскивания — кнопка «Запланировать».
 */
export function PlanPanel({ refreshKey, onPlan, onClose }: {
  refreshKey: number;
  onPlan: (taskId: string) => void;
  onClose: () => void;
}) {
  const [tasks, setTasks] = useState<PlanTask[] | null>(null);
  const [q, setQ] = useState('');
  useEffect(() => { api.calendarPlanTasks().then(setTasks).catch(() => setTasks([])); }, [refreshKey]);
  const s = q.trim().toLowerCase();
  const list = (tasks ?? []).filter((t) => !s || t.title.toLowerCase().includes(s) || t.id === s.replace(/^№|#/, ''));
  const phone = typeof window !== 'undefined' && window.matchMedia('(max-width: 700px)').matches;

  return (
    <aside className="cal-plan" aria-label="Задачи для планирования">
      <div className="cal-plan-head">
        <strong>Задачи для планирования</strong>
        <button className="ui-btn ui-btn-ghost ui-btn-icon-sm" onClick={onClose} aria-label="Скрыть панель"><Icon name="close" size={14} /></button>
      </div>
      <input className="ui-input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Поиск" aria-label="Поиск задачи" />
      {!phone && <div className="dim cal-plan-hint">Перетащите задачу на свободное время в календаре</div>}
      <ul className="cal-plan-list">
        {tasks === null && <li className="dim">Загружаю…</li>}
        {tasks !== null && !list.length && <li className="dim">Открытых задач, где вы исполнитель, нет</li>}
        {list.map((t) => (
          <li key={t.id}
            className="cal-plan-card"
            draggable={!phone}
            onDragStart={(e) => { e.dataTransfer.setData(DRAG_TASK, t.id); e.dataTransfer.effectAllowed = 'copy'; }}>
            <div className="cal-plan-title" title={t.title}><span className="cal-due-num">№{t.id}</span> {t.title}</div>
            <div className="cal-plan-meta">
              <span>{t.projectName}</span>
              <span className={t.deadlineAt && Date.parse(t.deadlineAt) < Date.now() ? 'cal-plan-late' : ''}>
                <Icon name="flag" size={11} /> {t.deadlineAt ? new Date(t.deadlineAt).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' }) : 'без срока'}
              </span>
              <span><Icon name="clock" size={11} /> {t.estimateMin ? `~${fmtMinutes(t.estimateMin)}` : 'длительность не задана'}</span>
              {t.plannedMin > 0 && <span className="cal-plan-planned"><Icon name="calendar" size={11} /> {fmtMinutes(t.plannedMin)} в календаре</span>}
            </div>
            <button className="ui-btn ui-btn-outline ui-btn-sm" onClick={() => onPlan(t.id)}>
              <Icon name={phone ? 'calendar' : 'search'} size={13} /> {phone ? 'Запланировать' : 'Найти время'}
            </button>
          </li>
        ))}
      </ul>
    </aside>
  );
}
