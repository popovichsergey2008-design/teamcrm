import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { Icon } from './Icon';
import { QUICK_REACTIONS } from '../lib/emoji';
import { loadEmojiSet } from '../lib/emoji-set';
import { placePopover } from '../lib/popover';
import { PHONE_MAX_PX } from '../hooks/useMediaQuery';

/**
 * Палитра эмодзи: полный набор Unicode (просьба заказчика — «как в Slack, чтобы был
 * полный комплект»).
 *
 * Знаки, разделы, тона кожи, поиск и ряд «часто используемые» приносит готовая
 * библиотека emoji-mart. Сам набор и русский словарь к нему живут в `lib/emoji-set`:
 * там же решается, когда их грузить, — обычно к моменту открытия палитры они уже
 * разобраны, потому что экран чата просит их заранее.
 *
 * Никаких загрузок со стороны: набор уезжает в нашу сборку, картинки не
 * подтягиваются, знаки рисует сам телефон или компьютер. Приложение работает без
 * сети, и палитра, которая без интернета пуста, там бесполезна.
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
    /*
      Слушаем на перехвате: поле поиска внутри палитры само обрабатывает Escape
      (очищает запрос) и дальше событие не пускает. Без перехвата палитра переставала
      закрываться с клавиатуры — а курсор в этом поле стоит сразу после открытия.
    */
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  useEffect(() => {
    let dead = false;
    let picker: HTMLElement | null = null;

    void (async () => {
      try {
        const { Picker, data, i18n } = await loadEmojiSet();
        if (dead) return;

        /*
          Тёмная палитра в светлой теме (и наоборот) выглядит чужой заплаткой, поэтому
          спрашиваем у самой страницы, в какой теме она сейчас. Цвета внутри задаёт
          app.css — здесь только выбор между светлым и тёмным набором значков.
        */
        const theme = document.documentElement.dataset.theme
          ?? (window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');

        picker = new Picker({
          data,
          i18n,
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
        // Набор не догрузился (нет сети, старый кэш) — работа не должна вставать:
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
