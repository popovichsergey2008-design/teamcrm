import { useState } from 'react';
import { Icon, IconName } from './Icon';
import { api } from '../lib/api';
import type { Approval } from '../types';

/**
 * Карточка согласования в колонке «Требует моего решения».
 *
 * Смысл — решить вопрос, не проваливаясь в переписку: суть в двух строках и две кнопки.
 * Поэтому «Одобрить» срабатывает сразу, а «Отклонить» раскрывает поле причины: отказ
 * без объяснения возвращается новым вопросом через час, и сервер такой отказ не примет.
 */

const KIND: Record<Approval['kind'], { icon: IconName; label: string }> = {
  budget: { icon: 'money', label: 'бюджет' },
  invoice: { icon: 'file', label: 'счёт' },
  vacation: { icon: 'calendar', label: 'отпуск' },
  question: { icon: 'help', label: 'вопрос' },
  other: { icon: 'alert', label: 'решение' },
};

export function ApprovalCard({ approval, onDecided, onOpenTask }: {
  approval: Approval;
  onDecided: (id: string) => void;
  onOpenTask?: (projectId: string, taskId: string) => void;
}) {
  const [rejecting, setRejecting] = useState(false);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const kind = KIND[approval.kind] ?? KIND.other;

  const decide = async (approve: boolean) => {
    if (!approve && !note.trim()) { setRejecting(true); return; }
    setBusy(true); setErr('');
    try {
      await api.decideApproval(approval.id, approve, note.trim() || undefined);
      onDecided(approval.id);
    } catch {
      setErr('Не удалось сохранить решение. Возможно, его уже приняли.');
      setBusy(false);
    }
  };

  return (
    <div className="approval-card">
      <div className="approval-head">
        <span className="avatar-xs avatar-ph">{approval.author_name?.[0]?.toUpperCase() ?? '?'}</span>
        <span className="approval-author">{approval.author_name ?? 'Коллега'}</span>
        <span className="badge badge-muted"><Icon name={kind.icon} size={11} /> {kind.label}</span>
      </div>

      <div className="approval-subject">{approval.subject}</div>
      {approval.details && <div className="approval-details">{approval.details}</div>}

      {approval.task_id && approval.project_id && onOpenTask && (
        <button
          className="approval-task"
          onClick={() => onOpenTask(approval.project_id!, approval.task_id!)}
        >
          <Icon name="check-circle" size={12} /> {approval.task_title ?? 'задача'}
        </button>
      )}

      {rejecting && (
        <input
          className="input approval-note"
          autoFocus
          placeholder="Почему отклоняете? Это сэкономит следующий круг переписки"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && note.trim()) decide(false); }}
          maxLength={500}
        />
      )}

      {err && <div className="error-text">{err}</div>}

      <div className="approval-actions">
        <button className="btn btn-sm approval-yes" disabled={busy} onClick={() => decide(true)}>
          <Icon name="check" size={14} /> Одобрить
        </button>
        <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => decide(false)}>
          {rejecting ? 'Отправить отказ' : 'Отклонить'}
        </button>
      </div>
    </div>
  );
}
