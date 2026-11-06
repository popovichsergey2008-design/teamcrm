import { useState } from 'react';
import { Icon } from '../Icon';
import { Button } from '../ui/button';
import { Dialog } from '../ui/dialog';
import { Select } from '../ui/select';
import { GateBlock, HandoffGateDialog, gateFromError } from '../HandoffGateDialog';
import { ApiError } from '../../lib/api';
import { flowApi } from '../../lib/flow-api';
import { feedback } from '../../lib/feedback';
import { toastSaved } from '../../lib/notifications';
import type { Task, User } from '../../types';
import './task-flow.css';

/**
 * Подсказка «где посмотреть» под вид работы (#4798 §5): дизайну — ссылка на макет,
 * исправлению — как проверить, документу — файл. По направлениям и тегам задачи.
 */
function wherePlaceholder(t: Task): string {
  const words = [...(t.directions ?? []), ...(t.labels ?? []).map((l) => l.name)].join(' ').toLowerCase();
  if (/дизайн|design|макет|ui/.test(words)) return 'Ссылка на макет (Figma и т. п.)';
  if (/ошиб|баг|bug|fix|backend|frontend|бэк|фронт/.test(words)) return 'Как проверить: шаги или адрес страницы';
  if (/док|текст|content|контент|статья/.test(words)) return 'Готовый файл — приложите во вкладке «Файлы» или дайте ссылку';
  if (/звон|клиент|call|sales|продаж/.test(words)) return 'Чем закончился разговор';
  return 'Ссылка, файл, снимок или короткая инструкция';
}

/**
 * Сдача результата на проверку (#4798 §5, #4799 BOARD03).
 *
 * Короткая форма, не отчёт: что сделано, где посмотреть, есть ли ограничения. Та же
 * задача переходит в колонку проверки, срок не переписывается; проверяющий получает
 * ссылку на эту версию результата. Можно перенести и без описания — обязательность
 * полей определяет приёмка проекта (чек-лист, снимки), а не эта форма.
 */
export function HandoffDialog({ task, columnId, columnName, position, users, canPickReviewer, onClose, onDone }: {
  task: Task;
  columnId: string;
  columnName: string;
  position: number;
  users: User[];
  canPickReviewer: boolean;
  onClose: () => void;
  onDone: (t: Task | null) => void;
}) {
  const [done, setDone] = useState('');
  const [where, setWhere] = useState('');
  const [limits, setLimits] = useState('');
  const [reviewerId, setReviewerId] = useState(String(task.reviewer_id ?? task.created_by ?? ''));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [gate, setGate] = useState<{ block: GateBlock; empty: boolean } | null>(null);

  const send = async (empty: boolean, confirmGate = false, noAfterReason?: string) => {
    if (busy) return;
    setBusy(true); setErr('');
    try {
      const r = await flowApi.submit(task.id, {
        done: empty ? '' : done, where: empty ? '' : where, limits: empty ? '' : limits,
        reviewerId: canPickReviewer && reviewerId ? reviewerId : null,
        columnId, position, confirmGate, noAfterReason,
      });
      feedback('task.moved');
      toastSaved('Передано на проверку', empty ? `«${columnName}»` : 'Проверяющий получит ссылку на результат');
      onDone(r.task);
    } catch (e) {
      const block = e instanceof ApiError ? gateFromError(e.details) : null;
      if (block) setGate({ block, empty });
      else setErr(e instanceof ApiError ? e.message : 'Не удалось передать на проверку');
    } finally { setBusy(false); }
  };

  if (gate) {
    return (
      <HandoffGateDialog
        block={gate.block}
        busy={busy}
        onCancel={() => setGate(null)}
        onForce={(reason) => { const g = gate; setGate(null); void send(g.empty, true, reason); }}
      />
    );
  }

  return (
    <Dialog
      open
      onOpenChange={(o) => { if (!o && !busy) onClose(); }}
      title={`Передать на проверку: «${columnName}»`}
      description="Коротко, чтобы проверяющему не пришлось переспрашивать. Срок задачи не меняется."
      footer={(
        <>
          <Button variant="ghost" onClick={() => void send(true)} disabled={busy} title="Перенести без описания результата">Перенести без описания</Button>
          <Button variant="primary" onClick={() => void send(false)} loading={busy} disabled={!done.trim() && !where.trim()}>
            <Icon name="send" size={15} /> Передать на проверку
          </Button>
        </>
      )}
    >
      <div className="tf-form">
        <label className="tf-field">
          <span>Что сделано?</span>
          <textarea className="ui-input" rows={3} value={done} onChange={(e) => setDone(e.target.value)} placeholder="Кратко: результат работы" autoFocus />
        </label>
        <label className="tf-field">
          <span>Где посмотреть?</span>
          <input className="ui-input" value={where} onChange={(e) => setWhere(e.target.value)} placeholder={wherePlaceholder(task)} />
        </label>
        <label className="tf-field">
          <span>Есть ограничения?</span>
          <input className="ui-input" value={limits} onChange={(e) => setLimits(e.target.value)} placeholder="Например: на телефоне ещё не проверял" />
        </label>
        {canPickReviewer && (
          <label className="tf-field">
            <span>Кто проверяет</span>
            <Select ariaLabel="Кто проверяет" value={reviewerId} onValueChange={setReviewerId}
              options={users.map((u) => ({ value: String(u.id), label: u.fullName }))} />
          </label>
        )}
        {err && <div className="tv2-callout tv2-callout-danger" role="alert"><Icon name="alert" size={15} /> {err}</div>}
      </div>
    </Dialog>
  );
}
