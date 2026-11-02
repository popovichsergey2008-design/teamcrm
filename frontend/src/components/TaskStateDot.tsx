import { Icon } from './Icon';
import type { RecentTask } from '../lib/api';
import './task-state.css';

/** #4720: на английском интерфейсе браузера — английская подпись */
export const RECENT_LABEL = typeof navigator !== 'undefined' && /^en\b/i.test(navigator.language) ? 'Recent tasks' : 'Последние задачи';
const NOT_STARTED = /^(нов|to ?do|бэклог|backlog|в планах|план|очеред|входящ)/i;

/**
 * Состояние задачи для значка (#4720, #4730, как в Linear): серый пунктир — не начата,
 * жёлтая половина — в работе, зелёные три четверти — на проверке, синий с галочкой —
 * готово, красный — просрочена.
 */
export function recentState(t: RecentTask): { cls: string; hint: string } {
  if (t.stage === 'done') return { cls: 'tst-done', hint: 'Готово' };
  if (t.overdue) return { cls: 'tst-late', hint: `Просрочена · ${t.status ?? ''}` };
  if (t.stage === 'testing' || t.stage === 'review') return { cls: 'tst-check', hint: t.status ?? 'На проверке' };
  if (t.status && NOT_STARTED.test(t.status)) return { cls: 'tst-new', hint: t.status };
  return { cls: 'tst-work', hint: t.status ?? 'В работе' };
}

export function TaskStateDot({ task }: { task: RecentTask }) {
  const st = recentState(task);
  return (
    <span className={`tst ${st.cls}`} role="img" aria-label={st.hint} title={st.hint}>
      {st.cls === 'tst-done' && <Icon name="check" size={9} />}
    </span>
  );
}
