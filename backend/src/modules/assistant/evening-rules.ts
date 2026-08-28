/**
 * Вечерний свод руководителю: чем закончился день в компании.
 *
 * Сегодня, чтобы узнать это, владелец обходит доски руками — а чаще не обходит вовсе
 * и узнаёт о сорванном сроке от заказчика. Все цифры у нас уже посчитаны для «Пульса
 * команды», не хватало только сказать их вслух один раз в день.
 *
 * Свод — не отчёт: в нём нет таблиц и процентов. Четыре строки о том, что изменилось
 * и где завтра будет больно.
 */

export interface EveningFacts {
  /** Закрыто за сегодня — по всей компании. */
  done: { title: string; assigneeName: string | null }[];
  /** Сдано на проверку и ждёт: самая долгая — первой. */
  review: { title: string; hours: number }[];
  /** Просрочено: сколько задач и у скольких людей. */
  overdue: { tasks: number; people: number };
  /** Сроки этой недели, которые прогноз считает несбыточными. */
  atRisk: { title: string; assigneeName: string | null }[];
}

const list = (items: { title: string }[], max = 3): string => {
  const shown = items.slice(0, max).map((i) => `«${i.title}»`).join(', ');
  return items.length > max ? `${shown} и ещё ${items.length - max}` : shown;
};

/** «5 задач у 2 человек» — с правильными окончаниями, иначе строка читается как машинная. */
function plural(n: number, one: string, few: string, many: string): string {
  const tail = n % 10;
  const teen = n % 100 >= 11 && n % 100 <= 14;
  if (!teen && tail === 1) return one;
  if (!teen && tail >= 2 && tail <= 4) return few;
  return many;
}

export function eveningText(f: EveningFacts, greeting = 'Добрый вечер'): string {
  const lines: string[] = [];

  if (f.done.length) lines.push(`Сдано за день (${f.done.length}): ${list(f.done)}`);
  if (f.review.length) {
    const oldest = Math.round(f.review[0].hours / 24);
    const tail = oldest >= 1 ? `, самая старая ждёт ${oldest} ${plural(oldest, 'день', 'дня', 'дней')}` : '';
    lines.push(`Ждёт проверки (${f.review.length})${tail}: ${list(f.review)}`);
  }
  if (f.overdue.tasks) {
    lines.push(
      `Просрочено: ${f.overdue.tasks} ${plural(f.overdue.tasks, 'задача', 'задачи', 'задач')}`
      + ` у ${f.overdue.people} ${plural(f.overdue.people, 'человека', 'человек', 'человек')}`,
    );
  }
  if (f.atRisk.length) {
    const who = f.atRisk.slice(0, 3)
      .map((t) => `«${t.title}»${t.assigneeName ? ` (${t.assigneeName})` : ''}`).join(', ');
    lines.push(`Под угрозой срыва на этой неделе (${f.atRisk.length}): ${who}`);
  }

  // День, в котором ничего не случилось, — не повод писать: молчание тоже сообщение.
  if (!lines.length) return '';
  return `${greeting}! Итоги дня:\n${lines.map((l) => `• ${l}`).join('\n')}`;
}

/** Ключ свода: один на руководителя в день, дата — местная у него. */
export function eveningKey(userId: string, localDate: string): string {
  return `evening:${userId}:${localDate}`;
}

/**
 * Пора ли подводить итоги: последний час рабочего дня.
 *
 * Раньше — рано, работа ещё идёт; после конца дня — поздно, человек закрыл ноутбук.
 * Как и сводка, считается по календарю и поясу получателя.
 */
export function isEveningTime(atMinutes: number, workEndMinutes: number): boolean {
  return atMinutes >= workEndMinutes - 60 && atMinutes < workEndMinutes;
}
