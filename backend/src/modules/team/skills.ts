/**
 * Справочник направлений и отделов для автораспределения задач (ТЗ-10, этап 3).
 *
 * Список закрытый и короткий намеренно. Свободный ввод здесь выглядит гибче, но
 * ломает главное: этот же список уходит в промпт как допустимые значения, и модель
 * должна выбирать ИЗ него, а не изобретать «fullstack-разработчик middle+». Что
 * человек называет «Разработчик» в должности — его дело; для подбора нужен признак,
 * который у всех означает одно и то же.
 *
 * Чистый модуль без зависимостей: одни и те же значения нужны и серверу, и промпту,
 * и проверкам.
 */

export const SKILLS = ['backend', 'frontend', 'fullstack', 'content', 'design', 'qa', 'analytics', 'other'] as const;
export type Skill = (typeof SKILLS)[number];

/** Отдел — то, что видит человек в предпросмотре; направления внутри него. */
export const DEPARTMENTS = ['development', 'content', 'unknown'] as const;
export type Department = (typeof DEPARTMENTS)[number];

export const SKILL_LABEL: Record<Skill, string> = {
  backend: 'Бэкенд',
  frontend: 'Фронтенд',
  fullstack: 'Фулстек',
  content: 'Контент',
  design: 'Дизайн',
  qa: 'Тестирование',
  analytics: 'Аналитика',
  other: 'Другое',
};

export const DEPARTMENT_LABEL: Record<Department, string> = {
  development: 'Программирование',
  content: 'Контент',
  unknown: 'Не определён',
};

/** Какие направления относятся к отделу: этим же списком ограничен выбор исполнителя. */
export const DEPARTMENT_SKILLS: Record<Department, Skill[]> = {
  development: ['backend', 'frontend', 'fullstack', 'qa'],
  content: ['content', 'design', 'analytics'],
  unknown: [...SKILLS],
};

export function isSkill(value: unknown): value is Skill {
  return typeof value === 'string' && (SKILLS as readonly string[]).includes(value);
}

export function isDepartment(value: unknown): value is Department {
  return typeof value === 'string' && (DEPARTMENTS as readonly string[]).includes(value);
}

/**
 * Подходит ли человек под нужное направление.
 *
 * Фулстек закрывает и бэкенд, и фронтенд — иначе на команду из двух фулстеков
 * подобрать некого. Обратное неверно: бэкендер не берёт фронтовую задачу, пока его
 * об этом не попросят руками.
 */
export function skillFits(userSkills: readonly string[], needed: Skill | null): boolean {
  if (!needed) return true;
  if (userSkills.includes(needed)) return true;
  if (userSkills.includes('fullstack') && (needed === 'backend' || needed === 'frontend')) return true;
  return false;
}

/** Справочник для промпта: отделы, их направления и русские названия — одним куском. */
export function skillsCatalog() {
  return {
    departments: DEPARTMENTS.filter((d) => d !== 'unknown').map((code) => ({
      code,
      name: DEPARTMENT_LABEL[code],
      specializations: DEPARTMENT_SKILLS[code],
    })),
    labels: SKILL_LABEL,
  };
}
