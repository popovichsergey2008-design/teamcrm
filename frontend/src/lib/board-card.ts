/**
 * Карточка задачи на доске (#4798 §2–3, §10–11; #4799 BOARD01): чей сейчас ход и сколько
 * задача стоит. Всё — из фактического состояния задачи; причину задержки не придумываем.
 */

import { PAUSED_STAGES, REVIEW_STAGES, reviewerOf } from './board-filter';

export interface CardTask {
  id: string;
  assignee_id?: string | null;
  assignee_name?: string | null;
  created_by?: string | null;
  reviewer_id?: string | null;
  reviewer_name?: string | null;
  closed_at?: string | null;
  approval_state?: string;
  is_blocked?: boolean;
  blocker?: { reason: string; need: string; helper_id: string | null; helper_name: string | null } | null;
  waits_for?: { id: string; title: string; closed: boolean }[];
  submitted_at?: string | null;
  returned_at?: string | null;
  stage_since?: string | null;
  last_activity_at?: string | null;
  created_at?: string;
}

export type StepTone = 'work' | 'review' | 'mine' | 'client' | 'blocked' | 'returned' | 'wait';

export interface NextStep {
  text: string;
  tone: StepTone;
  /** Подсказка: откуда это взялось. */
  title: string;
}

const eq = (a: unknown, b: unknown) => String(a ?? '') !== '' && String(a ?? '') === String(b ?? '');

/**
 * Чей сейчас ход. Порядок — от того, что сильнее всего мешает работе: препятствие,
 * ожидание другой задачи, решение по сданной работе, клиент, возврат, исполнитель.
 */
export function nextStep(t: CardTask, stage: string | undefined, me: string): NextStep | null {
  if (t.closed_at) return null;
  if (t.is_blocked) {
    const b = t.blocker;
    const need = b?.need?.trim();
    const help = b?.helper_name ? ` · помощь — ${eq(b.helper_id, me) ? 'от вас' : b.helper_name}` : '';
    if (b?.reason === 'no_info') return { text: `Нужно уточнить задание${need ? `: ${need}` : ''}${help}`, tone: 'blocked', title: 'Исполнитель отметил: не хватает информации' };
    return { text: `Остановлено${need ? `: ${need}` : ''}${help}`, tone: 'blocked', title: 'Отмечено «Есть препятствие»' };
  }
  const waits = (t.waits_for ?? []).filter((w) => !w.closed);
  if (waits.length) {
    const w = waits[0];
    return { text: `Сначала нужно завершить #${w.id}${waits.length > 1 ? ` и ещё ${waits.length - 1}` : ''}`, tone: 'wait', title: `Ждёт задачу #${w.id} «${w.title}»` };
  }
  if (t.approval_state === 'pending' || (stage && REVIEW_STAGES.includes(stage))) {
    const mine = eq(reviewerOf(t), me);
    const who = t.reviewer_name ?? '';
    return mine
      ? { text: 'Ждёт вашего решения', tone: 'mine', title: 'Работа сдана — принять или вернуть решаете вы' }
      : { text: who ? `Ждёт проверки: ${who}` : 'Ждёт проверки', tone: 'review', title: 'Работа сдана и ждёт решения проверяющего' };
  }
  if (stage === 'waiting_external') return { text: 'Нужен ответ клиента', tone: 'client', title: 'Задача в колонке ожидания клиента' };
  const returned = t.returned_at && (!t.submitted_at || new Date(t.returned_at) >= new Date(t.submitted_at));
  if (returned) return { text: `Возвращено исполнителю${t.assignee_name ? `: ${t.assignee_name}` : ''}`, tone: 'returned', title: 'Проверяющий вернул работу на доработку' };
  if (!t.assignee_id) return { text: 'Нужно назначить исполнителя', tone: 'wait', title: 'У задачи нет исполнителя' };
  return eq(t.assignee_id, me)
    ? { text: 'Вы выполняете', tone: 'work', title: 'Следующий шаг — за вами' }
    : { text: `${t.assignee_name ?? 'Исполнитель'} выполняет`, tone: 'work', title: 'Следующий шаг — за исполнителем' };
}

/**
 * Срок на карточке словами (#4799, макет 01): «Сегодня, 17:00», «Завтра», «Пятница»,
 * дальше — дата. Красный — только просрочка исполнителя; сданное на проверку — нейтрально.
 */
