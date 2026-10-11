/**
 * Контракт разбора встречи. Вывод LLM НЕ является авторитетом: всё, что не проходит
 * проверку, отбрасывается, а не «чинится» догадками. Лучше показать человеку три
 * достоверных черновика, чем десять, половина из которых выдумана.
 */

export interface MeetingTaskDraft {
  title: string;
  description: string | null;
  assigneeHint: string | null;
  /** Кто поручил — на встрече это не всегда тот, кто потом нажмёт «создать». */
  authorHint: string | null;
  /** Проект и колонка, названные вслух: «в проект Аэрос, в колонку Тексты». */
  projectHint: string | null;
  columnHint: string | null;
  deadline: string | null; // ISO-дата или null
  quote: string | null;    // цитата из стенограммы — по ней предложение проверяется
  /** Секунда записи, где прозвучало поручение (ТЗ-22): «Источник: 31:14». */
  sec: number | null;
  /** Насколько модель уверена в исполнителе: high — назван прямо, low — догадка. */
  confidence: 'high' | 'medium' | 'low' | null;
  /** Прозвучало «срочно», «сегодня», «горит». */
  urgent: boolean;
}

/** Решение или вопрос встречи — с секундой записи, где это прозвучало. */
export interface SourcedText {
  text: string;
  sec: number | null;
}

export interface MeetingAnalysis {
  summary: string;
  decisions: SourcedText[];
  risks: string[];
  /** Открытые вопросы (ТЗ-22): не решили, нужно уточнить. Отдельно от рисков. */
  questions: SourcedText[];
  tasks: MeetingTaskDraft[];
}

const MAX_TASKS = 20;
const str = (v: unknown, max: number): string | null => {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s ? s.slice(0, max) : null;
};
export const strList = (v: unknown, max: number, limit = 15): string[] =>
  Array.isArray(v) ? v.map((x) => str(x, max)).filter((x): x is string => !!x).slice(0, limit) : [];

/**
 * Метка времени из стенограммы: «31:14», «1:02:05», «[12:03]» или число секунд.
 * Модель ссылается на метки, которые видит у реплик; чужое и мусор — null.
 */
export function parseStamp(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) && v >= 0 ? Math.round(v) : null;
  if (typeof v !== 'string') return null;
  const m = /^\[?\s*(?:(\d{1,2}):)?(\d{1,3}):(\d{2})\s*\]?$/.exec(v.trim());
  if (!m) return null;
  const sec = (Number(m[1] ?? 0) * 3600) + Number(m[2]) * 60 + Number(m[3]);
  return Number(m[3]) < 60 ? sec : null;
}

/** Строка или {text, at} → текст с секундой. Старый формат (просто строка) тоже принимаем. */
function sourcedList(v: unknown, max: number, limit = 15): SourcedText[] {
  if (!Array.isArray(v)) return [];
  const out: SourcedText[] = [];
  for (const x of v) {
    const rec = x && typeof x === 'object' ? x as Record<string, unknown> : null;
    const text = str(rec ? rec.text : x, max);
    if (!text) continue;
    out.push({ text, sec: rec ? parseStamp(rec.at ?? rec.sec) : null });
    if (out.length >= limit) break;
  }
  return out;
}

const CONFIDENCE = new Set(['high', 'medium', 'low']);

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
      authorHint: str(rec.author ?? rec.authorHint, 120),
      projectHint: str(rec.project ?? rec.projectHint, 120),
      columnHint: str(rec.column ?? rec.columnHint, 120),
      deadline: parseDeadline(rec.deadline),
      quote: str(rec.quote, 500),
      sec: parseStamp(rec.at ?? rec.sec),
      confidence: CONFIDENCE.has(String(rec.confidence)) ? rec.confidence as 'high' | 'medium' | 'low' : null,
      urgent: rec.urgent === true,
    });
  }

  return {
    value: summary ? {
      summary, decisions: sourcedList(o.decisions, 500), risks: strList(o.risks, 500),
      questions: sourcedList(o.questions, 500), tasks,
    } : null,
    errors,
  };
}

