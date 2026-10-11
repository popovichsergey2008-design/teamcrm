import { matchUserInText } from '../nl/nl.match';
import { splitCommand } from '../nl/split-command';
import { pickDeadline, taskTitleFrom } from '../nl/task-draft';

/**
 * Разбор фразы демо «ИИ-созвон за 30 секунд» (ТЗ-24) правилами — когда модели нет
 * (ни своего ключа, ни ключа демо) или она не ответила. Чистые функции.
 *
 * Демо говорят одной фразой: «Нужно обновить логотип к среде и созвониться с
 * маркетологом». Быстрая команда «и» разделителем не считает — там «проверить и
 * поправить форму» одно поручение. Здесь делим по «и», только если за ним идёт новое
 * действие: глагол в неопределённой форме («созвониться», «подготовить»).
 */

export interface DemoDraft {
  title: string;
  kind: 'task' | 'meeting';
  /** YYYY-MM-DD или null */
  deadline: string | null;
  /** названный человек: «дизайнер», «Глеб» */
  assigneeHint: string | null;
  /** найденный в команде сотрудник; не найден — null, людей не выдумываем (§19) */
  assigneeId: string | null;
}

const MAX_DRAFTS = 5;

/*
  Кириллица в регулярках JS не знает \b и \w — границы слов вручную (память voice-and-nl).
  «и созвониться», «, а также подготовить», «потом позвонить».
*/
const VERB = '[а-яё]+(?:ть|ться|ти|чь)(?=[\\s,.!?]|$)';
const AND_THEN = new RegExp(`\\s*,?\\s+(?:и|а\\s+также|а\\s+потом|потом|затем|ещё|еще)\\s+(?=${VERB})`, 'gi');
const LEAD = /^(?:(?:так|итак|ну|короче)[,\s]+)?(?:нам\s+|мне\s+)?(?:нужно|надо|необходимо|давай(?:те)?|хочу|хотим|планирую|планируем)\s+/i;
const WEEKDAY = '(?:понедельник|вторник|сред|четверг|пятниц|суббот|воскресень)[а-я]*';
const DEADLINE_WORDS = new RegExp(
  `\\s*(?:(?:к|до|в|во|на)\\s+${WEEKDAY}`
  + '|(?:до\\s+)?(?:сегодня|завтра|послезавтра)(?:\\s+(?:утром|вечером|днём|днем))?'
  + '|до\\s+конца\\s+(?:недели|дня|месяца)'
  + '|(?:на|к)\\s+(?:этой|следующей)\\s+неделе'
  + '|через\\s+\\S+\\s+(?:дн|недел)[а-я]*'
  + '|к\\s+\\d{1,2}(?:[.\\-/]\\d{1,2})?(?:-?(?:му|го|е))?(?:\\s+числу)?)(?=[\\s,.!?]|$)',
  'gi',
);
const MEETING = /(?:созвон|встрет|встреч|позвон|переговор|обсуд)/i;
/** «Пусть дизайнер обновит», «поручи Глебу» — кто должен сделать. */
const WHO = /^(?:пусть|поручи(?:ть)?|попроси(?:ть)?|скажи)\s+([а-яёa-z-]{2,30})[,\s]+/i;

export function splitDemoPhrase(text: string): string[] {
  const clean = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!clean) return [];
  const byCommand = splitCommand(clean);
  const parts = byCommand.length > 1 ? byCommand : [clean];
  const out: string[] = [];
  for (const p of parts) for (const q of p.split(AND_THEN)) if (q.trim().length >= 4) out.push(q.trim());
  return out.slice(0, MAX_DRAFTS);
}

/** Название без вводных слов и без срока — срок уходит в своё поле. */
export function demoTitle(part: string): string {
  let t = part.trim().replace(/[.!?]+$/, '').replace(LEAD, '').replace(WHO, '');
  t = t.replace(DEADLINE_WORDS, '').replace(/\s{2,}/g, ' ').replace(/[\s,]+$/, '').trim();
  t = taskTitleFrom(t) || t;
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : '';
}

export function extractDemoDrafts(
  text: string, now: Date, team: { id: string; full_name: string }[], meId: string,
): DemoDraft[] {
  const drafts: DemoDraft[] = [];
  for (const part of splitDemoPhrase(text)) {
    const title = demoTitle(part);
    if (title.length < 3) continue;
    const who = WHO.exec(part.replace(LEAD, ''))?.[1] ?? null;
    const named = who ? matchUserInText(who, team.map((u) => ({ id: u.id, name: u.full_name }))) : null;
    drafts.push({
      title: title.slice(0, 255),
      kind: MEETING.test(part) ? 'meeting' : 'task',
      deadline: pickDeadline(part, now),
      assigneeHint: who && !named ? who : null,
      // не назвали никого — делает тот, кто говорит (§19); назвали несуществующего — никто
      assigneeId: named ?? (who ? null : meId),
    });
  }
  return drafts;
}

/** «Вы запланировали два действия: обновить логотип и созвониться с маркетологом.» */
export function demoSummary(drafts: { title: string }[]): string {
  if (!drafts.length) return '';
  const names = drafts.map((d) => d.title.charAt(0).toLowerCase() + d.title.slice(1));
  const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} и ${names[names.length - 1]}`;
  const n = drafts.length;
  const word = n === 1 ? 'одно действие' : n < 5 ? `${['', '', 'два', 'три', 'четыре'][n]} действия` : `${n} действий`;
  return `Вы запланировали ${word}: ${list}.`;
}
