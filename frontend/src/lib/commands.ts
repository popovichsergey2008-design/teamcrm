import type { IconName } from '../components/Icon';
import { norm } from './palette-match';

/**
 * Быстрые команды командной строки.
 *
 * Отделено от компонента, потому что здесь единственное, что может ошибаться молча:
 * подбор команды по словам. Человек пишет «не беспокоить», «днём не трогать»,
 * «dnd» — и ждёт одного и того же. Промах выглядит как «строка меня не понимает»,
 * и человек больше не пробует.
 *
 * Команда описывается словами-зацепками, а не одной фразой: искать по названию
 * недостаточно — «кто свободен» и «свободные люди» это один вопрос.
 */

export type CommandKind =
  | 'focus-deep-hour' | 'focus-deep-day' | 'focus-call' | 'focus-break' | 'focus-clear'
  | 'theme-dark' | 'theme-light' | 'theme-system'
  | 'my-overdue' | 'who-free' | 'at-risk' | 'day-summary'
  /** #4807 §5, п. 2: поиск — это и команды: создать задачу, позвонить, перейти */
  | 'new-task' | 'voice-task' | 'start-call' | 'open-inbox' | 'new-chat' | 'open-calendar';

export type Command = {
  kind: CommandKind;
  title: string;
  hint: string;
  icon: IconName;
  words: string[];
  /** команда доступна только руководителю */
  managerOnly?: boolean;
};

export const COMMANDS: Command[] = [
  {
    kind: 'new-task',
    title: 'Новая задача',
    hint: 'клавиша C — или напишите задачу прямо здесь',
    icon: 'plus',
    words: ['новая задача', 'создать задачу', 'поставить задачу', 'задача', 'добавить задачу'],
  },
  {
    kind: 'voice-task',
    title: 'Задача голосом',
    hint: 'клавиша V — скажите, что сделать',
    icon: 'mic',
    words: ['задача голосом', 'голосом', 'надиктовать', 'сказать голосом', 'голос'],
  },
  {
    kind: 'start-call',
    title: 'Позвонить',
    hint: 'выберите, кому — созвон начнётся сразу',
    icon: 'phone',
    words: ['позвонить', 'созвон', 'звонок', 'набрать', 'созвониться', 'видеозвонок'],
  },
  {
    kind: 'open-inbox',
    title: 'Входящие',
    hint: 'всё, что ждёт вашей реакции',
    icon: 'inbox',
    words: ['входящие', 'уведомления', 'ждут решения', 'упоминания', 'inbox'],
  },
  {
    kind: 'new-chat',
    title: 'Новый чат',
    hint: 'написать коллеге или создать группу',
    icon: 'chat',
    words: ['новый чат', 'написать', 'сообщение', 'группа', 'канал'],
  },
  {
    kind: 'open-calendar',
    title: 'Календарь',
    hint: 'встречи, блоки времени, «Найти время»',
    icon: 'calendar',
    words: ['календарь', 'встречи', 'расписание', 'найти время', 'запланировать'],
  },
  {
    kind: 'focus-deep-hour',
    title: 'Не беспокоить час',
    hint: 'глубокий фокус, статус увидят коллеги',
    icon: 'target',
    words: ['не беспокоить', 'фокус', 'dnd', 'тишина', 'не трогать', 'занят'],
  },
  {
    kind: 'focus-deep-day',
    title: 'Не беспокоить до конца дня',
    hint: 'глубокий фокус до 23:59',
    icon: 'target',
    words: ['не беспокоить', 'до конца дня', 'весь день', 'фокус на день'],
  },
  {
    kind: 'focus-call',
    title: 'Я на созвоне',
    hint: 'статус на 30 минут',
    icon: 'phone',
    words: ['на созвоне', 'созвон', 'встреча', 'звонок', 'на звонке'],
  },
  {
    kind: 'focus-break',
    title: 'Обед / перерыв',
    hint: 'статус на 30 минут',
    icon: 'clock',
    words: ['обед', 'перерыв', 'кофе', 'отошёл', 'отошел'],
  },
  {
    kind: 'focus-clear',
    title: 'Снять фокус',
    hint: 'снова доступен для всех',
    icon: 'close',
    words: ['снять фокус', 'я вернулся', 'доступен', 'свободен снова', 'убрать статус'],
  },
  {
    kind: 'theme-dark',
    title: 'Тёмная тема',
    hint: 'оформление',
    icon: 'moon',
    words: ['тёмная тема', 'темная тема', 'ночь', 'dark'],
  },
  {
    kind: 'theme-light',
    title: 'Светлая тема',
    hint: 'оформление',
    icon: 'sun',
    words: ['светлая тема', 'день', 'light'],
  },
  {
    kind: 'theme-system',
    title: 'Тема как в системе',
    hint: 'оформление',
    icon: 'monitor',
    words: ['тема как в системе', 'системная тема', 'авто тема'],
  },
  {
    kind: 'my-overdue',
    title: 'Мои просроченные',
    hint: 'задачи, у которых срок уже прошёл',
    icon: 'alert',
    words: ['мои просроченные', 'просрочено', 'просроченные', 'сроки прошли', 'горит'],
  },
  {
    kind: 'who-free',
    title: 'Кто свободен',
    hint: 'кто чем занят прямо сейчас',
    icon: 'users',
    words: ['кто свободен', 'свободные', 'кто занят', 'кто на созвоне', 'доступность'],
  },
  {
    kind: 'at-risk',
    title: 'Задачи под риском',
    hint: 'просрочка и то, что залежалось на проверке',
    icon: 'chart',
    words: ['под риском', 'риски', 'узкие места', 'что горит', 'застряло'],
    managerOnly: true,
  },
  {
    kind: 'day-summary',
    title: 'Сводка дня',
    hint: 'что закрыто, что ждёт решения, что просрочено',
    icon: 'sparkles',
    words: ['сводка дня', 'саммари', 'итоги дня', 'что сделано', 'сводка'],
  },
];

/**
 * Подходит ли команда под запрос. Совпадением считается и начало слова-зацепки,
 * и вхождение запроса в неё: человек набирает «не бесп» и не должен ждать,
 * пока допишет фразу целиком.
 */
export function matchCommand(cmd: Command, rawQuery: string): boolean {
  const q = norm(rawQuery);
  if (q.length < 2) return false;
  const hay = [cmd.title, ...cmd.words].map(norm);
  return hay.some((w) => w.startsWith(q) || w.includes(q));
}

export function findCommands(query: string, isManager: boolean): Command[] {
  return COMMANDS
    .filter((c) => (!c.managerOnly || isManager) && matchCommand(c, query))
    .slice(0, 5);
}

/**
 * Фраза — это постановка задачи, а не поиск: «поставь задачу Сергею до пятницы»,
 * «напомни Глебу про смету». Тогда первой строкой — «Поставить задачу: …» (#4807 §5, п. 2).
 */
export function looksLikeTask(raw: string): boolean {
  const t = raw.trim();
  return t.split(/\s+/).length >= 2 && /^(постав|созда[йт]|сделай задач|задач|напомн|поруч|назнач|добав\S* задач)/i.test(t);
}

/** «позвони Сергею», «созвон с Анной» — кому звонить; иначе null. */
export function callTarget(raw: string): string | null {
  const m = raw.trim().match(/^(?:позвон\S*|набери|набрать|созвон\S*(?:\s+с)?|звонок)\s+(.+)$/i);
  return m ? m[1].trim() : null;
}
