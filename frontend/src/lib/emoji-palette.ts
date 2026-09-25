import { loadEmojiSet, type EmojiSet } from './emoji-set';

/**
 * Палитра эмодзи, ОДНА на весь сеанс.
 *
 * Почему общая, а не своя на каждое открытие. Библиотека рисует знаки раздела не
 * заранее, а когда до него доходят: в замерах первый заход в «Символы» стоил почти
 * секунду, второй — полсекунды, третий — пятьдесят миллисекунд. Пока палитра
 * создавалась заново на каждое нажатие, этот счёт начинался с нуля каждый раз — именно
 * это заказчик и описал словами «по категориям гуляешь, и всё подгружается с
 * задержкой».
 *
 * Поэтому палитра строится однажды, в свободную минуту обходит все разделы и дальше
 * живёт в стороне от экрана. Открыть её — это передвинуть готовую коробку на нужное
 * место, а не собрать заново.
 *
 * Прятать можно только через `display: none`: библиотека считает уход из документа
 * концом жизни (`disconnectedCallback` разбирает внутренности), и вернуть такую
 * палитру обратно уже нельзя. По той же причине коробка НЕ переезжает между
 * родителями — двигаются только её координаты.
 *
 * Пока коробка спрятана, она не участвует в раскладке страницы: полторы тысячи кнопок
 * в `display: none` браузеру ничего не стоят, кроме памяти.
 */

/*
  Спрятанное положение — за краем экрана, но В РАСКЛАДКЕ.

  Через `display: none` было бы дешевле, но тогда у ленты знаков нулевая высота,
  наблюдатель библиотеки сообщает «не видно ни одного ряда», и всё нарисованное
  выбрасывается. В замерах разница решающая: у палитры, которая осталась в раскладке,
  обход всех разделов занимает 380 мс, у спрятанной насовсем — 3100 мс, как у только
  что созданной.

  Платить за это почти нечем: одновременно библиотека держит около двухсот кнопок —
  те, что попадают в видимую часть ленты, — а не весь набор.
*/
const HIDDEN = 'display:block;left:-10000px;top:0';

interface Palette {
  /** Коробка, которую двигаем по экрану. */
  box: HTMLDivElement;
  /** Сама палитра из библиотеки. */
  picker: HTMLElement;
  /** Тема, под которую она построена: сменилась — строим заново. */
  theme: 'light' | 'dark';
}

let palette: Palette | null = null;
let building: Promise<Palette> | null = null;
/** Куда отдать выбранный знак: меняется на каждое открытие. */
let deliver: ((emoji: string) => void) | null = null;
/** Палитра сейчас на экране: пока это так, фоновый обход разделов ждёт. */
let shown = false;
/** Прогрев уже назначен: свободная минута наступает не сразу, а звать могут не раз. */
let warmed = false;

export interface PalettePlace {
  x: number;
  y: number;
  width: number;
  height: number;
  /** Раскрываемся вверх: коробку сдвигает translateY(-100%), как у прочих всплывашек. */
  up: boolean;
}

