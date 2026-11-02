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

/*
  Средний путь (#4712, 02.11): обычная голосовая постановка — 40–250 слов, а не 14.

  Замер на проде 26.10–02.11: такие записи шли полным путём (Kimi K3 с рассуждением)
  — 10–19 с на вызов модели, а длинная надиктовка с несколькими поручениями — два
  таких вызова подряд (счёт задач, потом разбор каждой): черновик через 17–58 с.

  Теперь:
  - поручение оформляет быстрая модель без рассуждения, с потолком; не успела — тот же
    полный путь, что и раньше (качество не хуже прежнего, только дольше);
  - деление на поручения — тоже быстрой моделью и коротким ответом: модель называет
    только первые слова каждого поручения, куски речи режем сами (дословно и без
    лишних токенов ответа), а оформляем все куски параллельно;
  - одиночный разбор всей фразы идёт одновременно с делением: поручение одно — он и
    есть ответ.
*/

/** Включён ли средний путь: выключить — NL_MID_PATH=0 (вернётся прежний полный разбор). */
export const NL_MID_ON = process.env.NL_MID_PATH !== '0';
/** Потолок быстрой модели на оформление одного поручения. */
export const NL_MID_BUDGET_MS = Number(process.env.NL_MID_BUDGET_MS ?? 8000);
/** Ответ на поручение: название, описание, шаги проверки. */
export const NL_MID_MAX_TOKENS = 900;
/** Потолок деления на поручения: ответ короткий, только начала кусков. */
export const NL_SPLIT_BUDGET_MS = Number(process.env.NL_SPLIT_BUDGET_MS ?? 6000);

const ANCHOR_WORDS = 4;
const norm = (w: string) => w.toLowerCase().replace(/ё/g, 'е');

/**
 * Разрезать речь по началам поручений, которые назвала модель («Глебу поправить форму…»).
 *
 * Ищем первые слова начала подряд (до четырёх, хватит и двух совпавших) в словах текста,
 * по порядку и без возврата назад. Не нашлось начало — его поручение пропадает из
 * разреза; нашлось меньше двух — резать нечего, вернём пустой список (дальше одна задача).
 * Кусок — от своего начала до начала следующего; текст ДО первого начала (общая часть:
 * «Сергею, в проект QEVO, на завтра») остаётся общим контекстом и сюда не входит.
 */
export function sliceByAnchors(text: string, anchors: string[]): { index: number; part: string }[] {
  const words = [...(text ?? '').matchAll(WORD)].map((m) => ({ w: norm(m[0]), at: m.index ?? 0 }));
  const found: { index: number; at: number }[] = [];
  let from = 0;
  anchors.forEach((a, index) => {
    const want = ((a ?? '').match(WORD) ?? []).slice(0, ANCHOR_WORDS).map(norm);
    if (!want.length) return;
    const need = Math.min(2, want.length);
    for (let i = from; i < words.length; i++) {
      let k = 0;
      while (k < want.length && i + k < words.length && words[i + k].w === want[k]) k++;
      if (k >= need) { found.push({ index, at: words[i].at }); from = i + k; return; }
    }
  });
  if (found.length < 2) return [];
  return found.map((f, i) => ({
    index: f.index,
    part: text.slice(f.at, i + 1 < found.length ? found[i + 1].at : text.length).trim(),
  })).filter((x) => x.part.length >= 3);
}
