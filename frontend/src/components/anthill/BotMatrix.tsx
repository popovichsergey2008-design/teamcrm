import { useEffect, useState } from 'react';
import { api, ApiError, request } from '../../lib/api';
import { navigate } from '../../lib/router';
import { toastSaved } from '../../lib/notifications';
import { confirmAction, Dialog } from '../ui/dialog';

type Q = 'do' | 'plan' | 'delegate' | 'drop';
interface MTask { id: string; title: string; projectId: string; projectName: string | null; deadlineAt: string | null; priority: string | null; quadrant: Q; stale: boolean }

const QUAD: { id: Q; title: string; hint: string }[] = [
  { id: 'do', title: 'Срочно и важно', hint: 'сделать сегодня' },
  { id: 'plan', title: 'Важно, не срочно', hint: 'запланировать' },
  { id: 'delegate', title: 'Срочно, не важно', hint: 'поручить' },
  { id: 'drop', title: 'Не срочно и не важно', hint: 'отложить или закрыть' },
];

/**
 * «Приоритизация по Эйзенхауэру» (#4893, п. 10): не текст, а матрица 2×2 с задачами
 * человека. По квадратам — «В план на сегодня» (в Фокус дня), «Разложить по неделе»
 * (в Календарь), «Делегировать», «Закрыть» для старых без движения. Задачу можно
 * перетащить в другой квадрат. Ничего не меняется без подтверждения.
 */
export function BotMatrix({ onClose, onPrompt }: { onClose: () => void; onPrompt: (text: string) => void }) {
  const [tasks, setTasks] = useState<MTask[] | null>(null);
  const [drag, setDrag] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { void request<MTask[]>('GET', '/anthill/matrix').then(setTasks).catch(() => setTasks([])); }, []);
  const of = (q: Q) => (tasks ?? []).filter((t) => t.quadrant === q);
  const ids = (list: MTask[]) => list.map((t) => `#${t.id}`).join(', ');
  const moveTo = (q: Q) => { if (drag) setTasks((l) => (l ?? []).map((t) => (t.id === drag ? { ...t, quadrant: q } : t))); setDrag(null); };

  const today = async () => {
    const list = of('do').slice(0, 3);
    if (!list.length) return;
    const ok = await confirmAction({ title: 'В план на сегодня', description: list.map((t) => `«${t.title}»`).join(', '), confirmLabel: 'Добавить в Фокус дня' });
    if (!ok) return;
    setBusy(true);
    let added = 0; let reason = '';
    for (const t of list) {
      try { await api.focusAdd(`task:${t.id}`); added++; } catch (e) { reason = e instanceof ApiError ? e.message : ''; }
    }
    setBusy(false);
    window.dispatchEvent(new Event('teamcrm:tasks-changed'));
    toastSaved(added ? `В Фокусе дня: ${added}` : 'Не получилось', added ? 'откройте «Фокус дня»' : reason);
    if (added) { onClose(); navigate({ section: 'focus' }); }
  };

  const act = (q: Q) => {
    const list = q === 'drop' ? of('drop').filter((t) => t.stale) : of(q);
    if (!list.length) return null;
    if (q === 'do') return <button type="button" className="ui-btn ui-btn-primary ui-btn-sm" disabled={busy} onClick={() => void today()}>В план на сегодня</button>;
    if (q === 'plan') return <button type="button" className="ui-btn ui-btn-outline ui-btn-sm" onClick={() => { onClose(); onPrompt(`Разложи задачи ${ids(list)} по свободным окнам календаря на этой неделе — покажи план, поставлю после подтверждения.`); }}>Разложить по неделе</button>;
    if (q === 'delegate') return <button type="button" className="ui-btn ui-btn-outline ui-btn-sm" onClick={() => { onClose(); onPrompt(`Предложи, кому поручить задачи ${ids(list)} с учётом загрузки команды — каждую карточкой на подтверждение.`); }}>Делегировать</button>;
    return <button type="button" className="ui-btn ui-btn-ghost ui-btn-sm" onClick={() => { onClose(); onPrompt(`Закрой старые задачи без движения ${ids(list)} — каждую карточкой на подтверждение.`); }}>Закрыть старые ({list.length})</button>;
  };

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }} size="lg" title="Задачи по Эйзенхауэру">
      {tasks === null ? <div className="dim">Собираю задачи…</div> : !tasks.length ? <div className="dim">Открытых задач на вас нет.</div> : (
        <div className="bm-grid">
          {QUAD.map((q) => (
            <section key={q.id} className={`bm-q bm-${q.id}`} onDragOver={(e) => { if (drag) e.preventDefault(); }} onDrop={() => moveTo(q.id)} aria-label={q.title}>
              <div className="bm-head"><b>{q.title}</b><span className="dim">{of(q.id).length} · {q.hint}</span></div>
              <ul className="bm-list">
                {of(q.id).slice(0, 12).map((t) => (
                  <li key={t.id} draggable onDragStart={() => setDrag(t.id)} onDragEnd={() => setDrag(null)} className="bm-task" title="Перетащите в другой квадрат">
                    <button type="button" className="bm-task-title" onClick={() => navigate({ section: 'projects', projectId: t.projectId, taskId: t.id })}>{t.title}</button>
                    <span className="dim">#{t.id}{t.projectName ? ` · ${t.projectName}` : ''}{t.deadlineAt ? ` · срок ${new Date(t.deadlineAt).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })}` : ''}{t.stale ? ' · без движения 30+ дн.' : ''}</span>
                  </li>
                ))}
                {of(q.id).length > 12 && <li className="dim">и ещё {of(q.id).length - 12}</li>}
              </ul>
              <div className="bm-acts">{act(q.id)}</div>
            </section>
          ))}
        </div>
      )}
    </Dialog>
  );
}
