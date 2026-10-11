import { ApiError } from '../lib/api';
import { Icon } from './Icon';
import { Button } from './ui/button';

/**
 * Страж нагрузки (ТЗ-21, этап 3): сервер не ставит задачу перегруженному человеку молча,
 * а отвечает 409 с подробностями. Это не запрет — человек выбирает: другой срок, другой
 * исполнитель или «оставить как есть» (тогда запрос уходит повторно с подтверждением,
 * и решение пишется в журнал).
 */
export interface WorkloadInfo {
  level: 'ok' | 'high' | 'overloaded';
  before: number;
  after: number;
  reasons: string[];
  assigneeId: string;
  assigneeName: string;
  /** ГГГГ-ММ-ДД — для полей, где срок без времени (быстрая команда) */
  alternativeDate: string | null;
  /** ISO, 15:00 местного дня — для окна задачи */
  alternativeDeadline: string | null;
  alternatives: { id: string; name: string; after: number }[];
}

export function workloadOf(e: unknown): WorkloadInfo | null {
  if (!(e instanceof ApiError) || e.code !== 'CONFLICT') return null;
  const w = (e.details as { workload?: WorkloadInfo } | undefined)?.workload;
  return w && Array.isArray(w.reasons) ? w : null;
}

/** «на пятницу, 16 октября» — день недели читается быстрее даты. */
export function dayLabel(date: string): string {
  const d = new Date(`${date}T12:00:00`);
  return d.toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' });
}

/** ISO → значение поля `datetime-local` в местном времени. */
export function localInput(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
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
    <div className="tv2-callout tv2-callout-warn tv2-callout-block" role="alert">
      <div className="tv2-callout-head">
        <Icon name="alert" size={15} />
        {info.level === 'overloaded' ? 'Перегруз' : 'Высокая загрузка'}: {info.assigneeName}, {info.before}% → {info.after}%
      </div>
      {info.reasons.map((r, i) => <div key={i}>{r}</div>)}
      <div className="tv2-callout-actions">
        {onMove && info.alternativeDate && (
          <Button variant="primary" size="sm" disabled={busy} onClick={onMove}>
            Срок: {dayLabel(info.alternativeDate)}
          </Button>
        )}
        {onReassign && alt && (
          <Button variant="outline" size="sm" disabled={busy} onClick={() => onReassign(alt.id)}>
            Передать: {alt.name} ({alt.after}%)
          </Button>
        )}
        <Button variant="ghost" size="sm" disabled={busy} onClick={onKeep}>Оставить как есть</Button>
      </div>
      <div className="tv2-callout-sub">Это предупреждение, а не запрет: решение «оставить» запишется в журнал.</div>
    </div>
  );
}
