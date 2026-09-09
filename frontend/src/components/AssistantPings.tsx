import { useCallback, useEffect, useState } from 'react';
import { Icon } from './Icon';
import { api } from '../lib/api';
import { useEscape } from '../hooks/useEscape';
import { groupPings, pingPreview, urgentPings } from '../lib/pings-view';
import type { Ping } from '../types';
import { overlayProps } from '../lib/overlay';

/**
 * «Секретарь напоминает» — то, что сегодня руководитель обходит и спрашивает руками.
 *
 * Живёт в «Фокусе дня» и только когда есть что сказать: пустой блок «напоминаний нет»
 * занимал бы место и приучал не смотреть в эту часть экрана.
 *
 * Показывается СВЁРНУТЫМ — одной строкой со счётчиком и превью. Раньше все напоминания
 * лежали списком прямо на экране: на двух это удобно, а на десяти блок вырастал выше
 * самих задач и отодвигал план на день вниз — то есть мешал ровно тому, ради чего
 * «Фокус дня» и сделан. Разбор переехал в правую панель, где список может быть любой
 * длины, не съедая главный экран.
 *
 * У каждого напоминания есть выход, и он не один: «Сделаю сегодня» ставит задачу
 * в личный план, «Скрыть» закрывает вопрос. Напоминание, которое можно только
 * прочитать, превращается в шум за неделю.
 */

const PING_EVENT = 'teamcrm:assistant-ping';

/** Пришло новое напоминание — блок должен появиться, а не ждать перезагрузки страницы. */
export function notifyPingArrived(): void {
  window.dispatchEvent(new CustomEvent(PING_EVENT));
}

