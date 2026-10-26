import { createHash } from 'crypto';

/**
 * Отчёт «было/стало» (#4657): правила без модели.
 *
 * Всё, что можно посчитать кодом, считается здесь — и потому проверяется тестами:
 * на какие пункты делится задача, какой снимок «было», какой «стало», к какому
 * пункту он относится и что в итоге сказать человеку. Модель только смотрит снимки
 * и говорит своё мнение по каждому пункту; последнее слово о вердикте — за кодом
 * (урок «Проверить ИИ»: просьбами в промпте модель от обвинений не отучается).
 */

/** Не больше стольких пунктов: длиннее отчёт уже не «пробежать глазами». */
export const MAX_ITEMS = 20;

export type ItemSource = 'checklist' | 'list' | 'ai' | 'whole';
export type Side = 'before' | 'after';
/**
 * Вердикт пункта.
 *
 * `no_result` и `eyes` ставит только код: «результат не приложен» — факт о материалах,
 * а «проверьте глазами» — честный ответ, когда смотреть было некому (нет модели или
 * она не видит картинок). Выдавать за проверку то, чего никто не смотрел, нельзя.
 */
export type Verdict = 'fixed' | 'not_fixed' | 'unclear' | 'no_result' | 'eyes';

/**
 * Роль снимка в отчёте (#4657, жалоба заказчика: «скрины давались как пример, а он
 * думает, что это „было“»).
 *
 * - `before` — текущий вид, часто со стрелками и обводками: колонка «Было»;
 * - `example` — образец или макет того, как должно стать: показываем отдельно
 *   («Образец от постановщика»), в «Было» не кладём, пункт он «без результата» не делает;
 * - `reference` — просто справка; `none` — человек сказал «не относится»;
 * - `after` — результат: колонка «Стало».
 *
 * Кто решил: правила, модель или человек руками. Человек главнее модели, модель — правил.
 */
export type ShotRole = 'before' | 'example' | 'reference' | 'after' | 'none';
/** Роли, которые человек выбирает руками во вкладке: «Было / Образец / Стало / Не относится». */
export type ManualRole = 'before' | 'example' | 'after' | 'none';
export const MANUAL_ROLES: readonly ManualRole[] = ['before', 'example', 'after', 'none'];
export type RoleBy = 'rule' | 'model' | 'manual';
/**
 * Что за задача: `visual` — правки текста и вида, сравниваем снимки; `functional` —
 * пункты это критерии приёмки функции, результат — код и выкладка, снимков «стало»
 * не требуем: отчёт — чек-лист приёмки.
 */
export type CheckKind = 'visual' | 'functional';

export interface Shot {
  fileId: string;
  name: string;
  mime: string;
  /** Кто приложил — для подписи под снимком. */
  by: string | null;
  at: string | null;
  /** Откуда снимок: описание, вложение, сообщение в обсуждении, наш снимок страницы. */
  origin: 'description' | 'attachment' | 'comment' | 'page';
  /** Текст рядом со снимком: подпись сообщения или alt картинки в описании. */
  caption?: string | null;
  /** Адрес страницы — у снимков, которые сделали мы. */
  url?: string | null;
  /** Роль снимка; у старых отчётов её нет — значит, по стороне. */
  role?: ShotRole;
  roleBy?: RoleBy;
}

export interface RawItem {
  title: string;
  /** Продолжение пункта в описании — строки под ним до следующего пункта. */
  detail?: string;
  done?: boolean | null;
  /** Картинки описания, стоящие сразу под этим пунктом. */
  descImages?: string[];
}

export interface Change { from: string | null; to: string | null }

export interface CheckItem {
  n: number;
  title: string;
  detail: string | null;
  source: ItemSource;
  /** Отметка чек-листа — показываем, но доказательством не считаем. */
  done: boolean | null;
  change: Change | null;
  before: Shot[];
  after: Shot[];
  verdict: Verdict;
  reason: string;
}

export interface CheckSummary {
  total: number;
  fixed: number;
  notFixed: number;
  /** «Проверьте сами»: не удалось проверить + смотреть было некому. */
  check: number;
  noResult: number;
}

// ───────────── описание задачи → строки ─────────────

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", nbsp: ' ', laquo: '«', raquo: '»', mdash: '—', ndash: '–' };

