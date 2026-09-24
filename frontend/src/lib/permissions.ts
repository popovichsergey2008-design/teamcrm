/**
 * Права по-человечески: как их называть и в каком порядке показывать.
 *
 * Ключи приходят с сервера в виде `contact.reveal` — в списке галочек такое читать
 * невозможно. Здесь единственный перевод на человеческий язык; сами правила живут
 * на сервере и здесь не дублируются: интерфейс показывает, а решает сервер.
 */
const TITLES: Record<string, string> = {
  'organization.manage': 'Управлять организацией',
  'employee.view': 'Видеть сотрудников',
  'employee.manage': 'Управлять сотрудниками',
  'department.manage': 'Управлять отделами',

  'project.view': 'Видеть проекты',
  'project.create': 'Создавать проекты',
  'project.edit': 'Править проекты',
  'project.delete': 'Удалять проекты',
  'project.manage_members': 'Управлять участниками проекта',
  'project.view_finance': 'Видеть деньги проекта',

  'task.view': 'Видеть задачи',
  'task.create': 'Создавать задачи',
  'task.edit': 'Править задачи',
  'task.assign': 'Назначать исполнителей',
  'task.delete': 'Удалять задачи (в корзину)',
  'task.restore': 'Возвращать из корзины',
  'task.delete_permanently': 'Удалять насовсем',
  'task.export': 'Выгружать задачи',

  'contact.view': 'Видеть контакты клиентов',
  'contact.reveal': 'Раскрывать скрытые контакты',
  'contact.copy': 'Копировать контакты',
  'contact.export': 'Выгружать контакты',
  'contact.bulk_reveal': 'Раскрывать контакты списком',
  'crm.view': 'Видеть клиентов и сделки',
  'crm.edit': 'Править клиентов и сделки',

  'chat.view': 'Читать переписку',
  'chat.write': 'Писать в чаты',
  'file.download': 'Скачивать файлы',

  'ai.use': 'Пользоваться ИИ',
  'ai.manage': 'Настраивать ИИ',

  'integration.view': 'Видеть интеграции',
  'integration.manage': 'Подключать интеграции',
  'export.create': 'Делать выгрузки',
  'security.manage': 'Управлять безопасностью',
  'audit.view': 'Смотреть журнал безопасности',
};

export function permissionTitle(key: string): string {
  return TITLES[key] ?? key;
}

/** Разделы списка прав — в том порядке, в каком о них думает владелец. */
export const PERMISSION_GROUPS: { title: string; items: string[] }[] = [
  {
    title: 'Задачи и проекты',
    items: [
      'task.view', 'task.create', 'task.edit', 'task.assign',
      'task.delete', 'task.restore', 'task.delete_permanently', 'task.export',
      'project.view', 'project.create', 'project.edit', 'project.delete',
      'project.manage_members', 'project.view_finance',
    ],
  },
  {
    title: 'Клиенты и контакты',
    items: ['crm.view', 'crm.edit', 'contact.view', 'contact.reveal', 'contact.copy', 'contact.export', 'contact.bulk_reveal'],
  },
  {
    title: 'Переписка и файлы',
    items: ['chat.view', 'chat.write', 'file.download'],
  },
  {
    title: 'Люди и организация',
    items: ['employee.view', 'employee.manage', 'department.manage', 'organization.manage'],
  },
  {
    title: 'ИИ, интеграции и выгрузки',
    items: ['ai.use', 'ai.manage', 'integration.view', 'integration.manage', 'export.create'],
  },
  {
    title: 'Безопасность',
    items: ['security.manage', 'audit.view'],
  },
];
