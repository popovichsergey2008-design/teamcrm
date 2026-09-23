import { useState } from 'react';
import { Icon } from './Icon';
import { api, ApiError, AssigneeSuggestion } from '../lib/api';

/**
 * «Подобрать» исполнителя по названию задачи (ТЗ-10).
 *
 * В быстрой команде отдел и направление определяются заодно с разбором текста. В
 * обычном окне разбора нет — поэтому кнопка: человек написал название и, если хочет,
 * спрашивает совет. Автоматически модель не дёргаем (решение заказчика): иначе токены
 * тратятся на каждую создаваемую задачу, включая те, где исполнитель и так известен.
 *
 * Совет — это совет: поле остаётся за человеком, «Поставить» нажимают отдельно.
 * Не нашли подходящего — говорим честно, почему, и ничего не подставляем.
 */
export function SuggestAssignee({ title, description, projectId, onPick }: {
  title: string;
  description?: string | null;
  projectId?: string | null;
  onPick: (userId: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<AssigneeSuggestion | null>(null);
  const [err, setErr] = useState('');

  const ask = async () => {
    setBusy(true); setErr(''); setResult(null);
    try { setResult(await api.suggestAssignee({ title: title.trim(), description: description ?? undefined, projectId: projectId ?? undefined })); }
    catch (e) { setErr(e instanceof ApiError ? e.message : 'Не удалось подобрать'); }
    finally { setBusy(false); }
  };

  return (
    <div className="suggest-assignee">
      <button
        type="button"
        className="btn btn-ghost btn-sm"
        disabled={busy || title.trim().length < 3}
        onClick={() => void ask()}
        title={title.trim().length < 3 ? 'Сначала напишите название задачи' : 'Спросить ИИ, кому поручить'}
      >
        <Icon name="sparkles" size={13} /> {busy ? 'Подбираю…' : 'Подобрать'}
      </button>

      {err && <span className="error-text suggest-line">{err}</span>}

      {result && (
        <span className={`suggest-line${result.sure ? '' : ' suggest-guess'}`}>
          {result.suggestedAssigneeId ? (
            <>
              <b>{result.suggestedAssigneeName}</b>
              {' — '}{result.reason}{result.sure ? '' : ' (ИИ предполагает)'}
              <button type="button" className="btn btn-sm suggest-apply" onClick={() => onPick(result.suggestedAssigneeId!)}>
                Поставить
              </button>
            </>
          ) : (
            <>Не подобрал: {result.reason}</>
          )}
        </span>
      )}
    </div>
  );
}
