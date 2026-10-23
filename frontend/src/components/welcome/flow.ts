import type { Sphere } from './phrase';

/**
 * Шаги Qevo-бота (#4632): «Назад», «Вперёд», «шаг N из M» — чистой логикой, чтобы
 * проверять её без браузера (scripts/logic-check.mjs).
 *
 * Главное правило: проект один. Вернулся и поменял название или «один / с командой» —
 * при уходе с третьего шага проект ПРАВИТСЯ (ручка та же, с projectId), а не
 * создаётся второй. Ответы при этом не теряются: «Вперёд» ведёт по уже данным.
 */
// #4615, 23.10: после «Данные о проекте» — «Кто руководит направлениями?» (можно пропустить)
export const STEPS = ['sphere', 'name', 'team', 'info', 'leads', 'task', 'ask'] as const;
export type StepKey = (typeof STEPS)[number];
export const TOTAL = STEPS.length;
/** Номер шага (1…TOTAL) по ключу. */
export const at = (k: StepKey): number => STEPS.indexOf(k) + 1;

export interface Starter { projectId: string; name: string; columns: { id: string; name: string }[]; taskIds: string[] }
export interface Answers { sphere: Sphere | null; sphereText?: string; name: string; team: boolean | null }

/** Что сохраняется в ui_prefs.welcome.bot — переживает переход по разделам и перезагрузку. */
export interface BotState extends Answers {
  v: 1;
  /** 1…TOTAL */
  step: number;
  project: Starter | null;
  /** С какими ответами собран проект: отличаются — проект надо поправить. */
  built: Answers | null;
  /** Первая задача поставлена. */
  task: string | null;
  /** Шаг «Данные о проекте»: человек ушёл заполнять — бот свёрнут и ждёт «Готово, дальше». */
  filling: boolean;
  mini: boolean;
  /** Раскладка шагов: 2 — с шагом «Кто руководит направлениями» (сохранённые раньше сдвигаем). */
  lv?: number;
}

export const initial = (): BotState => ({
  v: 1, step: 1, sphere: null, name: '', team: null, project: null, built: null, task: null, filling: false, mini: false, lv: 2,
});

export const keyOf = (s: BotState): StepKey => STEPS[Math.min(Math.max(s.step, 1), TOTAL) - 1];

/** Ответ на шаг уже есть — можно идти «Вперёд», не отвечая заново. */
export function answered(s: BotState, step = s.step): boolean {
  switch (STEPS[step - 1]) {
    case 'sphere': return s.sphere !== null;
    case 'name': return s.name.trim().length > 0;
    case 'team': return s.team !== null;
    case 'info': case 'leads': return s.project !== null;
    case 'task': return s.task !== null;
    default: return false;
  }
}

export const canBack = (s: BotState): boolean => s.step > 1;
/** Вперёд — только по отвеченному; с шага «Данные о проекте» — всегда («Сделаю потом»). */
export const canForward = (s: BotState): boolean => s.step < TOTAL && answered(s);

export function back(s: BotState): BotState {
  return canBack(s) ? { ...s, step: s.step - 1, filling: false } : s;
}

const same = (a: Answers, b: Answers) => a.sphere === b.sphere && (a.sphereText ?? '') === (b.sphereText ?? '')
  && a.name.trim() === b.name.trim() && a.team === b.team;

/**
 * Что сделать с проектом при уходе с шага «один / с командой»:
 * нет проекта — создать; ответы поменялись — поправить тот же; иначе — ничего.
 */
export function sync(s: BotState): 'create' | 'update' | null {
  if (!s.project) return 'create';
  return s.built && same(s.built, s) ? null : 'update';
}

/** Тело запроса POST /onboarding/starter: projectId есть — сервер правит, а не создаёт. */
export function starterBody(s: BotState) {
  return {
    sphere: s.sphere ?? 'custom', sphereText: s.sphereText, name: s.name.trim(), team: !!s.team,
    ...(s.project ? { projectId: s.project.projectId } : {}),
  };
}

/** Проект собран (или поправлен) — запоминаем, с какими ответами, и идём к данным о проекте. */
export function built(s: BotState, p: Starter): BotState {
  const answers: Answers = { sphere: s.sphere, sphereText: s.sphereText, name: s.name, team: s.team };
  // при правке сервер примеры не заводит заново: id примеров — от первого создания
  const project = s.project ? { ...p, taskIds: s.project.taskIds } : p;
  return { ...s, project, built: answers, step: 4 };
}

/** Сохранённое в ui_prefs: только узнаваемое, иначе — с начала. */
export function restore(raw: unknown): BotState | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Partial<BotState>;
  if (r.v !== 1 || typeof r.step !== 'number' || r.step < 1 || r.step > TOTAL) return null;
  const s = { ...initial(), lv: undefined, ...r } as BotState;
  // сохранено до шага «Кто руководит направлениями»: «задача» и «вопросы» сдвинулись на один
  if (s.lv !== 2) { if (s.step >= at('leads')) s.step = Math.min(TOTAL, s.step + 1); s.lv = 2; }
  // без проекта дальше третьего шага не уйти — значит, сохранение недописано
  if (s.step > 3 && !s.project) s.step = 3;
  return s;
}
