import { Icon } from './Icon';

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
  missing: { code: string; text: string }[];
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
  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal-card gate-card" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Приёмка работы">
        <h3 className="gate-title"><Icon name="alert" size={18} /> Работа сдаётся не полностью</h3>
        <div className="dim gate-hint">
          Задача уходит в «{block.column}». Проверяющий увидит только то, что есть в карточке:
        </div>
        <ul className="gate-list">
          {block.missing.map((m) => (
            <li key={m.code}><Icon name="close" size={13} /> {m.text}</li>
          ))}
        </ul>
        <div className="gate-actions">
          <button className="btn btn-primary" onClick={onCancel} disabled={busy}>Вернуться и дополнить</button>
          <button className="btn btn-sm gate-force" onClick={onForce} disabled={busy}>Сдать всё равно</button>
        </div>
      </div>
    </div>
  );
}