export function dueText(deadline: string | null | undefined, closed: boolean, paused: boolean, now = new Date()): { text: string; tone: 'over' | 'soon' | 'plain' | 'done' } | null {
  if (!deadline) return null;
  const d = new Date(deadline);
  if (Number.isNaN(d.getTime())) return null;
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((day(d) - day(now)) / 86_400_000);
  const hm = d.getHours() || d.getMinutes() ? d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }) : '';
  const date = d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' }).replace('.', '');
  if (closed) return { text: date, tone: 'done' };
  if (days < 0 || (days === 0 && d < now)) {
    return paused ? { text: `${date} · на проверке`, tone: 'plain' } : { text: `Просрочено: ${days === 0 ? `сегодня${hm ? `, ${hm}` : ''}` : date}`, tone: 'over' };
  }
  if (days === 0) return { text: `Сегодня${hm ? `, ${hm}` : ''}`, tone: 'soon' };
  if (days === 1) return { text: `Завтра${hm ? `, ${hm}` : ''}`, tone: 'soon' };
  if (days < 7) {
    const wd = d.toLocaleDateString('ru-RU', { weekday: 'long' });
    return { text: wd[0].toUpperCase() + wd.slice(1), tone: 'plain' };
  }
  return { text: date, tone: 'plain' };
}

/** Рабочие дни между двумя моментами (без выходных). */
export function workDays(from: Date, to: Date): number {
  if (Number.isNaN(from.getTime()) || to <= from) return 0;
  let days = 0;
  const d = new Date(from);
  for (;;) {
    d.setDate(d.getDate() + 1);
    if (d > to) break;
    const wd = d.getDay();
    if (wd !== 0 && wd !== 6) days++;
  }
  return days;
}

export function daysWord(n: number): string {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return `${n} день`;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return `${n} дня`;
  return `${n} дней`;
}

/**
 * Сколько задача на нынешнем этапе (#4798 §10–11): «В работе 3 дня», «Ждёт решения
 * 2 дня». Меньше рабочего дня — молчим: свежая задача метки не заслуживает.
 */
export function stageAge(t: CardTask, stage: string | undefined, columnName: string, now = new Date()): string | null {
  if (t.closed_at) return null;
  const inReview = t.approval_state === 'pending' || (stage && REVIEW_STAGES.includes(stage));
  const since = inReview ? (t.submitted_at ?? t.stage_since) : (t.stage_since ?? t.created_at);
  if (!since) return null;
  const n = workDays(new Date(since), now);
  if (n < 1) return null;
  if (inReview) return `Ждёт решения ${daysWord(n)}`;
  if (stage && PAUSED_STAGES.includes(stage)) return `${columnName} ${daysWord(n)}`;
  return /работ/i.test(columnName) ? `В работе ${daysWord(n)}` : `В «${columnName}» ${daysWord(n)}`;
}

/**
 * «Нет обновления 5 дней» — только по фактам: ни правок, ни сообщений, ни переносов.
 * Отсутствие комментариев само по себе не значит, что человек не работает, поэтому
 * порог — пять рабочих дней, и формулировка нейтральная.
 */
export function staleDays(t: CardTask, now = new Date()): number {
  if (t.closed_at || !t.last_activity_at) return 0;
  const n = workDays(new Date(t.last_activity_at), now);
  return n >= 5 ? n : 0;
}

/**
 * Одинаковый второстепенный тег на каждой карточке ничего не различает (#4798 §2):
 * прячем метки, которые стоят почти на всех карточках доски.
 */
export function commonLabels(tasks: { labels?: { id: string }[] }[]): Set<string> {
  const out = new Set<string>();
  if (tasks.length < 4) return out;
  const count = new Map<string, number>();
  for (const t of tasks) for (const l of t.labels ?? []) count.set(String(l.id), (count.get(String(l.id)) ?? 0) + 1);
  for (const [id, n] of count) if (n / tasks.length >= 0.9) out.add(id);
  return out;
}

/**
 * «Готово» не вываливает всю историю (#4798 §13): по умолчанию — завершённые за две
 * недели (и не больше 30), остальное — по «Показать более ранние». Ничего не удаляется.
 */
export const RECENT_DONE_DAYS = 14;
export function splitDone<T extends { closed_at?: string | null }>(tasks: T[], now = new Date()): { recent: T[]; older: T[] } {
  const edge = now.getTime() - RECENT_DONE_DAYS * 86_400_000;
  const recent: T[] = [];
  const older: T[] = [];
  for (const t of tasks) {
    // не закрыта (ждёт согласования) — всегда на виду
    if (!t.closed_at || (new Date(t.closed_at).getTime() >= edge && recent.length < 30)) recent.push(t);
    else older.push(t);
  }
  return { recent, older };
}
