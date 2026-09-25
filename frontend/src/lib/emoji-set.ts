import { WORK_WORDS } from './emoji';

/**
 * Полный набор эмодзи: загрузка, русский словарь и прогрев.
 *
 * Набор — это отдельный кусок сборки почти на мегабайт, и грузить его при каждом входе
 * в CRM незачем: большинство дней проходит без единого смайла. Но и ждать его после
 * нажатия на кнопку — плохо: заказчик увидел «окно появляется с задержкой в секунду».
 *
 * Поэтому здесь две двери в одно и то же место:
 *
 *   `loadEmojiSet()` — то, чего ждёт палитра при открытии;
 *   `warmEmojiSet()` — тот же вызов, но заранее и в свободную минуту, когда человек
 *                      открыл чат. К нажатию всё уже разобрано, и палитра появляется
 *                      сразу.
 *
 * Работа делается РОВНО ОДИН РАЗ за сеанс: словарь подмешивается в данные, которые
 * библиотека потом держит у себя, и повторять слияние и на второе открытие незачем.
 */

/** Внутреннее устройство набора: нам нужны только знаки и их слова для поиска. */
interface EmojiData {
  emojis: Record<string, { keywords?: string[]; skins?: { native?: string }[] }>;
}

export interface EmojiSet {
  /** Конструктор палитры из библиотеки. */
  Picker: new (props: Record<string, unknown>) => unknown;
  /** Набор знаков с уже подмешанными русскими словами. */
  data: EmojiData;
  /** Названия разделов и подписи — по-русски. */
  i18n: unknown;
}

let pending: Promise<EmojiSet> | null = null;

/** Загрузить набор (или дождаться уже идущей загрузки). */
export function loadEmojiSet(): Promise<EmojiSet> {
  pending ??= (async () => {
    const [lib, dataModule, i18nModule, ruModule] = await Promise.all([
      import('emoji-mart'),
      import('@emoji-mart/data'),
      import('@emoji-mart/data/i18n/ru.json'),
      import('./emoji-ru.json'),
    ]);
    const data = (dataModule as unknown as { default: EmojiData }).default;
    mergeRussianWords(data, (ruModule as unknown as { default: Record<string, string> }).default);
    return {
      Picker: lib.Picker as unknown as EmojiSet['Picker'],
      data,
      i18n: (i18nModule as unknown as { default: unknown }).default,
    };
  })().catch((e) => {
    // Сорвалась загрузка — забываем обещание, чтобы следующая попытка началась заново,
    // а не получила навсегда сломанный результат.
    pending = null;
    throw e;
  });
  return pending;
}

/**
 * Начать загрузку заранее, в свободную минуту.
 *
 * Вызывается там, где палитра вот-вот понадобится, — на экране чатов и в обсуждении
 * задачи. Ошибку глушим намеренно: это подготовка, а не работа человека; если не
 * вышло, палитра попробует ещё раз при открытии.
 *
 * На экономном режиме сети не лезем: человек нарочно просил не тратить трафик.
 */
export function warmEmojiSet(): void {
  if (pending) return;
  const link = (navigator as { connection?: { saveData?: boolean } }).connection;
  if (link?.saveData) return;
  const later = window.requestIdleCallback ?? ((cb: () => void) => window.setTimeout(cb, 2000));
  later(() => { void loadEmojiSet().catch(() => undefined); });
}

/**
 * Подмешать русские слова в поисковый указатель.
 *
 * Ключ словаря — сам знак без «вариационных селекторов»: в разных наборах они стоят
 * по-разному, и сравнение «как есть» промахивается на каждом втором знаке.
 *
 * Русские слова встают ПЕРЕД английскими: библиотека сортирует выдачу по тому,
 * насколько рано слово встретилось в описании знака, и в хвосте они проигрывали
 * любому английскому совпадению.
 *
 * Поверх общего словаря ложатся рабочие слова (WORK_WORDS): у своего знака такое
 * слово идёт первым, у всех прочих вычёркивается — иначе на «готово» первым выпадает
 * маникюр, а «срочно» и «баг» не находятся вовсе.
 */
function mergeRussianWords(data: EmojiData, ru: Record<string, string>): void {
  const clean = (s: string) => s.replace(/[\uFE0E\uFE0F]/g, '');
  const owners = new Map<string, string[]>();
  for (const [word, native] of Object.entries(WORK_WORDS)) {
    const key = clean(native);
    owners.set(key, [...(owners.get(key) ?? []), word]);
  }
  const pinned = new Set(Object.keys(WORK_WORDS));

  for (const emoji of Object.values(data.emojis ?? {})) {
    const native = emoji.skins?.[0]?.native;
    if (!native) continue;
    const key = clean(native);
    const mine = owners.get(key) ?? [];
    const words = (ru[key] ?? '').split(' ').filter(Boolean);
    const rest = [...words, ...(emoji.keywords ?? [])]
      .filter((w) => !pinned.has(w) || mine.includes(w));
    emoji.keywords = [...new Set([...mine, ...rest])];
  }
}
