import { useState } from 'react';
import { Icon } from './Icon';
import { DatePicker } from './DatePicker';
import { Button } from './ui/button';
import { Select } from './ui/select';
import { Checkbox } from './ui/checkbox';
import { Field, Textarea } from './ui/field';
import { Input } from './ui/input';
import { ClampText } from './ClampText';
import { PeopleField, peopleOf, type PersonOption } from './PeopleField';
import { TaskTagsField } from './TaskTagsField';
import { useWorkloadCheck, WorkloadWarning } from './WorkloadWarning';
import { api } from '../lib/api';
import { EMPTY_TAGS, type TagsValue } from '../lib/tags';
import { useStickyCheck } from '../lib/sticky-checks';
import { chipDate, chipFor, DEADLINE_CHIPS, PRIORITY_LABEL, shortDay } from '../lib/auto-task';
import './nl-auto.css';

/**
 * Автоматическая постановка (#4615): срок чипами и живая сводка «Так поставлю».
 * Всё остальное — проект, исполнителя, теги, приоритет — система ставит сама,
 * а поправить любое поле можно здесь же (#4663).
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

/** Люди черновика для выбора: исполнитель, соисполнители, наблюдатели. */
function usersOf(ctx: any): PersonOption[] {
  return (ctx?.users ?? []).map((u: any) => ({ id: String(u.id), name: String(u.name ?? u.fullName ?? '') }));
}

/** Названия тегов компании — для сводки после правки: поле тегов отдаёт только id. */
let tagNames: Promise<Map<string, string>> | null = null;
const loadTagNames = () => (tagNames ??= api.listTags()
  .then((r) => new Map(r.items.map((x) => [String(x.id), x.name])))
  .catch(() => { tagNames = null; return new Map<string, string>(); }));

type PeopleRole = 'coAssigneeIds' | 'watcherIds';

/**
 * Одна задача, как её поставит система.
 *
 * #4663: в первом окне задачу снова можно править на месте. После #4615 сводка
 * стала только для чтения — менялся лишь проект, и то когда его не нашли; всё
 * остальное правилось только через «Править поля» или уже в карточке. Теперь
 * «Изменить» (или нажатие на название) раскрывает поля: название, описание,
 * исполнитель, соисполнители и наблюдатели (#4661), проект, срок, приоритет,
 * теги, согласование. Правки ложатся в черновик и уходят в задачу тем же
 * запросом, что и без правок.
 */
