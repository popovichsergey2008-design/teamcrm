import { useCallback, useEffect, useState } from 'react';
import { Icon } from '../Icon';
import { Button } from '../ui/button';
import { Dialog } from '../ui/dialog';
import { Select } from '../ui/select';
import { Badge } from '../ui/badge';
import { lazyComponent } from '../../lib/lazy';
import { api, ApiError, type FocusSession } from '../../lib/api';
import { flowApi, type Handoff, type ShareLink, type TaskLink } from '../../lib/flow-api';
import { nextStep, daysWord, workDays, staleDays } from '../../lib/board-card';
import { REVIEW_STAGES } from '../../lib/board-filter';
import { navigate } from '../../lib/router';
import { toastSaved } from '../../lib/notifications';
import { useAuth } from '../../state/auth';
import type { Task, TaskBlocker, User } from '../../types';
import { HandoffDialog } from './HandoffDialog';
import { TaskFamily } from './TaskFamily';
import './task-flow.css';
import { DateInput } from '../DateInput';

const FocusDialog = lazyComponent(() => import('../../pages/calendar/FocusDialog').then((m) => m.FocusDialog));

const REASONS: { value: TaskBlocker['reason']; label: string }[] = [
  { value: 'wait_answer', label: 'Жду ответ' },
  { value: 'no_access', label: 'Нет доступа' },
  { value: 'no_info', label: 'Не хватает информации' },
  { value: 'depends', label: 'Зависит от другой задачи' },
  { value: 'other', label: 'Другая причина' },
];
const when = (iso: string | null | undefined) => (iso
  ? new Date(iso).toLocaleString('ru-RU', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
  : '—');

/**
 * Поток работы в карточке задачи (#4798 §3, §5, §8–11, §16, §19; #4799 BOARD01–05, 09).
 *
 * Над вкладками: кто сейчас делает следующий шаг, почему стоит (препятствие, ожидание
 * другой задачи), когда сдали и сколько ждёт решения — отдельно от срока исполнителя,
 * и действия: передать на проверку, запланировать время, начать фокус, отправить
 * клиенту. Ничего не происходит само — каждое действие делает человек.
 */
export function TaskFlowPanel({ task, columns, users, onRefresh, onOpenChat }: {
  task: Task;
  columns: { id: string; name: string; stage_type?: string }[];
  users: User[];
  onRefresh: () => void;
  onOpenChat: () => void;
}) {
  const { user } = useAuth();
  const me = String(user?.id ?? '');
  const isBoss = user?.role === 'owner' || user?.role === 'manager';
  const col = columns.find((c) => String(c.id) === String(task.column_id));
  const stage = col?.stage_type;
  const step = nextStep(task, stage, me);
  const [err, setErr] = useState('');
  const [blockerOpen, setBlockerOpen] = useState(false);
  const [handoffTo, setHandoffTo] = useState<{ id: string; name: string } | null>(null);
  const [focusOpen, setFocusOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [links, setLinks] = useState<TaskLink[]>([]);
  const [handoffs, setHandoffs] = useState<Handoff[]>([]);
  const [shares, setShares] = useState<ShareLink[]>([]);
  const [linkInput, setLinkInput] = useState('');
  const [session, setSession] = useState<FocusSession | null>(null);

  const load = useCallback(() => {
    flowApi.links(task.id).then(setLinks).catch(() => setLinks([]));
    flowApi.handoffs(task.id).then(setHandoffs).catch(() => setHandoffs([]));
    flowApi.shares(task.id).then(setShares).catch(() => setShares([]));
  }, [task.id]);
  useEffect(() => { load(); }, [load, task.version]);
  useEffect(() => { api.focusSessionCurrent().then(setSession).catch(() => setSession(null)); }, [task.id]);

  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    setErr('');
    try { await fn(); if (ok) toastSaved(ok); load(); onRefresh(); }
    catch (e) { setErr(e instanceof ApiError ? e.message : 'Не получилось'); }
  };

  const waits = links.filter((l) => l.dir === 'waits');
  const blocks = links.filter((l) => l.dir === 'blocks');
  const reviewCol = columns.find((c) => REVIEW_STAGES.includes(c.stage_type ?? ''));
  const inReview = task.approval_state === 'pending' || REVIEW_STAGES.includes(stage ?? '');
  const isDoer = String(task.assignee_id ?? '') === me || (task.co_assignees ?? []).some((p) => String(p.userId) === me);
  const waiting = inReview && task.submitted_at ? workDays(new Date(task.submitted_at), new Date()) : 0;
  const stale = staleDays(task);
  const inFocus = !!session && !session.finished && (session.tasks ?? (session.task ? [session.task] : [])).some((t) => String(t.id) === String(task.id));
  const submittedInTime = task.submitted_at && task.deadline_at ? new Date(task.submitted_at) <= new Date(task.deadline_at) : null;

  return (
    <div className="tf-panel">
      {err && <div className="tv2-callout tv2-callout-danger" role="alert"><Icon name="alert" size={15} /> {err}</div>}
      {step && (
        <div className={`kc-step t-${step.tone}`} title={step.title}>
          <Icon name={step.tone === 'blocked' ? 'ban' : step.tone === 'mine' || step.tone === 'review' ? 'eye' : 'user'} size={14} /> <span>{step.text}</span>
        </div>
      )}
      {inFocus && session && (
        <div className="tv2-note"><Icon name="target" size={13} /> Вы работаете над этой задачей. Фокус до {new Date(session.plannedEndAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}</div>
      )}

      <div className="tf-row" style={{ marginTop: 8 }}>
        {!inReview && !task.closed_at && reviewCol && isDoer && (
          <Button size="sm" variant="secondary" onClick={() => setHandoffTo({ id: reviewCol.id, name: reviewCol.name })} title="Коротко: что сделано и где посмотреть">
            <Icon name="send" size={14} /> Передать на проверку
          </Button>
        )}
        {!task.closed_at && (
          <Button size="sm" variant="outline" onClick={() => setBlockerOpen(true)} title="Работа не может продолжаться: укажите причину и кто поможет">
            <Icon name="ban" size={14} /> {task.is_blocked ? 'Изменить препятствие' : 'Есть препятствие'}
          </Button>
        )}
        {!task.closed_at && (
          <Button size="sm" variant="outline" onClick={() => { try { sessionStorage.setItem('calendar.planTask', String(task.id)); } catch { /* без хранилища */ } navigate({ section: 'calendar' }); }}
            title="Выбрать, когда делать: в календаре появится блок со ссылкой на задачу. Срок не меняется">
            <Icon name="calendar" size={14} /> Запланировать время
          </Button>
        )}
        {!task.closed_at && isDoer && !inFocus && (
          <Button size="sm" variant="outline" onClick={() => setFocusOpen(true)} title="Глубокий фокус 10–120 минут: тишина, без обычных звонков, сводка после">
            <Icon name="target" size={14} /> Начать фокус
          </Button>
        )}
        {(isDoer || String(task.created_by ?? '') === me || isBoss) && (
          <Button size="sm" variant="ghost" onClick={() => setShareOpen(true)} title="Показать результат клиенту по ссылке: согласовать или попросить изменения">
            <Icon name="link" size={14} /> Отправить клиенту
          </Button>
        )}
      </div>

      {task.is_blocked && task.blocker && (
        <div className="tf-block tf-blocked">
          <h4>Остановлено: {REASONS.find((r) => r.value === task.blocker!.reason)?.label}</h4>
          <div>{task.blocker.need}</div>
          <div className="dim">
            {task.blocker.helper_name ? `Помощь требуется от: ${task.blocker.helper_name}. ` : ''}
            {task.blocker.next_step ? `Следующий шаг: ${task.blocker.next_step}. ` : ''}
            {task.blocker.due_on ? `До ${new Date(task.blocker.due_on).toLocaleDateString('ru-RU')}.` : ''}
          </div>
          <div className="tf-row">
            <Button size="sm" variant="primary" onClick={() => void run(() => flowApi.resolveBlocker(task.id), 'Препятствие снято')}>Снять препятствие</Button>
          </div>
        </div>
      )}

      {/* Срок исполнителя и ожидание проверки — раздельно (#4798 §11, #4799 BOARD05) */}
      <div className="tf-block">
        <h4>Сроки и ожидание</h4>
        <dl className="tf-grid">
          <div><dt>Срок сдачи</dt><dd>{when(task.deadline_at)}</dd></div>
          {task.submitted_at && <div><dt>Передано на проверку</dt><dd>{when(task.submitted_at)}{submittedInTime === true ? ' · в срок' : submittedInTime === false ? ' · после срока' : ''}</dd></div>}
          {inReview && <div><dt>Ожидает решения</dt><dd>{waiting ? daysWord(waiting) : 'меньше рабочего дня'}</dd></div>}
          {task.returned_at && <div><dt>Возвращено</dt><dd>{when(task.returned_at)}</dd></div>}
          {task.estimate_hours && <div><dt>Оценка</dt><dd>{task.estimate_hours} ч</dd></div>}
          {task.stage_since && <div><dt>На этапе «{col?.name}»</dt><dd>с {when(task.stage_since)}</dd></div>}
        </dl>
        {inReview && <p className="dim" style={{ margin: '6px 0 0' }}>Ожидание проверки не считается просрочкой исполнителя. Общий срок задачи — выше.</p>}
        {stale > 0 && (
          <div className="tf-row" style={{ marginTop: 6 }}>
            <span>По задаче давно нет обновления ({daysWord(stale)}). Уточнить состояние?</span>
            {String(task.assignee_id ?? '') !== me && task.assignee_id && (
              <Button size="sm" variant="outline" onClick={() => void run(async () => { const r = await flowApi.requestUpdate(task.id); if (r.already) toastSaved('Обновление уже запрашивали сегодня'); }, 'Попросили обновление')}>Запросить обновление</Button>
            )}
            {isDoer && <Button size="sm" variant="outline" onClick={onOpenChat}>Обновить статус</Button>}
          </div>
        )}
      </div>

      {/* #4846: подзадачи и родительская задача — как в Битрикс24 */}
      <TaskFamily task={task} columns={columns} users={users} onRefresh={onRefresh} />

      {/* Связи: что нужно завершить сначала и кто ждёт эту задачу (#4798 §9) */}
      <div className="tf-block">
        <h4>Связанные задачи</h4>
        {waits.map((l) => {
          const later = l.deadline_at && task.deadline_at && new Date(l.deadline_at) > new Date(task.deadline_at);
          return (
            <div key={`w${l.id}`} className="tf-row">
              <span>{l.closed ? '✓' : '⏳'} Сначала нужно завершить <button className="bb-link" onClick={() => navigate({ section: 'projects', projectId: l.project_id, taskId: l.id })}>#{l.id} — {l.title}</button>{l.assignee_name ? ` (${l.assignee_name})` : ''}</span>
              {later && !l.closed && <Badge tone="warn" title="Срок той задачи позже срока этой — сроки сами не меняются, решите вручную">срок позже вашего</Badge>}
              <Button variant="ghost" size="icon-sm" aria-label={`Убрать связь с #${l.id}`} onClick={() => void run(() => flowApi.removeLink(task.id, l.id))}><Icon name="close" size={13} /></Button>
            </div>
          );
        })}
        {blocks.map((l) => (
          <div key={`b${l.id}`} className="tf-row dim">
            Её ждёт <button className="bb-link" onClick={() => navigate({ section: 'projects', projectId: l.project_id, taskId: l.id })}>#{l.id} — {l.title}</button>{l.assignee_name ? ` (${l.assignee_name})` : ''}
          </div>
        ))}
        <form className="tf-row" onSubmit={(e) => { e.preventDefault(); const v = linkInput.trim(); if (!v) return; void run(async () => { await flowApi.addLink(task.id, v); setLinkInput(''); }); }}>
          <input className="ui-input ui-input-sm" style={{ maxWidth: 220 }} value={linkInput} onChange={(e) => setLinkInput(e.target.value)} placeholder="Номер задачи, например #120" aria-label="Номер задачи, которую нужно завершить сначала" />
          <Button size="sm" variant="outline" type="submit">Ждёт эту задачу</Button>
        </form>
        <p className="dim" style={{ margin: '4px 0 0' }}>Когда та задача завершится, исполнитель получит «можно приступать». Сроки сами не сдвигаются.</p>
      </div>

      {handoffs.length > 0 && (
        <div className="tf-block">
          <h4>Сдачи результата</h4>
          {handoffs.slice(0, 5).map((h) => (
            <div key={h.id} className="tf-row">
              <span>Версия {h.version} · {when(h.created_at)}{h.author_name ? ` · ${h.author_name}` : ''}{h.done_text ? ` — ${h.done_text.slice(0, 120)}` : ''}</span>
              {h.decision && <Badge tone={h.decision === 'accepted' ? 'ok' : 'warn'}>{h.decision === 'accepted' ? 'принято' : 'возвращено'}{h.decision_note ? `: ${h.decision_note.slice(0, 60)}` : ''}</Badge>}
            </div>
          ))}
        </div>
      )}

      {shares.length > 0 && (
        <div className="tf-block">
          <h4>Ссылки для клиента</h4>
          {shares.map((s) => (
            <div key={s.id} className="tf-row">
              <span>{when(s.created_at)} · {s.revoked_at ? 'отозвана' : s.decision === 'approved' ? `согласовано${s.guest_name ? ` (${s.guest_name})` : ''}` : s.decision === 'changes' ? `просят изменения: ${s.decision_note ?? ''}` : 'ждём ответа'}</span>
              {!s.revoked_at && (
                <>
                  <Button size="sm" variant="ghost" onClick={() => { navigator.clipboard?.writeText(`${window.location.origin}/r/${s.token}`).then(() => toastSaved('Ссылка скопирована')).catch(() => undefined); }}><Icon name="copy" size={13} /> Ссылка</Button>
                  <Button size="sm" variant="ghost" onClick={() => void run(() => flowApi.revokeShare(task.id, s.id), 'Ссылка отозвана')}>Отозвать</Button>
                </>
              )}
            </div>
          ))}
        </div>
      )}

      {blockerOpen && <BlockerDialog task={task} users={users} onClose={() => setBlockerOpen(false)} onSaved={() => { setBlockerOpen(false); load(); onRefresh(); }} />}
      {handoffTo && (
        <HandoffDialog
          task={task} columnId={handoffTo.id} columnName={handoffTo.name} position={0} users={users}
          canPickReviewer={isBoss || String(task.created_by ?? '') === me}
          onClose={() => setHandoffTo(null)} onDone={() => { setHandoffTo(null); load(); onRefresh(); }}
        />
      )}
      {focusOpen && <FocusDialog preselect={[String(task.id)]} onClose={() => setFocusOpen(false)} onSaved={() => { setFocusOpen(false); api.focusSessionCurrent().then(setSession).catch(() => undefined); }} />}
      {shareOpen && <ShareDialog task={task} onClose={() => setShareOpen(false)} onCreated={() => { setShareOpen(false); load(); }} />}
    </div>
  );
}

/** «Есть препятствие» (#4798 §8, #4799 BOARD04): причина, что нужно, кто поможет, следующий шаг, дата. */
function BlockerDialog({ task, users, onClose, onSaved }: { task: Task; users: User[]; onClose: () => void; onSaved: () => void }) {
  const b = task.blocker;
  const [reason, setReason] = useState<string>(b?.reason ?? 'wait_answer');
  const [need, setNeed] = useState(b?.need ?? '');
  const [helperId, setHelperId] = useState(b?.helper_id ?? '');
  const [nextStepText, setNext] = useState(b?.next_step ?? '');
  const [dueOn, setDue] = useState(b?.due_on ?? '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const save = async () => {
    if (!need.trim()) { setErr('Напишите, что нужно, чтобы продолжить'); return; }
    setBusy(true); setErr('');
    try {
      await flowApi.setBlocker(task.id, { reason, need: need.trim(), helperId: helperId || null, nextStep: nextStepText.trim(), dueOn: dueOn || null });
      toastSaved('Препятствие отмечено', helperId ? 'Помощник получил уведомление' : 'Задача видна в «Есть препятствия»');
      onSaved();
    } catch (e) { setErr(e instanceof ApiError ? e.message : 'Не получилось'); } finally { setBusy(false); }
  };
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }} title="Есть препятствие"
      description="Задача останется в своей колонке, но на доске будет видно, что работа стоит и кто может помочь."
      footer={<><Button variant="ghost" onClick={onClose}>Отмена</Button><Button variant="primary" onClick={() => void save()} loading={busy}>Отметить</Button></>}>
      <div className="tf-form">
        <label className="tf-field"><span>Причина</span>
          <Select ariaLabel="Причина" value={reason} onValueChange={setReason} options={REASONS} />
        </label>
        <label className="tf-field"><span>Что нужно для продолжения</span>
          <input className="ui-input" value={need} onChange={(e) => setNeed(e.target.value)} placeholder="Например: нужен доступ к кабинету" autoFocus />
        </label>
        <label className="tf-field"><span>Кто может помочь</span>
          <Select ariaLabel="Кто может помочь" value={helperId} onValueChange={setHelperId}
            options={[{ value: '', label: 'Не выбрано' }, ...users.map((u) => ({ value: String(u.id), label: u.fullName }))]} />
        </label>
        <label className="tf-field"><span>Следующий шаг</span>
          <input className="ui-input" value={nextStepText} onChange={(e) => setNext(e.target.value)} placeholder="Например: написать в поддержку сервиса" />
        </label>
        <label className="tf-field"><span>Когда снять (необязательно)</span>
          <DateInput className="ui-input" type="date" value={dueOn} onChange={(e) => setDue(e.target.value)} />
        </label>
        {err && <div className="tv2-callout tv2-callout-danger" role="alert"><Icon name="alert" size={15} /> {err}</div>}
      </div>
    </Dialog>
  );
}

