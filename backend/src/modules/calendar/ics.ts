/**
 * Сборка файла .ics (RFC 5545).
 *
 * Нужен, чтобы встреча легла в тот календарь, которым человек уже пользуется, — Google,
 * Outlook, календарь телефона. Без него приглашение остаётся только у нас, а человек
 * планирует день в другом месте и про встречу забывает.
 *
 * Формат придирчив в мелочах, и каждая мелочь ломает его молча: почтовый клиент просто
 * не покажет кнопку «Добавить в календарь», не объяснив почему. Поэтому здесь:
 * переводы строк только CRLF, длинные строки складываются по 75 октетов, спецсимволы
 * экранируются, время — в UTC с суффиксом Z.
 */

export interface IcsEvent {
  uid: string;
  title: string;
  description?: string | null;
  location?: string | null;
  startsAt: Date | string;
  endsAt: Date | string;
  allDay?: boolean;
  organizer?: { name?: string | null; email?: string | null } | null;
  attendees?: { name?: string | null; email?: string | null }[];
  /** REQUEST — приглашение, CANCEL — отмена встречи. */
  method?: 'REQUEST' | 'CANCEL' | 'PUBLISH';
  /** Номер правки: клиенты обновляют встречу, только если он вырос. */
  sequence?: number;
  /** Напоминания за N минут — как VALARM внутри события. */
  reminders?: number[];
}

const pad = (n: number) => String(n).padStart(2, '0');

/** Дата-время в UTC: 20260825T090000Z. Локальные значения тут запрещены — часовые пояса разные. */
function stamp(value: Date | string): string {
  const d = value instanceof Date ? value : new Date(value);
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T`
    + `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
}

/** Дата без времени для событий «весь день»: 20260825. */
function dateOnly(value: Date | string): string {
  const d = value instanceof Date ? value : new Date(value);
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
}

/**
 * Экранирование текста.
 *
 * Запятая и точка с запятой в названии встречи («Договор, правки») без экранирования
 * читаются как разделители полей — и клиент показывает обрезанное название либо
 * не показывает событие вовсе.
 */
export function escapeText(v: string): string {
  return String(v)
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

/**
 * Складывание длинных строк.
 *
 * По стандарту строка не длиннее 75 октетов; продолжение начинается с пробела. Считаем
 * именно ОКТЕТЫ, а не символы: кириллица в UTF-8 занимает два байта, и наивный подсчёт
 * по символам давал бы строки вдвое длиннее разрешённого.
 */
export function fold(line: string): string {
  const bytes = Buffer.from(line, 'utf8');
  if (bytes.length <= 75) return line;

  const out: string[] = [];
  let start = 0;
  let limit = 75;
  while (start < bytes.length) {
    let end = Math.min(start + limit, bytes.length);
    // не режем посреди многобайтового символа
    while (end > start && end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
    out.push(bytes.subarray(start, end).toString('utf8'));
    start = end;
    limit = 74; // у продолжений первый октет занят пробелом
  }
  return out.join('\r\n ');
}

/** Готовый текст .ics. */
export function buildIcs(event: IcsEvent): string {
  const method = event.method ?? 'REQUEST';
  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//TEAMCRM//Calendar//RU',
    'CALSCALE:GREGORIAN',
    `METHOD:${method}`,
    'BEGIN:VEVENT',
    `UID:${event.uid}`,
    `DTSTAMP:${stamp(new Date())}`,
    `SEQUENCE:${event.sequence ?? 0}`,
    `STATUS:${method === 'CANCEL' ? 'CANCELLED' : 'CONFIRMED'}`,
    `SUMMARY:${escapeText(event.title)}`,
  ];

  if (event.allDay) {
    // у события на весь день конец — СЛЕДУЮЩИЙ день: DTEND в стандарте не включается
    const end = new Date(event.endsAt instanceof Date ? event.endsAt : new Date(event.endsAt));
    end.setUTCDate(end.getUTCDate() + 1);
    lines.push(`DTSTART;VALUE=DATE:${dateOnly(event.startsAt)}`);
    lines.push(`DTEND;VALUE=DATE:${dateOnly(end)}`);
  } else {
    lines.push(`DTSTART:${stamp(event.startsAt)}`);
    lines.push(`DTEND:${stamp(event.endsAt)}`);
  }

  if (event.description) lines.push(`DESCRIPTION:${escapeText(event.description)}`);
  if (event.location) lines.push(`LOCATION:${escapeText(event.location)}`);
  if (event.organizer?.email) {
    const name = event.organizer.name ? `;CN=${escapeText(event.organizer.name)}` : '';
    lines.push(`ORGANIZER${name}:mailto:${event.organizer.email}`);
  }
  for (const a of event.attendees ?? []) {
    if (!a.email) continue;
    const name = a.name ? `;CN=${escapeText(a.name)}` : '';
    lines.push(`ATTENDEE${name};ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:${a.email}`);
  }

  for (const minutes of event.reminders ?? []) {
    lines.push(
      'BEGIN:VALARM',
      'ACTION:DISPLAY',
      `DESCRIPTION:${escapeText(event.title)}`,
      // отрицательное смещение = «до начала»; нулевое пишем как PT0M, иначе клиенты спорят
      `TRIGGER:-PT${Math.max(0, Math.round(minutes))}M`,
      'END:VALARM',
    );
  }

  lines.push('END:VEVENT', 'END:VCALENDAR');
  return lines.map(fold).join('\r\n') + '\r\n';
}

/** Стабильный идентификатор встречи: по нему внешний календарь понимает правку и отмену. */
export function icsUid(tenantId: string, eventId: string, host = 'teamsmrt.com'): string {
  return `teamcrm-${tenantId}-${eventId}@${host}`;
}
