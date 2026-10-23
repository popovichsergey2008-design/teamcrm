import { useEffect, useState } from 'react';
import { Icon, type IconName } from './Icon';
import { ApiError, request } from '../lib/api';
import { awaitsMyReply, type FeedMessage } from '../lib/task-ai-reply';
import './task-ai-reply.css';

type Kind = 'reply' | 'status' | 'thanks';

const CHIPS: { kind: Kind; label: string; icon: IconName; hint: string }[] = [
  { kind: 'reply', label: 'Предложить ответ', icon: 'reply', hint: 'ИИ напишет ответ на последний вопрос или сообщение вам' },
  { kind: 'status', label: 'Обновление статуса', icon: 'flag', hint: 'ИИ напишет, что сделано, что дальше и когда' },
  { kind: 'thanks', label: 'Спасибо', icon: 'heart', hint: 'Короткая благодарность автору последнего сообщения' },
];

/**
 * Ответ одной кнопкой у поля ввода задачи — как в Jira (#4639, #4641, #4642).
 *
 * Три кнопки видны всегда: «Предложить ответ», «Обновление статуса», «Спасибо».
 * Результат ложится В ПОЛЕ, а не в ленту: человек читает, правит и отправляет сам.
 * Пока черновик не проверен — над полем плашка «Создано с помощью ИИ» с «Удалить»
 * (вернуть поле как было) и «Оставить». Повторное нажатие той же кнопки — другой вариант.
 *
 * Прежние подсказки помощнику («Объяснить задачу», «Составить план»…) — в «Ещё»:
 * они нужны себе, а не собеседнику, и на виду им место не каждый день.
 */
export function TaskAiReplyBar({
  taskId, feed, meId, meName, body, setBody, disabled, moreOpen, onToggleMore, onFilled, onError,
}: {
  taskId: string;
  feed: FeedMessage[];
  meId: string;
  meName: string | null;
  body: string;
  setBody: (v: string) => void;
  disabled?: boolean;
  moreOpen: boolean;
  onToggleMore: () => void;
  /** Текст вписан — поле в фокус, чтобы оставалось нажать Enter. */
  onFilled: () => void;
  onError: (msg: string) => void;
}) {
  /** Черновик ИИ в поле: что было в поле до него и какой вариант показан. */
  const [draft, setDraft] = useState<{ kind: Kind; prev: string; variant: number } | null>(null);
  const [loading, setLoading] = useState<Kind | null>(null);

  // Отправили или стёрли — плашка больше ни к чему.
  useEffect(() => { if (draft && !body.trim()) setDraft(null); }, [body, draft]);
  // Другая задача — другой разговор.
  useEffect(() => { setDraft(null); }, [taskId]);

  const hot = !draft && awaitsMyReply(feed, meId, meName);

  const run = async (kind: Kind) => {
    const variant = draft?.kind === kind ? draft.variant + 1 : 0;
    const prev = draft ? draft.prev : body;
    setLoading(kind); onError('');
    try {
      // Вызов здесь, а не в api.ts: компонент ленивый, первый экран не тяжелеет.
      const res = await request<{ text: string; ai: boolean }>('POST', `/tasks/${taskId}/ai-reply`, { kind, variant });
      setBody(res.text);
      setDraft({ kind, prev, variant });
      onFilled();
    } catch (e) {
      onError(e instanceof ApiError ? e.message : 'ИИ не ответил — попробуйте ещё раз');
    } finally { setLoading(null); }
  };

  return (
    <>
      {draft && (
        <div className="tc-ai-draft" role="status">
          <span className="tc-ai-draft-note">
            <Icon name="sparkles" size={14} /> Создано с помощью ИИ — проверьте
          </span>
          <span className="tc-ai-draft-actions">
            <button className="ui-btn ui-btn-ghost ui-btn-sm" onClick={() => { setBody(draft.prev); setDraft(null); }}>Удалить</button>
            <button className="ui-btn ui-btn-secondary ui-btn-sm" onClick={() => { setDraft(null); onFilled(); }}>Оставить</button>
          </span>
        </div>
      )}
      <div className="tc-ai-chips" role="toolbar" aria-label="Ответить с помощью ИИ">
        {CHIPS.map((c) => (
          <button
            key={c.kind}
            type="button"
            className={`ui-btn ui-btn-outline ui-btn-sm tc-ai-chip${c.kind === 'reply' && hot ? ' is-hot' : ''}`}
            disabled={disabled || loading !== null}
            aria-busy={loading === c.kind}
            aria-label={c.kind === 'reply' && hot ? `${c.label} — вас ждут с ответом` : undefined}
            title={draft?.kind === c.kind ? 'Другой вариант' : c.hint}
            onClick={() => { void run(c.kind); }}
          >
            {loading === c.kind
              ? <span className="ui-spinner tc-ai-spin" aria-hidden="true" />
              : <Icon name={c.icon} size={14} />}
            {c.label}
          </button>
        ))}
        <button
          type="button"
          className={`ui-btn ui-btn-ghost ui-btn-sm tc-ai-chip tc-ai-more${moreOpen ? ' active' : ''}`}
          aria-expanded={moreOpen}
          title="Спросить помощника: объяснить задачу, план, что осталось, резюме, отчёт"
          onClick={onToggleMore}
        >
          <Icon name="sparkles" size={14} /> Ещё
        </button>
      </div>
    </>
  );
}
