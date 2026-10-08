import { useEffect } from 'react';
import type { Route } from './router';

/**
 * Заголовок вкладки по странице (#1516).
 *
 * У всех страниц был один заголовок «QEVO», и ссылка на задачу, скопированная из
 * браузера, вставлялась как «[QEVO](…/task/1137)» — не понять, о чём она, пока не
 * откроешь. Теперь у задачи «#1137 Название · QEVO», у проекта, клиента и чата — их
 * имя, у раздела — его название.
 *
 * Почему не «кто последний поставил, того и заголовок»: открытые разделы остаются
 * смонтированными и просто прячутся, и спрятанная доска перебивала бы видимую
 * страницу. Поэтому экраны только СООБЩАЮТ имена (`useTitleHint`), а заголовок
 * считается в одном месте — по текущему адресу (`pageTitleFor`).
 */

const hints = new Map<string, string>();
export const TITLE_HINTS_EVENT = 'teamcrm:title-hints';

/** Экран знает имя того, что показывает: «task:1137» → «#1137 Название». */
export function useTitleHint(key: string | null, text: string | null | undefined): void {
  useEffect(() => {
    if (!key || !text?.trim()) return;
    if (hints.get(key) === text) return;
    hints.set(key, text.trim());
    window.dispatchEvent(new CustomEvent(TITLE_HINTS_EVENT));
  }, [key, text]);
}

const SECTION_TITLE: Record<string, string> = {
  focus: 'Фокус дня', calendar: 'Календарь', news: 'Новости', tasks: 'Задачи', projects: 'Проекты',
  chat: 'Чаты', radar: 'Пульс команды', support: 'Служба заботы', clients: 'Клиенты', console: 'Консоль',
  settings: 'Настройки', profile: 'Личный кабинет', meet: 'Встреча',
};

/** Заголовок страницы без «· QEVO»: самое конкретное, что известно об адресе. */
export function pageTitleFor(r: Route): string {
  const hint = (key: string) => hints.get(key) ?? null;
  if (r.taskId) return hint(`task:${r.taskId}`) ?? `Задача #${r.taskId}`;
  if (r.section === 'tasks' && r.taskIds) return 'Созданные задачи';
  if (r.section === 'projects' && r.projectId) return hint(`project:${r.projectId}`) ?? 'Проект';
  if (r.section === 'clients' && r.clientId) return hint(`client:${r.clientId}`) ?? 'Клиент';
  if (r.section === 'chat') {
    if (r.view === 'meetings') return 'Встречи';
    if (r.chatId === 'anthill') return 'QEVO Bot';
    if (r.chatId) return hint(`chat:${r.chatId}`) ?? 'Чат';
  }
  return SECTION_TITLE[r.section] ?? '';
}