/**
 * «Отправить клиенту» (#4798 §19, #4799 BOARD09): что поручено, готовый результат,
 * пояснение и выбранные файлы. До отправки видно, что именно увидит клиент; переписка
 * и прочие вложения остаются внутри. Ссылку можно отозвать.
 */
function ShareDialog({ task, onClose, onCreated }: { task: Task; onClose: () => void; onCreated: () => void }) {
  const [summary, setSummary] = useState(task.title);
  const [result, setResult] = useState('');
  const [files, setFiles] = useState<{ id: string; name: string }[]>([]);
  const [picked, setPicked] = useState<string[]>([]);
  const [link, setLink] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => {
    flowApi.reviewItem(task.id).then((r) => {
      setFiles(r.files.map((f) => ({ id: f.id, name: f.name })));
      const h = r.handoffs[0];
      if (h?.done_text) setResult(h.done_text);
    }).catch(() => undefined);
  }, [task.id]);
  const create = async () => {
    if (!result.trim()) { setErr('Опишите результат для клиента'); return; }
    setBusy(true); setErr('');
    try {
      const r = await flowApi.createShare(task.id, { summary: summary.trim(), result: result.trim(), fileIds: picked });
      const url = `${window.location.origin}${r.path}`;
      setLink(url);
      navigator.clipboard?.writeText(url).catch(() => undefined);
    } catch (e) { setErr(e instanceof ApiError ? e.message : 'Не получилось'); } finally { setBusy(false); }
  };
  return (
    <Dialog open onOpenChange={(o) => { if (!o) { if (link) onCreated(); else onClose(); } }} title="Отправить результат клиенту"
      description="Клиент увидит только то, что ниже: без переписки, внутреннего чата и прочих файлов. Он сможет согласовать или попросить изменения."
      footer={link
        ? <Button variant="primary" onClick={onCreated}>Готово</Button>
        : <><Button variant="ghost" onClick={onClose}>Отмена</Button><Button variant="primary" onClick={() => void create()} loading={busy}>Создать ссылку</Button></>}>
      {link ? (
        <div className="tf-form">
          <p>Ссылка скопирована — отправьте её клиенту:</p>
          <input className="ui-input" readOnly value={link} onFocus={(e) => e.currentTarget.select()} />
          <p className="dim">Ответ клиента придёт в обсуждение задачи. Ссылку можно отозвать в карточке.</p>
        </div>
      ) : (
        <div className="tf-form">
          <label className="tf-field"><span>Что было поручено</span>
            <input className="ui-input" value={summary} onChange={(e) => setSummary(e.target.value)} />
          </label>
          <label className="tf-field"><span>Готовый результат и пояснение</span>
            <textarea className="ui-input" rows={4} value={result} onChange={(e) => setResult(e.target.value)} placeholder="Что сделано и как посмотреть" />
          </label>
          <div className="tf-field"><span>Файлы, которые увидит клиент</span>
            {files.length === 0 && <p className="dim">В задаче нет файлов.</p>}
            {files.map((f) => (
              <label key={f.id} className="tf-row">
                <input type="checkbox" checked={picked.includes(f.id)} onChange={() => setPicked((p) => (p.includes(f.id) ? p.filter((x) => x !== f.id) : [...p, f.id]))} /> {f.name}
              </label>
            ))}
          </div>
          {err && <div className="tv2-callout tv2-callout-danger" role="alert"><Icon name="alert" size={15} /> {err}</div>}
        </div>
      )}
    </Dialog>
  );
}
