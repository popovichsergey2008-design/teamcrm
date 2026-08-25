import { useMemo, useRef, useState } from 'react';
import { Avatar } from './Avatar';
import { activeQuery, MentionUser, suggest } from '../lib/mentions';

/**
 * Поле с упоминаниями через `@`.
 *
 * Подсказка открывается на `@` в начале слова и закрывается, как только строка
 * перестаёт совпадать хоть с кем-то: список, который висит всегда, начинают закрывать
 * не глядя. Разбор текста живёт в lib/mentions — там же он и проверяется.
 */

const MAX_SUGGESTIONS = 6;

export function MentionField({ value, users, onChange, onMention, placeholder, rows, onEnter, disabled, className }: {
  value: string;
  users: MentionUser[];
  onChange: (v: string) => void;
  /** Позвали человека — id уходит наверх, чтобы уехать с постом или комментарием. */
  onMention: (userId: string) => void;
  placeholder?: string;
  /** Больше одной строки — textarea, иначе однострочный input (комментарий). */
  rows?: number;
  onEnter?: () => void;
  disabled?: boolean;
  className?: string;
}) {
  const ref = useRef<HTMLTextAreaElement & HTMLInputElement>(null);
  const [caret, setCaret] = useState(0);
  const [active, setActive] = useState(0);
  const [open, setOpen] = useState(false);

  const found = useMemo(() => {
    if (!open) return [];
    const q = activeQuery(value, caret);
    return q ? suggest(users, q.query, MAX_SUGGESTIONS) : [];
  }, [open, value, caret, users]);

  const pick = (user: MentionUser) => {
    const q = activeQuery(value, caret);
    if (!q) return;
    const next = `${value.slice(0, q.start)}@${user.fullName} ${value.slice(caret)}`;
    onChange(next);
    onMention(user.id);
    setOpen(false);
    setActive(0);
    // возвращаем курсор сразу за вставленным именем, иначе он прыгает в конец
    const pos = q.start + user.fullName.length + 2;
    requestAnimationFrame(() => {
      ref.current?.focus();
      ref.current?.setSelectionRange(pos, pos);
      setCaret(pos);
    });
  };

  const keyDown = (e: React.KeyboardEvent) => {
    if (found.length) {
      if (e.key === 'ArrowDown') { e.preventDefault(); return setActive((i) => (i + 1) % found.length); }
      if (e.key === 'ArrowUp') { e.preventDefault(); return setActive((i) => (i - 1 + found.length) % found.length); }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); return pick(found[active]); }
      if (e.key === 'Escape') { e.preventDefault(); return setOpen(false); }
    }
    if (e.key === 'Enter' && !e.shiftKey && onEnter) { e.preventDefault(); onEnter(); }
  };

  const common = {
    ref,
    className: `input ${className ?? ''}`.trim(),
    placeholder,
    value,
    disabled,
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      onChange(e.target.value);
      setCaret(e.target.selectionStart ?? e.target.value.length);
      setOpen(true);
      setActive(0);
    },
    onKeyDown: keyDown,
    onKeyUp: (e: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      setCaret((e.target as HTMLInputElement).selectionStart ?? 0),
    onClick: (e: React.MouseEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      setCaret((e.target as HTMLInputElement).selectionStart ?? 0),
    // закрываем не мгновенно: щелчок по подсказке успевает сработать
    onBlur: () => setTimeout(() => setOpen(false), 150),
  };

  return (
    <div className="mention-wrap">
      {rows && rows > 1 ? <textarea {...common} rows={rows} /> : <input {...common} />}
      {found.length > 0 && (
        <ul className="mention-list" role="listbox">
          {found.map((u, i) => (
            <li key={u.id}>
              <button
                type="button"
                className={`mention-option${i === active ? ' mention-active' : ''}`}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pick(u)}
              >
                <Avatar path={u.avatarUrl ?? null} fallback={u.fullName[0]?.toUpperCase() ?? '?'} className="avatar-sm" />
                {u.fullName}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export type { MentionUser };