export function AssistantPings({ today, onOpenTask, onPlanned }: {
  /** Сегодняшняя дата глазами человека: «сегодня» на сервере может быть другим днём. */
  today: string;
  onOpenTask: (projectId: string, taskId: string) => void;
  onPlanned: () => void;
}) {
  const [items, setItems] = useState<Ping[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  const load = useCallback(() => {
    api.assistantPings().then(setItems).catch(() => undefined);
  }, []);

  useEffect(() => {
    load();
    window.addEventListener(PING_EVENT, load);
    return () => window.removeEventListener(PING_EVENT, load);
  }, [load]);

  const drop = (id: string) => setItems((prev) => prev.filter((p) => p.id !== id));

  const dismiss = async (p: Ping) => {
    drop(p.id); // сразу: человек нажал «скрыть» и должен увидеть результат
    setBusy(p.id);
    try { await api.dismissPing(p.id); } catch { load(); } finally { setBusy(null); }
  };

  const planToday = async (p: Ping) => {
    if (!p.taskId) return;
    drop(p.id);
    setBusy(p.id);
    try {
      await api.setFocusDate(p.taskId, today);
      // Именно «сделаю», а не «скрыть»: по этой разнице секретарь считает, слушают ли
      // его вообще, и сам приглушает поводы, на которые перестали отвечать.
      await api.actedPing(p.id);
      onPlanned();
    } catch {
      load();
    } finally {
      setBusy(null);
    }
  };

  /**
   * Разобрать всё разом.
   *
   * Появляется от трёх напоминаний: когда за отпуск накопился десяток устаревших
   * поводов, гасить их по одному — работа ради работы, и человек просто перестаёт
   * открывать панель. Сводку не трогаем: её и так видно одним взглядом.
   */
  const dismissAll = async () => {
    const doomed = items.filter((p) => p.kind !== 'digest');
    if (!doomed.length) return;
    setItems((prev) => prev.filter((p) => p.kind === 'digest'));
    setBusy('all');
    try {
      await Promise.all(doomed.map((p) => api.dismissPing(p.id)));
    } catch {
      load();
    } finally {
      setBusy(null);
    }
  };

  if (!items.length) return null;

  const urgent = urgentPings(items);
  const groups = groupPings(items);

  const row = (p: Ping) => (
    <div key={p.id} className={`ping-row${p.kind === 'digest' ? ' ping-digest' : ''}`}>
      {/* Сводка дня — не строка про одну задачу, а несколько пунктов:
          переносы в ней несут смысл и обязаны сохраниться. */}
      <button
        className="ping-text"
        onClick={() => (p.projectId && p.taskId ? onOpenTask(p.projectId, p.taskId) : undefined)}
        title={p.taskId ? 'Открыть задачу' : undefined}
        style={p.kind === 'digest' ? { whiteSpace: 'pre-line', cursor: 'default' } : undefined}
      >
        {p.text}
      </button>
      <span className="ping-actions">
        {/* «Сделаю сегодня» — только тем, кто задачу и делает: проверяющему план не нужен */}
        {p.taskId && p.kind !== 'stuck_review' && (
          <button className="btn btn-sm" disabled={busy === p.id} onClick={() => planToday(p)}>
            Сделаю сегодня
          </button>
        )}
        <button className="btn btn-ghost btn-sm" disabled={busy === p.id} onClick={() => dismiss(p)}>
          Скрыть
        </button>
      </span>
    </div>
  );

  return (
    <>
      {/*
        Свёрнутая строка. Одна и та же высота при двух напоминаниях и при двадцати —
        «Фокус дня» не должен зависеть от того, сколько всего накопилось.
      */}
      <button className="ping-strip" onClick={() => setOpen(true)} title="Открыть напоминания секретаря">
        <Icon name="bell" size={15} />
        <span className="ping-strip-label">Секретарь напоминает</span>
        <span className={`ping-strip-count${urgent > 0 ? ' urgent' : ''}`}>{items.length}</span>
        <span className="ping-strip-preview">{pingPreview(items)}</span>
        <span className="ping-strip-go">Разобрать <Icon name="chevron-right" size={14} /></span>
      </button>

      {open && (
        <PingsDrawer
          groups={groups}
          count={items.length}
          canDismissAll={items.filter((p) => p.kind !== 'digest').length >= 3}
          busyAll={busy === 'all'}
          onDismissAll={dismissAll}
          onClose={() => setOpen(false)}
          row={row}
        />
      )}
    </>
  );
}

/**
 * Правая панель с разбором. Вынесена отдельным компонентом ради `useEscape`: хук
 * нельзя звать по условию, а панель существует не всегда.
 */
function PingsDrawer({ groups, count, canDismissAll, busyAll, onDismissAll, onClose, row }: {
  groups: { title: string; items: Ping[] }[];
  count: number;
  canDismissAll: boolean;
  busyAll: boolean;
  onDismissAll: () => void;
  onClose: () => void;
  row: (p: Ping) => JSX.Element;
}) {
  useEscape(onClose); // закрытие с клавиатуры, а не только крестиком

  return (
    <div className="drawer-overlay" {...overlayProps(onClose)}>
      <aside className="drawer" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-head">
          <h3><Icon name="bell" size={18} /> Секретарь напоминает</h3>
          <button className="drawer-close" onClick={onClose} title="Закрыть" aria-label="Закрыть">
            <Icon name="close" size={18} />
          </button>
        </div>
        <p className="drawer-desc dim">
          {count} {count === 1 ? 'повод' : count < 5 ? 'повода' : 'поводов'} посмотреть.
          «Сделаю сегодня» ставит задачу в план на день, «Скрыть» закрывает вопрос.
        </p>

        {canDismissAll && (
          <div className="ping-bulk">
            <button className="btn btn-ghost btn-sm" disabled={busyAll} onClick={onDismissAll}>
              <Icon name="check" size={14} /> Скрыть все
            </button>
          </div>
        )}

        {groups.map((g) => (
          <section key={g.title} className="ping-group">
            <h4 className="ping-group-head">{g.title}<span className="ping-group-count">{g.items.length}</span></h4>
            {g.items.map(row)}
          </section>
        ))}
      </aside>
    </div>
  );
}
