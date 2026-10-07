import { useRef } from 'react';
import { enterAction } from '../lib/enter-key';

type Field = HTMLTextAreaElement | HTMLInputElement;

/**
 * Enter отправляет, Shift/Ctrl+Enter переносит строку — для любого поля сообщения.
 *
 * Возвращает обработчики для поля. onKeyDown отвечает true, если нажатие разобрано,
 * чтобы поле с подсказками (MentionField) не обрабатывало его второй раз.
 *
 * Диктовка и IME: пока текст не принят, отправлять нельзя — уйдёт сообщение без
 * последних слов. Поэтому ждём конца ввода (compositionend), а уже потом отправляем.
 * Отправку берём из ref: к этому моменту поле перерисовалось, и отправка видит полный
 * текст, а не тот, что был при нажатии.
 */
export function useEnterSend(onSend: (() => void) | undefined) {
  const sendRef = useRef(onSend);
  sendRef.current = onSend;
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fire = () => {
    if (pending.current) clearTimeout(pending.current);
    pending.current = null;
    // на следующем такте: принятый текст успевает попасть в состояние
    setTimeout(() => sendRef.current?.(), 0);
  };

  const onKeyDown = (e: React.KeyboardEvent<Field>): boolean => {
    const action = enterAction(e);
    if (!action) return false;
    if (action === 'newline') {
      // Shift+Enter браузер переносит сам; Ctrl+Enter — нет, вставляем перенос сами.
      // execCommand — чтобы React увидел ввод и работала отмена по Ctrl+Z.
      if ((e.ctrlKey || e.metaKey) && e.currentTarget instanceof HTMLTextAreaElement) {
        e.preventDefault();
        if (!document.execCommand('insertText', false, '\n')) {
          e.currentTarget.setRangeText('\n', e.currentTarget.selectionStart, e.currentTarget.selectionEnd, 'end');
          e.currentTarget.dispatchEvent(new Event('input', { bubbles: true }));
        }
      }
      return true;
    }
    if (!sendRef.current) return false;
    e.preventDefault();
    if (e.nativeEvent.isComposing) {
      // ждём конца диктовки; если система конец не сообщит — отправим сами
      if (pending.current) clearTimeout(pending.current);
      pending.current = setTimeout(fire, 400);
    } else if (e.key !== 'Enter') {
      fire(); // служебное нажатие без композиции — текст догонит на следующем такте
    } else {
      sendRef.current();
    }
    return true;
  };

  const onCompositionEnd = () => {
    if (pending.current) fire();
  };

  return { onKeyDown, onCompositionEnd };
}
