/**
 * Мини-роутер TEAMCRM на History API.
 *
 * Зачем свой, а не react-router: нужен ровно разбор пути, переход и подписка на
 * изменение — это сотня строк. Во фронте нет ни одной UI-зависимости намеренно
 * (см. Icon.tsx), и ради navigate() ломать это правило не стоит.
 *
 * Что было до него: раздел лежал в localStorage (`teamcrm.route`). Из-за этого
 * ссылку на задачу нельзя было никому отправить, «назад» в браузере выкидывало
 * из приложения целиком, а две вкладки дрались за один и тот же ключ.
 */
import { useEffect, useState } from 'react';

export type Section = 'focus' | 'calendar' | 'news' | 'tasks' | 'projects' | 'chat' | 'radar' | 'support'
  /** Консоль техотдела вендора: клиентам этого раздела не существует. */
  | 'console'
  | 'settings' | 'profile';

/**
 * Разобранный адрес. Плоский на одном уровне: сузить тип по секции можно и в месте
 * использования, а разбирать вложенный union в каждом обработчике — шумно.
 */
export type Route = {
  section: Section;
  /** подраздел секции: `inbox` (в фокусе), `clients` (в проектах), `meetings` (в чате) */
  view?: string;
  projectId?: string;
  taskId?: string;
  chatId?: string;
  /** вкладка настроек */
  tab?: string;
};

const SECTIONS: Section[] = [
  'focus', 'calendar', 'news', 'tasks', 'projects', 'chat', 'radar', 'support', 'console', 'settings', 'profile',
];

/** По ТЗ приложение открывается на «Фокусе дня», а не на досках. */
export const DEFAULT_PATH = '/focus';

/**
 * Адрес консоли техподдержки — тот же сайт под своим именем (ТЗ-8).
 *
 * Открытый по нему TeamCRM сразу показывает консоль: у техотдела свой вход, и идти
 * через «Фокус дня» ему незачем. Дальше по сайту он ходит как обычно — приложение
 * одно, отдельной сборки для поддомена нет.
 *
 * Скрытием это не является и являться не должно: права проверяет сервер, а адрес
 * лишь избавляет клиентов от лишней строки в чужой адресной строке.
 */
const CONSOLE_HOST = 'console.';

export function isConsoleHost(): boolean {
  return window.location.hostname.startsWith(CONSOLE_HOST);
}

/**
 * Куда вести за консолью с основного домена.
 *
 * На боевом адресе — на поддомен: у техотдела свой вход, и в меню обычного сайта
 * консоли нет. В разработке (localhost, голый IP) поддомена не существует — там
 * остаёмся внутри приложения, иначе ссылка вела бы в никуда.
 *
 * Имя выводим из текущего домена, а не пишем строкой: установок у продукта будет
 * больше одной, и «anthill.team» в коде фронта — чужое имя в чужой копии.
 */
export function consoleHref(): string {
  const host = window.location.hostname;
  const local = host === 'localhost' || host === '127.0.0.1' || /^\d+\.\d+\.\d+\.\d+$/.test(host);
  if (isConsoleHost() || local) return '/console';
  return `${window.location.protocol}//${CONSOLE_HOST}${host.replace(/^www\./, '')}/console`;
}

const NAV_EVENT = 'teamcrm:navigate';
const enc = encodeURIComponent;

