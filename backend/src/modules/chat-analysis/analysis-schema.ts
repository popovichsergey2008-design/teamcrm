import { createHash } from 'crypto';
import { durationOf, meetingDateOf } from './meeting-rules';

/**
 * Разбор ответа модели о переписке (ТЗ-12, разд. 51–53).
 *
 * Главное правило раздела 52: **идентификаторам от модели верить нельзя**. Она охотно
 * выдумывает `user_id: 42`, и задача уезжает случайному человеку. Поэтому наружу ей
 * даются не наши номера, а короткие пометки (`u3`, `p1`) из справочника, собранного под
 * этот конкретный разговор, — и обратно принимается только то, что в справочнике есть.
 * Всё остальное становится пустым полем, а не догадкой.
 *
 * Второе правило (разд. 65): наблюдение без сообщений-источников не наблюдение, а мнение.
 * Такие строки выбрасываем целиком: проверить их человеку нечем.
 *
 * Чистые функции; проверяются юнит-тестом рядом.
 */

export const ACTION_TYPES = [
  'task', 'decision', 'meeting', 'question', 'status', 'blocker', 'idea',
  // Изменение уже заведённой задачи: отменили, отдали другому, перенесли срок (этап 7).
  'change',
] as const;
export type ActionType = (typeof ACTION_TYPES)[number];

export const SOURCE_ROLES = [
  'instruction', 'context', 'acceptance', 'correction', 'cancellation', 'decision',
] as const;
export type SourceRole = (typeof SOURCE_ROLES)[number];

/** Сколько наблюдений максимум берём из одного прохода: остальное — сбой разбора. */
export const MAX_ACTIONS = 20;

export interface RefCatalog {
  /** Пометка вида `u3` → наш id сотрудника. */
  users: Map<string, string>;
  projects: Map<string, string>;
  /** Пометка `t2` → номер задачи. Только для статуса и блокера; нет — модель задач не видит. */
  tasks?: Map<string, string>;
  /** Сообщения этого отрезка: ссылаться можно только на них. */
  messageIds: Set<string>;
}

export interface ExtractedAction {
  type: ActionType;
  title: string;
  description: string;
  projectId: string | null;
  assignerId: string | null;
  assigneeId: string | null;
  /** Задача, о которой статус или блокер. Выбор модели — ещё не привязка: её решает `resolveTask`. */
  taskId: string | null;
  deadlineAt: Date | null;
  meetingAt: Date | null;
  /** Встреча: названа дата без времени — время спросим (ТЗ разд. 35). */
  meetingDate: string | null;
  durationMinutes: number | null;
  /** Кого звать. Модель их не называет: участников считаем сами по переписке. */
  participantIds: string[];
  /** Изменение: cancel | reassign | deadline. Для остальных видов пусто. */
  changeKind: string | null;
  confidence: { intent: number; project: number; assigner: number; assignee: number; task: number };
  sources: { messageId: string; role: SourceRole }[];
  dedupKey: string;
}

const str = (v: unknown, max: number): string => String(v ?? '').trim().slice(0, max);

/** Уверенность: не число или вне отрезка — считаем нулём, а не «наверное, высокая». */
const conf = (v: unknown): number => {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.round(Math.min(1, Math.max(0, n)) * 1000) / 1000;
};

/**
 * Дата из ответа модели.
 *
 * Прошедшее время не берём: срок во вчера и созвон во вчера — это не договорённость, а
 * след разговора о прошлом. Пустое поле честнее выдуманного.
 */
function when(v: unknown, now: Date): Date | null {
  const raw = String(v ?? '').trim();
  if (!raw) return null;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return null;
  return d.getTime() >= now.getTime() ? d : null;
}

/** Суть наблюдения в сравнимом виде: регистр, ё и знаки роли не играют. */
function normalized(title: string): string {
  return title.toLowerCase().replace(/ё/g, 'е').replace(/[^a-zа-я0-9]+/gi, ' ').trim();
}

/**
 * Ключ от повторной обработки (разд. 20).
 *
 * Один и тот же разговор попадёт и в затихший отрезок, и в ночную сверку. Ключ собран
 * так, чтобы это было ОДНО наблюдение: вид, суть, проект, исполнитель и сообщения, из
 * которых всё выросло. Хешируем, чтобы не тащить в индекс длинную строку.
 */
export function dedupKeyOf(a: {
  type: string; title: string; projectId: string | null; assigneeId: string | null;
  sources: { messageId: string }[];
}): string {
  const ids = a.sources.map((s) => s.messageId).sort((x, y) => (Number(x) || 0) - (Number(y) || 0));
  const line = [a.type, normalized(a.title), a.projectId ?? '', a.assigneeId ?? '', ids.join(',')].join('|');
  return createHash('sha1').update(line).digest('hex');
}


