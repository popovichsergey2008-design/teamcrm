import { useEffect, useState } from 'react';
import { api, ApiError } from '../lib/api';
import { Icon } from './Icon';
import { Button } from './ui/button';

/**
 * Страж нагрузки (ТЗ-21, этап 3; #1525 — «радар перегрузки»). Это не запрет, а мягкая
 * подсказка словами документа: «Обратите внимание: у Сергея на четверг уже назначено
 * 4 срочные задачи…». Появляется сразу, как только в форме известны исполнитель и срок
 * (ранняя проверка), и — запасным путём — по ответу 409 при «Создать».
 */
export interface WorkloadInfo {
  level: 'ok' | 'high' | 'overloaded';
  before: number;
  after: number;
  reasons: string[];
  assigneeId: string;
  assigneeName: string;
  /** ГГГГ-ММ-ДД — день предложенного срока */
  alternativeDate: string | null;
  /** ISO, 15:00 местного дня */
  alternativeDeadline: string | null;
  alternatives: { id: string; name: string; after: number }[];
  /** Из чего сложилась загрузка — словами (13.10, #1553). */
  basis?: string | null;
  /** #1525: подсказка и подписи кнопок — с сервера, уже просклонённые. */
  hint?: string | null;
  moveLabel?: string | null;
  reassignLabel?: string | null;
}

export function workloadOf(e: unknown): WorkloadInfo | null {
  if (!(e instanceof ApiError) || e.code !== 'CONFLICT') return null;
  const w = (e.details as { workload?: WorkloadInfo } | undefined)?.workload;
  return w && Array.isArray(w.reasons) ? w : null;
}

/** ISO → значение поля `datetime-local` в местном времени. */
export function localInput(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * Ранняя проверка (#1525): исполнитель и проект известны — через полсекунды тишины
 * спрашиваем сервер. Принятое решение («Оставить как есть», «Дедлайн на …») помним
 * по исполнителю: подсказка о нём больше не всплывает, а «Создать» уходит с подтверждением.
 */
export function useWorkloadCheck(input: {
  assigneeId?: string | null; projectId?: string | null; priority?: string | null;
  deadlineAt?: string | null; deadline?: string | null; directions?: string[];
}) {
  const [info, setInfo] = useState<WorkloadInfo | null>(null);
  const [accepted, setAccepted] = useState<string | null>(null);
  const who = input.assigneeId ? String(input.assigneeId) : '';
  const key = who && input.projectId
    ? JSON.stringify([who, input.projectId, input.priority, input.deadlineAt, input.deadline, input.directions])
    : '';
  useEffect(() => {
    setInfo(null);
    if (!key || accepted === who) return;
    let alive = true;
    const t = window.setTimeout(() => {
      api.workloadCheck({
        assigneeId: who, projectId: String(input.projectId), priority: input.priority || undefined,
        deadlineAt: input.deadlineAt || undefined, deadline: input.deadline || undefined, directions: input.directions,
      }).then((r) => { if (alive) setInfo(r.warn ? (r as unknown as WorkloadInfo) : null); }).catch(() => undefined);
    }, 500);
    return () => { alive = false; window.clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, accepted]);
  return {
    info: accepted === who ? null : info,
    /** решение принято — создаём с подтверждением */
    confirmed: !!who && accepted === who,
    accept: (id?: string) => setAccepted(id ?? who),
  };
}

export function WorkloadWarning({ info, busy, onMove, onReassign, onKeep }: {
  info: WorkloadInfo;
  busy?: boolean;
  onMove?: () => void;
  onReassign?: (userId: string) => void;
  onKeep: () => void;
}) {
  const alt = info.alternatives[0];
  return (
    <div className="tv2-callout tv2-callout-info tv2-callout-block" role="status">
      <div className="tv2-callout-head" style={{ fontWeight: 400, alignItems: 'flex-start' }}>
        <Icon name="sparkles" size={15} />
        {info.hint ?? info.reasons.join(' ')}
      </div>
      {info.basis && <div className="tv2-callout-sub">{info.basis}</div>}
      <div className="tv2-callout-actions">
        {onMove && info.alternativeDate && (
          <Button variant="primary" size="sm" disabled={busy} onClick={onMove}>
            {info.moveLabel ?? 'Перенести срок'}
          </Button>
        )}
        {onReassign && alt && (
          <Button variant="outline" size="sm" disabled={busy} onClick={() => onReassign(alt.id)}>
            {info.reassignLabel ?? `Передать: ${alt.name}`}
          </Button>
        )}
        <Button variant="outline" size="sm" disabled={busy} onClick={onKeep}>
          Оставить как есть
        </Button>
      </div>
    </div>
  );
}