export function parsePath(pathname: string): Route {
  const seg = pathname.split('/').filter(Boolean).map((s) => {
    try { return decodeURIComponent(s); } catch { return s; }
  });
  const section = SECTIONS.includes(seg[0] as Section) ? (seg[0] as Section) : null;
  if (!section) return { section: 'focus' };

  switch (section) {
    case 'focus':
      if (seg[1] === 'inbox') return { section, view: 'inbox' };
      // календарь стал отдельным разделом; старый адрес продолжает работать —
      // он уже разослан ссылками в письмах-приглашениях и лежит в закладках
      if (seg[1] === 'calendar') return { section: 'calendar' };
      return { section };
    // Реестр задач: срез живёт в адресе, чтобы ссылкой делились вкладкой
    // («вот всё, что я поставил»), а не чьим-то временным набором фильтров.
    case 'tasks':
      return seg[1] ? { section, view: seg[1] } : { section };
    case 'projects': {
      if (!seg[1]) return { section };
      return seg[2] === 'task' && seg[3]
        ? { section, projectId: seg[1], taskId: seg[3] }
        : { section, projectId: seg[1] };
    }
    case 'chat':
      if (seg[1] === 'meetings') return { section, view: 'meetings' };
      // Лента переехала из чатов в свой раздел «Новости»: она не переписка, а издание.
      // Старый адрес разослан в письмах и лежит в закладках — ведём его на новый.
      if (seg[1] === 'feed') return { section: 'news' };
      return seg[1] ? { section, chatId: seg[1] } : { section };
    case 'settings':
    case 'console':
      return seg[1] ? { section, tab: seg[1] } : { section };
    default:
      return { section };
  }
}

export function buildPath(r: Route): string {
  switch (r.section) {
    case 'focus':
      if (r.view === 'inbox') return '/focus/inbox';
      return '/focus';
    case 'tasks':
      return r.view ? `/tasks/${enc(r.view)}` : '/tasks';
    case 'projects':
      if (!r.projectId) return '/projects';
      return r.taskId
        ? `/projects/${enc(r.projectId)}/task/${enc(r.taskId)}`
        : `/projects/${enc(r.projectId)}`;
    case 'chat':
      if (r.view === 'meetings') return '/chat/meetings';
      if (r.view === 'feed') return '/chat/feed';
      return r.chatId ? `/chat/${enc(r.chatId)}` : '/chat';
    case 'settings':
      return r.tab ? `/settings/${enc(r.tab)}` : '/settings';
    case 'console':
      return r.tab ? `/console/${enc(r.tab)}` : '/console';
    default:
      return `/${r.section}`;
  }
}

/**
 * Переход. `replace` — когда адрес лишь догоняет состояние экрана (выбрали проект
 * внутри доски): в историю такие шаги класть нельзя, иначе «назад» будет ходить
 * по собственным следам вместо возврата в предыдущий раздел.
 */
export function navigate(to: Route | string, opts: { replace?: boolean } = {}) {
  const path = typeof to === 'string' ? to : buildPath(to);
  if (path === window.location.pathname && !opts.replace) return;
  window.history[opts.replace ? 'replaceState' : 'pushState']({}, '', path + window.location.search);
  window.dispatchEvent(new Event(NAV_EVENT));
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parsePath(window.location.pathname));
  useEffect(() => {
    const sync = () => setRoute(parsePath(window.location.pathname));
    window.addEventListener('popstate', sync);
    window.addEventListener(NAV_EVENT, sync);
    return () => {
      window.removeEventListener('popstate', sync);
      window.removeEventListener(NAV_EVENT, sync);
    };
  }, []);
  return route;
}

const LEGACY_KEY = 'teamcrm.route';
/** Старые значения раздела → новые адреса. Живёт до тех пор, пока у людей не обновится вкладка. */
const LEGACY_PATHS: Record<string, string> = {
  board: '/projects',
  mytasks: '/focus',
  chats: '/chat',
  meetings: '/chat/meetings',
  profile: '/profile',
};

/**
 * Разовая настройка адреса при старте. Вызывается до первой отрисовки.
 *
 * Ссылки-приглашения приходят как `/?invite=…`, поэтому query сохраняем —
 * иначе человек потеряет токен на первом же шаге.
 */
export function initRouter() {
  const saved = localStorage.getItem(LEGACY_KEY);
  if (saved) localStorage.removeItem(LEGACY_KEY);
  if (window.location.pathname !== '/') return;
  const path = (saved && LEGACY_PATHS[saved]) || (isConsoleHost() ? '/console' : DEFAULT_PATH);
  window.history.replaceState({}, '', path + window.location.search);
}
