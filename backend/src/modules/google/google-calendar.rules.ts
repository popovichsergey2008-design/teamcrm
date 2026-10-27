import type { EventRow } from '../calendar/calendar.repository';

/**
 * Перевод встречи QEVO в событие Google и обратно — чистые функции, проверяются тестом.
 */

/** YYYY-MM-DD в поясе компании: «весь день» в Google задаётся датой, а не моментом. */
export function dateInTz(d: Date, tz: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

function addDays(ymd: string, days: number): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Тело события Google. Ссылку на созвон кладём ссылкой QEVO, а не Google Meet (§66):
 * у нас свой созвон, и в него ведёт постоянная ссылка встречи.
 */
export function googleEventBody(e: EventRow, o: { tz: string; baseUrl: string }) {
  const meetUrl = e.is_call && e.public_id ? `${o.baseUrl}/meet/${e.public_id}` : null;
  const lines = [
    e.description?.trim() || null,
    meetUrl ? `Созвон в QEVO: ${meetUrl}` : null,
    `Встреча в календаре QEVO: ${o.baseUrl}/calendar`,
  ].filter(Boolean);
  let start: Record<string, string>;
  let end: Record<string, string>;
  if (e.all_day) {
    const s = dateInTz(new Date(e.starts_at), o.tz);
    const last = dateInTz(new Date(e.ends_at), o.tz);
    // у Google дата конца — исключительная: событие на один день кончается назавтра
    start = { date: s };
    end = { date: addDays(last < s ? s : last, 1) };
  } else {
    start = { dateTime: new Date(e.starts_at).toISOString(), timeZone: o.tz };
    end = { dateTime: new Date(e.ends_at).toISOString(), timeZone: o.tz };
  }
  return {
    summary: e.title,
    description: lines.join('\n\n'),
    location: e.location || meetUrl || undefined,
    start,
    end,
    visibility: e.is_private ? 'private' : 'default',
    // метка «это наша копия» — по ней не тянем событие обратно и не двоим встречу
    extendedProperties: { private: { qevoEventId: String(e.id), qevoTenantId: String(e.tenant_id) } },
    source: { title: 'QEVO', url: `${o.baseUrl}/calendar` },
    reminders: { useDefault: true },
  };
}

export interface PulledEvent {
  uid: string; title: string; location: string | null; startsAt: Date; endsAt: Date; allDay: boolean;
}

/**
 * Событие Google → строка слоя «чужие встречи». Отменённые, «свободен» (transparent)
 * и те, от которых человек отказался, не показываем: они не занимают его время.
 */
export function pulledEvent(item: any): PulledEvent | null {
  if (!item || item.status === 'cancelled') return null;
  if (item.transparency === 'transparent') return null;
  const me = (item.attendees ?? []).find((a: any) => a.self);
  if (me?.responseStatus === 'declined') return null;
  const allDay = !!item.start?.date;
  const startsAt = new Date(allDay ? `${item.start.date}T00:00:00Z` : item.start?.dateTime);
  const endsAt = new Date(allDay ? `${item.end?.date ?? item.start.date}T00:00:00Z` : item.end?.dateTime ?? item.start?.dateTime);
  if (Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAt.getTime())) return null;
  return {
    uid: String(item.id).slice(0, 300),
    // «Занято» вместо пустоты: у приватных событий Google названия не отдаёт
    title: String(item.summary ?? 'Занято').slice(0, 300),
    location: item.location ? String(item.location).slice(0, 300) : null,
    startsAt,
    endsAt: endsAt < startsAt ? startsAt : endsAt,
    allDay,
  };
}
