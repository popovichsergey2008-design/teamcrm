import { useState } from 'react';
import { Icon } from './Icon';
import { DatePicker } from './DatePicker';
import { Button } from './ui/button';
import { Select } from './ui/select';
import { ClampText } from './ClampText';
import { useWorkloadCheck, WorkloadWarning } from './WorkloadWarning';
import { chipDate, chipFor, DEADLINE_CHIPS, PRIORITY_LABEL, shortDay } from '../lib/auto-task';
import './nl-auto.css';

/**
 * Автоматическая постановка (#4615): срок чипами и живая сводка «Так поставлю».
 * Всё остальное — проект, исполнителя, теги, приоритет — система ставит сама.
 */

export function DeadlineChips({ value, onChange }: { value: string | null; onChange: (date: string | null) => void }) {
  const now = new Date();
  const active = chipFor(value, now);
  const [custom, setCustom] = useState(false);
  return (
    <div className="nla-deadline">
      <div className="nla-chips" role="group" aria-label="Срок задачи">
        {DEADLINE_CHIPS.map((c) => (
          <button
            key={c.key}
            type="button"
            className={`nla-chip${active === c.key ? ' on' : ''}`}
            aria-pressed={active === c.key}
            onClick={() => { setCustom(false); onChange(chipDate(c.key, now)); }}
          >
            {c.label}
          </button>
        ))}
        <button
          type="button"
          className={`nla-chip${active === 'custom' ? ' on' : ''}`}
          aria-pressed={active === 'custom'}
          onClick={() => setCustom((v) => !v)}
        >
          <Icon name="calendar" size={13} /> {active === 'custom' && value ? shortDay(value) : 'Свой срок'}
        </button>
      </div>
      {custom && <DatePicker value={value ?? ''} onChange={(v) => onChange(v ? v.slice(0, 10) : null)} placeholder="выберите дату" warnPast />}
    </div>
  );
}

/** Одна задача, как её поставит система: правится только то, без чего нельзя (проект). */
export function AutoSummary({ draft, index, many, deadline, busy, onPatchTask, onPatchDraft, onDrop }: {
  draft: any;
  index: number;
  many: boolean;
  /** Срок, с которым задача уйдёт: чип или услышанный во фразе. */
  deadline: string | null;
  busy: boolean;
  onPatchTask: (patch: any) => void;
  onPatchDraft: (patch: any) => void;
  onDrop: () => void;
}) {
  const t = draft.task;
  const ctx = draft.context ?? { projects: [], users: [] };
  const due = t.deadlineAt ?? deadline;
  // радар перегрузки (#1525) — и в автоматической постановке, сразу как известны исполнитель и срок
  const early = useWorkloadCheck({
    assigneeId: t.assigneeId, projectId: t.projectId, priority: t.priority, directions: t.directions,
    deadlineAt: t.deadlineAt ?? null, deadline: t.deadlineAt ? null : deadline,
  });
  const wl = draft.workload ?? early.info;
  const tags: { id: string; name: string }[] = t.autoTags ?? [];
  const fix = (patch: any) => { onPatchTask(patch); onPatchDraft({ workload: null, error: null }); };
  return (
    <section className="nla-sum" aria-label={many ? `Задача ${index + 1}` : 'Так поставлю'}>
      <div className="nla-sum-head">
        <span><Icon name="sparkles" size={13} /> Так поставлю{many ? ` · ${index + 1}` : ''}</span>
        {many && (
          <Button variant="ghost" size="icon-sm" onClick={onDrop} title="Не ставить эту задачу" aria-label={`Не ставить задачу ${index + 1}`}>
            <Icon name="close" size={14} />
          </Button>
        )}
      </div>
      <div className="nla-title">{t.title}</div>
      {/* описание от ИИ бывает длинным: четыре строки и «Ещё», а не обрыв многоточием (#4670) */}
      {t.description && <ClampText className="nla-desc" lines={4}>{t.description}</ClampText>}
      <dl className="nla-facts">
        <dt>Исполнитель</dt>
        <dd>{t.assigneeName ?? 'без исполнителя'}{t.assigneeWhy ? <span className="nla-why"> · {t.assigneeWhy}</span> : null}</dd>
        <dt>Проект</dt>
        <dd>
          {t.projectId
            ? <>{t.projectName ?? ctx.projects.find((p: any) => String(p.id) === String(t.projectId))?.name}{t.projectHint ? <span className="nla-why"> · {t.projectHint}</span> : null}</>
            : (
              <Select
                ariaLabel="Проект"
                value=""
                invalid={!!draft.error}
                onValueChange={(v) => v && fix({ projectId: v, projectName: ctx.projects.find((p: any) => String(p.id) === v)?.name ?? null, projectHint: 'выбран вами' })}
                options={[{ value: '', label: 'Выберите проект' }, ...ctx.projects.map((p: any) => ({ value: String(p.id), label: p.name }))]}
              />
            )}
        </dd>
        <dt>Срок</dt>
        <dd className={due ? '' : 'nla-missing'}>{due ? shortDay(due) : 'выберите выше'}</dd>
        <dt>Приоритет</dt>
        <dd>{PRIORITY_LABEL[t.priority] ?? PRIORITY_LABEL.normal}</dd>
        <dt>Теги</dt>
        <dd>{tags.length ? tags.map((x) => x.name).join(', ') : 'без тегов'}</dd>
      </dl>
      {draft.warnings?.map((w: string, i: number) => (
        <div key={i} className="nla-warn"><Icon name="alert" size={12} /> {w}</div>
      ))}
      {draft.error && <div className="error-text nla-warn" role="alert"><Icon name="alert" size={12} /> {draft.error}</div>}
      {wl && (
        <WorkloadWarning
          info={wl}
          busy={busy}
          onMove={wl.alternativeDate ? () => {
            early.accept(String(wl.assigneeId));
            fix({ deadlineAt: wl.alternativeDeadline, confirmWorkload: true });
          } : undefined}
          onReassign={(id) => fix({ assigneeId: id, assigneeName: ctx.users.find((u: any) => String(u.id) === String(id))?.name ?? null, assigneeWhy: 'выбран вами' })}
          onKeep={() => { early.accept(String(wl.assigneeId)); fix({ confirmWorkload: true }); }}
        />
      )}
    </section>
  );
}