/** Светлая или тёмная — спрашиваем у самой страницы. */
function currentTheme(): 'light' | 'dark' {
  const set = document.documentElement.dataset.theme;
  if (set === 'light' || set === 'dark') return set;
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

async function build(): Promise<Palette> {
  const set: EmojiSet = await loadEmojiSet();
  const theme = currentTheme();

  const box = document.createElement('div');
  box.className = 'emoji-pop emoji-pop-full';
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-label', 'Выбор эмодзи');
  /*
    Пока палитра убрана, она остаётся в раскладке — а значит, её кнопки попадали бы под
    Tab и в чтение экранным диктором. `inert` убирает и то, и другое, но не трогает
    размеры: прогрев по разделам работает как прежде (нажатия из кода проходят).
  */
  box.inert = true;
  box.setAttribute('aria-hidden', 'true');
  /*
    Прогреваемся ЗА краем экрана, но в раскладке: у спрятанной через `display: none`
    ленты нулевая высота, и библиотека не нарисует ни одного ряда — весь смысл обхода
    разделов при этом пропадает.
  */
  box.style.cssText = HIDDEN;
  box.style.setProperty('--emoji-w', '352px');
  box.style.setProperty('--emoji-h', '420px');

  const host = document.createElement('div');
  host.className = 'emoji-host';
  box.appendChild(host);

  const picker = new set.Picker({
    data: set.data,
    i18n: set.i18n,
    locale: 'ru',
    theme,
    // Знаки рисует система: картинки со стороннего адреса не тянем.
    set: 'native',
    // Ширину задаёт наша коробка, а не число знаков в ряду.
    dynamicWidth: true,
    previewPosition: 'none',
    skinTonePosition: 'search',
    navPosition: 'top',
    maxFrequentRows: 2,
    // Курсор ставим сами и после появления палитры — см. `focusPaletteSearch`.
    autoFocus: false,
    onEmojiSelect: (e: { native?: string }) => { if (e?.native) deliver?.(e.native); },
  }) as unknown as HTMLElement;

  host.appendChild(picker);
  document.body.appendChild(box);

  return { box, picker, theme };
}

/**
 * Палитра, построенная ровно один раз.
 *
 * Обещание держим в переменной, а не строим по запросу: и прогрев, и открытие зовут
 * эту же дверь, и без общего обещания они успевали построить по своей палитре — на
 * экране оказывалось два набора разделов.
 */
function ensurePalette(): Promise<Palette> {
  if (palette) return Promise.resolve(palette);
  building ??= build()
    .then((p) => {
      palette = p;
      building = null;
      walkCategories(p);
      return p;
    })
    .catch((e) => { building = null; throw e; });
  return building;
}

/**
 * Построить палитру заранее и обойти разделы, пока человек занят другим.
 *
 * Вызывается там, где палитра вот-вот понадобится, — на экране чатов и в обсуждении
 * задачи. На экономном режиме сети не лезем: человек нарочно просил не тратить трафик.
 */
export function warmPalette(): void {
  if (warmed || palette || building) return;
  const link = (navigator as { connection?: { saveData?: boolean } }).connection;
  if (link?.saveData) return;
  warmed = true;
  idle(() => { void ensurePalette().catch(() => undefined); });
}

/**
 * Обойти разделы, пока палитра за краем экрана.
 *
 * Это и есть главная подготовка: после такого обхода вход в раздел стоит полсотни
 * миллисекунд вместо полусекунды. За краем экрана он почти бесплатен — знаки не
 * рисуются на экране, а библиотека всё равно запоминает, что ей считать.
 *
 * Между разделами обязательно ждём кадр: о попадании ряда в видимую часть библиотека
 * узнаёт от наблюдателя, а тот срабатывает только после раскладки. Пройти всё одним
 * циклом — значит подготовить лишь последний раздел.
 *
 * Пока палитра открыта, обход ждёт: иначе человек увидел бы, как разделы
 * переключаются сами собой.
 */
function walkCategories(p: Palette): void {
  let tabs: HTMLElement[] = [];
  let i = 0;
  let tries = 0;

  const next = () => requestAnimationFrame(() => requestAnimationFrame(step));

  const step = () => {
    if (shown) { idle(step); return; }
    if (!tabs.length) {
      tabs = [...(p.picker.shadowRoot?.querySelectorAll('#nav button') ?? [])] as HTMLElement[];
      // Палитра собирается не мгновенно; ждём её, но не бесконечно.
      if (!tabs.length) { if (tries++ < 40) idle(step); return; }
    }
    if (i < tabs.length) { tabs[i++].click(); next(); return; }
    scrollToTop(p);
  };

  idle(step);
}

/** Показать палитру на месте всплывашки. Вернёт false, если набор не догрузился. */
export async function showPalette(place: PalettePlace, onPick: (emoji: string) => void): Promise<boolean> {
  deliver = onPick;
  try {
    // Тема сменилась на ходу — старую палитру выбрасываем: перекрасить её нечем.
    if (palette && palette.theme !== currentTheme()) {
      palette.box.remove();
      palette = null;
    }
    if (!palette) await ensurePalette();
  } catch {
    return false;
  }

  const p = palette;
  if (!p) return false;
  shown = true;
  resetSearch(p);
  scrollToTop(p);

  p.box.inert = false;
  p.box.removeAttribute('aria-hidden');
  p.box.style.cssText = 'display:block';
  p.box.style.left = `${place.x}px`;
  p.box.style.top = `${place.y}px`;
  if (place.up) p.box.style.transform = 'translateY(-100%)';
  p.box.style.setProperty('--emoji-w', `${place.width}px`);
  p.box.style.setProperty('--emoji-h', `${place.height}px`);
  return true;
}

/** Убрать палитру с экрана, не разрушая её. */
export function hidePalette(): void {
  deliver = null;
  shown = false;
  if (palette) hide(palette);
}

function hide(p: Palette): void {
  p.box.inert = true;
  p.box.setAttribute('aria-hidden', 'true');
  p.box.style.cssText = HIDDEN;
}

/** Поставить курсор в поиск (только на большом экране — см. вызывающий код). */
export function focusPaletteSearch(): void {
  const input = palette?.picker.shadowRoot?.querySelector('input[type="search"]');
  (input as HTMLInputElement | null)?.focus();
}

/**
 * Очистить прошлый запрос.
 *
 * Палитра живёт между открытиями, и набранное в прошлый раз слово осталось бы в
 * поиске — человек увидел бы три знака вместо набора и решил, что всё сломалось.
 * Значение меняем «как из клавиатуры»: библиотека слушает событие ввода, а не поле.
 */
function resetSearch(p: Palette): void {
  const input = p.picker.shadowRoot?.querySelector('input[type="search"]') as HTMLInputElement | null;
  if (!input?.value) return;
  input.value = '';
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function scrollToTop(p: Palette): void {
  const scroller = p.picker.shadowRoot?.querySelector('.scroll');
  if (scroller) (scroller as HTMLElement).scrollTop = 0;
}

/** Свободная минута браузера; где такого нет (Safari) — просто немного погодя. */
function idle(cb: (deadline?: IdleDeadline) => void): void {
  if (window.requestIdleCallback) window.requestIdleCallback(cb);
  else window.setTimeout(() => cb(), 1200);
}
