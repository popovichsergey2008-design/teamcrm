/**
 * Разбор надиктованной задачи правилами: «Иванову обновить баннер на сайте к пятнице, срочно».
 *
 * Второй слой рядом с моделью — по той же причине, что и в календаре. Модель хорошо
 * понимает формулировку, но регулярно не возвращает проект и исполнителя, названных
 * прямым текстом, а без проекта задачу создать нельзя: человек продиктовал фразу
 * и упёрся в пустой выпадающий список.
 *
 * Здесь же живёт главное правило удобства: **проект берётся из обстановки**. Названный
 * вслух — сильнее всего; иначе тот, чья доска открыта; иначе единственный в компании.
 * Откуда он взялся, видно человеку: молча подставленный не тот проект хуже пустого поля.
 */

import { latinKey, numeralsToDigits, pickDay } from './event-draft';

export interface NamedThing {
  id: string;
  name: string;
}

/** Откуда взялся проект — показывается в форме подписью под выбором. */
export type ProjectSource = 'spoken' | 'model' | 'board' | 'only' | 'none';

/** Слова, по которым проект не опознать: они есть в половине названий. */
const STOP_WORDS = new Set(['и', 'в', 'на', 'по', 'для', 'the', 'проект', 'сайт-', 'crm']);

const words = (text: string): string[] =>
  text.toLowerCase().replace(/ё/g, 'е').split(/[^a-zа-я0-9]+/i).filter(Boolean);

/**
 * Значимые слова названия в общем алфавите.
 *
 * Через `latinKey`, потому что название могут произнести по-русски, а в базе оно
 * записано латиницей («TeamCRM» на слух — «тим црм»): без приведения к одному виду
 * такой проект не находится никогда.
 */
function nameKeys(name: string): string[] {
  return words(name)
    .filter((w) => w.length >= 3 && !STOP_WORDS.has(w))
    .map(latinKey)
    .filter((k) => k.length >= 2);
}

/** Слово из речи и слово из названия — одно и то же? Падежи режем по началу слова. */
function sameWord(spoken: string, target: string): boolean {
  if (spoken === target) return true;
  if (target.length < 4) return false;
  const stem = target.slice(0, target.length - 1);
  return spoken.startsWith(stem) && spoken.length <= target.length + 2;
}

/**
 * Проект, названный в самой фразе.
 *
 * Совпадением считаем только полное: все значимые слова названия прозвучали.
 * «Сайт клиента» не должен ловиться фразой про какой-то сайт — поставить задачу
 * не в тот проект хуже, чем не поставить вовсе. При ничьей возвращаем null:
 * выбор между двумя проектами — не работа угадайки.
 */
export function matchProjectInText(text: string, projects: NamedThing[]): string | null {
  const spoken = words(text).map(latinKey).filter(Boolean);
  if (!spoken.length) return null;

  let best: { id: string; score: number } | null = null;
  let tie = false;
  for (const p of projects) {
    const keys = nameKeys(p.name ?? '');
    if (!keys.length) continue;
    if (!keys.every((k) => spoken.some((s) => sameWord(s, k)))) continue;
    const score = keys.length;
    if (!best || score > best.score) { best = { id: String(p.id), score }; tie = false; }
    else if (score === best.score) tie = true;
  }
  return best && !tie ? best.id : null;
}

/**
 * Проект задачи по всей доступной обстановке.
 *
 * Порядок — от самого надёжного к самому общему: сказанное вслух побеждает догадку
 * модели, догадка модели — открытую доску. Открытая доска стоит выше «единственного
 * проекта» не случайно: человек, который смотрит на доску и диктует задачу, почти
 * всегда имеет в виду именно её.
 */
export function chooseProject(o: {
  spokenId: string | null;
  modelId: string | null;
  currentId: string | null;
  projects: NamedThing[];
}): { projectId: string | null; source: ProjectSource } {
  const known = (id: string | null) =>
    (id && o.projects.some((p) => String(p.id) === String(id)) ? String(id) : null);

  const spoken = known(o.spokenId);
  if (spoken) return { projectId: spoken, source: 'spoken' };
  const model = known(o.modelId);
  if (model) return { projectId: model, source: 'model' };
  const board = known(o.currentId);
  if (board) return { projectId: board, source: 'board' };
  if (o.projects.length === 1) return { projectId: String(o.projects[0].id), source: 'only' };
  return { projectId: null, source: 'none' };
}

