import type { Focus } from '../types';
import type { FocusSession } from '../lib/api';
import { lazyComponent } from '../lib/lazy';

/*
  #4787, п. 12: один и тот же глубокий фокус из меню аккаунта и из календаря — окно
  календаря (задачи, 10–120 минут, сейчас или в календарь, кто может обратиться срочно).
  Отдельным куском: меню живёт в первом экране, окно нужно редко.
*/
export const FocusDialog = lazyComponent(() => import('../pages/calendar/FocusDialog').then((m) => m.FocusDialog));
/** Переключатель фокуса — в меню аккаунта, грузится при его открытии (бюджет первого экрана). */
export const FocusMenu = lazyComponent(() => import('./FocusPicker').then((m) => m.FocusMenu));

export const FOCUS_LABEL: Record<Focus['kind'], string> = {
  deep: 'Глубокий фокус',
  call: 'На созвоне',
  quick: 'Быстрые ответы',
  break: 'Перерыв',
  task: 'В работе',
};

/** Строка под именем в панели: что человек делает и до какого времени. */
export function focusLine(focus: Focus | null): string {
  if (!focus) return 'Фокус не задан';
  const what = focus.note?.trim() || FOCUS_LABEL[focus.kind];
  if (!focus.until) return what;
  const till = new Date(focus.until);
  const hh = String(till.getHours()).padStart(2, '0');
  const mm = String(till.getMinutes()).padStart(2, '0');
  return `${what} до ${hh}:${mm}`;
}

/**
 * #4777: идёт глубокий фокус — статус говорит, до скольки и над какими задачами:
 * «Глубокий фокус · до 15:20 · #1326, #1350» (#4782, п. 3). Конец — по остатку от сервера, а не по плану:
 * после паузы план сдвигается.
 */
export function focusSessionLine(s: FocusSession, receivedAt: number): string {
  const tasks = s.tasks?.length ? s.tasks : s.task ? [s.task] : [];
  // #4782, п. 3: «Глубокий фокус · до 15:20 · #1326, #1476»
  const nums = tasks.length ? ` · ${tasks.map((t) => `#${t.id}`).join(', ')}` : '';
  if (s.status === 'paused') return `Глубокий фокус на паузе${nums}`;
  const end = new Date(receivedAt + s.remainingSeconds * 1000);
  return `Глубокий фокус · до ${String(end.getHours()).padStart(2, '0')}:${String(end.getMinutes()).padStart(2, '0')}${nums}`;
}

