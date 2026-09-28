/**
 * Отрасли и отделы, которые предлагаются при первой настройке компании (ТЗ-11, разд. 20–22).
 *
 * Зачем список отраслей, а не один набор отделов. «Продажи, маркетинг, разработка»
 * подходит ИТ-компании и выглядит чужим у строителей и в клинике. Спросив одно — чем
 * занимается компания, — можно предложить структуру, которую владельцу останется
 * подтвердить, а не придумывать с нуля.
 *
 * Отрасли отобраны по тому, как часто такие компании вообще заводят таск-менеджер: это
 * не справочник ОКВЭД, а короткий список, в котором человек узнаёт себя с первого
 * взгляда. Не нашёл себя — «Другое» даёт набор, который есть почти везде.
 *
 * `common: true` — отдел, который есть почти у всех компаний отрасли: такие отмечены
 * заранее. Остальные предлагаются рядом, но галочку ставит человек. Отмечать всё
 * подряд нельзя: пустой отдел, заведённый «на всякий случай», потом мешает при
 * назначении исполнителя и в отборах.
 */

export interface IndustryDepartment {
  name: string;
  /** Отмечен заранее: есть почти у всех компаний этой отрасли. */
  common: boolean;
}

export interface Industry {
  code: string;
  title: string;
  departments: IndustryDepartment[];
}

/** Есть почти в любой компании независимо от отрасли. */
const SALES: IndustryDepartment = { name: 'Продажи', common: true };
const MARKETING: IndustryDepartment = { name: 'Маркетинг', common: true };
const ACCOUNTING: IndustryDepartment = { name: 'Бухгалтерия', common: true };
const HR: IndustryDepartment = { name: 'Кадры', common: false };
const SUPPORT: IndustryDepartment = { name: 'Поддержка клиентов', common: false };
const PURCHASING: IndustryDepartment = { name: 'Закупки и снабжение', common: false };
const WAREHOUSE: IndustryDepartment = { name: 'Склад и логистика', common: false };
const LEGAL: IndustryDepartment = { name: 'Юридический отдел', common: false };

export const INDUSTRIES: Industry[] = [
  {
    code: 'it',
    title: 'ИТ и разработка',
    departments: [
      { name: 'Разработка', common: true },
      { name: 'Тестирование', common: true },
      { name: 'Дизайн и UX', common: true },
      { name: 'Аналитика', common: false },
      { name: 'Эксплуатация и DevOps', common: false },
      SALES, MARKETING, SUPPORT, ACCOUNTING, HR,
    ],
  },
  {
    code: 'retail',
    title: 'Торговля и маркетплейсы',
    departments: [
      SALES,
      { name: 'Закупки', common: true },
      { name: 'Склад', common: true },
      { name: 'Работа с маркетплейсами', common: false },
      MARKETING, SUPPORT, ACCOUNTING, HR,
    ],
  },
  {
    code: 'construction',
    title: 'Строительство и ремонт',
    departments: [
      { name: 'Проектирование', common: true },
      { name: 'Строительно-монтажные работы', common: true },
      { name: 'Сметный отдел', common: true },
      { name: 'Технадзор и качество', common: false },
      PURCHASING, SALES, ACCOUNTING, HR,
    ],
  },
  {
    code: 'manufacturing',
    title: 'Производство',
    departments: [
      { name: 'Производство', common: true },
      { name: 'Технический отдел', common: true },
      { name: 'Контроль качества', common: true },
      { name: 'Конструкторский отдел', common: false },
      PURCHASING, WAREHOUSE, SALES, ACCOUNTING, HR,
    ],
  },
  {
    code: 'marketing',
    title: 'Реклама и маркетинг',
    departments: [
      { name: 'Аккаунт-менеджмент', common: true },
      { name: 'Креатив и дизайн', common: true },
      { name: 'Реклама и трафик', common: true },
      { name: 'Копирайтинг и контент', common: false },
      { name: 'Аналитика', common: false },
      SALES, ACCOUNTING,
    ],
  },
  {
    code: 'logistics',
    title: 'Логистика и перевозки',
    departments: [
      { name: 'Диспетчерская', common: true },
      { name: 'Перевозки', common: true },
      { name: 'Склад', common: true },
      { name: 'Документы и таможня', common: false },
      SALES, ACCOUNTING, HR,
    ],
  },
  {
    code: 'finance',
    title: 'Финансы, банки и страхование',
    departments: [
      { name: 'Клиентский отдел', common: true },
      { name: 'Финансовый отдел', common: true },
      { name: 'Оценка рисков', common: false },
      LEGAL, SALES, MARKETING, ACCOUNTING,
    ],
  },
  {
    code: 'medical',
    title: 'Медицина и здоровье',
    departments: [
      { name: 'Регистратура', common: true },
      { name: 'Врачи и специалисты', common: true },
      { name: 'Диагностика и лаборатория', common: false },
      { name: 'Контроль качества помощи', common: false },
      PURCHASING, MARKETING, ACCOUNTING, HR,
    ],
  },
  {
    code: 'education',
    title: 'Образование и курсы',
    departments: [
      { name: 'Учебная часть', common: true },
      { name: 'Преподаватели', common: true },
      { name: 'Приём и сопровождение', common: true },
      { name: 'Методический отдел', common: false },
      MARKETING, SALES, ACCOUNTING,
    ],
  },
  {
    code: 'realestate',
    title: 'Недвижимость',
    departments: [
      { name: 'Отдел продаж', common: true },
      { name: 'Аренда', common: false },
      { name: 'Ипотека и сделки', common: false },
      LEGAL, MARKETING, ACCOUNTING,
    ],
  },
  {
    code: 'horeca',
    title: 'Рестораны и гостиницы',
    departments: [
      { name: 'Кухня и производство', common: true },
      { name: 'Зал и обслуживание', common: true },
      { name: 'Служба приёма', common: false },
      PURCHASING, MARKETING, ACCOUNTING, HR,
    ],
  },
  {
    code: 'services',
    title: 'Услуги населению и сервис',
    departments: [
      { name: 'Мастера и специалисты', common: true },
      { name: 'Приём заявок', common: true },
      { name: 'Выездная служба', common: false },
      SALES, MARKETING, ACCOUNTING,
    ],
  },
  {
    code: 'legal',
    title: 'Юридические услуги и консалтинг',
    departments: [
      { name: 'Юристы', common: true },
      { name: 'Работа с клиентами', common: true },
      { name: 'Консалтинг и аудит', common: false },
      SALES, MARKETING, ACCOUNTING,
    ],
  },
  {
    code: 'other',
    title: 'Другое',
    departments: [
      SALES, MARKETING,
      { name: 'Операции', common: true },
      ACCOUNTING, HR, SUPPORT,
    ],
  },
];

/** Отрасль по коду; незнакомый код — «Другое», а не пустой список. */
export function industryByCode(code: string | null | undefined): Industry {
  return INDUSTRIES.find((i) => i.code === code) ?? INDUSTRIES[INDUSTRIES.length - 1];
}

/** Что предложить отметить заранее: только `common`, см. пояснение наверху файла. */
export function suggestedDepartments(code: string | null | undefined): string[] {
  return industryByCode(code).departments.filter((d) => d.common).map((d) => d.name);
}
