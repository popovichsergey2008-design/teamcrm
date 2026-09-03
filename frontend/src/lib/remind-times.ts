/**
 * Варианты «напомнить мне».
 *
 * Считаются на клиенте намеренно: «сегодня вечером» и «завтра утром» — это про часовой
 * пояс человека, а не сервера. Сервер получает готовый момент и проверяет только, что
 * он в будущем.
 *
 * Правила простые, но ошибаются молча: «вечером», выбранное в 23:40, не должно означать
 * «через двадцать минут», а «завтра утром» в понедельник — воскресенье.
 */

export interface RemindOption {
  key: string;
  label: string;
  at: Date;
}

/** Вечер — 18:00, утро — 09:00: рабочие ориентиры, а не астрономические. */
const EVENING_HOUR = 18;
const MORNING_HOUR = 9;

const at = (base: Date, days: number, hour: number): Date => {
  const d = new Date(base);
  d.setDate(d.getDate() + days);
  d.setHours(hour, 0, 0, 0);
  return d;
};

export function remindOptions(now = new Date()): RemindOption[] {
  const hour = now.getHours();
  const out: RemindOption[] = [
    { key: 'hour', label: 'Через час', at: new Date(now.getTime() + 3600_000) },
  ];

  // «Сегодня вечером» предлагаем, только пока вечер впереди: в 23:40 это издевательство
  if (hour < EVENING_HOUR - 1) out.push({ key: 'evening', label: 'Сегодня вечером', at: at(now, 0, EVENING_HOUR) });
  out.push({ key: 'tomorrow', label: 'Завтра утром', at: at(now, 1, MORNING_HOUR) });
  out.push({ key: 'week', label: 'Через неделю', at: at(now, 7, MORNING_HOUR) });
  return out;
}

/** Подпись выбранного времени: «завтра в 09:00» понятнее, чем дата с секундами. */
export function remindLabel(when: Date, now = new Date()): string {
  const time = when.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  const sameDay = when.toDateString() === now.toDateString();
  const tomorrow = new Date(now.getTime() + 86400000).toDateString() === when.toDateString();
  if (sameDay) return `сегодня в ${time}`;
  if (tomorrow) return `завтра в ${time}`;
  return `${when.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' })} в ${time}`;
}
