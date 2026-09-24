import { useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from './Icon';
import { EMOJI_GROUPS, recentEmoji, rememberEmoji, searchEmoji } from '../lib/emoji';
import { placePopover } from '../lib/popover';

/**
 * Палитра эмодзи — как в Slack (просьба заказчика: «почти сотня, а не шесть»).
 *
 * Шесть быстрых реакций остаются на виду в меню сообщения: ими ставят в девяти
 * случаях из десяти, и лезть за ними в палитру — лишний шаг. Всё остальное живёт
 * здесь: поиск по русским словам, разделы и ряд «недавние» — человек ставит одно и то
 * же, и это должно лежать первым.
 *
 * Палитра одна на все места: реакция на сообщение и вставка в текст. Две разные
 * палитры разошлись бы content'ом на первой же правке.
 */
export function EmojiPicker({ at, onPick, onClose }: {
  /** Откуда открыли: координаты на экране (как у меню сообщения). */
  at: { x: number; y: number };
  onPick: (emoji: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const [group, setGroup] = useState(EMOJI_GROUPS[0].key);
  const [recent, setRecent] = useState<string[]>(() => recentEmoji());
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    searchRef.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const found = useMemo(() => (query.trim() ? searchEmoji(query) : null), [query]);
  const current = EMOJI_GROUPS.find((g) => g.key === group) ?? EMOJI_GROUPS[0];
  const place = placePopover({ left: at.x, top: at.y, bottom: at.y }, 340, window.innerWidth, 300, window.innerHeight);

  const pick = (emoji: string) => {
    setRecent(rememberEmoji(emoji));
    onPick(emoji);
    onClose();
  };

  return (
    <>
      <span className="msg-ctx-veil" onClick={onClose} onContextMenu={(e) => { e.preventDefault(); onClose(); }} />
      <div
        className="emoji-pop"
        role="dialog"
        aria-label="Выбор эмодзи"
        style={{ left: place.x, top: place.y, transform: place.up ? 'translateY(-100%)' : undefined }}
        onClick={(e) => e.stopPropagation()}
      >
        <input
          ref={searchRef}
          className="input input-sm emoji-search"
          placeholder="Поиск: огонь, готово, спасибо…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />

        {!query.trim() && (
          <div className="emoji-tabs" role="tablist">
            {EMOJI_GROUPS.map((g) => (
              <button
                key={g.key}
                className={`emoji-tab${g.key === group ? ' on' : ''}`}
                role="tab"
                aria-selected={g.key === group}
                title={g.title}
                onClick={() => setGroup(g.key)}
              >
                {g.icon}
              </button>
            ))}
          </div>
        )}

        <div className="emoji-body">
          {!query.trim() && recent.length > 0 && (
            <>
              <div className="emoji-title">Недавние</div>
              <div className="emoji-grid">
                {recent.map((e) => (
                  <button key={`r-${e}`} className="emoji-btn" onClick={() => pick(e)} title={e}>{e}</button>
                ))}
              </div>
            </>
          )}

          <div className="emoji-title">{query.trim() ? 'Найдено' : current.title}</div>
          <div className="emoji-grid">
            {(found ?? current.items).map((it) => (
              <button key={it.e} className="emoji-btn" onClick={() => pick(it.e)} title={it.words[0]}>
                {it.e}
              </button>
            ))}
          </div>
          {found && !found.length && (
            <div className="dim emoji-empty">
              <Icon name="search" size={14} /> Ничего не нашлось — попробуйте другое слово
            </div>
          )}
        </div>
      </div>
    </>
  );
}
