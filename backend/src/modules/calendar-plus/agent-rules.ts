/**
 * ИИ-агент календаря (#4892, п. 13): команды обычным языком. Разбор — правилами (даты
 * модель путает), на выход — намерение; план изменений строит сервис.
 *  «перенеси все мои встречи завтра после 15:00 на пятницу, мне к врачу»
 *  «найди час с Глебом на этой неделе» · «освободи мне утро четверга» · «что у меня завтра?»
 */
import { pickDay } from '../nl/event-draft';

export type DayPart = 'morning' | 'afternoon' | 'evening' | 'day';
export type AgentIntent =
  | { kind: 'summary'; day: Date }
  | { kind: 'move'; day: Date; after: number | null; before: number | null; part: DayPart | null; target: Date; targetMin: number | null; reason: string | null }
  | { kind: 'free'; day: Date; part: DayPart; reason: string | null }
  | { kind: 'find'; minutes: number; scope: 'week' | 'day'; day: Date | null; week: 'this' | 'next' | null }
  | null;

const norm = (t: string) => t.toLowerCase().replace(/ё/g, 'е');
const hm = (h: string, m?: string) => Number(h) * 60 + (m ? Number(m) : 0);

export function partOf(text: string): DayPart | null {
  const t = norm(text);
  if (/утр[оа]|до обеда|утренн/.test(t)) return 'morning';
  if (/после обеда|днем|дневн/.test(t)) return 'afternoon';
  if (/вечер/.test(t)) return 'evening';
  if (/(весь|целый) день/.test(t)) return 'day';
  return null;
}

/** Минуты от полуночи: границы части дня. */
export function partRange(p: DayPart): [number, number] {
  return p === 'morning' ? [0, 13 * 60] : p === 'afternoon' ? [13 * 60, 18 * 60] : p === 'evening' ? [17 * 60, 24 * 60] : [0, 24 * 60];
}

export function parseAgent(text: string, now: Date): AgentIntent {
  const raw = (text ?? '').trim();
  const t = norm(raw);
  if (!t) return null;
  const comma = raw.indexOf(',');
  const reason = comma > 0 ? raw.slice(comma + 1).trim().replace(/^и\s+/i, '').slice(0, 200) || null : null;
  const head = comma > 0 ? raw.slice(0, comma) : raw;
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  const aboutMeetings = /встреч|созвон|звонк|планерк|совещан|календар|расписан/.test(t);
  const dayWord = /(сегодня|завтра|послезавтра|понедельник|вторник|сред|четверг|пятниц|суббот|воскресен)/.test(t);
  if ((/^(что|какие)\s.*(у меня|встречи|в календаре|по плану)/.test(t) && (aboutMeetings || dayWord) && !/задач/.test(t))
    || /^мой день|^расписание/.test(t)) {
    return { kind: 'summary', day: pickDay(head, now) ?? today };
  }
  if (/(перенеси|перенести|сдвинь|сдвинуть|передвинь)/.test(t) && aboutMeetings) {
    // источник — до последнего «на <день>», цель — после
    const m = /^(.*)\s+на\s+([^,]+)$/i.exec(head);
    const src = m ? m[1] : head;
    const dst = m ? m[2] : '';
    const day = pickDay(src, now) ?? today;
    const target = pickDay(`в ${dst}`, now) ?? pickDay(dst, now);
    if (!target) return null;
    const after = /после\s+(\d{1,2})(?::(\d{2}))?/.exec(norm(src));
    const before = /до\s+(\d{1,2})(?::(\d{2}))?/.exec(norm(src));
    const at = /(?:^|\s)(?:в|к)\s+(\d{1,2})(?::(\d{2}))?/.exec(norm(dst));
    return {
      kind: 'move', day, target, reason,
      after: after ? hm(after[1], after[2]) : null, before: before ? hm(before[1], before[2]) : null,
      part: partOf(src), targetMin: at ? hm(at[1], at[2]) : null,
    };
  }
  if (/(освободи|освободить|разгрузи)/.test(t) && /(утро|вечер|день|после обеда|до обеда)/.test(t)) {
    return { kind: 'free', day: pickDay(head, now) ?? today, part: partOf(head) ?? 'day', reason };
  }
  if (/(найди|подбери|найти)\s.*(час|время|минут|полчаса|встреч|окно).*\sс\s/.test(t) && !/задач/.test(t)) {
    const minutes = /полчаса/.test(t) ? 30 : /полтора час/.test(t) ? 90 : (() => {
      const mm = /(\d{1,3})\s*мин/.exec(t);
      if (mm) return Number(mm[1]);
      const hh = /(\d)\s*час/.exec(t);
      return hh ? Number(hh[1]) * 60 : 60;
    })();
    // #4920: «недел» сидит и в «понедельнике» — «в понедельник» читалось как «на неделе»
    const week = /(^|[^а-я])след\S*\s+недел/.test(t) ? 'next' : /(^|[^а-я])недел/.test(t) ? 'this' : null;
    const day = week ? null : pickDay(head, now);
    return { kind: 'find', minutes, scope: day ? 'day' : 'week', day, week };
  }
  return null;
}
