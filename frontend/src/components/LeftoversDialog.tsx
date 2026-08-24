import { useEffect, useState } from 'react';
import { Icon } from './Icon';
import { api } from '../lib/api';
import { deadlineBadge } from '../lib/labels';
import type { Task } from '../types';

/**
 * Разбор вчерашних хвостов — первое, что человек видит за день, если вчера что-то не закрыл.
 *
 * Смысл в том, чего здесь НЕ происходит: незакрытое не превращается молча в просрочку и не
 * переносится само. Вчерашний план — личное обещание себе, и продлевать его должен человек,
 * иначе список «на сегодня» через неделю станет свалкой, которую никто не читает.
 *
 * Показываем один раз в день: пометка о разборе хранится локально. Если человек закрыл
 * окно, не решив, — вернёмся завтра, а не будем спрашивать при каждом переходе в раздел.
 */

const SEEN_KEY = 'teamcrm.leftovers.seen';

export function leftoversSeenToday(today: string): boolean {
  try { return localStorage.getItem(SEEN_KEY) === today; } catch { return false; }
}

export function markLeftoversSeen(today: string) {
  try { localStorage.setItem(SEEN_KEY, today); } catch { /* приватный режим — просто спросим ещё раз */ }
}

type Leftover = Task & { project_name: string };

export function LeftoversDialog({ tasks, today, onClose, onDone }: {
  tasks: Leftover[];
  today: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [left, setLeft] = useState(tasks);

  const decide = async (task: Leftover, toToday: boolean) => {
    setLeft((prev) => prev.filter((t) => t.id !== task.id));
    try { await api.setFocusDate(task.id, toToday ? today : null); } catch { /* вернётся в следующий разбор */ }
  };

  const all = async (toToday: boolean) => {
    setBusy(true);
    const list = left;
    setLeft([]);
    await Promise.allSettled(list.map((t) => api.setFocusDate(t.id, toToday ? today : null)));
    setBusy(false);
    finish();
  };

  const finish = () => { markLeftoversSeen(today); onDone(); };

  // Всё разобрано — окно закрывается само, отдельное «готово» нажимать незачем.
  // Через эффект, а не прямо в рендере: рендер обязан оставаться без побочных действий.
  useEffect(() => {
    if (left.length === 0) finish();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [left.length]);

  if (left.length === 0) return null;

  return (
    <div className="drawer-overlay" onClick={() => { markLeftoversSeen(today); onClose(); }}>
      <div className="leftovers" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Вчерашние задачи">
        <div className="leftovers-head">
          <h3><Icon name="clock" size={18} /> Со вчера осталось: {left.length}</h3>
          <button className="btn btn-ghost btn-sm" onClick={() => { markLeftoversSeen(today); onClose(); }} title="Закрыть">
            <Icon name="close" />
          </button>
        </div>
        <div className="dim leftovers-hint">
          Это ваш вчерашний план, а не просрочка. Решите по каждой: продолжаем сегодня или
          возвращаем в общий список.
        </div>

        <div className="leftovers-list">
          {left.map((t) => {
            const due = deadlineBadge(t.deadline_at, false);
            return (
              <div key={t.id} className="leftovers-row">
                <div className="leftovers-main">
                  <div>{t.title}</div>
                  <div className="leftovers-meta">
                    <span className="badge badge-muted">{t.project_name}</span>
                    {due && <span className={due.cls}>{due.text}</span>}
                  </div>
                </div>
                <div className="leftovers-actions">
                  <button className="btn btn-sm btn-primary" onClick={() => decide(t, true)}>Сегодня</button>
                  <button className="btn btn-ghost btn-sm" onClick={() => decide(t, false)}>В список</button>
                </div>
              </div>
            );
          })}
        </div>

        <div className="leftovers-foot">
          <button className="btn btn-sm" disabled={busy} onClick={() => all(true)}>Все на сегодня</button>
          <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => all(false)}>Все в список</button>
        </div>
      </div>
    </div>
  );
}
