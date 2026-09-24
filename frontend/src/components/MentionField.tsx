import { useEffect, useMemo, useRef, useState } from 'react';
import { Avatar } from './Avatar';
import { htmlToMd } from '../lib/rich-text';
import { activeQuery, MentionUser, suggest } from '../lib/mentions';

/**
 * Поле с упоминаниями через `@`.
 *
 * Подсказка открывается на `@` в начале слова и закрывается, как только строка
 * перестаёт совпадать хоть с кем-то: список, который висит всегда, начинают закрывать
 * не глядя. Разбор текста живёт в lib/mentions — там же он и проверяется.
 */

const MAX_SUGGESTIONS = 6;

export function MentionField({
  value, users, onChange, onMention, placeholder, rows, autoGrow, onEnter, disabled, className, focusKey,
}: {
  value: string;
  users: MentionUser[];
  onChange: (v: string) => void;
  /** Позвали человека — id уходит наверх, чтобы уехать с постом или комментарием. */
  onMention: (userId: string) => void;
  placeholder?: string;
  /** Больше одной строки — textarea, иначе однострочный input (комментарий). */
  rows?: number;
  /**
   * Поле растёт под текст, как в мессенджерах.
   *
   * В однострочном поле длинное сообщение уезжает влево: написанного не видно, а
   * перечитать перед отправкой нельзя — приходится гонять курсор стрелками. Предел
   * роста задан в CSS (max-height), дальше поле прокручивается.
   */
  autoGrow?: boolean;
  onEnter?: () => void;
  disabled?: boolean;
  className?: string;
  /**
   * Смена значения переводит курсор в поле.
   *
   * Нужно там, где действие происходит НЕ в поле: нажал «Ответить» в меню сообщения —
   * и сразу пиши. Раньше курсор оставался на странице, человек начинал печатать, и
   * текст уходил в никуда (жалоба заказчика).
   */
  focusKey?: number;
}) {
  const ref = useRef<HTMLTextAreaElement & HTMLInputElement>(null);

  /*
    Фокус по просьбе снаружи. Курсор ставим В КОНЕЦ набранного: человек продолжает
    писать, а не переписывает начатое.
  */
  useEffect(() => {
    if (!focusKey) return;
    const el = ref.current;
    if (!el) return;
    el.focus();
    const end = el.value.length;
    try { el.setSelectionRange(end, end); } catch { /* input без выделения — не беда */ }
  }, [focusKey]);

  const [caret, setCaret] = useState(0);
  const [active, setActive] = useState(0);
  const [open, setOpen] = useState(false);

  /*
    Высоту пересчитываем на каждое изменение текста, а не только при вводе с
    клавиатуры: сообщение приходит и извне — вставкой из буфера, выбором упоминания,
    очисткой после отправки. Сначала «auto», иначе scrollHeight помнит прежнюю высоту
    и поле умеет только расти.
  */
  useEffect(() => {
    if (!autoGrow) return;
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [autoGrow, value]);

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
    /*
      Вставка из Word, Google Docs, почты или с сайта.

      В буфере лежит и HTML, и плоский текст. Браузер по умолчанию берёт плоский —
      и вместе с ним пропадают списки, жирный, заголовки: приходит стена слов.
      Берём HTML и переводим его в ту же разметку, которой живут описания задач
      (`**жирный**`, `- пункт`), — сообщение потом показывается со списками и
      абзацами, а в базе остаётся читаемый текст.

      Если HTML нет (скопировали из блокнота) — не вмешиваемся вовсе: пусть работает
      обычная вставка со всеми её привычками, включая отмену по Ctrl+Z.
    */
    onPaste: (e: React.ClipboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      const html = e.clipboardData?.getData('text/html');
      if (!html?.trim()) return;
      const md = htmlToMd(new DOMParser().parseFromString(html, 'text/html').body);
      if (!md.trim()) return;
      e.preventDefault();
      const el = e.currentTarget;
      const from = el.selectionStart ?? value.length;
      const to = el.selectionEnd ?? from;
      const next = `${value.slice(0, from)}${md}${value.slice(to)}`;
      onChange(next);
      // курсор — за вставленным куском: человек продолжает печатать с этого места
      requestAnimationFrame(() => {
        const pos = from + md.length;
        el.setSelectionRange(pos, pos);
        setCaret(pos);
      });
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
      {autoGrow || (rows && rows > 1)
        ? <textarea {...common} rows={rows ?? 1} />
        : <input {...common} />}
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
                <span className="mention-name">{u.fullName}</span>
                {/* Роль в задаче: по одному имени не понять, к кому обращаться
                    с вопросом «когда будет», а к кому — «так делать?». */}
                {u.hint && <span className="mention-hint">{u.hint}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export type { MentionUser };
