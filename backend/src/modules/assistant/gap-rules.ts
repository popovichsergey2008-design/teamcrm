/**
 * Дыры в данных: задача без исполнителя и задача без срока.
 *
 * Главная поломка в живой базе — не просрочки, а пустые поля: 45 открытых задач
 * из 61 без срока и 25 без исполнителя. Из-за них молчит не только секретарь —
 * не работают ни светофор рисков, ни расчёт загрузки, ни планирование. Жаловаться
 * на это бесполезно: заполнять полсотни полей руками никто не сядет.
 *
 * Поэтому здесь не проверка «поле пустое», а готовый ответ: кого поставить и на когда,
 * с причиной, которую можно оспорить одним взглядом. Решение остаётся за человеком,
 * но его работа сводится к «да» или «не этого».
 */

export interface Worker {
  userId: string;
  fullName: string;
  /** Сколько задач этого проекта человек уже довёл до конца. */
  doneInProject: number;
  /** Сколько открытых задач на нём сейчас — по всей компании. */
  openTasks: number;
}

export interface AssigneeSuggestion {
  userId: string;
  fullName: string;
  reason: string;
}

/**
 * Кого поставить исполнителем.
 *
 * Первый признак — кто уже возил этот проект: человек в контексте сделает быстрее
 * и спросит меньше. При равном опыте берём того, у кого меньше открытых задач:
 * назначать шестую задачу тому, кто уже тонет, — способ сорвать все шесть.
 *
 * Когда в проекте не работал никто, честнее предложить самого свободного и прямо
 * сказать, что выбор сделан по загрузке, а не по опыту.
 */
export function pickAssignee(workers: Worker[]): AssigneeSuggestion | null {
  if (!workers.length) return null;

  const experienced = workers.filter((w) => w.doneInProject > 0);
  const pool = experienced.length ? experienced : workers;
  const best = [...pool].sort((a, b) => (
    b.doneInProject - a.doneInProject || a.openTasks - b.openTasks || a.userId.localeCompare(b.userId)
  ))[0];

  const reason = best.doneInProject > 0
    ? `больше всех работал в этом проекте (${best.doneInProject})`
    : `сейчас свободнее остальных (${best.openTasks} задач в работе)`;
  return { userId: best.userId, fullName: best.fullName, reason };
}

export interface DeadlineSuggestion {
  date: string;
  reason: string;
}

const pad = (n: number) => String(n).padStart(2, '0');
const asDate = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** Рабочий день: срок в субботу — это срок в понедельник, только с обманом себя. */
function addWorkdays(from: Date, days: number, weekendDays: number[]): Date {
  const d = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  let left = Math.max(1, Math.round(days));
  while (left > 0) {
    d.setDate(d.getDate() + 1);
    if (!weekendDays.includes(d.getDay())) left--;
  }
  return d;
}

/**
 * На когда ставить срок.
 *
 * По убыванию честности: собственная оценка задачи в часах; типичный срок задач
 * этого проекта; конец недели. Последнее — не выдумка, а признание: срока нет,
 * но задача без даты выпадает из всех расчётов, и лучше поставить ближний
 * и пересмотреть, чем не ставить вовсе.
 */
export function suggestDeadline(o: {
  estimateHours: number | null;
  medianDays: number | null;
  now: Date;
  weekendDays: number[];
  /** Часов работы в дне: восемь — не догма, но ближе к правде, чем любая другая цифра. */
  hoursPerDay?: number;
}): DeadlineSuggestion {
  const perDay = o.hoursPerDay ?? 8;

  if (o.estimateHours && o.estimateHours > 0) {
    const days = Math.ceil(o.estimateHours / perDay);
    return {
      date: asDate(addWorkdays(o.now, days, o.weekendDays)),
      reason: `по оценке в ${o.estimateHours} ч это ${days} раб. дн.`,
    };
  }
  if (o.medianDays && o.medianDays > 0) {
    const days = Math.min(30, Math.round(o.medianDays));
    return {
      date: asDate(addWorkdays(o.now, days, o.weekendDays)),
      reason: `похожие задачи проекта закрываются за ${days} дн.`,
    };
  }
  // ближайшая пятница, а если сегодня она и есть — следующая
  const friday = new Date(o.now.getFullYear(), o.now.getMonth(), o.now.getDate());
  const shift = ((5 - friday.getDay() + 7) % 7) || 7;
  friday.setDate(friday.getDate() + shift);
  return { date: asDate(friday), reason: 'срок не из чего вывести — предлагаю конец недели' };
}
