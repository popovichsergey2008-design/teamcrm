import { Icon } from './Icon';
import { overlayProps } from '../lib/overlay';
import { useEscape } from '../hooks/useEscape';

/**
 * Приёмка работы: что мешает сдать задачу.
 *
 * Диалог намеренно НЕ запирает. Он говорит вслух то, что иначе выяснилось бы через день
 * в переписке («а что сделано-то?»), и оставляет решение человеку: половина задач
 * заканчивается звонком или встречей, и файла у них не бывает по природе.
 *
 * Кнопка «Сдать всё равно» — не лазейка: обход пишется в историю задачи, и проверяющий
 * видит, чего не хватало. Тихий обход был бы хуже запрета.
 */

export interface GateBlock {
  column: string;
  missing: { code: string; text: string; blocking?: boolean }[];
  /** Есть нехватка, которую обойти нельзя: постановщик не принимает без чек-листа. */
  blocking?: boolean;
}

/** Достаём подробности гейта из ответа сервера; не гейт — вернём null. */
export function gateFromError(details: unknown): GateBlock | null {
  const gate = (details as { gate?: GateBlock } | undefined)?.gate;
  return gate && Array.isArray(gate.missing) && gate.missing.length ? gate : null;
}

export function HandoffGateDialog({ block, busy, onCancel, onForce }: {
  block: GateBlock;
  busy?: boolean;
  onCancel: () => void;
  onForce: () => void;
}) {
  // Escape — то же, что «Вернуться к задаче»: ничего не сдаём
  useEscape(onCancel, !busy);
  /*
    Обязательный чек-лист (задача #1386): тут не «сдать всё равно», а прямое «нельзя» —
    и почему. Исполнитель должен понять правило сразу, а не из возврата задачи.
  */
  const locked = block.blocking || block.missing.some((m) => m.blocking);
  return (
    <div className="modal-overlay" {...overlayProps(onCancel)}>
      <div className="modal-card gate-card" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Приёмка работы">
        <h3 className="gate-title">
          <Icon name={locked ? 'lock' : 'alert'} size={18} /> {locked ? 'Задачу нельзя сдать' : 'Работа сдаётся не полностью'}
        </h3>
        {locked && (
          <div className="gate-locked">
            Постановщик не принимает эту задачу без выполненного чек-листа. Отметьте все
            пункты — тогда задачу можно будет сдать.
          </div>
        )}
        <div className="dim gate-hint">
          Задача уходит в «{block.column}». Проверяющий увидит только то, что есть в карточке:
        </div>
        <ul className="gate-list">
          {block.missing.map((m) => (
            <li key={m.code}><Icon name="close" size={13} /> {m.text}</li>
          ))}
        </ul>
        <div className="gate-actions">
          <button className="ui-btn ui-btn-primary ui-btn-md" onClick={onCancel} disabled={busy}>
            {locked ? 'Вернуться к чек-листу' : 'Вернуться и дополнить'}
          </button>
          {!locked && <button className="ui-btn ui-btn-outline ui-btn-sm gate-force" onClick={onForce} disabled={busy}>Сдать всё равно</button>}
        </div>
      </div>
    </div>
  );
}
