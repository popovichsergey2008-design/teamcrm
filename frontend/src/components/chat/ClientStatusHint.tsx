import { useState } from 'react';
import { Icon } from '../Icon';
import { ApiError } from '../../lib/api';
import { clientChatApi, Suggestion } from './client-chat-api';
import './client-chat-panel.css';

/**
 * «Ответить статусом задач» в чате с клиентом (#4902, п. 15).
 *
 * ИИ предлагает ответ вида «5 из 17 задач готово, срок 20.11» по задачам, открытым клиенту
 * (или по проекту чата, если ещё ничего не открыли), — сотрудник смотрит, вставляет в поле
 * сообщения и отправляет сам. Сам ответ никуда не уходит.
 */
export default function ClientStatusHint({ chatId, onInsert }: { chatId: string; onInsert: (text: string) => void }) {
  const [hint, setHint] = useState<Suggestion | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const ask = async () => {
    setBusy(true); setErr('');
    try { setHint(await clientChatApi.suggest(chatId)); } catch (e) { setErr(e instanceof ApiError ? e.message : 'Подсказка не получилась'); } finally { setBusy(false); }
  };

  return (
    <div className="cch">
      {!hint && (
        <button className="ui-btn ui-btn-outline ui-btn-sm" onClick={() => void ask()} disabled={busy} title="ИИ подскажет ответ клиенту статусом задач — вы проверите и отправите">
          <Icon name="sparkles" size={13} /> {busy ? 'Считаю…' : 'Ответить статусом задач'}
        </button>
      )}
      {err && <span className="error-text">{err}</span>}
      {hint && (
        <div className="cch-box" role="dialog" aria-label="Подсказка ответа">
          <p className="cch-text">{hint.text}</p>
          <span className="dim">
            {hint.source === 'ai' ? 'Предложил ИИ' : 'Собрано по задачам'}
            {hint.scope === 'project' ? ' · клиенту задачи не открыты, посчитано по проекту чата' : ''}
            {hint.scope === 'none' ? ' · задач нет — откройте их клиенту в «Сведениях»' : ''}
          </span>
          <div className="cch-actions">
            <button className="ui-btn ui-btn-primary ui-btn-sm" onClick={() => { onInsert(hint.text); setHint(null); }}><Icon name="edit" size={13} /> Вставить в сообщение</button>
            <button className="ui-btn ui-btn-ghost ui-btn-sm" onClick={() => void ask()} disabled={busy}><Icon name="refresh" size={13} /> Ещё раз</button>
            <button className="ui-btn ui-btn-ghost ui-btn-sm" onClick={() => setHint(null)}>Закрыть</button>
          </div>
        </div>
      )}
    </div>
  );
}
