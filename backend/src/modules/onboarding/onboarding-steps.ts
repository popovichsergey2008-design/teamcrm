/**
 * Путь владельца: из чего он состоит и когда считается пройденным (ТЗ-11, разд. 7, 8, 52).
 *
 * Чистые функции без базы: это то место, где ошибка видна не как поломка, а как
 * «система считает меня новичком третью неделю» — и лечится тем, что подсказку
 * закрывают навсегда. Поэтому правила проверяются тестами, а не глазами.
 *
 * ГЛАВНОЕ РЕШЕНИЕ. Шаги считаются по ФАКТУ, а не по отметкам «выполнено». Есть проект —
 * шаг пройден, даже если человек создал его мимо подсказки. Отметки рассинхронизируются
 * с жизнью на первой же неделе, и владелец видит незавершённый путь поверх работающей
 * компании. Исключение одно — настройки компании: их можно было и не трогать, у пояса
 * есть значение по умолчанию, и «не трогал» от «оставил как есть» по данным не отличить.
 */

export type StepKey = 'workspace' | 'company' | 'departments' | 'team' | 'project' | 'task';

/** Что известно про организацию на самом деле. */
export interface OnboardingFacts {
  /** Владелец подтвердил настройки компании (пояс, отрасль, логотип). */
  companyConfirmed: boolean;
  departments: number;
  /** Людей в организации, кроме самого владельца. */
  teammates: number;
  /** Отправленных приглашений — они тоже считаются «команду позвал». */
  invites: number;
  projects: number;
  tasks: number;
}

export interface OnboardingStep {
  key: StepKey;
  title: string;
  hint: string;
  done: boolean;
  /** Человек нажал «Позже»: шаг не мешает и не мигает, но виден. */
  skipped: boolean;
  /**
   * Без него путь не завершается.
   *
   * Обязательны только пространство, проект и задача: ТЗ (разд. 52, 53) прямо требует,
   * чтобы владелец мог работать один и не упирался в приглашение команды.
   */
  required: boolean;
}

const TITLES: Record<StepKey, { title: string; hint: string; required: boolean }> = {
  workspace: {
    title: 'Создать пространство',
    hint: 'Готово — организация создана вместе с вашей учётной записью.',
    required: true,
  },
  company: {
    title: 'Настроить компанию',
    hint: 'Часовой пояс и отрасль. От пояса зависят сроки, напоминания и тихие часы.',
    required: false,
  },
  departments: {
    title: 'Создать отделы',
    hint: 'Подскажем набор под вашу отрасль — останется подтвердить.',
    required: false,
  },
  team: {
    title: 'Пригласить команду',
    hint: 'Почтой или ссылкой. Можно пропустить и работать одному.',
    required: false,
  },
  project: {
    title: 'Создать первый проект',
    hint: 'Проект — это доска с колонками, по которым движется работа.',
    required: true,
  },
  task: {
    title: 'Поставить первую задачу',
    hint: 'Вручную, голосом или командой — как удобнее.',
    required: true,
  },
};

/**
 * Собрать шаги пути.
 *
 * Пространство всегда пройдено: без организации этот код не выполняется вовсе —
 * человек ещё не вошёл.
 */
export function buildSteps(facts: OnboardingFacts, skipped: readonly string[] = []): OnboardingStep[] {
  const was = (key: StepKey) => skipped.includes(key);
  const done: Record<StepKey, boolean> = {
    workspace: true,
    company: facts.companyConfirmed,
    departments: facts.departments > 0,
    // «Команду позвал» — это и принятое приглашение, и просто отправленное: человек
    // своё действие сделал, а придёт коллега или нет, от владельца уже не зависит.
    team: facts.teammates > 0 || facts.invites > 0,
    project: facts.projects > 0,
    task: facts.tasks > 0,
  };

  return (Object.keys(TITLES) as StepKey[]).map((key) => ({
    key,
    title: TITLES[key].title,
    hint: TITLES[key].hint,
    required: TITLES[key].required,
    done: done[key],
    // Сделанный шаг не показываем отложенным: «Позже» уже не имеет значения.
    skipped: !done[key] && was(key),
  }));
}

/**
 * Путь пройден?
 *
 * Ровно по ТЗ (разд. 52): пространство, хотя бы один проект и хотя бы одна задача.
 * Отделы, настройки и приглашения не блокируют — иначе владелец-одиночка не завершит
 * онбординг никогда, а подсказка будет висеть у него вечно.
 */
export function isComplete(steps: readonly OnboardingStep[]): boolean {
  return steps.filter((s) => s.required).every((s) => s.done);
}

/** Сколько шагов сделано — для строки «3 / 6». Считаем все, а не только обязательные. */
export function progress(steps: readonly OnboardingStep[]): { done: number; total: number } {
  return { done: steps.filter((s) => s.done).length, total: steps.length };
}

/**
 * Следующий шаг, к которому стоит позвать.
 *
 * Сначала обязательные — проект и задача: без них человек не увидит от системы пользы.
 * Отложенные пропускаем: человек уже сказал «позже», и звать его туда снова — навязчиво.
 */
export function nextStep(steps: readonly OnboardingStep[]): OnboardingStep | null {
  const open = steps.filter((s) => !s.done && !s.skipped);
  return open.find((s) => s.required) ?? open[0] ?? null;
}
