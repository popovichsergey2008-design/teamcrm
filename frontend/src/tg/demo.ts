import type { TgCheck, TgSource } from './source';

/**
 * Демо-доска Mini App (#4619): до регистрации, без сервера и без записи куда-либо.
 *
 * Главная задача — та самая, что бот собирает из голосового в демо (ТЗ, шаг 2):
 * «Подготовить отчёт по рекламе», Дмитрий, пятница 15:00, чек-лист из трёх пунктов.
 * Человек кликает галочки и статус — всё живёт в памяти окна и пропадает при закрытии.
 */

export const DEMO_TASK_ID = 'demo';

interface DemoTask {
  id: string; title: string; assignee: string; due: string | null; overdue?: boolean;
  column: string; description: string; checklist: TgCheck[];
}

const COLUMNS = [
  { id: 'todo', name: 'К выполнению' },
  { id: 'doing', name: 'В работе' },
  { id: 'review', name: 'На проверке' },
  { id: 'done', name: 'Готово' },
];

function seed(): DemoTask[] {
  return [
    {
      id: DEMO_TASK_ID, title: 'Подготовить отчёт по рекламе', assignee: 'Дмитрий', due: 'Пятница, 15:00', column: 'todo',
      description: 'Поручение из голосового: «Дима, подготовь отчёт по рекламе к пятнице 15:00 и добавь сравнение с прошлым месяцем».',
      checklist: [
        { id: 'c1', text: 'Собрать показатели рекламных кабинетов за текущий период', done: false },
        { id: 'c2', text: 'Сравнить конверсии и бюджет с прошлым месяцем', done: false },
        { id: 'c3', text: 'Сформулировать выводы и рекомендации', done: false },
      ],
    },
    {
      id: 'demo-2', title: 'Обновить баннеры к распродаже', assignee: 'Анна', due: 'Четверг, 12:00', column: 'doing',
      description: 'Три размера: лента, сторис, сайт.',
      checklist: [
        { id: 'c1', text: 'Макет для ленты', done: true },
        { id: 'c2', text: 'Макет для сторис', done: false },
      ],
    },
    {
      id: 'demo-3', title: 'Созвон с подрядчиком по контекстной рекламе', assignee: 'Игорь', due: 'Сегодня, 17:30', column: 'todo',
      description: 'Обсудить ставки и минус-слова.', checklist: [],
    },
    {
      id: 'demo-4', title: 'Проверить посадочную страницу акции', assignee: 'Мария', due: 'Вчера, 18:00', overdue: true, column: 'review',
      description: 'Форма заявки, скорость загрузки, мобильная версия.',
      checklist: [
        { id: 'c1', text: 'Форма отправляет заявку', done: true },
        { id: 'c2', text: 'Страница открывается быстрее 3 секунд', done: true },
      ],
    },
    {
      id: 'demo-5', title: 'Согласовать бюджет на ноябрь', assignee: 'Дмитрий', due: null, column: 'done',
      description: 'Согласовано с руководителем.', checklist: [],
    },
  ];
}

export function demoSource(): TgSource {
  const tasks = seed();
  const find = (id: string) => {
    const t = tasks.find((x) => x.id === id);
    if (!t) throw new Error('Такой задачи в примере нет');
    return t;
  };
  const card = (t: DemoTask) => ({
    id: t.id, title: t.title, assignee: t.assignee, due: t.due, overdue: !!t.overdue && t.column !== 'done',
    checkDone: t.checklist.filter((c) => c.done).length, checkTotal: t.checklist.length,
  });
  const project = { id: 'demo', name: 'Маркетинг и аналитика' };
  return {
    demo: true,
    projects: async () => [project],
    board: async () => ({
      project,
      columns: COLUMNS.map((c) => ({ ...c, cards: tasks.filter((t) => t.column === c.id).map(card) })),
    }),
    task: async (id) => {
      const t = find(id);
      return {
        card: card(t), description: t.description, columnId: t.column, projectId: project.id, projectName: project.name,
        columns: COLUMNS, closed: t.column === 'done',
      };
    },
    checklist: async (id) => find(id).checklist.map((c) => ({ ...c })),
    toggle: async (id, itemId, done) => {
      const c = find(id).checklist.find((x) => x.id === itemId);
      if (c) c.done = done;
    },
    move: async (id, columnId) => { find(id).column = columnId; },
  };
}
