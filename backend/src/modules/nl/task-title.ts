/**
 * Название задачи по описанию (#4699): человек расписал задачу в описании, а поле
 * «Название» оставил пустым — по «Создать» название пишет модель. Здесь — правила
 * вокруг модели: очистка ответа и запасной вариант, когда модели нет или она молчит.
 */

export const TITLE_MAX = 90;

export const TITLE_SYSTEM = [
  'Ты придумываешь короткое название задачи по её описанию для таск-трекера.',
  'Название — повелительное или отглагольное, 3–9 слов, по-русски, без кавычек, без точки в конце,',
  'без слов «задача» и «нужно». Пример: описание «в кево бот выпадает окно, нижняя часть не видна» →',
  '«Исправить окно Qevo-бота: не видна нижняя часть».',
  'Ответь только названием, одной строкой.',
].join(' ');

/** Описание хранится в лёгкой разметке — для названия она мусор. */
export function plainOf(md: string): string {
  return String(md ?? '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|~~|__)/g, '')
    .replace(/(^|\s)\*(\S[^*\n]*\S|\S)\*(?=\s|$)/g, '$1$2')
    .replace(/^\s*(#{1,6}\s+|[-*]\s+|\d+[.)]\s+)/gm, '')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

/** Обрезаем по слову, а не посреди него. */
function clip(s: string, max = TITLE_MAX): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const sp = cut.lastIndexOf(' ');
  return `${(sp > max * 0.5 ? cut.slice(0, sp) : cut).replace(/[\s,;:—-]+$/, '')}…`;
}

const upFirst = (s: string) => (s ? s[0].toLocaleUpperCase('ru-RU') + s.slice(1) : s);

/** Ответ модели → название: первая строка, без кавычек, «Название:» и точки в конце. */
export function tidyTitle(raw: string): string {
  const line = String(raw ?? '').split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  const t = line
    .replace(/^(название( задачи)?\s*[:—-]\s*)/i, '')
    .replace(/[.。]+$/, '')
    .replace(/^["«„'`*]+|["»“'`*]+$/g, '')
    .replace(/[.。]+$/, '')
    .trim();
  return t ? clip(upFirst(t)) : '';
}

/** Без модели: первая фраза описания — лучше, чем «Введите название». */
export function titleFromText(md: string): string {
  const plain = plainOf(md);
  const first = plain.split(/\n+/).map((l) => l.trim()).find(Boolean) ?? '';
  const sentence = first.split(/(?<=[.!?])\s+/)[0] ?? first;
  return clip(upFirst(sentence.replace(/[.!?]+$/, '').trim()));
}