function decode(s: string): string {
  return s.replace(/&(#\d+|#x[\da-f]+|\w+);/gi, (m, code: string) => {
    if (ENTITIES[code.toLowerCase()] !== undefined) return ENTITIES[code.toLowerCase()];
    if (/^#x/i.test(code)) return String.fromCodePoint(parseInt(code.slice(2), 16));
    if (/^#\d+$/.test(code)) return String.fromCodePoint(Number(code.slice(1)));
    return m;
  });
}

/** Картинка описания — отдельной строкой-меткой: по её месту видно, к какому пункту она. */
const IMG_TOKEN = /^\[\[img:(\d+)\]\]$/;

/**
 * Описание задачи (HTML редактора или простой текст) → строки.
 *
 * Пункты списка получают маркер «• » или номер, картинки `img[data-file-id]` —
 * метку `[[img:N]]` своей строкой. Остальная разметка снимается.
 */
export function descriptionLines(html: string | null | undefined): string[] {
  let s = String(html ?? '');
  if (!s.trim()) return [];
  // нумерация <ol>: номер считаем сами, браузер его не пишет в разметку
  s = s.replace(/<ol\b[^>]*>([\s\S]*?)<\/ol>/gi, (_m, inner: string) => {
    let i = 0;
    return inner.replace(/<li\b[^>]*>/gi, () => `\n${++i}. `);
  });
  s = s
    .replace(/<img\b[^>]*data-file-id="(\d+)"[^>]*>/gi, '\n[[img:$1]]\n')
    .replace(/<li\b[^>]*>/gi, '\n• ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|ul|ol|blockquote|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, '');
  return decode(s).split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
}

/** Текст описания без разметки — для модели и для отпечатка. */
export function descriptionText(html: string | null | undefined): string {
  return descriptionLines(html).filter((l) => !IMG_TOKEN.test(l)).join('\n');
}

/** id картинок описания по порядку. */
export function descriptionImageIds(html: string | null | undefined): string[] {
  return descriptionLines(html).map((l) => IMG_TOKEN.exec(l)?.[1]).filter((x): x is string => !!x);
}

/**
 * Текст рядом с каждой картинкой описания: ближайшая строка до неё (подряд идущие
 * картинки делят одну подпись — «Образец отчёта:» и три скрина) и строка сразу после.
 */
export function descriptionImageContext(html: string | null | undefined): Map<string, string> {
  const lines = descriptionLines(html);
  const out = new Map<string, string>();
  lines.forEach((l, i) => {
    const id = IMG_TOKEN.exec(l)?.[1];
    if (!id) return;
    let prev = '';
    for (let j = i - 1; j >= 0; j--) if (!IMG_TOKEN.test(lines[j])) { prev = lines[j]; break; }
    const next = lines[i + 1] && !IMG_TOKEN.test(lines[i + 1]) ? lines[i + 1] : '';
    out.set(id, `${prev} ${next}`.trim());
  });
  return out;
}

const LIST_LINE = /^(?:\d{1,2}\s*[.)]|[-–—•*·▪●])\s+(.+)$/;

/** Название пункта: первая фраза, без хвостовых знаков, не длиннее 160 знаков. */
function titleOf(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim().replace(/[;,.]+$/, '');
  return t.length > 160 ? `${t.slice(0, 157).trimEnd()}…` : t;
}

/**
 * Пункты правок по правилам: чек-лист, иначе список в описании.
 *
 * `source: null` — правила пунктов не нашли: делить описание будет модель, а без
 * неё задача пойдёт одним пунктом целиком. Картинки описания, стоящие до первого
 * пункта, возвращаются отдельно — они «было» без привязки.
 */
export function splitItems(input: {
  checklist: { text: string; done: boolean }[];
  description: string | null | undefined;
}): { items: RawItem[]; source: ItemSource | null; looseImages: string[] } {
  const lines = descriptionLines(input.description);
  const allImages = lines.map((l) => IMG_TOKEN.exec(l)?.[1]).filter((x): x is string => !!x);

  const checklist = input.checklist.filter((c) => String(c.text ?? '').trim());
  if (checklist.length) {
    return {
      items: checklist.slice(0, MAX_ITEMS).map((c) => ({ title: titleOf(c.text), done: !!c.done })),
      source: 'checklist',
      looseImages: allImages,
    };
  }

  const items: RawItem[] = [];
  const loose: string[] = [];
  for (const line of lines) {
    const img = IMG_TOKEN.exec(line)?.[1];
    const cur = items[items.length - 1];
    if (img) {
      if (cur) (cur.descImages ??= []).push(img);
      else loose.push(img);
      continue;
    }
    const m = LIST_LINE.exec(line);
    if (m) { items.push({ title: titleOf(m[1]), detail: '', descImages: [] }); continue; }
    // строка под пунктом — его продолжение («на главной, в мобильной версии тоже»)
    if (cur) cur.detail = `${cur.detail ? `${cur.detail} ` : ''}${line}`.slice(0, 600);
  }
  if (items.length >= 2) {
    return {
      items: items.slice(0, MAX_ITEMS).map((i) => ({ ...i, detail: i.detail || undefined })),
      source: 'list',
      looseImages: [...loose, ...items.slice(MAX_ITEMS).flatMap((i) => i.descImages ?? [])],
    };
  }
  return { items: [], source: null, looseImages: allImages };
}

/** Ответ модели на «раздели описание на пункты»: JSON-массив строк или нумерованный список. */
export function parseSplit(raw: string): string[] {
  const text = String(raw ?? '').trim();
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start >= 0 && end > start) {
    try {
      const arr = JSON.parse(text.slice(start, end + 1));
      if (Array.isArray(arr)) {
        return arr.map((x) => titleOf(String(typeof x === 'object' && x ? (x as { title?: string }).title ?? '' : x ?? '')))
          .filter(Boolean).slice(0, MAX_ITEMS);
      }
    } catch { /* ниже — разбор списком */ }
  }
  return text.split('\n').map((l) => LIST_LINE.exec(l.trim())?.[1]).filter((x): x is string => !!x)
    .map(titleOf).slice(0, MAX_ITEMS);
}

// ───────────── «Было: … → Стало: …» ─────────────

const Q_OPEN = '[«"“„\']';
const Q_CLOSE = '[»"”“\']';
const QUOTED = `${Q_OPEN}([^«»"“”„]{1,200})${Q_CLOSE}`;
const CHANGE_RULES: { re: RegExp; removed?: boolean }[] = [
  { re: new RegExp(`(?:замени\\p{L}*|поменя\\p{L}*|измени\\p{L}*|исправ\\p{L}*|переименов\\p{L}*)\\s+(?:текст\\s+|надпись\\s+|слово\\s+|фразу\\s+)?${QUOTED}\\s+на\\s+${QUOTED}`, 'iu') },
  { re: new RegExp(`вместо\\s+${QUOTED}\\s*[,:—–-]?\\s*(?:\\S+\\s+){0,2}?${QUOTED}`, 'iu') },
  { re: new RegExp(`был[оа]?\\s*:?\\s*${QUOTED}[,;.]?\\s*(?:стал[оа]?|станет|должно быть|нужно|надо)\\s*:?\\s*${QUOTED}`, 'iu') },
  { re: new RegExp(`${QUOTED}\\s*(?:→|->|=>|⟶)\\s*${QUOTED}`, 'u') },
  { re: new RegExp(`(?:убра\\p{L}*|удали\\p{L}*|скры\\p{L}*)\\s+(?:текст\\s+|надпись\\s+|слово\\s+|фразу\\s+|блок\\s+)?${QUOTED}`, 'iu'), removed: true },
];

/**
 * Прежний и новый текст из формулировки пункта: «заменить «А» на «Б»», «вместо «А» — «Б»»,
 * «было «А», стало «Б»», «А → Б», «убрать «А»». Не нашли — null, строку «Было → Стало»
 * тогда заполнит модель тем, что прочитала на снимках, или её не будет вовсе.
 */
export function parseChange(text: string | null | undefined): Change | null {
  const s = String(text ?? '');
  for (const r of CHANGE_RULES) {
    const m = r.re.exec(s);
    if (!m) continue;
    if (r.removed) return { from: m[1].trim(), to: '' };
    return { from: m[1].trim(), to: m[2].trim() };
  }
  return null;
}

// ───────────── чьи материалы: было или стало ─────────────

export interface MaterialFile {
  fileId: string;
  name: string;
  mime: string;
  uploadedBy: string | null;
  uploaderName: string | null;
  at: Date;
  /** Текст сообщения, с которым файл пришёл в обсуждение (если пришёл так). */
  caption?: string | null;
}

export interface People {
  creatorId: string | null;
  /** Исполнитель и соисполнители. */
  doers: Set<string>;
  /** Граница по времени — только для задачи «сам себе». */
  boundary: Date | null;
  /** Файлы, приложенные ИИ-агентом: это всегда результат. */
  agentFiles: Set<string>;
  /** Картинки описания — это всегда постановка. */
  descriptionFiles: Set<string>;
}

/**
 * Сторона файла.
 *
 * Описание — постановка. Файлы агента — результат. Остальное решает автор: исполнитель
 * и соисполнители приносят результат, постановщик и все прочие (руководитель со
 * своими стрелками на скриншоте) — замечания. Если задачу человек поставил себе сам,
 * по автору не отличить — тогда решает время: до начала работы — «было», после — «стало».
 */
export function sideOf(f: MaterialFile, p: People): Side {
  if (p.descriptionFiles.has(f.fileId)) return 'before';
  if (p.agentFiles.has(f.fileId)) return 'after';
  const by = f.uploadedBy ? String(f.uploadedBy) : null;
  const selfTask = !p.creatorId || p.doers.has(String(p.creatorId)) || !p.doers.size;
  if (selfTask) {
    if (!p.boundary) return 'before';
    return f.at.getTime() < p.boundary.getTime() ? 'before' : 'after';
  }
  return by && p.doers.has(by) ? 'after' : 'before';
}

export const isImage = (mime: string | null | undefined) => /^image\/(png|jpe?g|webp|gif)$/i.test(String(mime ?? ''));

// ───────────── роль снимка постановщика ─────────────

/**
 * Слова «это образец»: пример, образец, макет, как должно, так должно, референс, по аналогии.
 * «Например» — не образец: перед «пример» не должно быть букв.
 */
const EXAMPLE_RE = /(?<!\p{L})(?:пример\p{L}*|образ(?:ец|ц\p{L}*)|макет\p{L}*|мокап\p{L}*|mock-?up|референс\p{L}*|reference|как\s+должн\p{L}*|так\s+должн\p{L}*|по\s+аналогии)/iu;
/** Слова про приложенные картинки — «образец на скринах», «во вложении — макет». */
const ATTACH_RE = /(?<!\p{L})(?:скрин\p{L}*|скриншот\p{L}*|снимк\p{L}*|снимок|вложени\p{L}*|прилож\p{L}*|картинк\p{L}*|изображени\p{L}*|ниже|файл\p{L}*)/iu;

/** Говорит ли текст, что картинка — образец. */
export function saysExample(text: string | null | undefined): boolean {
  return EXAMPLE_RE.test(String(text ?? ''));
}

/**
 * Описание задачи прямо называет вложения образцом: в одной строке есть и «пример /
 * образец / макет…», и «скрин / вложение / картинка…» («Образец отчёта — на скринах»).
 */
export function descriptionCallsExample(descText: string | null | undefined): boolean {
  return String(descText ?? '').split(/\n|(?<=[.!?])\s+/).some((l) => saysExample(l) && ATTACH_RE.test(l));
}

/**
 * Роль снимка постановщика по правилам (без модели).
 *
 * Стрелки и обводки мы не распознаём, поэтому решают только слова: подпись снимка или
 * строка описания рядом с ним говорит «пример/образец/макет…» — образец; описание
 * называет вложения образцом — образец; иначе, как и раньше, «было».
 */
export function ruleRole(input: { context?: string | null; descriptionCallsExample?: boolean }): 'before' | 'example' {
  if (saysExample(input.context)) return 'example';
  if (input.descriptionCallsExample) return 'example';
  return 'before';
}

/**
 * Итоговая роль снимка до ответа модели: руками — главнее всего; результат исполнителя
 * без ручной правки — «стало»; материалы постановщика — по правилам.
 */
export function initialRole(side: Side, manual: ManualRole | null | undefined, rule: 'before' | 'example'): { role: ShotRole; by: RoleBy } {
  if (manual) return { role: manual, by: 'manual' };
  if (side === 'after') return { role: 'after', by: 'rule' };
  return { role: rule, by: 'rule' };
}

// ───────────── визуальная правка или приёмка функции ─────────────

/** Пункт начинается с проверки: «Открыть…», «Убедиться, что…», «Проверить…», «Принять/отклонить». */
const ACCEPT_START = /^(?:открыть|открыв|запустить|запуск|убедиться|проверить|проверка|принять|отклонить|протестировать|тест|нажать|зайти|войти|выбрать|дождаться|сдать|перевести|создать|отправить|загрузить|посмотреть|сравнить)(?!\p{L})/iu;
/** Глагол правки текста или вида. */
const EDIT_VERB = /(?<!\p{L})(?:замени\p{L}*|поменя\p{L}*|измени\p{L}*|исправ\p{L}*|убра\p{L}*|удали\p{L}*|переименов\p{L}*|сдвину\p{L}*|выровня\p{L}*|перекрас\p{L}*|увеличи\p{L}*|уменьши\p{L}*|поправ\p{L}*|скры\p{L}*)/iu;
/** Что правят на экране. */
const UI_NOUN = /(?<!\p{L})(?:заголов\p{L}*|подзаголов\p{L}*|иконк\p{L}*|кнопк\p{L}*|текст\p{L}*|надпис\p{L}*|цвет\p{L}*|шрифт\p{L}*|отступ\p{L}*|логотип\p{L}*|картинк\p{L}*|фон\p{L}*|баннер\p{L}*|карточк\p{L}*|подпис\p{L}*|опечатк\p{L}*|вёрстк\p{L}*|верстк\p{L}*|правк\p{L}*|блок[аеиуо]?м?|страниц\p{L}*|сайт\p{L}*)(?!\p{L})/iu;

/** Похож ли пункт на правку текста или вида (а не на критерий приёмки функции). */
export function looksVisual(text: string | null | undefined): boolean {
  const t = String(text ?? '').trim();
  if (!t) return false;
  if (parseChange(t)) return true;
  if (ACCEPT_START.test(t)) return false;
  return EDIT_VERB.test(t) || UI_NOUN.test(t);
}

/**
 * Тип задачи по правилам: снимков «было» нет и ни один пункт не похож на правку текста
 * или вида — это приёмка функции. Иначе — визуальные правки, как раньше.
 */
export function kindByRules(items: { title: string; detail?: string | null }[], beforeShots: number): CheckKind {
  if (beforeShots > 0) return 'visual';
  return items.some((i) => looksVisual(i.title) || looksVisual(i.detail)) ? 'visual' : 'functional';
}

// ───────────── к какому пункту снимок ─────────────

const STOP = new Set(['было', 'стало', 'надо', 'нужно', 'чтобы', 'сделать', 'этот', 'этой', 'этого', 'который', 'которая', 'также', 'тоже', 'будет',
  'сейчас', 'только', 'после', 'перед', 'можно', 'когда', 'снимок', 'скрин', 'скриншот', 'image', 'screenshot', 'photo']);

/** Значимые слова: от четырёх букв, грубая основа — первые пять букв (падежи не мешают). */
function stems(text: string): Set<string> {
  const out = new Set<string>();
  for (const w of String(text ?? '').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
    if (w.length < 4 || STOP.has(w) || /^\d+$/.test(w)) continue;
    out.add(w.slice(0, 5));
  }
  return out;
}

/** Номер пункта, названный рядом со снимком: «п. 2», «пункт 2», «№2», «#2», «2.» в начале. */
export function mentionedNumber(text: string | null | undefined): number | null {
  const s = String(text ?? '');
  const m = /(?:^|[\s(])(?:п\.?|пункт|№|#)\s*(\d{1,2})(?!\d)/i.exec(s) ?? /^\s*(\d{1,2})\s*[.)]\s/.exec(s);
  return m ? Number(m[1]) : null;
}

/**
 * Разложить снимки одной стороны по пунктам.
 *
 * Правила по силе: картинка описания под пунктом; названный номер; общие слова
 * подписи и пункта (у одного пункта больше всех); поровну — по порядку. Что не легло — «без привязки»,
 * его может разложить модель. Пункт один — все снимки его.
 */
export function matchShots(
  items: { title: string; detail?: string | null; descImages?: string[] }[],
  shots: Shot[],
): { byItem: Shot[][]; loose: Shot[] } {
  const byItem: Shot[][] = items.map(() => []);
  if (!items.length) return { byItem, loose: [...shots] };
  if (items.length === 1) return { byItem: [[...shots]], loose: [] };

  const left: Shot[] = [];
  const itemStems = items.map((i) => stems(`${i.title} ${i.detail ?? ''}`));
  for (const s of shots) {
    const byDesc = items.findIndex((i) => i.descImages?.includes(s.fileId));
    if (byDesc >= 0) { byItem[byDesc].push(s); continue; }
    const n = mentionedNumber(s.caption) ?? mentionedNumber(s.name.replace(/\.\w+$/, ' '));
    if (n && n >= 1 && n <= items.length) { byItem[n - 1].push(s); continue; }
    const st = stems(`${s.caption ?? ''} ${s.name.replace(/\.\w+$/, '').replace(/[_-]+/g, ' ')}`);
    // больше всех общих слов — к этому пункту; ничья — не угадываем
    const scores = itemStems.map((is) => [...st].filter((w) => is.has(w)).length);
    const top = Math.max(...scores);
    if (top > 0 && scores.filter((x) => x === top).length === 1) { byItem[scores.indexOf(top)].push(s); continue; }
    left.push(s);
  }
  // поровну и ни одной привязки — снимки идут тем же порядком, что пункты
  if (left.length === items.length && byItem.every((b) => !b.length)) {
    return { byItem: left.map((s) => [s]), loose: [] };
  }
  return { byItem, loose: left };
}

// ───────────── отпечаток: изменилось ли что-нибудь ─────────────

/** Отпечаток материалов: тот же — значит, новая проверка ничего нового не скажет. */
export function fingerprint(parts: unknown): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

// ───────────── ответ модели ─────────────

export interface ModelItem {
  n: number;
  verdict: 'fixed' | 'not_fixed' | 'unclear';
  reason: string;
  from: string | null;
  to: string | null;
  beforeShots: number[];
  afterShots: number[];
}

export interface ModelShotRole { shot: number; role: 'before' | 'example' | 'reference' }

export interface ParsedCheck {
  items: ModelItem[];
  summary: string;
  /** Тип задачи по мнению модели; не сказала или сказала непонятно — null, решат правила. */
  kind: CheckKind | null;
  /** Роли снимков постановщика: только известные номера, только известные роли. */
  roles: ModelShotRole[];
}

/**
 * Разбор ответа проверяющей модели. Не JSON или пусто — null: честная неудача лучше выдумки.
 *
 * `shotCount` — сколько снимков ей показали; роль снимка с чужим номером отбрасываем,
 * `canRole(n)` — можно ли модели решать роль этого снимка (результат исполнителя и
 * роль, выбранную человеком руками, она не переопределяет).
 */
export function parseCheck(
  raw: string, itemCount: number, shotCount = 0, canRole: (n: number) => boolean = () => true,
): ParsedCheck | null {
  const text = String(raw ?? '');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let obj: Record<string, unknown>;
  try { obj = JSON.parse(text.slice(start, end + 1)); } catch { return null; }
  const rows = Array.isArray(obj.items) ? (obj.items as Record<string, unknown>[]) : [];
  const nums = (v: unknown) => (Array.isArray(v) ? v.map(Number).filter((x) => Number.isInteger(x) && x > 0) : []);
  const str = (v: unknown, max: number) => {
    const s = typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '';
    return s ? s.slice(0, max) : null;
  };
  const seen = new Set<number>();
  const items: ModelItem[] = [];
  for (const r of rows) {
    const n = Number(r?.n);
    if (!Number.isInteger(n) || n < 1 || n > itemCount || seen.has(n)) continue;
    seen.add(n);
    const v = String(r?.verdict ?? '');
    items.push({
      n,
      verdict: v === 'fixed' || v === 'not_fixed' ? v : 'unclear',
      reason: str(r?.reason, 300) ?? '',
      from: str(r?.from, 200),
      to: str(r?.to, 200),
      beforeShots: nums(r?.before_shots ?? r?.beforeShots),
      afterShots: nums(r?.after_shots ?? r?.afterShots),
    });
  }
  if (!items.length) return null;
  const k = String(obj.kind ?? '').toLowerCase();
  const kind: CheckKind | null = k === 'visual' || k === 'functional' ? k : null;
  const roles: ModelShotRole[] = [];
  const roleSeen = new Set<number>();
  const rawRoles = Array.isArray(obj.shot_roles ?? obj.shotRoles) ? (obj.shot_roles ?? obj.shotRoles) as Record<string, unknown>[] : [];
  for (const r of rawRoles) {
    const n = Number(r?.shot ?? r?.n);
    const role = String(r?.role ?? '').toLowerCase();
    if (!Number.isInteger(n) || n < 1 || n > shotCount || roleSeen.has(n) || !canRole(n)) continue;
    if (role !== 'before' && role !== 'example' && role !== 'reference') continue;
    roleSeen.add(n);
    roles.push({ shot: n, role });
  }
  return { items, summary: str(obj.summary, 400) ?? '', kind, roles };
}

/**
 * Видит ли ответившая модель картинки.
 *
 * Запрос со снимками может уйти по фолбэку в модель без зрения — она ответит
 * уверенно и наугад. Поэтому решаем по модели, которая ОТВЕТИЛА, а не которую просили.
 */
export function seesImages(model: string | null | undefined): boolean {
  const m = String(model ?? '').toLowerCase();
  if (!m || m.startsWith('mock')) return false;
  if (/^kimi-k3/.test(m)) return true;
  if (/^kimi/.test(m)) return false;
  if (/(^|\/)(gpt-4o|gpt-4\.1|gpt-5|o\d|claude|gemini)/.test(m)) return true;
  return /vision|vl\b|-vl-/.test(m);
}

/**
 * Последнее слово о вердикте — за кодом, но мнение модели не глушим молча.
 *
 * - нет ни одного материала «стало» по пункту и нет общих — «результат не приложен»;
 *   но если модель с объяснением считает пункт выполненным (видела образец, отчёт),
 *   показываем «стоит посмотреть» с её словами: пусть решит человек;
 * - смотреть было некому (нет модели) — «проверьте глазами»;
 * - модель не видит картинок, а у пункта, кроме картинок, ничего — «проверьте глазами»;
 * - «не исправлено» без причины — не вывод, а «не удалось проверить».
 */
export function settleVerdict(input: {
  model: ModelItem | null;
  hasModel: boolean;
  modelSees: boolean;
  /** У пункта есть свои снимки «стало». */
  hasAfterShots: boolean;
  /** Есть текст «стало» (отчёт исполнителя, документ агента) или общие снимки «стало». */
  hasAfterOther: boolean;
  kind?: CheckKind;
}): { verdict: Verdict; reason: string } {
  const functional = input.kind === 'functional';
  if (!input.hasAfterShots && !input.hasAfterOther) {
    const m = input.model;
    if (input.hasModel && m && m.verdict === 'fixed' && m.reason) {
      return { verdict: 'unclear', reason: `ИИ считает, что пункт выполнен: ${m.reason} Результата исполнителя в задаче нет — посмотрите сами.` };
    }
    return {
      verdict: 'no_result',
      reason: functional ? 'Исполнитель не написал, что проверил этот пункт, и не приложил результат.' : 'Нет ни снимка, ни отчёта исполнителя по этому пункту.',
    };
  }
  if (!input.hasModel || !input.model) {
    const what = functional ? 'проверьте пункт по отчёту исполнителя сами' : 'сравните снимки сами';
    return {
      verdict: 'eyes',
      reason: input.hasModel ? `ИИ не ответил по этому пункту — ${what}.` : `ИИ не подключён — ${what}.`,
    };
  }
  if (!input.modelSees && input.hasAfterShots && !input.hasAfterOther) {
    return { verdict: 'eyes', reason: 'Модель компании не умеет смотреть снимки — сравните их сами.' };
  }
  const m = input.model;
  if (m.verdict === 'not_fixed' && !m.reason) return { verdict: 'unclear', reason: 'Не удалось понять по материалам.' };
  return { verdict: m.verdict, reason: m.reason || (m.verdict === 'fixed' ? 'По материалам видно, что правка внесена.' : 'Не удалось понять по материалам.') };
}

/**
 * Стоит ли проверять самим после сдачи.
 *
 * Нужен результат: снимок «стало» — или отчёт исполнителя (сообщение, документ) при
 * снимках «было». Образцы постановщика ни «стало», ни «было» не считаются: задача с
 * одними макетами и без единого слова исполнителя дала бы отчёт «результат не
 * приложен» (#4657). Задача без единой картинки — по кнопке, а не сама.
 */
export function autoWorthy(c: { before: unknown[]; after: unknown[]; afterMessages: unknown[]; afterDocs: unknown[] }): boolean {
  if (c.after.length) return true;
  return c.before.length > 0 && (c.afterMessages.length > 0 || c.afterDocs.length > 0);
}

// ───────────── итог и сообщения ─────────────

export function summarize(items: { verdict: Verdict }[]): CheckSummary {
  const s: CheckSummary = { total: items.length, fixed: 0, notFixed: 0, check: 0, noResult: 0 };
  for (const i of items) {
    if (i.verdict === 'fixed') s.fixed++;
    else if (i.verdict === 'not_fixed') s.notFixed++;
    else if (i.verdict === 'no_result') s.noResult++;
    else s.check++;
  }
  return s;
}

function plural(n: number, one: string, few: string, many: string): string {
  const d = n % 10;
  const dd = n % 100;
  return d === 1 && dd !== 11 ? one : d >= 2 && d <= 4 && (dd < 12 || dd > 14) ? few : many;
}

/** «1 правка», «2 правки», «5 правок». */
export function edits(n: number): string {
  return `${n} ${plural(n, 'правка', 'правки', 'правок')}`;
}

/** «1 пункт», «2 пункта», «5 пунктов» — для чек-листа приёмки. */
export function points(n: number): string {
  return `${n} ${plural(n, 'пункт', 'пункта', 'пунктов')}`;
}

/** «из 1 правки», «из 6 правок» — после «из» всегда родительный падеж. */
export function ofEdits(n: number): string {
  return `из ${n} ${n % 10 === 1 && n % 100 !== 11 ? 'правки' : 'правок'}`;
}

/** «из 1 пункта», «из 6 пунктов». */
export function ofPoints(n: number): string {
  return `из ${n} ${n % 10 === 1 && n % 100 !== 11 ? 'пункта' : 'пунктов'}`;
}

/** Части итога: «2 исправлено, 1 не внесено, 1 без результата, 1 стоит посмотреть». */
function parts(s: CheckSummary, kind: CheckKind): string[] {
  const out: string[] = [];
  if (s.fixed) out.push(`${s.fixed} ${kind === 'functional' ? 'подтверждено' : 'исправлено'}`);
  if (s.notFixed) out.push(`${s.notFixed} ${kind === 'functional' ? 'не выполнено' : 'не внесено'}`);
  if (s.noResult) out.push(`${s.noResult} без результата`);
  if (s.check) out.push(`${s.check} стоит посмотреть`);
  return out;
}

/** Строка над отчётом: «Мы проверили 6 правок: 4 исправлено, 2 стоит посмотреть». */
export function headline(s: CheckSummary, kind: CheckKind = 'visual'): string {
  const p = parts(s, kind);
  if (kind === 'functional') return `Чек-лист приёмки, ${points(s.total)}${p.length ? `: ${p.join(', ')}` : ''}`;
  if (s.total && s.noResult === s.total) return `${edits(s.total)} — результат пока не приложен`;
  return `Мы проверили ${edits(s.total)}: ${p.join(', ') || 'нечего сравнивать'}`;
}

/**
 * Нашли ли ошибки: только невнесённая правка. «Результата нет» — не ошибка в работе,
 * а нехватка материалов: так и говорим, без слова «ошибки».
 */
export function hasProblems(s: CheckSummary): boolean {
  return s.notFixed > 0;
}

/** Есть ли что попросить у исполнителя: пункты без результата. */
export function needsResult(s: CheckSummary): boolean {
  return s.noResult > 0;
}

/** Текст «Попросить результат» — комментарий исполнителю в обсуждение задачи. */
export const ASK_RESULT_TEXT = 'Приложите, пожалуйста, как стало — скрин или ссылку, чтобы проверить по пунктам';

/**
 * Сообщение по итогам — то, ради чего заказчик просил функцию: «Посмотрите, мы
 * проверили и нашли/не нашли ошибки». Честно:
 * - «нашли ошибки» — ТОЛЬКО когда есть невнесённые пункты;
 * - у всех пунктов нет результата — «проверять нечего», а не «ошибки»;
 * - смешанный случай — по числам: «2 исправлено, 1 без результата, 1 стоит посмотреть»;
 * - без модели не притворяемся проверившими.
 */
export function resultMessage(s: CheckSummary, mode: 'ai' | 'eyes', kind: CheckKind = 'visual'): string {
  const fn = kind === 'functional';
  const of = fn ? ofPoints : ofEdits;
  if (s.total && s.noResult === s.total) return 'Исполнитель пока не приложил результат — проверять нечего.';
  if (s.notFixed > 0) {
    const rest = [s.noResult ? `${s.noResult} без результата` : '', s.check ? `${s.check} стоит посмотреть` : ''].filter(Boolean);
    return `Посмотрите, мы проверили и нашли ошибки: ${s.notFixed} ${of(s.total)} ${fn ? 'не выполнены' : 'не внесены'}`
      + `${rest.length ? `; ещё ${rest.join(', ')}` : ''}.`;
  }
  if (mode === 'eyes') {
    const head = fn
      ? `Мы собрали чек-лист приёмки по ${s.total === 1 ? 'одному пункту' : `${s.total} пунктам`} — ИИ не подключён, проверьте пункты по отчёту исполнителя.`
      : `Мы собрали отчёт «было/стало» по ${s.total === 1 ? 'одной правке' : `${s.total} правкам`} — ИИ не подключён, сравните снимки глазами.`;
    return s.noResult ? `${head} По ${s.noResult} ${of(s.total)} результат пока не приложен.` : head;
  }
  if (s.noResult > 0) return `Посмотрите, что получилось: ${parts(s, kind).join(', ')}.`;
  if (s.check > 0) return `Посмотрите, мы проверили: ошибок не нашли, но ${s.check} ${of(s.total)} стоит посмотреть глазами.`;
  return fn
    ? `Посмотрите, мы проверили: ${s.fixed} ${of(s.total)} подтверждены отчётом исполнителя.`
    : `Посмотрите, мы проверили и не нашли ошибок: ${s.fixed} ${of(s.total)} внесены.`;
}

/** Замечания исполнителю — для «Вернуть на доработку»: невнесённые пункты и пункты без результата. */
export function remarksText(items: { n: number; title: string; verdict: Verdict; reason: string }[]): string {
  const bad = items.filter((i) => i.verdict === 'not_fixed' || i.verdict === 'no_result');
  if (!bad.length) return '';
  const head = bad.some((i) => i.verdict === 'not_fixed')
    ? 'По отчёту «было/стало» не внесены правки:'
    : 'По отчёту «было/стало» нет результата по пунктам:';
  return [head, ...bad.map((i) => `${i.n}. ${i.title}${i.reason ? ` — ${i.reason}` : ''}`)].join('\n');
}

// ───────────── ссылки для снимка страницы ─────────────

/**
 * Ссылки на страницы из текста: http(s), без хвостовой пунктуации, без наших
 * собственных адресов (ссылка на задачу — не сайт, который правили), не больше `max`.
 */
export function pageUrls(texts: string[], ownHosts: string[], max = 2): string[] {
  const out: string[] = [];
  const own = new Set(ownHosts.map((h) => h.toLowerCase()));
  for (const t of texts) {
    for (const m of String(t ?? '').matchAll(/https?:\/\/[^\s<>"'«»()]+/gi)) {
      const url = m[0].replace(/[.,;:!?)\]]+$/, '');
      let host = '';
      try { host = new URL(url).hostname.toLowerCase(); } catch { continue; }
      if (own.has(host) || own.has(host.replace(/^www\./, ''))) continue;
      // файлы, а не страницы, — снимать нечего
      if (/\.(png|jpe?g|gif|webp|pdf|docx?|xlsx?|zip|mp4|mov)(\?|$)/i.test(url)) continue;
      if (!out.includes(url)) out.push(url);
      if (out.length >= max) return out;
    }
  }
  return out;
}
