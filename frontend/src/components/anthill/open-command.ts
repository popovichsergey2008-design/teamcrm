import { api } from '../../lib/api';
import type { Route } from '../../lib/router';

/**
 * #5005: «Открой такой-то раздел, такую-то страницу, такую-то задачу» — голосом или текстом
 * в QEVO Bot. Разбираем правилами здесь же, без модели: переход должен случиться сразу.
 * Не узнали, что открыть, — вопрос уходит боту как обычно.
 */

const VERB = /^(?:qevo\s*bot|кево\s*бот|бот)?[\s,.!]*(?:пожалуйста\s+)?(?:открой(?:те)?|открыть|покажи(?:те)?|перейди(?:те)?|перейти|зайди|зайти|отправь\s+меня|включи)(?:\s+(?:мне|пожалуйста))*\s+(?:(?:в|на|во)\s+)?(.+)$/i;

/** «Открой календарь» → «календарь»; не команда — null. */
export function openTarget(text: string): string | null {
  const t = text.trim().replace(/[.!?…]+$/, '');
  if (t.length > 160 || t.includes('\n')) return null;
  const m = VERB.exec(t);
  return m ? m[1].trim() : null;
}

const norm = (s: string) => s.toLowerCase().replace(/ё/g, 'е').replace(/[«»"'.,!?]/g, ' ').replace(/\s+/g, ' ').trim();

/** Основы слов: «задачу», «задачи», «задач» → «задач». Хватает для разделов и названий. */
const stem = (w: string) => (w.length > 4 ? w.replace(/(ами|ями|ого|его|ому|ему|ой|ей|ую|юю|ые|ие|ах|ях|ам|ям|ом|ем|у|ю|а|я|е|и|ы|ь)$/, '') : w);

type Page = { words: string[]; route: Route; title: string; roles?: string[] };

/** Разделы и страницы. Слова — основы; порядок важен: частное раньше общего. */
const PAGES: Page[] = [
  { words: ['мои задач'], route: { section: 'tasks' }, title: 'Мои задачи' },
  { words: ['поручил', 'поручен', 'делегир'], route: { section: 'tasks', view: 'delegated' }, title: 'Что я поручил' },
  { words: ['все задач', 'общие задач', 'задачи компании'], route: { section: 'tasks', view: 'all' }, title: 'Все задачи компании' },
  { words: ['задач'], route: { section: 'tasks' }, title: 'Задачи' },
  { words: ['проект'], route: { section: 'projects' }, title: 'Проекты и задачи' },
  { words: ['фокус', 'главн', 'домой', 'план дня'], route: { section: 'focus' }, title: 'Фокус дня' },
  { words: ['входящ', 'уведомлен', 'колокольч'], route: { section: 'inbox' }, title: 'Входящие' },
  { words: ['календар', 'расписан'], route: { section: 'calendar' }, title: 'Календарь' },
  { words: ['встреч', 'созвон', 'протокол'], route: { section: 'chat', view: 'meetings' }, title: 'Встречи' },
  { words: ['чат', 'сообщен', 'переписк', 'мессендж'], route: { section: 'chat' }, title: 'Чаты' },
  { words: ['стикер', 'напоминалк'], route: { section: 'stickers' }, title: 'Стикеры' },
  { words: ['новост', 'лент'], route: { section: 'news' }, title: 'Новости' },
  { words: ['пульс', 'радар'], route: { section: 'radar' }, title: 'Пульс команды', roles: ['owner', 'manager'] },
  { words: ['клиент', 'сделк'], route: { section: 'clients' }, title: 'Клиенты' },
  { words: ['отчет'], route: { section: 'settings', tab: 'reports' }, title: 'Отчёты' },
  { words: ['тариф', 'оплат', 'подписк', 'счет'], route: { section: 'settings', tab: 'billing' }, title: 'Тариф и оплата' },
  { words: ['интеграц'], route: { section: 'settings', tab: 'integrations' }, title: 'Интеграции' },
  { words: ['команд', 'сотрудник', 'пространств'], route: { section: 'settings', tab: 'team' }, title: 'Команда и пространство' },
  { words: ['безопасн', 'парол', 'двухфактор'], route: { section: 'settings', tab: 'security' }, title: 'Безопасность' },
  { words: ['база знан', 'регламент'], route: { section: 'settings', tab: 'knowledge' }, title: 'База знаний' },
  { words: ['почт'], route: { section: 'settings', tab: 'mail' }, title: 'Почта' },
  { words: ['профил'], route: { section: 'settings', tab: 'account' }, title: 'Профиль' },
  { words: ['личный кабинет', 'кабинет', 'настройк'], route: { section: 'settings' }, title: 'Личный кабинет' },
  { words: ['поддержк', 'инженер', 'забот'], route: { section: 'support' }, title: 'Служба заботы' },
];

export type OpenResult = { route: Route; title: string } | { error: string } | null;

/**
 * Куда вести по словам после «открой». null — команда не наша (пусть отвечает бот),
 * error — команда наша, но открыть нечего («задачи 99999 нет»).
 */
export async function resolveOpen(target: string, role: string): Promise<OpenResult> {
  const t = norm(target);
  if (!t) return null;
  const st = t.split(' ').map(stem).join(' ');

  // задача по номеру: «задачу 5005», «задачу номер 5005», «#5005», «5005»
  const num = /^(?:(?:задач\S*|карточк\S*|таск\S*)\s+)?(?:номер\s+|№\s*|#\s*)?(\d{1,7})$/.exec(t.replace(/#/g, ' # ').replace(/\s+/g, ' ').trim());
  if (num) {
    const r = await api.search(num[1]).catch(() => null);
    const hit = r?.tasks.find((x) => String(x.id) === num[1]);
    if (!hit) return { error: `Задачу #${num[1]} не нашёл — или её нет, или у вас нет к ней доступа.` };
    return { route: { section: 'projects', projectId: String(hit.project_id), taskId: String(hit.id) }, title: `задачу #${hit.id} «${hit.title}»` };
  }

  // задача / проект / чат по названию: «задачу про логотип», «проект QEVO», «чат с Сергеем»
  const named = /^(задач|карточк|проект|доск|чат|переписк|диалог)\S*\s+(?:(?:про|по|с|со|под названием|называется)\s+)?(.+)$/.exec(t);
  if (named) {
    const kind = named[1];
    const q = named[2].trim();
    if (q.length >= 2) {
      const r = await api.search(q).catch(() => null);
      if (kind === 'задач' || kind === 'карточк') {
        const hit = r?.tasks.find((x) => !x.closed) ?? r?.tasks[0];
        if (hit) return { route: { section: 'projects', projectId: String(hit.project_id), taskId: String(hit.id) }, title: `задачу #${hit.id} «${hit.title}»` };
        return { error: `Не нашёл задачу «${named[2]}». Скажите номер — открою сразу.` };
      }
      if (kind === 'проект' || kind === 'доск') {
        const hit = r?.projects[0];
        if (hit) return { route: { section: 'projects', projectId: String(hit.id) }, title: `проект «${hit.name}»` };
        return { error: `Не нашёл проект «${named[2]}».` };
      }
      // чат: сначала по названию, потом личный с человеком
      const chat = r?.chats[0];
      if (chat) return { route: { section: 'chat', chatId: String(chat.id) }, title: `чат «${chat.title ?? 'Чат'}»` };
      const person = r?.people[0] ?? (await personByStem(q));
      if (person) {
        const dm = await api.openDm(String(person.id)).catch(() => null);
        if (dm) return { route: { section: 'chat', chatId: String(dm.id) }, title: `личный чат — ${person.full_name}` };
      }
      return { error: `Не нашёл чат «${named[2]}».` };
    }
  }

  // «Заметки» — чат с собой: адрес у каждого свой
  if (st.startsWith('заметк') || st.startsWith('мои заметк')) {
    const self = await api.openSelfChat().catch(() => null);
    if (self) return { route: { section: 'chat', chatId: String(self.id) }, title: '«Заметки»' };
  }

  // раздел или страница
  for (const p of PAGES) {
    if (p.roles && !p.roles.includes(role)) continue;
    if (p.words.some((w) => st === w || st.startsWith(`${w}`) || st.includes(` ${w}`) || t.startsWith(w))) {
      return { route: p.route, title: `«${p.title}»` };
    }
  }
  return null;
}

/** «чат с Сергеем» — поиск ищет «сергеем» и не находит: пробуем основу имени. */
async function personByStem(q: string): Promise<{ id: string; full_name: string } | null> {
  const s = q.split(' ').map(stem).filter((w) => w.length >= 3).join(' ');
  if (!s || s === q) return null;
  const r = await api.search(s).catch(() => null);
  return r?.people.length === 1 ? r.people[0] : null;
}
