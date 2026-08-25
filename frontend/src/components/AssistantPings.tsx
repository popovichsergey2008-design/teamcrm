import { useCallback, useEffect, useState } from 'react';
import { Icon } from './Icon';
import { api } from '../lib/api';
import type { Ping } from '../types';

/**
 * «Секретарь напоминает» — то, что сегодня руководитель обходит и спрашивает руками.
 *
 * Живёт в «Фокусе дня» и только когда есть что сказать: пустой блок «напоминаний нет»
 * занимал бы место и приучал не смотреть в эту часть экрана.
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
      await api.dismissPing(p.id); // ответ дан делом — напоминание больше не нужно
      onPlanned();
    } catch {
      load();
    } finally {
      setBusy(null);
    }
  };

  if (!items.length) return null;

  return (
    <section className="card ping-box">
      <h3 className="ping-head"><Icon name="bell" size={15} /> Секретарь напоминает</h3>
      {items.map((p) => (
        <div key={p.id} className="ping-row">
          <button
            className="ping-text"
            onClick={() => (p.projectId && p.taskId ? onOpenTask(p.projectId, p.taskId) : undefined)}
            title={p.taskId ? 'Открыть задачу' : undefined}
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
      ))}
    </section>
  );
}