/** Человеческое объяснение выбора: молча подставленный проект пугает. */
export const PROJECT_HINT: Record<ProjectSource, string> = {
  spoken: 'проект прозвучал в команде',
  model: 'проект понят из смысла',
  board: 'проект — открытая доска',
  only: 'в компании один проект',
  none: '',
};

const URGENT = /(?<![а-я])(срочн|сроч|горит|как можно скорее|asap|немедленн)/i;
const HIGH = /(?<![а-я])(важн|в приоритете|приоритетн|в первую очередь)/i;
const LOW = /(?<![а-я])(не\s+срочн|когда\s+будет\s+время|не\s+горит|низкий приоритет)/i;

/** Приоритет по словам. Ничего не сказано — не выдумываем, пусть будет обычный. */
export function pickPriority(text: string): string | null {
  const t = text.toLowerCase().replace(/ё/g, 'е');
  if (LOW.test(t)) return 'low';
  if (URGENT.test(t)) return 'urgent';
  if (HIGH.test(t)) return 'high';
  return null;
}

const pad = (n: number) => String(n).padStart(2, '0');
const asDate = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/**
 * Срок задачи словами: «к пятнице», «до конца недели», «через три дня», «завтра».
 *
 * Отдельно от календаря: у встречи час начала обязателен, у задачи важен только день.
 * «Конец недели» — пятница, а не воскресенье: сдавать работу в выходной никто не ждёт.
 */
export function pickDeadline(text: string, now: Date): string | null {
  // Числительные словами — сразу цифрами: на слух срок звучит как «через три дня»,
  // и правило, ищущее только цифры, на такой расшифровке молчит.
  // \w в регулярных выражениях JS не считает буквой кириллицу, поэтому окончания
  // слов везде описаны явно: с \w* «до конца недели» не находилось вовсе.
  const t = numeralsToDigits(text.toLowerCase().replace(/ё/g, 'е'));
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  if (/(?:до|к)\s+конц[а-я]*\s+недел/i.test(t)) {
    const d = new Date(today);
    d.setDate(d.getDate() + (((5 - d.getDay()) + 7) % 7)); // ближайшая пятница, сегодня годится
    return asDate(d);
  }
  if (/(?:до|к)\s+конц[а-я]*\s+месяц/i.test(t)) {
    return asDate(new Date(today.getFullYear(), today.getMonth() + 1, 0));
  }
  const inDays = /через\s+(\d{1,3})\s*(день|дня|дней)/i.exec(t);
  if (inDays) {
    const d = new Date(today);
    d.setDate(d.getDate() + Number(inDays[1]));
    return asDate(d);
  }
  if (/через\s+недел/i.test(t)) {
    const d = new Date(today);
    d.setDate(d.getDate() + 7);
    return asDate(d);
  }

  const day = pickDay(t, now);
  if (!day || day < today) return null;
  // «20 августа», когда оно уже прошло, календарь переносит на следующий год —
  // для встречи это верно, для срока задачи нет: человек назвал прошедшую дату,
  // а не собирался ждать год. Явно названный год оставляем как сказано.
  const MONTHS_AHEAD = 180 * 24 * 60 * 60 * 1000;
  if (day.getTime() - today.getTime() > MONTHS_AHEAD && !/\d{4}/.test(t)) return null;
  return asDate(day);
}

/**
 * Название задачи из фразы, когда модель молчит.
 *
 * Служебную обёртку команды убираем, остальное оставляем дословно: человек уже
 * сформулировал, и пересказ своими словами он потом не узнаёт в списке задач.
 */
export function taskTitleFrom(text: string): string {
  const clean = text.trim()
    .replace(/^(?:поставь|постав|создай|заведи|добавь|запиши|сделай)\s+(?:задачу|таск|туду)?\s*/i, '')
    .replace(/^(?:задача|таск)\s*[:—-]\s*/i, '')
    .replace(/^(?:нужно|надо)\s+/i, '')
    .replace(/[\s,;.]+$/g, '')
    .trim();
  return (clean || text.trim()).slice(0, 255);
}
