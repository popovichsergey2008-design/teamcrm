/**
 * Контракт разбора встречи. Вывод LLM НЕ является авторитетом: всё, что не проходит
 * проверку, отбрасывается, а не «чинится» догадками. Лучше показать человеку три
 * достоверных черновика, чем десять, половина из которых выдумана.
 */

export interface MeetingTaskDraft {
  title: string;
  description: string | null;
  assigneeHint: string | null;
  deadline: string | null; // ISO-дата или null
  quote: string | null;    // цитата из стенограммы — по ней предложение проверяется
}

export interface MeetingAnalysis {
  summary: string;
  decisions: string[];
  risks: string[];
  tasks: MeetingTaskDraft[];
}

const MAX_TASKS = 20;
const str = (v: unknown, max: number): string | null => {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s ? s.slice(0, max) : null;
};
const strList = (v: unknown, max: number, limit = 15): string[] =>
  Array.isArray(v) ? v.map((x) => str(x, max)).filter((x): x is string => !!x).slice(0, limit) : [];

/** ISO-дата без времени или с ним; мусор и прошлое-«вчера» отбрасываем. */
function parseDeadline(v: unknown): string | null {
  const s = str(v, 40);
  if (!s) return null;
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T18:00:00` : s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export function validateMeetingAnalysis(raw: unknown): { value: MeetingAnalysis | null; errors: string[] } {
  const errors: string[] = [];
  if (!raw || typeof raw !== 'object') return { value: null, errors: ['ответ модели не является объектом'] };
  const o = raw as Record<string, unknown>;

  const summary = str(o.summary, 4000);
  if (!summary) errors.push('пустая сводка');

  const tasksRaw = Array.isArray(o.tasks) ? o.tasks : [];
  if (!Array.isArray(o.tasks)) errors.push('tasks отсутствует или не массив');

  const tasks: MeetingTaskDraft[] = [];
  for (const [i, t] of tasksRaw.entries()) {
    if (tasks.length >= MAX_TASKS) { errors.push(`задач больше ${MAX_TASKS} — лишние отброшены`); break; }
    if (!t || typeof t !== 'object') { errors.push(`задача #${i + 1}: не объект`); continue; }
    const rec = t as Record<string, unknown>;
    const title = str(rec.title, 255);
    if (!title) { errors.push(`задача #${i + 1}: пустой заголовок`); continue; }
    tasks.push({
      title,
      description: str(rec.description, 4000),
      assigneeHint: str(rec.assignee ?? rec.assigneeHint, 120),
      deadline: parseDeadline(rec.deadline),
      quote: str(rec.quote, 500),
    });
  }

  return {
    value: summary ? { summary, decisions: strList(o.decisions, 500), risks: strList(o.risks, 500), tasks } : null,
    errors,
  };
}

/** Инструкция парсера. Держим здесь, чтобы промпт и схема правились вместе. */
export const MEETING_PROMPT =
  'Ты разбираешь стенограмму рабочей встречи. Верни СТРОГО JSON без пояснений:\n' +
  '{"summary":"краткая сводка встречи 3-6 предложений",' +
  '"decisions":["принятое решение"],"risks":["озвученный риск или проблема"],' +
  '"tasks":[{"title":"что сделать","description":"детали","assignee":"имя исполнителя как прозвучало или null",' +
  '"deadline":"YYYY-MM-DD или null","quote":"дословная цитата из стенограммы, породившая задачу"}]}\n' +
  'Задачу добавляй ТОЛЬКО если на встрече прозвучала договорённость что-то сделать. ' +
  'Не выдумывай исполнителей и сроки: если не прозвучало — null. ' +
  'Цитата обязательна и должна дословно встречаться в стенограмме.';