/** Откуда взялся проект наблюдения: по этому видно, догадка это или факт. */
export type ProjectGround = 'chat' | 'spoken' | 'none';

/**
 * Проект разговора — по твёрдым основаниям, а не по догадке модели (ТЗ-12, разд. 9, 68).
 *
 * Живая проверка 29.09 показала, почему это нельзя оставлять модели: в групповом чате,
 * не привязанном ни к какому проекту, она уверенно (0.9) приписала задачу первому
 * попавшемуся проекту организации. «AI не создаёт задачу в случайном проекте» — это
 * прямое требование ТЗ, и одного слова в промпте для него мало.
 *
 * Порядок из ТЗ: чат проекта сильнее всего — люди в нём говорят «надо переделать фильтр»,
 * имея в виду именно его. Дальше — название, прозвучавшее в самом разговоре. Больше
 * никаких оснований нет: пусто честнее случайного.
 */
export function resolveProject(o: {
  chatProjectId: string | null;
  spokenId: string | null;
}): { projectId: string | null; confidence: number; ground: ProjectGround } {
  if (o.chatProjectId) return { projectId: String(o.chatProjectId), confidence: 1, ground: 'chat' };
  if (o.spokenId) return { projectId: String(o.spokenId), confidence: 0.9, ground: 'spoken' };
  return { projectId: null, confidence: 0, ground: 'none' };
}

/** Ответ модели: текст с возможной обёрткой ```json. Сбой разбора — это пустой список. */
export function parseAnalysis(raw: string, cat: RefCatalog, now = new Date()): ExtractedAction[] {
  let parsed: any;
  try {
    parsed = JSON.parse(String(raw ?? '').replace(/^```json\s*|\s*```$/g, '').trim());
  } catch {
    return [];
  }
  const items = Array.isArray(parsed?.actions) ? parsed.actions : [];
  const out: ExtractedAction[] = [];

  for (const item of items.slice(0, MAX_ACTIONS)) {
    const type = String(item?.type ?? '').trim() as ActionType;
    if (!ACTION_TYPES.includes(type)) continue;

    const title = str(item?.title, 255);
    if (!title) continue;

    // Источники: только сообщения этого отрезка. Чужие и выдуманные id отбрасываем.
    const seen = new Set<string>();
    const sources: { messageId: string; role: SourceRole }[] = [];
    for (const s of Array.isArray(item?.sources) ? item.sources : []) {
      const messageId = String(s?.message_id ?? s?.messageId ?? '').trim();
      if (!cat.messageIds.has(messageId) || seen.has(messageId)) continue;
      const role = String(s?.role ?? '').trim() as SourceRole;
      seen.add(messageId);
      sources.push({ messageId, role: SOURCE_ROLES.includes(role) ? role : 'context' });
    }
    // Наблюдение, которое нечем проверить, человеку не показываем вовсе.
    if (!sources.length) continue;

    const projectId = cat.projects.get(String(item?.project_ref ?? '').trim()) ?? null;
    const assignerId = cat.users.get(String(item?.assigner_ref ?? '').trim()) ?? null;
    const assigneeId = cat.users.get(String(item?.assignee_ref ?? '').trim()) ?? null;
    const taskId = cat.tasks?.get(String(item?.task_ref ?? '').trim()) ?? null;
    const c = item?.confidence ?? {};

    const action: ExtractedAction = {
      type,
      title,
      description: str(item?.description, 4000),
      projectId,
      assignerId,
      assigneeId,
      taskId,
      deadlineAt: when(item?.deadline, now),
      meetingAt: when(item?.meeting_at, now),
      /*
        Дату сверяем со вчерашним днём по UTC, а не с сегодняшним: «сегодня» организации
        на востоке наступает раньше. Прошедшее время всё равно отсечётся, когда человек
        назовёт час.
      */
      meetingDate: type === 'meeting' && !item?.meeting_at
        ? meetingDateOf(item?.meeting_date, new Date(now.getTime() - 24 * 3600_000).toISOString().slice(0, 10))
        : null,
      durationMinutes: type === 'meeting' ? durationOf(item?.duration_minutes) : null,
      participantIds: [],
      changeKind: type === 'change' && ['cancel', 'reassign', 'deadline'].includes(String(item?.change ?? ''))
        ? String(item.change) : null,
      confidence: {
        intent: conf(c.intent), project: conf(c.project),
        assigner: conf(c.assigner), assignee: conf(c.assignee),
        // Уверенность в задаче считаем сами по основаниям, модельную не берём.
        task: 0,
      },
      sources,
      dedupKey: '',
    };
    action.dedupKey = dedupKeyOf(action);
    out.push(action);
  }
  return out;
}
