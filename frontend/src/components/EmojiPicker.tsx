import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { Icon } from './Icon';
import { QUICK_REACTIONS, WORK_WORDS } from '../lib/emoji';
import { placePopover } from '../lib/popover';
import { PHONE_MAX_PX } from '../hooks/useMediaQuery';

/**
 * Палитра эмодзи: полный набор Unicode (просьба заказчика — «как в Slack, чтобы был
 * полный комплект»).
 *
 * Берём готовую библиотеку emoji-mart: почти две тысячи знаков, разделы, тона кожи,
 * ряд «часто используемые» и поиск. Своими силами такой набор не поддержать — Unicode
 * пополняется каждый год, и список, набитый руками, устаревает с первого же дня.
 *
 * Два решения, которые пришлось принять отдельно.
 *
 * 1. Поиск по-РУССКИ. Библиотека ищет по английским словам («fire», «check mark»), а
 *    в рабочей переписке набирают «огонь» и «готово». Русские названия подмешиваем в
 *    данные перед запуском: словарь собран заранее (scripts/build-emoji-ru.mjs) и
 *    лежит рядом готовым файлом.
 *
 * 2. Никаких загрузок со стороны. Набор и словарь уезжают в сборку, картинки не
 *    подтягиваются: знаки рисует сам телефон или компьютер. Приложение работает без
 *    сети, и палитра, которая без интернета пуста, там бесполезна.
 *
 * Сама библиотека грузится отдельным куском и только при первом открытии палитры:
 * это треть мегабайта, и платить за неё при каждом входе в CRM незачем.
 */
export function EmojiPicker({ at, onPick, onClose }: {
  /** Откуда открыли: координаты на экране (как у меню сообщения). */
  at: { x: number; y: number };
  onPick: (emoji: string) => void;
  onClose: () => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);

  /*
    Обработчики приходят новыми на каждую перерисовку родителя (набор текста в поле
    ввода перерисовывает всю страницу чатов). Если положить их в зависимости эффекта,
    палитра будет пересобираться на каждую букву и терять введённый поиск, поэтому
    храним их в ссылке, а эффект запускаем ровно один раз.
  */
  const handlers = useRef({ onPick, onClose });
  handlers.current = { onPick, onClose };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') handlers.current.onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    let dead = false;
    let picker: HTMLElement | null = null;

    void (async () => {
      try {
        const [{ Picker }, dataModule, i18nModule, ruModule] = await Promise.all([
          import('emoji-mart'),
          import('@emoji-mart/data'),
          import('@emoji-mart/data/i18n/ru.json'),
          import('../lib/emoji-ru.json'),
        ]);
        if (dead) return;

        const data = (dataModule as unknown as { default: EmojiData }).default;
        const ru = (ruModule as unknown as { default: Record<string, string> }).default;
        mergeRussianWords(data, ru);

        /*
          Тёмная палитра в светлой теме (и наоборот) выглядит чужой заплаткой, поэтому
          спрашиваем у самой страницы, в какой теме она сейчас. Цвета внутри задаёт
          app.css — здесь только выбор между светлым и тёмным набором значков.
        */
        const theme = document.documentElement.dataset.theme
          ?? (window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');

        picker = new Picker({
          data,
          i18n: (i18nModule as unknown as { default: unknown }).default,
          locale: 'ru',
          theme: theme === 'light' ? 'light' : 'dark',
          // Знаки рисует система: картинки со стороннего адреса не тянем.
          set: 'native',
          // Ширину задаёт наша коробка, а не число знаков в ряду.
          dynamicWidth: true,
          previewPosition: 'none',
          skinTonePosition: 'search',
          navPosition: 'top',
          maxFrequentRows: 2,
          /*
            Курсор в поиск ставим только на большом экране. На телефоне это поднимает
            клавиатуру, и та закрывает половину палитры — человек открыл её, чтобы
            выбрать знак глазами, а не печатать.
          */
          autoFocus: window.innerWidth > PHONE_MAX_PX,
          onEmojiSelect: (e: { native?: string }) => {
            if (!e?.native) return;
            handlers.current.onPick(e.native);
            handlers.current.onClose();
          },
        }) as unknown as HTMLElement;

        host.current?.replaceChildren(picker);
      } catch {
        // Кусок не догрузился (нет сети, старый кэш) — работа не должна вставать:
        // показываем быстрый ряд, им отвечают в девяти случаях из десяти.
        if (!dead) setFailed(true);
      }
    })();

    return () => { dead = true; picker?.remove(); };
  }, []);

  /*
    Размер палитры постоянный: всплывашка, меняющая высоту по ходу поиска, читается
    как поломка. Но на телефоне окно уже палитры, поэтому размер ещё и ужимается по
    экрану — иначе правый край уезжает за пределы видимого.
  */
  const width = Math.min(352, window.innerWidth - 16);
  const height = Math.min(420, window.innerHeight - 16);
  const place = placePopover({ left: at.x, top: at.y, bottom: at.y }, height, window.innerWidth, width, window.innerHeight);

  return (
    <>
      <span className="msg-ctx-veil" onClick={onClose} onContextMenu={(e) => { e.preventDefault(); onClose(); }} />
      <div
        className={failed ? 'emoji-pop' : 'emoji-pop emoji-pop-full'}
        role="dialog"
        aria-label="Выбор эмодзи"
        style={{
          left: place.x,
          top: place.y,
          transform: place.up ? 'translateY(-100%)' : undefined,
          ['--emoji-w' as string]: `${width}px`,
          ['--emoji-h' as string]: `${height}px`,
        } as CSSProperties}
        onClick={(e) => e.stopPropagation()}
      >
        {failed ? (
          <div className="emoji-fallback">
            <div className="dim emoji-empty">
              <Icon name="alert" size={14} /> Полный набор не загрузился — вот частые:
            </div>
            <div className="emoji-grid">
              {QUICK_REACTIONS.map((e) => (
                <button key={e} className="emoji-btn" onClick={() => { onPick(e); onClose(); }}>
                  {e}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div ref={host} className="emoji-host" />
        )}
      </div>
    </>
  );
}

/** Внутреннее устройство набора: нам нужны только знаки и их слова для поиска. */
interface EmojiData {
  emojis: Record<string, { keywords?: string[]; skins?: { native?: string }[] }>;
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