/** Инструкция парсера. Держим здесь, чтобы промпт и схема правились вместе. */
export const MEETING_PROMPT =
  'Ты разбираешь стенограмму рабочей встречи. Верни СТРОГО JSON без пояснений:\n' +
  '{"summary":"краткая сводка встречи 3-7 предложений: о чём говорили, что решили, что изменилось, что важно помнить",' +
  '"decisions":[{"text":"принятое решение","at":"мм:сс"}],"risks":["озвученный риск или проблема"],' +
  '"questions":[{"text":"вопрос, который не решили или нужно уточнить","at":"мм:сс"}],' +
  '"tasks":[{"title":"что сделать","description":"детали","assignee":"имя исполнителя или null",' +
  '"author":"кто поручил или null","project":"проект или null","column":"колонка или null",' +
  '"deadline":"YYYY-MM-DD или null","urgent":false,"confidence":"high|medium|low",' +
  '"at":"мм:сс","quote":"дословная цитата из стенограммы, породившая задачу"}]}\n' +
  // Источник у каждого пункта (ТЗ-22): человек проверяет решение, переходя к секунде записи.
  'В "at" пиши метку реплики [мм:сс] из стенограммы, где это прозвучало. Не нашёл — null.\n' +
  'confidence — насколько уверен в исполнителе: high — назван прямо, medium — понятно по контексту, low — догадка. ' +
  'urgent — true, только если прозвучало «срочно», «сегодня», «горит».\n' +
  'Решение — то, о чём договорились. Открытый вопрос — что обсуждали, но не решили, или что нужно уточнить; ' +
  'решённое в вопросы не пиши.\n' +
  // Раньше задачи терялись: сказанного «ставим задачу на Юру» модель не считала
  // договорённостью, а имя в стенограмме звучало искажённо.
  'Задача — это всё, что на встрече поручили сделать: «поставим задачу», «сделай», ' +
  '«надо подготовить», «займись». Согласия исполнителя не требуется — поручение уже задача. ' +
  'Обсуждение без поручения задачей не считается.\n' +
  'В начале сообщения дан список сотрудников. В assignee пиши ПОЛНОЕ имя из этого списка, ' +
  'даже если в речи прозвучало сокращённое или искажённое: «Юра», «Юре», «Юрий» — это Юрий из списка. ' +
  'Если сопоставить не с кем — null, выдумывать людей нельзя.\n' +
  'Стенограмма распознана автоматически и содержит ошибки: восстанавливай смысл по контексту, ' +
  'а не по буквальному звучанию. Сводка описывает содержание разговора, а не сам факт записи.\n' +
  'Поручил тот, кто произнёс поручение, — смотри имя говорящего в стенограмме. ' +
  'Не путай его с исполнителем: «Константин: ставь задачу на Юру» — поручил Константин, исполнитель Юрий.\n' +
  'Перед стенограммой дан список проектов с их колонками. Если проект или колонка названы вслух — ' +
  'верни их точные названия из списка. Колонка принадлежит выбранному проекту. Не угадывай: не прозвучало — null.\n' +
  'Сроки не выдумывай: не прозвучал — null. Относительные сроки («до пятницы», «завтра») считай от даты встречи, ' +
  'она дана в начале сообщения. ' +
  'Цитата обязательна и берётся из стенограммы как есть, даже с ошибками распознавания.';

/**
 * Быстрое «Кратко» (ТЗ-22): отдельным коротким вызовом, параллельно с полным разбором —
 * чтобы первый полезный блок на экране итогов появился за секунды, а не после всего.
 */
export const SUMMARY_PROMPT =
  'Ты пишешь краткие итоги рабочей встречи по стенограмме. 3–7 предложений простым русским ' +
  'языком: о чём говорили, что решили, что изменилось, что важно помнить. Без вступлений, ' +
  'без списков и без пересказа самого факта записи — только содержание. Стенограмма распознана ' +
  'автоматически и содержит ошибки: восстанавливай смысл по контексту. Верни только текст.';
