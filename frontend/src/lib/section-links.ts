import { buildPath, navigate, type Route } from './router';

/*
  Названия разделов в ответах поддержки — ссылками (#4737).

  Инженер или бот пишет «Откройте «Настройки» → «Интеграции»» — человек ищет это сам.
  Здесь такие названия в кавычках-ёлочках становятся ссылками прямо в тексте. После
  «Настройки» → вкладка ищется среди вкладок настроек («Фокус дня» там — настройка
  брифинга, а не раздел).
*/
const SECTIONS: Record<string, Route> = {
  'настройки': { section: 'settings' },
  'фокус дня': { section: 'focus' },
  'проекты': { section: 'projects' },
  'проекты и задачи': { section: 'projects' },
  'задачи': { section: 'tasks' },
  'мои задачи': { section: 'tasks' },
  'чаты': { section: 'chat' },
  'чаты & созвоны': { section: 'chat' },
  'чаты и созвоны': { section: 'chat' },
  'встречи': { section: 'chat', view: 'meetings' },
  'встречи — созвоны': { section: 'chat', view: 'meetings' },
  'qevo bot': { section: 'chat', chatId: 'anthill' },
  'календарь': { section: 'calendar' },
  'новости': { section: 'news' },
  'пульс команды': { section: 'radar' },
  'личный кабинет': { section: 'profile' },
  'профиль': { section: 'profile' },
  'клиенты': { section: 'clients' },
};

const SETTINGS_TABS: Record<string, string> = {
  'профиль': 'account', 'команда': 'team', 'команда и пространство': 'team', 'интеграции': 'integrations',
  'клиенты': 'clients', 'почта': 'mail', 'google': 'google', 'тариф и оплата': 'billing', 'тариф и ии': 'ai-plan',
  'расход ии': 'ai-usage', 'отчёты': 'reports', 'база знаний': 'knowledge', 'база знаний и регламенты': 'knowledge',
  'приёмка работы': 'handoff', 'настройка qevo': 'onboarding', 'рабочее время': 'work', 'безопасность': 'security',
  'теги задач': 'tags', 'разбор переписки': 'chat-analysis', 'гостевая страница': 'guest', 'фокус дня': 'focus',
  'напоминания ассистента': 'assistant',
};

const QUOTED = /«([^«»\n]{2,40})»/g;
/** Между «Настройки» и вкладкой — только стрелка и пробелы: «Настройки» → «Интеграции». */
const ARROW_ONLY = /^[\s→>›\-–—]*$/;

/** Обойти готовую разметку сообщения и превратить известные «Разделы» в ссылки. Возвращает уборку. */
export function linkSections(root: HTMLElement): () => void {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.parentElement?.closest('a, code, pre') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  const nodes: Text[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) nodes.push(n as Text);

  let afterSettings = false;
  let gap = '';
  for (const node of nodes) {
    const text = node.data;
    QUOTED.lastIndex = 0;
    let m: RegExpExecArray | null;
    let last = 0;
    const parts: (string | HTMLAnchorElement)[] = [];
    while ((m = QUOTED.exec(text))) {
      gap += text.slice(last, m.index);
      const name = m[1].trim().toLowerCase().replace(/\s+/g, ' ');
      const tab = afterSettings && ARROW_ONLY.test(gap) ? SETTINGS_TABS[name] : undefined;
      const route: Route | undefined = tab ? { section: 'settings', tab } : SECTIONS[name];
      parts.push(text.slice(last, m.index));
      if (route) {
        const a = document.createElement('a');
        a.href = buildPath(route);
        a.className = 'msg-section-link';
        a.textContent = m[0];
        a.addEventListener('click', (e) => {
          if (e.ctrlKey || e.metaKey || e.shiftKey) return; // в новой вкладке — как обычная ссылка
          e.preventDefault();
          navigate(route);
        });
        parts.push(a);
      } else {
        parts.push(m[0]);
      }
      afterSettings = name === 'настройки';
      gap = '';
      last = m.index + m[0].length;
    }
    gap += text.slice(last);
    if (!parts.some((p) => typeof p !== 'string')) continue;
    parts.push(text.slice(last));
    const frag = document.createDocumentFragment();
    for (const p of parts) frag.append(p);
    node.replaceWith(frag);
  }
  // разметку при следующем рендере React заменит целиком — убирать нечего
  return () => undefined;
}