export function AutoSummary({ draft, index, many, deadline, busy, onPatchTask, onPatchDraft, onDrop, onDeadline }: {
  draft: any;
  index: number;
  many: boolean;
  /** Срок, с которым задача уйдёт: чип, свой срок этой задачи или услышанный во фразе. */
  deadline: string | null;
  /** Задача одна — срок из карточки становится общим (чипы). Нет — срок только этой задачи. */
  onDeadline?: (date: string | null) => void;
  busy: boolean;
  onPatchTask: (patch: any) => void;
  onPatchDraft: (patch: any) => void;
  onDrop: () => void;
}) {
  const t = draft.task;
  const ctx = draft.context ?? { projects: [], users: [] };
  const users = usersOf(ctx);
  const due = t.deadlineAt ?? deadline;
  const [editing, setEditing] = useState(false);
  const [approvalHabit, setApprovalHabit] = useStickyCheck('task.requiresApproval', true);
  // радар перегрузки (#1525) — и в автоматической постановке, сразу как известны исполнитель и срок
  const early = useWorkloadCheck({
    assigneeId: t.assigneeId, projectId: t.projectId, priority: t.priority, directions: t.directions,
    deadlineAt: t.deadlineAt ?? null, deadline: t.deadlineAt ? null : deadline,
  });
  const wl = draft.workload ?? early.info;
  const tags: { id: string; name: string }[] = t.autoTags ?? [];
  const co = peopleOf(t.coAssigneeIds, users);
  const watchers = peopleOf(t.watcherIds, users);
  const fix = (patch: any) => { onPatchTask(patch); onPatchDraft({ workload: null, error: null }); };
  /** Исполнителя выбрал человек: из соисполнителей и наблюдателей он уходит, «кто отвечает» не спрашиваем. */
  const setAssignee = (id: string) => fix({
    assigneeId: id || null,
    assigneeName: id ? users.find((u) => u.id === id)?.name ?? null : null,
    assigneeWhy: id ? 'выбран вами' : null,
    noLeadFor: null,
    coAssigneeIds: (t.coAssigneeIds ?? []).filter((x: string) => String(x) !== id),
    watcherIds: (t.watcherIds ?? []).filter((x: string) => String(x) !== id),
  });
  const setProject = (id: string) => fix({
    projectId: id || null,
    projectName: ctx.projects.find((p: any) => String(p.id) === id)?.name ?? null,
    projectHint: id ? 'выбран вами' : null,
  });
  // один человек — одна роль: добавили в соисполнители — из наблюдателей уходит
  const addPerson = (role: PeopleRole, id: string) => {
    const other: PeopleRole = role === 'coAssigneeIds' ? 'watcherIds' : 'coAssigneeIds';
    onPatchTask({ [role]: [...(t[role] ?? []), id], [other]: (t[other] ?? []).filter((x: string) => String(x) !== id) });
  };
  const dropPerson = (role: PeopleRole, id: string) => (
    onPatchTask({ [role]: (t[role] ?? []).filter((x: string) => String(x) !== id) })
  );
  // в автоматической постановке теги подтверждает «Ок» через 30 секунд — поле в режиме правки
  const tagsValue: TagsValue = { ...EMPTY_TAGS, tagIds: tags.map((x) => String(x.id)), confirmed: true };
  const onTags = (next: TagsValue) => {
    const known = new Map(tags.map((x) => [String(x.id), x.name]));
    const pick = (names: Map<string, string>) => next.tagIds.map((id) => ({ id, name: known.get(id) ?? names.get(id) ?? '' }));
    onPatchTask({ autoTags: pick(new Map()) });
    void loadTagNames().then((names) => onPatchTask({ autoTags: pick(names) }));
  };
  const projectOptions = [{ value: '', label: 'Выберите проект' }, ...ctx.projects.map((p: any) => ({ value: String(p.id), label: p.name }))];
  const label = (k: string) => `${k}${many ? ` задачи ${index + 1}` : ''}`;
  const notAssignee = t.assigneeId ? [String(t.assigneeId)] : [];

  return (
    <section className={`nla-sum${editing ? ' nla-editing' : ''}`} aria-label={many ? `Задача ${index + 1}` : 'Так поставлю'}>
      <div className="nla-sum-head">
        <span><Icon name="sparkles" size={13} /> Так поставлю{many ? ` · ${index + 1}` : ''}</span>
        <span className="nla-sum-tools">
          <Button
            variant={editing ? 'outline' : 'ghost'}
            size="sm"
            onClick={() => setEditing((v) => !v)}
            aria-expanded={editing}
            aria-label={editing ? `Готово — свернуть поля${many ? ` задачи ${index + 1}` : ''}` : `Изменить задачу${many ? ` ${index + 1}` : ''}`}
          >
            <Icon name={editing ? 'check' : 'edit'} size={13} /> {editing ? 'Готово' : 'Изменить'}
          </Button>
          {many && (
            <Button variant="ghost" size="icon-sm" onClick={onDrop} title="Не ставить эту задачу" aria-label={`Не ставить задачу ${index + 1}`}>
              <Icon name="close" size={14} />
            </Button>
          )}
        </span>
      </div>
      {editing ? (
        <div className="nla-edit">
          <Field label="Название">
            <Input aria-label={label('Название')} value={t.title ?? ''} onChange={(e) => onPatchTask({ title: e.target.value })} />
          </Field>
          <Field label="Описание">
            <Textarea rows={3} aria-label={label('Описание')} placeholder="Необязательно" value={t.description ?? ''} onChange={(e) => onPatchTask({ description: e.target.value })} />
          </Field>
          <div className="tv2-grid2">
            <Field label="Исполнитель" hint={t.assigneeWhy && t.assigneeId ? t.assigneeWhy : undefined}>
              <Select
                ariaLabel={label('Исполнитель')}
                className="tv2-wide"
                value={String(t.assigneeId ?? '')}
                onValueChange={setAssignee}
                options={[{ value: '', label: 'Без исполнителя' }, ...users.map((u) => ({ value: u.id, label: u.name }))]}
              />
            </Field>
            <Field label="Проект">
              <Select ariaLabel={label('Проект')} className="tv2-wide" value={String(t.projectId ?? '')} invalid={!t.projectId && !!draft.error} onValueChange={setProject} options={projectOptions} />
            </Field>
          </div>
          {/* #4661: соисполнители и наблюдатели — сразу, а не вторым заходом в карточке */}
          <div className="tv2-grid2">
            <PeopleField
              label="Соисполнители"
              hint="Делают работу вместе с исполнителем и видят задачу в своих"
              people={co}
              users={users}
              exclude={notAssignee}
              onAdd={(id) => addPerson('coAssigneeIds', id)}
              onRemove={(id) => dropPerson('coAssigneeIds', id)}
            />
            <PeopleField
              label="Наблюдатели"
              hint="Следят за ходом и получают уведомления, выполнять не обязаны"
              people={watchers}
              users={users}
              exclude={notAssignee}
              onAdd={(id) => addPerson('watcherIds', id)}
              onRemove={(id) => dropPerson('watcherIds', id)}
            />
          </div>
          <div className="tv2-grid2">
            <Field label="Срок" hint={many ? 'только у этой задачи' : undefined}>
              <DatePicker
                value={due ? String(due).slice(0, 10) : ''}
                onChange={(v) => {
                  const day = v ? v.slice(0, 10) : null;
                  // одна задача — это и есть общий срок: чипы выше показывают то же
                  if (onDeadline) { onDeadline(day); onPatchDraft({ workload: null, error: null }); }
                  else fix({ deadline: day, deadlineAt: null, ownDeadline: true });
                }}
                placeholder="выберите дату"
                warnPast
              />
            </Field>
            <Field label="Приоритет">
              <Select
                ariaLabel={label('Приоритет')}
                className="tv2-wide"
                value={String(t.priority ?? 'normal')}
                onValueChange={(v) => onPatchTask({ priority: v })}
                options={Object.entries(PRIORITY_LABEL).map(([value, l]) => ({ value, label: l }))}
              />
            </Field>
          </div>
          <TaskTagsField
            compact
            mode="edit"
            task={{ title: String(t.title ?? ''), description: String(t.description ?? '') }}
            value={tagsValue}
            onChange={onTags}
          />
          <Checkbox
            checked={t.requiresApproval ?? approvalHabit}
            onCheckedChange={(on) => { onPatchTask({ requiresApproval: on }); setApprovalHabit(on); }}
            label={<span title="Исполнитель сдаст работу, а завершите её вы">Не завершать без согласования с постановщиком</span>}
          />
          <div className="nla-why nla-edit-note">Правки сохранятся, пока вы не измените саму фразу выше.</div>
        </div>
      ) : (
        <>
          <button type="button" className="nla-title" onClick={() => setEditing(true)} title="Изменить задачу">{t.title}</button>
          {/* описание от ИИ бывает длинным: четыре строки и «Ещё», а не обрыв многоточием (#4670) */}
          {t.description && <ClampText className="nla-desc" lines={4}>{t.description}</ClampText>}
          <dl className="nla-facts">
            <dt>Исполнитель</dt>
            <dd>{t.assigneeName ?? 'без исполнителя'}{t.assigneeWhy ? <span className="nla-why"> · {t.assigneeWhy}</span> : null}</dd>
            {co.length > 0 && <><dt>Соисполнители</dt><dd>{co.map((p) => p.name).join(', ')}</dd></>}
            {watchers.length > 0 && <><dt>Наблюдатели</dt><dd>{watchers.map((p) => p.name).join(', ')}</dd></>}
            <dt>Проект</dt>
            <dd>
              {t.projectId
                ? <>{t.projectName ?? ctx.projects.find((p: any) => String(p.id) === String(t.projectId))?.name}{t.projectHint ? <span className="nla-why"> · {t.projectHint}</span> : null}</>
                : <Select ariaLabel="Проект" value="" invalid={!!draft.error} onValueChange={(v) => v && setProject(v)} options={projectOptions} />}
            </dd>
            <dt>Срок</dt>
            <dd className={due ? '' : 'nla-missing'}>{due ? shortDay(due) : 'выберите выше'}</dd>
            <dt>Приоритет</dt>
            <dd>{PRIORITY_LABEL[t.priority] ?? PRIORITY_LABEL.normal}</dd>
            <dt>Теги</dt>
            <dd>{tags.length ? tags.map((x) => x.name).filter(Boolean).join(', ') || `${tags.length}` : 'без тегов'}</dd>
          </dl>
          {!co.length && !watchers.length && (
            <button type="button" className="nla-add-people" onClick={() => setEditing(true)}>
              <Icon name="plus" size={13} /> Соисполнители и наблюдатели
            </button>
          )}
        </>
      )}
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
          onReassign={(id) => setAssignee(String(id))}
          onKeep={() => { early.accept(String(wl.assigneeId)); fix({ confirmWorkload: true }); }}
        />
      )}
    </section>
  );
}
