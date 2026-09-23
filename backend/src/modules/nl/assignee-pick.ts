import { Skill, skillFits } from '../team/skills';

/**
 * Кому поручить задачу из быстрой команды (ТЗ-10, этап 4).
 *
 * Тот же подход, что в службе заботы (`support/support-routing.ts`): считаем очки и
 * объясняем выбор словами. Почему не тот же файл — разные входные и разный смысл
 * «загрузки»: у поддержки это одновременные разговоры и дежурство сейчас, у задач —
 * открытые задачи и недельная ёмкость. Склеивать их в одну функцию с флагами значило
 * бы получить код, который непонятен с обеих сторон.
 *
 * Главное правило: **не назначать наугад**. Нет подходящего — возвращаем null и
 * причину. Задача без исполнителя честнее, чем задача у случайного человека: первую
 * видно в «ничьих», вторую никто не заметит, пока не сорвётся срок.
 *
 * Чистая функция: проверяется тестом рядом.
 */

export interface AssigneeCandidate {
  userId: string;
  name: string;
  /** Направления человека из справочника (`user_skills`). */
  skills: string[];
  /** Сколько открытых задач уже на нём. */
  openTasks: number;
  /** Вес подбора: 0.5 «в последнюю очередь», 1 обычный, 2 «в первую». */
  weight: number;
  /** Участвует ли в проекте задачи: свой человек в проекте быстрее входит в курс. */
  inProject?: boolean;
}

export interface PickInput {
  /** Направление, которое нужно задаче. null — модель не определила. */
  skill: Skill | null;
  /** Насколько модель уверена в классификации (0..1). */
  confidence: number;
}

export interface PickResult {
  userId: string | null;
  name: string | null;
  /** Словами — это видит человек в предпросмотре. */
  reason: string;
  /** Оценки всех, кого рассматривали: по ним разбирают неудачный выбор. */
  considered: { userId: string; score: number; fits: boolean; openTasks: number }[];
}

/** Ниже этого модели не верим и никого не предлагаем (ТЗ-10, разд. 38). */
export const MIN_CONFIDENCE = 0.5;
/** Выше этого — обычная рекомендация; между — «ИИ предполагает». */
export const SURE_CONFIDENCE = 0.8;

/** Совпало направление — главный признак: остальное лишь уточняет порядок. */
const W_SKILL = 10;
/** Уже в проекте: не придётся объяснять, о чём вообще речь. */
const W_PROJECT = 3;
/** Штраф за каждую открытую задачу: ровняем очередь, а не сваливаем всё на одного. */
const W_LOAD = 1;

export function pickAssignee(input: PickInput, candidates: AssigneeCandidate[]): PickResult {
  if (input.confidence < MIN_CONFIDENCE) {
    return { userId: null, name: null, reason: 'не уверен в направлении — выберите исполнителя сами', considered: [] };
  }
  if (!candidates.length) {
    return { userId: null, name: null, reason: 'некого предложить: нет сотрудников с автоназначением', considered: [] };
  }

  const fitting = input.skill ? candidates.filter((c) => skillFits(c.skills, input.skill)) : candidates;
  if (!fitting.length) {
    return { userId: null, name: null, reason: 'нет свободного специалиста нужного направления', considered: [] };
  }

  const scored = fitting.map((c) => {
    const fits = !!input.skill && skillFits(c.skills, input.skill);
    let score = 0;
    if (fits) score += W_SKILL;
    if (c.inProject) score += W_PROJECT;
    score -= c.openTasks * W_LOAD;
    // Вес множителем, а не слагаемым: «в первую очередь» должно перевешивать
    // разницу в пару задач, но не ломать совпадение направления.
    score *= Number.isFinite(c.weight) && c.weight > 0 ? c.weight : 1;
    return { userId: String(c.userId), name: c.name, score, fits, openTasks: c.openTasks };
  });

  /*
    Порядок при равенстве задан явно — иначе выбор зависит от порядка строк в выдаче
    базы: сегодня задача уходит одному, завтра другому, и объяснить это нельзя.
  */
  scored.sort((a, b) => b.score - a.score || a.openTasks - b.openTasks || Number(a.userId) - Number(b.userId));
  const best = scored[0];

  const reason = best.fits
    ? (input.confidence >= SURE_CONFIDENCE ? 'по направлению работы' : 'похоже на его направление')
    : 'свободнее остальных';

  return {
    userId: best.userId,
    name: best.name,
    reason,
    considered: scored.map(({ userId, score, fits, openTasks }) => ({ userId, score, fits, openTasks })),
  };
}
