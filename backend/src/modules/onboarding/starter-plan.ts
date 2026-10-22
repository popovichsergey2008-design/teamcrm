/**
 * Первый проект от Qevo-бота (#4620, «Старт», пункт 2).
 *
 * Бот задаёт три вопроса — сфера, название, один или с командой — и по ответам
 * собирает проект: имя, этапы доски и два примера задач под сферу. Всё это —
 * правилами, а не моделью: проект должен появиться за 2 секунды и одинаково
 * у всех, а не зависеть от того, есть ли у компании ключ ИИ.
 */

export type StarterSphere = 'business' | 'it' | 'services' | 'personal' | 'custom';
export const STARTER_SPHERES: StarterSphere[] = ['business', 'it', 'services', 'personal', 'custom'];

/** Этапы задач — дословно из документа: вариант А и вариант Б. */
export const SOLO_COLUMNS = ['Сделать', 'В работе', 'Готово'];
export const TEAM_COLUMNS = ['Бэклог', 'В работе', 'На проверке', 'Готово'];

/** Названия сфер — как на кнопках первого вопроса. */
const SPHERE_LABEL: Record<Exclude<StarterSphere, 'custom'>, string> = {
  business: 'Бизнес и команда',
  it: 'IT, продукт и маркетинг',
  services: 'Услуги, стройка, производство',
  personal: 'Личные дела и задачи',
};

/** Два понятных примера задач под сферу — чтобы проект сразу выглядел живым. */
const EXAMPLES: Record<StarterSphere, [string, string]> = {
  business: ['Провести планёрку и раздать задачи на неделю', 'Подготовить отчёт по продажам за месяц'],
  it: ['Собрать требования к новой функции и оценить сроки', 'Составить контент-план на месяц'],
  services: ['Согласовать с клиентом смету и сроки работ', 'Заказать материалы и проверить сроки поставки'],
  personal: ['Составить список дел на неделю', 'Записаться к врачу и оплатить счета'],
  // сказал голосом или написал своё — примеры, которые подходят к любому делу
  custom: ['Записать три главные цели проекта', 'Разбить первую цель на шаги и поставить сроки'],
};

/*
  Сфера из свободного ответа («сказал голосом» или написал текстом).

  \w в регулярных выражениях JS не видит кириллицу, поэтому окончания не пишем
  через \w — только явные основы слов. Порядок важен: «маркетинг» — это IT-кнопка,
  хотя в ответе может встретиться и «команда».
*/
const SPHERE_WORDS: [Exclude<StarterSphere, 'custom'>, RegExp][] = [
  ['it', /(?:^|[^а-яa-z])(?:it|айти|ит)(?:[^а-яa-z]|$)|разработ|программ|продукт|маркет|сайт|приложени|дизайн|smm|реклам|digital|диджитал/i],
  ['services', /(?:услуг|строй|строит|ремонт|производ|цех|завод|монтаж|объект|бригад|клиент|салон|сервис)/i],
  ['personal', /(?:личн|свои дела|для себя|дом|семь|учеб|учёб|быт)/i],
  ['business', /(?:бизнес|компан|команд|отдел|сотрудник|продаж|офис|фирм|руковод)/i],
];

export function sphereFromText(text: string | null | undefined): StarterSphere {
  const t = String(text ?? '').toLowerCase().replace(/ё/g, 'е');
  for (const [sphere, re] of SPHERE_WORDS) if (re.test(t)) return sphere;
  return 'custom';
}

/** «Один или с командой» из свободного ответа; null — не понятно, спросим кнопками. */
export function teamFromText(text: string | null | undefined): boolean | null {
  const t = String(text ?? '').toLowerCase().replace(/ё/g, 'е');
  if (/(?:команд|коллег|сотрудник|вместе|с нами|отдел|бригад|партнер)/.test(t)) return true;
  if (/(?:один|одна|сам(?:а)?(?:[^а-я]|$)|в одиночку|только я|пока я)/.test(t)) return false;
  return null;
}

export interface StarterPlan {
  name: string;
  description: string;
  columns: string[];
  examples: string[];
}

export function starterPlan(input: {
  sphere: StarterSphere; sphereText?: string | null; name: string; team: boolean;
}): StarterPlan {
  const sphere = STARTER_SPHERES.includes(input.sphere) ? input.sphere : 'custom';
  const name = String(input.name ?? '').replace(/\s+/g, ' ').trim().slice(0, 120) || 'Мой первый проект';
  const about = sphere === 'custom'
    ? String(input.sphereText ?? '').replace(/\s+/g, ' ').trim().slice(0, 300)
    : SPHERE_LABEL[sphere];
  return {
    name,
    // описание нужно определителю проекта: по нему ИИ узнаёт проект в переписке
    description: `Первый проект, собранный Qevo-ботом${about ? `: ${about}` : ''}. ${input.team ? 'Работаем с командой' : 'Пока работаю один'}.`,
    columns: input.team ? [...TEAM_COLUMNS] : [...SOLO_COLUMNS],
    examples: [...EXAMPLES[sphere]],
  };
}
