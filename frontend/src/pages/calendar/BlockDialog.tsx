import { useState } from 'react';
import { Icon } from '../../components/Icon';
import { Button } from '../../components/ui/button';
import { confirmAction, Dialog } from '../../components/ui/dialog';
import { api, ApiError, type CalBlock } from '../../lib/api';
import { navigate } from '../../lib/router';
import { toastSaved } from '../../lib/notifications';
import { dayLabel, fmtMinutes } from './TaskTimeDialog';

const hhmm = (iso: string) => new Date(iso).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });

/**
 * Нажатие на рабочий блок (#4787, п. 4): исходная задача открывается отсюда — копии нет.
 * Перенос — тем же подбором окон; срок задачи при этом не меняется (п. 3).
 */
export function BlockDialog({ block, onClose, onChanged, onReschedule, onUndo }: {
  block: CalBlock;
  onClose: () => void;
  onChanged: () => void;
  onReschedule: (b: CalBlock) => void;
  /** «Отменить изменение» (#4787, п. 19) */
  onUndo?: (u: { text: string; run: () => Promise<unknown> }) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const min = Math.round((Date.parse(block.endsAt) - Date.parse(block.startsAt)) / 60000);
  const focus = block.kind === 'focus';

  const remove = async () => {
    if (!(await confirmAction({ title: focus ? 'Убрать фокус из календаря?' : 'Убрать время работы из календаря?', description: 'Сама задача и её срок останутся.', confirmLabel: 'Убрать', danger: true }))) return;
    setBusy(true);
    try {
      await api.calendarBlockDelete(block.id);
      const b = block;
      onUndo?.({ text: 'Убрано из календаря', run: () => api.calendarBlockCreate({ kind: b.kind, taskId: b.taskId ?? undefined, taskIds: b.taskIds, startsAt: b.startsAt, endsAt: b.endsAt }) });
      onChanged();
    }
    catch (e) { setErr(e instanceof ApiError ? e.message : 'Не удалось убрать'); setBusy(false); }
  };

  const startFocus = async () => {
    setBusy(true); setErr('');
    try {
      const left = Math.max(10, Math.min(120, Math.round((Date.parse(block.endsAt) - Date.now()) / 60000))) || min;
      await api.focusStart({ taskId: block.taskIds[0] ?? null, minutes: left });
      window.dispatchEvent(new Event('qevo:focus-changed'));
      toastSaved('Фокус начат');
      onChanged();
    } catch (e) { setErr(e instanceof ApiError ? e.message : 'Не удалось начать фокус'); setBusy(false); }
  };

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }} size="sm"
      title={<span className="cal-block-dlg-title"><Icon name={focus ? 'target' : 'check-circle'} size={16} /> {focus ? 'Глубокий фокус' : 'Время на задачу'}</span>}>
      <div className="cal-tt">
        {!focus && <div className="cal-tt-picked"><strong>№{block.taskId} — {block.title}</strong>{block.projectName && <span className="dim">{block.projectName}</span>}</div>}
        <div><Icon name="clock" size={14} /> {dayLabel(block.startsAt)}, {hhmm(block.startsAt)}–{hhmm(block.endsAt)} · {fmtMinutes(min)}</div>
        {!focus && (
          <div className="dim">
            Срок задачи: {block.deadlineAt ? new Date(block.deadlineAt).toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' }) : 'не задан'}
            {' '}— перенос этого блока срок не меняет.
          </div>
        )}
        {focus && block.taskIds.length > 0 && <div className="dim">Задачи: {block.taskIds.map((id) => `№${id}`).join(', ')}</div>}
        <div className="cal-tt-actions">
          {!focus && block.taskId && block.projectId && (
            <Button variant="primary" onClick={() => { onClose(); navigate({ section: 'projects', projectId: block.projectId!, taskId: block.taskId! }); }}>
              <Icon name="arrow-right" size={15} /> Открыть задачу
            </Button>
          )}
          {focus && <Button variant="primary" onClick={() => void startFocus()} disabled={busy}><Icon name="target" size={15} /> Начать фокус</Button>}
          {!focus && <Button variant="outline" onClick={() => onReschedule(block)} disabled={busy}><Icon name="calendar" size={15} /> Перенести</Button>}
          <Button variant="ghost" onClick={() => void remove()} disabled={busy}><Icon name="trash" size={15} /> Убрать</Button>
        </div>
        {err && <div className="tv2-callout tv2-callout-danger" role="alert"><Icon name="alert" size={15} /> {err}</div>}
      </div>
    </Dialog>
  );
}
