/**
 * Похожесть задач и склейка чек-листов — без ИИ.
 *
 * Зачем отдельно от модели: поиск дублей обязан работать всегда. Ключа может не
 * быть, провайдер может лежать, а человек уже нажал «Объединить» — показать ему
 * пустое окно значит сломать саму возможность. Поэтому здесь простая мера
 * похожести по словам, а эмбеддинги (когда они есть) её лишь усиливают.
 *
 * Мера — коэффициент Дайса по множествам слов: доля общих слов от их общего числа.
 * Она не понимает синонимов, зато не выдумывает: «добавить чат в карточку» и
 * «добавить обсуждение в карточку» получат честные проценты, а не догадку.
 */

/** Слова короче трёх букв и служебные — шум: по ним похоже вообще всё. */
const STOP = new Set([
  'и', 'в', 'во', 'на', 'по', 'с', 'со', 'к', 'у', 'о', 'об', 'от', 'для', 'из', 'за', 'при',
  'что', 'как', 'это', 'the', 'a', 'an', 'to', 'in', 'of', 'for', 'and',
  'нужно', 'надо', 'сделать', 'задача',
]);

/**
 * Слова текста: строчными, без знаков препинания.
 *
 * Окончания не режем: «чата» и «чат» останутся разными словами, и это честнее
 * самодельного стеммера, который однажды склеит «поиск» и «поиграть».
 */
export function words(text: string): string[] {
  return (text || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .split(' ')
    .filter((w) => w.length > 2 && !STOP.has(w));
}

/** Похожесть двух текстов, 0…1. */
export function similarity(a: string, b: string): number {
  const A = new Set(words(a));
  const B = new Set(words(b));
  if (!A.size || !B.size) return 0;
  let common = 0;
  for (const w of A) if (B.has(w)) common++;
  return (2 * common) / (A.size + B.size);
}

export interface TaskLike {
  id: string;
  title: string;
  description?: string | null;
}

export interface Scored {
  id: string;
  score: number;
  /** Почему эта задача здесь: человек не должен верить проценту на слово. */
  reason: string;
}

/**
 * Насколько задача похожа на образец и почему.
 *
 * Заголовок весит больше описания: дубли называются похоже, а описания у них
 * бывают и пустыми, и списком из двадцати строк, где совпадёт что угодно.
 */
export function scoreTask(base: TaskLike, other: TaskLike): Scored {
  const byTitle = similarity(base.title, other.title);
  const byBody = similarity(
    `${base.title} ${base.description ?? ''}`,
    `${other.title} ${other.description ?? ''}`,
  );
  const score = Math.min(1, byTitle * 0.7 + byBody * 0.5);
  const reason = byTitle >= 0.5 ? 'почти одинаковые названия'
    : byTitle >= 0.25 ? 'похожее название'
    : byBody >= 0.3 ? 'похожее описание'
    : 'есть общие слова';
  return { id: other.id, score, reason };
}

/** Совпадение в процентах — то, что видит человек. */
export const percent = (score: number): number => Math.max(1, Math.min(99, Math.round(score * 100)));

/**
 * Склейка чек-листов без дублей.
 *
 * «Добавить чат» и «Реализовать чат» — один и тот же пункт, написанный дважды.
 * Считаем пункты одинаковыми при высокой похожести слов; порог намеренно высокий:
 * потерять шаг работы хуже, чем оставить лишнюю строку.
 *
 * Порядок сохраняем: сначала пункты основной задачи, потом новое из второй —
 * человек читает чек-лист сверху вниз и ждёт, что его собственные шаги на месте.
 */
export function mergeChecklists(primary: string[], secondary: string[], threshold = 0.6): string[] {
  const out = primary.map((t) => t.trim()).filter(Boolean);
  for (const raw of secondary) {
    const item = raw.trim();
    if (!item) continue;
    const dup = out.some((kept) => kept.toLowerCase() === item.toLowerCase()
      || similarity(kept, item) >= threshold);
    if (!dup) out.push(item);
  }
  return out;
}

/**
 * Объединённое описание, когда модель недоступна.
 *
 * Просто склеиваем оба текста с подписью, откуда какой: потерять описание нельзя,
 * а придумывать за человека связный текст без модели — нельзя тем более.
 */
export function joinDescriptions(primary: string, secondary: string, secondaryNumber: string): string {
  const a = (primary || '').trim();
  const b = (secondary || '').trim();
  if (!b) return a;
  if (!a) return b;
  if (similarity(a, b) >= 0.85) return a; // одно и то же другими словами — второй раз не нужно
  return `${a}\n\n— из задачи #${secondaryNumber}:\n${b}`;
}
