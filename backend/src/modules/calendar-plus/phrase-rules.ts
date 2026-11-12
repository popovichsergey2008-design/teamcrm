/**
 * Событие одной фразой (#4892, п. 3): то, чего не умеет общий разбор встречи.
 *
 * «в пятницу после обеда», «каждый вторник в 10», «на полчаса», «30 мин», «про CRM».
 * Общий разбор (nl/event-draft) считает день, час и людей; здесь — части дня без
 * часа, повтор, длительность без «на» и тема. Всё правилами: модель в датах ошибается.
 */
import { buildEventDraft, EventContextUser, parseLocalInput, pickDay, pickDuration, pickTime, toLocalInput } from '../nl/event-draft';

export type RepeatFreq = 'daily' | 'weekdays' | 'weekly' | 'biweekly' | 'monthly';

export interface PhraseDraft {
  title: string;
  topic: string | null;
  startsAt: string | null; // местное YYYY-MM-DDTHH:mm
  endsAt: string | null;
  allDay: boolean;
  location: string | null;
  participantIds: string[];
  repeat: RepeatFreq | null;
  /** Час не назван — время подставлено (начало дня или часть дня). */
  timeGuessed: boolean;
}

const LETTER = '[а-яa-z0-9]';
const word = (body: string) => new RegExp(`(?<!${LETTER})(?:${body})(?!${LETTER})`, 'i');
const norm = (t: string) => t.toLowerCase().replace(/ё/g, 'е');

/** Часть дня без часа: «после обеда» — 14:00 (или конец обеда человека), «утром» — 10:00. */
export function dayPart(text: string, lunchEnd?: string | null): { hour: number; minute: number } | null {
  const t = norm(text);
  if (word('после\\s+обеда').test(t)) {
    const [h, m] = String(lunchEnd ?? '14:00').split(':').map(Number);
    return { hour: Number.isFinite(h) ? h : 14, minute: Number.isFinite(m) ? m : 0 };
  }
  if (word('до\\s+обеда|утром|с\\s+утра').test(t)) return { hour: 10, minute: 0 };
  if (word('в\\s+обед').test(t)) return { hour: 13, minute: 0 };
  if (word('вечером|ближе\\s+к\\s+вечеру').test(t)) return { hour: 17, minute: 0 };
  if (word('днем').test(t)) return { hour: 14, minute: 0 };
  return null;
}

/** Повтор: «каждый вторник», «каждый день», «по будням», «раз в две недели», «каждый месяц». */
export function pickRepeat(text: string): RepeatFreq | null {
  const t = norm(text);
  if (word('по\\s+будням|каждый\\s+будний\\s+день|по\\s+рабочим\\s+дням').test(t)) return 'weekdays';
  if (word('каждый\\s+день|ежедневно').test(t)) return 'daily';
  if (word('каждые\\s+(?:две|2)\\s+недели|раз\\s+в\\s+(?:две|2)\\s+недели').test(t)) return 'biweekly';
  if (word('каждый\\s+месяц|ежемесячно|раз\\s+в\\s+месяц').test(t)) return 'monthly';
  if (word('кажд(?:ый|ую|ое)\\s+(?:понедельник|вторник|среду|четверг|пятницу|субботу|воскресенье|неделю)|еженедельно|раз\\s+в\\s+неделю|по\\s+(?:понедельникам|вторникам|средам|четвергам|пятницам)').test(t)) return 'weekly';
  return null;
}

/** «30 мин», «45 минут», «полчаса», «1,5 часа» — и без «на». */
export function durationAnywhere(text: string): number | null {
  const named = pickDuration(text);
  if (named) return named;
  const t = norm(text);
  if (word('полчаса').test(t)) return 30;
  if (word('полтора\\s+часа').test(t)) return 90;
  const m = /(?<![\d:])(\d{1,3})\s*(?:мин|минут|минуты)(?![а-я])/.exec(t);
  if (m && Number(m[1]) >= 5) return Number(m[1]);
  const h = /(?<![\d:])(\d)(?:[.,](\d))?\s*(?:ч|час|часа|часов)(?![а-я])/.exec(t);
  if (h && !/(?:в|к)\s+\d/.test(t.slice(Math.max(0, h.index - 3), h.index + 1))) return Math.round((Number(h[1]) + (h[2] ? Number(h[2]) / 10 : 0)) * 60);
  return null;
}

/** Тема — после «про / по поводу / насчёт / по», до запятой или времени. */
export function pickTopic(text: string): string | null {
  const m = /(?:^|\s)(?:про|по поводу|насчет|насчёт|на тему|обсудить)\s+([^,.;!?]+)/i.exec(text);
  if (!m) return null;
  const cut = m[1]
    .replace(/\s+(?:завтра|сегодня|послезавтра|в\s+\d.*|на\s+\d.*|на\s+полчаса.*|на\s+час.*|каждый.*|каждую.*|с\s+[А-ЯЁA-Z][^\s]*.*|\d{1,2}[.\s/]+(?:\d{1,2}|января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря).*|в\s+(?:понедельник|вторник|среду|четверг|пятницу|субботу|воскресенье).*)$/i, '')
    .trim();
  return cut ? cut.slice(0, 120) : null;
}

const KIND = /(созвон|встреч[ауи]|звонок|планерк[ау]|планёрк[ау]|обсуждение|демо|ретро|синк|1:1)/i;

function titleOf(text: string, topic: string | null, fallback: string): string {
  const k = KIND.exec(text)?.[1]?.toLowerCase().replace('ё', 'е') ?? null;
  const kind = !k ? null : k.startsWith('встреч') ? 'Встреча' : k.startsWith('планерк') ? 'Планёрка' : k === '1:1' ? '1:1' : k[0].toUpperCase() + k.slice(1);
  if (topic) return `${kind ?? 'Встреча'}: ${topic}`.slice(0, 255);
  return fallback;
}

export function phraseDraft(text: string, now: Date, users: EventContextUser[], opts: { lunchEnd?: string | null; workStart?: string | null; model?: Record<string, unknown> | null } = {}): PhraseDraft {
  const base = buildEventDraft(text, now, users, opts.model ?? null);
  const topic = pickTopic(text);
  const repeat = pickRepeat(text);
  const explicit = pickTime(text);
  const part = explicit ? null : dayPart(text, opts.lunchEnd);
  const day = pickDay(text, now);
  const minutes = durationAnywhere(text) ?? 60;
  let start = parseLocalInput(base.startsAt);
  let timeGuessed = !explicit;
  if (!start && (part || repeat)) {
    // повтор без дня («каждый день в 10») — с ближайшего подходящего
    start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  }
  if (start && !base.allDay) {
    if (part) { start.setHours(part.hour, part.minute, 0, 0); timeGuessed = false; }
    else if (!explicit && opts.workStart) {
      const [h, m] = opts.workStart.split(':').map(Number);
      start.setHours(h || 10, m || 0, 0, 0);
    }
    if (!day && start.getTime() < now.getTime()) start.setDate(start.getDate() + 1);
  }
  const startsAt = start ? toLocalInput(start) : null;
  const endsAt = start ? (base.allDay ? base.endsAt : toLocalInput(new Date(start.getTime() + minutes * 60_000))) : null;
  return {
    title: titleOf(text, topic, base.title),
    topic,
    startsAt, endsAt,
    allDay: base.allDay,
    location: base.location,
    participantIds: base.participantIds,
    repeat,
    timeGuessed: !!start && timeGuessed && !base.allDay,
  };
}
