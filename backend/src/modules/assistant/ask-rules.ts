/**
 * Вопрос секретарю обычным языком: «что у нас с сайтом», «кто свободен», «что горит».
 *
 * Разбираем правилами, а не моделью, и по той же причине, что в календаре: ответ
 * состоит из цифр, которые надо не сочинить, а посчитать. Модель здесь добавила бы
 * задержку, стоимость и риск красиво изложить несуществующее.
 *
 * Спрашивают редко и коротко, поэтому важнее всего не пропустить вопрос: любой
 * непонятный текст, в котором звучит название проекта, считаем вопросом о проекте.
 */

import { matchProjectInText, NamedThing } from '../nl/task-draft';

export type AskKind = 'project' | 'who_free' | 'hot' | 'mine' | 'unknown';

export interface AskIntent {
  kind: AskKind;
  projectId: string | null;
}

const WHO_FREE = /(кто|у кого).*(свободен|свободна|свободны|не занят|меньше всего|разгруж)|кого\s+можно\s+загрузить|загрузка\s+команды/i;
const HOT = /(что|где).*(горит|срочн|сроч|просроч|срывается|под угрозой)|какие\s+риски|что\s+не\s+успеваем/i;
const MINE = /(что|чем).*(мне|у меня|я должен|моё|мои)\b|мои\s+задачи|что\s+на\s+мне/i;
const PROJECT = /(что|как).*(с|по)\s|состояние|статус|дела\s+по/i;

/**
 * О чём спросили.
 *
 * Порядок проверок — от узкого к широкому: «кто свободен» и «что горит» звучат
 * почти одинаково с вопросом о проекте, но отвечают на них разные цифры.
 * Название проекта, названное вслух, сильнее любого шаблона: если человек назвал
 * проект, он спрашивает про него, какими бы словами вопрос ни начинался.
 */
export function classifyAsk(question: string, projects: NamedThing[]): AskIntent {
  const text = String(question ?? '').trim();
  if (!text) return { kind: 'unknown', projectId: null };

  const projectId = matchProjectInText(text, projects);
  if (projectId) return { kind: 'project', projectId };

  if (WHO_FREE.test(text)) return { kind: 'who_free', projectId: null };
  if (HOT.test(text)) return { kind: 'hot', projectId: null };
  if (MINE.test(text)) return { kind: 'mine', projectId: null };
  if (PROJECT.test(text)) return { kind: 'project', projectId: null };
  return { kind: 'unknown', projectId: null };
}

export interface ProjectFacts {
  name: string;
  open: number;
  closedWeek: number;
  overdue: number;
  hours: number;
  atRisk: { title: string; assigneeName: string | null }[];
  lastMeeting: { title: string; when: Date } | null;
  topWorkers: { fullName: string; open: number }[];
}

const dateRu = (d: Date) => new Date(d).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });

/** Часы без лишней точности: «12 ч» честнее, чем «11.7 ч». */
const hoursRu = (h: number) => `${Math.round(h)} ч`;

export function projectAnswer(f: ProjectFacts): string {
  const lines = [`${f.name}: ${f.open} открытых задач, за неделю закрыто ${f.closedWeek}.`];
  if (f.overdue) lines.push(`Просрочено: ${f.overdue}.`);
  if (f.hours > 0) lines.push(`Учтено времени: ${hoursRu(f.hours)}.`);
  if (f.topWorkers.length) {
    lines.push(`Кто в работе: ${f.topWorkers.map((w) => `${w.fullName} (${w.open})`).join(', ')}.`);
  }
  if (f.atRisk.length) {
    const who = f.atRisk.slice(0, 3)
      .map((t) => `«${t.title}»${t.assigneeName ? ` — ${t.assigneeName}` : ''}`).join(', ');
    lines.push(`Под угрозой срока: ${who}.`);
  }
  if (f.lastMeeting) lines.push(`Последняя встреча по проекту: ${dateRu(f.lastMeeting.when)}, «${f.lastMeeting.title}».`);
  return lines.join('\n');
}

export interface WorkerLoad {
  fullName: string;
  open: number;
  overdue: number;
  hoursPlanned: number;
}

/**
 * Кто свободен, а кто тонет.
 *
 * Сортируем по числу открытых задач, но говорим и о просрочках: человек с двумя
 * задачами, обе из которых просрочены, «свободен» только на бумаге.
 */
export function loadAnswer(workers: WorkerLoad[]): string {
  if (!workers.length) return 'В команде пока некому раздавать работу.';
  const sorted = [...workers].sort((a, b) => a.open - b.open || a.overdue - b.overdue);
  const free = sorted.slice(0, 3).map((w) => `${w.fullName} — ${w.open} задач`
    + (w.overdue ? `, из них просрочено ${w.overdue}` : ''));
  const busiest = sorted[sorted.length - 1];
  const lines = [`Свободнее всех: ${free.join('; ')}.`];
  if (busiest && busiest.open > 0 && sorted.length > 1) {
    lines.push(`Больше всех загружен ${busiest.fullName} — ${busiest.open} задач`
      + (busiest.overdue ? `, просрочено ${busiest.overdue}` : '') + '.');
  }
  return lines.join('\n');
}

export interface HotItem {
  title: string;
  assigneeName: string | null;
  projectName: string | null;
  /** Часы просрочки; ноль — значит, ещё не сорвано, но прогноз не верит в срок. */
  overdueHours: number;
}

export function hotAnswer(items: HotItem[]): string {
  if (!items.length) return 'Ничего не горит: просроченного и рискованного сейчас нет.';
  const lines = items.slice(0, 7).map((i) => {
    const days = Math.round(i.overdueHours / 24);
    const late = i.overdueHours > 0
      ? `просрочено на ${days || 1} ${days === 1 ? 'день' : days >= 2 && days <= 4 ? 'дня' : 'дней'}`
      : 'под угрозой срока';
    return `• «${i.title}»${i.projectName ? ` (${i.projectName})` : ''} — ${late}`
      + `${i.assigneeName ? `, ${i.assigneeName}` : ', исполнителя нет'}`;
  });
  const tail = items.length > 7 ? `\nи ещё ${items.length - 7}.` : '';
  return `Горит сейчас (${items.length}):\n${lines.join('\n')}${tail}`;
}

/** Подсказка, когда вопрос не разобран: список умений короче, чем извинения. */
export function unknownAnswer(): string {
  return [
    'Не понял вопрос. Я умею отвечать про дела:',
    '• «что с проектом Сайт» — состояние проекта',
    '• «кто свободен» — загрузка команды',
    '• «что горит» — просроченное и рискованное',
    '• «что на мне» — ваши задачи',
  ].join('\n');
}
