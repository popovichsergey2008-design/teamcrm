import { Icon } from './Icon';
import { api } from '../lib/api';
import { showToast, toastSaved } from '../lib/notifications';
import { confirmAction } from './ui/dialog';
import type { SelMsg } from '../lib/chat-select';
import { canDeleteAll, selCopyText } from '../lib/chat-select-actions';

/**
 * Панель режима выделения (#4640, как в Telegram): «Выбрано: N» и действия над всеми
 * выбранными сразу. Встаёт на место поля ввода, грузится лениво — нужна, только
 * когда выделяют.
 *
 * «Удалить» — только если каждое выбранное можно удалить и по одному (своё): те же
 * права, что у одиночного удаления, и сервер проверяет их у каждого запроса.
 */
export function ChatSelectBar({ chatId, selected, userId, onForward, onDeleted, onDone }: {
  chatId: string;
  /** Выбранные — уже в порядке времени. */
  selected: SelMsg[];
  userId: string | number | null | undefined;
  onForward: () => void;
  onDeleted: (ids: Set<string>) => void;
  onDone: () => void;
}) {
  const n = selected.length;

  const copy = () => {
    void navigator.clipboard?.writeText(selCopyText(selected))
      .then(() => toastSaved('Скопировано', `Сообщений: ${n}`), () => undefined);
    onDone();
  };

  const remove = async () => {
    if (!(await confirmAction({ title: `Удалить сообщения (${n})?`, description: 'У собеседников они тоже исчезнут.', danger: true }))) return;
    const gone = new Set<string>();
    for (const m of selected) {
      try { await api.deleteMessage(chatId, String(m.id)); gone.add(String(m.id)); } catch { /* остальные — дальше */ }
    }
    onDeleted(gone);
    if (gone.size < n) showToast({ title: 'Удалены не все', body: `${gone.size} из ${n}`, section: 'chat' });
    onDone();
  };

  return (
    <div className="msg-selbar" role="toolbar" aria-label="Выбранные сообщения">
      <b>Выбрано: {n}</b>
      <button className="ui-btn ui-btn-primary ui-btn-sm" onClick={onForward}>
        <Icon name="reply" size={14} /> Переслать
      </button>
      <button className="ui-btn ui-btn-ghost ui-btn-sm" onClick={copy}>
        <Icon name="copy" size={14} /> Копировать текст
      </button>
      {canDeleteAll(selected, userId) && (
        <button className="ui-btn ui-btn-ghost ui-btn-sm" onClick={() => void remove()}>
          <Icon name="trash" size={14} /> Удалить
        </button>
      )}
      <button className="ui-btn ui-btn-ghost ui-btn-sm" onClick={onDone} title="Esc">Отмена</button>
    </div>
  );
}
