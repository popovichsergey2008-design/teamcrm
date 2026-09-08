/**
 * Ближайшие дни рождения.
 *
 * Считаем в коде, а не в SQL, ровно из-за 29 февраля: в невисокосный год такой даты
 * не существует, и `make_date(год, 2, 29)` роняет весь запрос — правая колонка
 * новостей исчезла бы у всей компании из-за одного сотрудника. Здесь такой человек
 * поздравляется 28 февраля, и это видно глазами, а не выясняется в проде.
 *
 * Год рождения не используем нигде: возраст — не наше дело, нужен только день.
 */

export interface BirthdayRow {
  id: string;
  full_name: string;
  avatar_file_id: string | null;
  /** Дата рождения: важны только месяц и день. */
  birth_date: string | Date;
}

export interface Birthday {
  userId: string;
  fullName: string;
  avatarUrl: string | null;
  /** Ближайшая дата поздравления, YYYY-MM-DD. */
  date: string;
  /** Через сколько дней: 0 — сегодня, 1 — завтра. */
  inDays: number;
}

const DAY = 86_400_000;

/** Полночь UTC для дня — считать «через сколько дней» иначе мешает время суток. */
const dayStart = (d: Date) => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());

const isLeap = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;

const iso = (y: number, m: number, d: number) =>
  `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

/**
 * Кого поздравлять в ближайшие `days` дней, по возрастанию даты.
 *
 * `today` приходит аргументом, а не берётся из часов: иначе такую функцию нельзя
 * проверить, не подкручивая время машины.
 */
export function upcomingBirthdays(rows: BirthdayRow[], today: Date, days = 30, limit = 5): Birthday[] {
  const from = dayStart(today);
  const out: Birthday[] = [];

  for (const r of rows) {
    const raw = typeof r.birth_date === 'string' ? new Date(`${r.birth_date.slice(0, 10)}T00:00:00Z`) : r.birth_date;
    if (!raw || Number.isNaN(raw.getTime())) continue;
    const month = raw.getUTCMonth() + 1;
    const day = raw.getUTCDate();

    // Ближайшее празднование: в этом году, а если оно уже прошло — в следующем.
    for (const year of [today.getUTCFullYear(), today.getUTCFullYear() + 1]) {
      // 29 февраля в невисокосный год отмечаем 28-го: пропустить человека совсем хуже.
      const realDay = month === 2 && day === 29 && !isLeap(year) ? 28 : day;
      const at = Date.UTC(year, month - 1, realDay);
      if (at < from) continue;
      const inDays = Math.round((at - from) / DAY);
      if (inDays > days) break;
      out.push({
        userId: String(r.id),
        fullName: r.full_name,
        avatarUrl: r.avatar_file_id ? `/api/files/${r.avatar_file_id}` : null,
        date: iso(year, month, realDay),
        inDays,
      });
      break;
    }
  }

  return out.sort((a, b) => a.inDays - b.inDays || a.fullName.localeCompare(b.fullName, 'ru')).slice(0, limit);
}
