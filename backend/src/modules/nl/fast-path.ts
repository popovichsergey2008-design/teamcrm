import { splitCommand } from './split-command';

/*
  Быстрая постановка короткой фразы (#4666).

  Замер на проде 26.10 (голосовые задачи компании 2, Kimi K3 с рассуждением «low»):
  разбор одного поручения — 8–20 с на вызов модели, а вызовов было до пяти подряд:
  счёт задач и одиночный разбор в фоне записи, ТО ЖЕ САМОЕ ещё раз из окна (второй
  этап), потом подбор тегов. Фраза в несколько слов ставилась 25–40 секунд.

  Для короткой фразы работа модели — одна формулировка: даты, исполнитель, проект и
  согласование и так считаются правилами. Поэтому:
  - счёт задач не спрашиваем (в пять слов две задачи не помещаются, а явные
    разделители «и второе…» всё равно ловят правила);
  - формулировку — быстрой моделью без рассуждения, с потолком по времени: не успела
    — заголовок из фразы правилами, человек не ждёт;
  - теги — одновременно с разбором, с тем же потолком.
*/

/** Сколько слов ещё считается короткой командой («Сергею поправить вход на сайте к пятнице»). */
export const FAST_MAX_WORDS = 14;
export const FAST_MAX_CHARS = 140;

/** Потолок ожидания модели на быстром пути: дальше — правила. */
export const NL_FAST_BUDGET_MS = Number(process.env.NL_FAST_BUDGET_MS ?? 3500);
/** Ответу на короткую фразу хватает: название, пара строк описания, 3–5 шагов. */
export const NL_FAST_MAX_TOKENS = 450;

const WORD = /[0-9a-zа-яё]+/gi;

export function wordCount(text: string): number {
  return ((text ?? '').match(WORD) ?? []).length;
}

/** Короткая команда — одно поручение в несколько слов: её ставим быстрым путём. */
export function isShortCommand(text: string): boolean {
  const clean = (text ?? '').trim();
  if (clean.length < 3 || clean.length > FAST_MAX_CHARS) return false;
  if (wordCount(clean) > FAST_MAX_WORDS) return false;
  // явная нумерация или «вторая задача» — это пачка, её разбирает полный путь
  return splitCommand(clean).length < 2;
}

const DAY = '(?:завтра|сегодня|послезавтра|понедельник[а-я]*|вторник[а-я]*|сред[а-я]*|четверг[а-я]*|пятниц[а-я]*|суббот[а-я]*|воскресень[а-я]*|конц[а-я]*\\s+недели)';
const TAIL_DUE = new RegExp(`(?:[\\s,]+(?:к|до|на|в)\\s+${DAY}|[\\s,]+${DAY}|[\\s,]+срочно)+[\\s.!,]*$`, 'iu');
const HEAD_DUE = new RegExp(`^(?:срочно|${DAY})[\\s,]+`, 'iu');

/**
 * Заголовок короткой фразы без модели (модель не успела за потолок).
 *
 * «Сергею поправить кнопку входа к пятнице» → «Поправить кнопку входа»: исполнитель
 * и срок и так стоят в своих полях, в названии работы они лишние. Имя срезаем, только
 * если это кто-то из сотрудников (по началу имени), — иначе «Проверьте форму» лишилась
 * бы глагола.
 */
export function fastTitleFrom(text: string, people: string[] = []): string {
  let t = (text ?? '').replace(/\s+/g, ' ').trim().replace(/[.!]+$/, '');
  const stems = people
    .map((n) => (n ?? '').trim().split(/\s+/)[0]?.toLowerCase().replace(/ё/g, 'е') ?? '')
    .filter((n) => n.length >= 3)
    .map((n) => n.slice(0, Math.max(3, n.length - 2)));
  const head = t.match(/^(?:(?:на|для)\s+)?([А-ЯЁA-Zа-яёa-z][а-яёa-z-]*)[\s,:—-]+/u);
  if (head) {
    const w = head[1].toLowerCase().replace(/ё/g, 'е');
    if (stems.some((s) => w.startsWith(s))) t = t.slice(head[0].length);
  }
  t = t.replace(HEAD_DUE, '').replace(TAIL_DUE, '').trim();
  if (t.length < 3) t = (text ?? '').trim();
  return (t.charAt(0).toUpperCase() + t.slice(1)).slice(0, 255);
}

/** Журнал таймингов разбора (#4666): только длительности и признаки, без текста. */
export interface NlTiming {
  [k: string]: number | string | boolean | null | undefined;
}
