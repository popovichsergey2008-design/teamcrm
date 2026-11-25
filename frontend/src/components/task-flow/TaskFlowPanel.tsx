import { useCallback, useEffect, useState } from 'react';
import { Icon } from '../Icon';
import { Button } from '../ui/button';
import { Dialog } from '../ui/dialog';
import { Select } from '../ui/select';
import { Badge } from '../ui/badge';
import { lazyComponent } from '../../lib/lazy';
import { api, ApiError, type FocusSession } from '../../lib/api';
import { flowApi, type Handoff, type ShareLink, type TaskLink } from '../../lib/flow-api';
import { daysWord, workDays, staleDays } from '../../lib/board-card';
import { REVIEW_STAGES } from '../../lib/board-filter';
import { navigate } from '../../lib/router';
import { toastSaved } from '../../lib/notifications';
import { useAuth } from '../../state/auth';
import type { Task, TaskBlocker, User } from '../../types';
import { HandoffDialog } from './HandoffDialog';
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

export { HandoffDialog };
export const TaskFocusDialog = FocusDialog;

/**
 * Поток работы в карточке задачи (#4798 §3, §5, §8–11, §16, §19; #4799 BOARD01–05, 09).
 *
 * #5016: единой панели над вкладками больше нет — её части расставлены по новой карточке:
 * кнопки — в строку действий, «Связанные задачи» — во вкладку «Связи», сдачи и ссылки
 * клиенту — в «Историю», препятствие и «давно нет обновления» — под кнопками.
 */
export function useTaskFlow(task: Task) {
  const { user } = useAuth();
  const me = String(user?.id ?? '');
  const [links, setLinks] = useState<TaskLink[]>([]);
  const [handoffs, setHandoffs] = useState<Handoff[]>([]);
  const [shares, setShares] = useState<ShareLink[]>([]);
  const [session, setSession] = useState<FocusSession | null>(null);
  const load = useCallback(() => {
    flowApi.links(task.id).then(setLinks).catch(() => setLinks([]));
    flowApi.handoffs(task.id).then(setHandoffs).catch(() => setHandoffs([]));
    flowApi.shares(task.id).then(setShares).catch(() => setShares([]));
  }, [task.id]);
  useEffect(() => { load(); }, [load, task.version]);
  const loadSession = useCallback(() => { api.focusSessionCurrent().then(setSession).catch(() => setSession(null)); }, []);
  useEffect(() => { loadSession(); }, [task.id, loadSession]);
  const isDoer = String(task.assignee_id ?? '') === me || (task.co_assignees ?? []).some((p) => String(p.userId) === me);
  const isBoss = user?.role === 'owner' || user?.role === 'manager';
  const inFocus = !!session && !session.finished && (session.tasks ?? (session.task ? [session.task] : [])).some((t) => String(t.id) === String(task.id));
  return { me, links, handoffs, shares, session, inFocus, isDoer, isBoss, load, loadSession };
}
export type TaskFlow = ReturnType<typeof useTaskFlow>;

/** Под кнопками действий: препятствие, «вы в фокусе», «давно нет обновления». */
export function FlowNotices({ task, flow, onRefresh, onOpenChat }: { task: Task; flow: TaskFlow; onRefresh: () => void; onOpenChat: () => void }) {
  const [err, setErr] = useState('');
  const stale = staleDays(task);
  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    setErr('');
    try { await fn(); if (ok) toastSaved(ok); flow.load(); onRefresh(); }
    catch (e) { setErr(e instanceof ApiError ? e.message : 'Не получилось'); }
  };
  const showStale = stale > 0 && !task.closed_at && ((String(task.assignee_id ?? '') !== flow.me && !!task.assignee_id) || flow.isDoer);
  if (!err && !(task.is_blocked && task.blocker) && !(flow.inFocus && flow.session) && !showStale) return null;
  return (
    <div className="tf-panel">
      {err && <div className="tv2-callout tv2-callout-danger" role="alert"><Icon name="alert" size={15} /> {err}</div>}
      {flow.inFocus && flow.session && (
        <div className="tv2-note"><Icon name="target" size={13} /> Вы работаете над этой задачей. Фокус до {new Date(flow.session.plannedEndAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}</div>
      )}
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
      {showStale && (
        <div className="tf-row tv2-note">
          <span>По задаче давно нет обновления ({daysWord(stale)}). Уточнить состояние?</span>
          {String(task.assignee_id ?? '') !== flow.me && task.assignee_id && (
            <Button size="sm" variant="outline" onClick={() => void run(async () => { const r = await flowApi.requestUpdate(task.id); if (r.already) toastSaved('Обновление уже запрашивали сегодня'); }, 'Попросили обновление')}>Запросить обновление</Button>
          )}
          {flow.isDoer && <Button size="sm" variant="outline" onClick={onOpenChat}>Обновить статус</Button>}
        </div>
      )}
    </div>
  );
}

/** Сроки сдачи и ожидания проверки — строками вкладки «Время» (раньше блок «Сроки и ожидание»). */
export function flowTimeRows(task: Task, columns: { id: string; name: string; stage_type?: string }[]): { k: string; v: string }[] {
  const col = columns.find((c) => String(c.id) === String(task.column_id));
  const inReview = task.approval_state === 'pending' || REVIEW_STAGES.includes(col?.stage_type ?? '');
  const waiting = inReview && task.submitted_at ? workDays(new Date(task.submitted_at), new Date()) : 0;
  const inTime = task.submitted_at && task.deadline_at ? new Date(task.submitted_at) <= new Date(task.deadline_at) : null;
  const rows: { k: string; v: string }[] = [];
  if (task.submitted_at) rows.push({ k: 'Передано на проверку', v: `${when(task.submitted_at)}${inTime === true ? ' · в срок' : inTime === false ? ' · после срока' : ''}` });
  if (inReview) rows.push({ k: 'Ожидает решения', v: `${waiting ? daysWord(waiting) : 'меньше рабочего дня'} · не считается просрочкой исполнителя` });
  if (task.returned_at) rows.push({ k: 'Возвращено', v: when(task.returned_at) });
  if (task.stage_since) rows.push({ k: `На этапе «${col?.name ?? ''}»`, v: `с ${when(task.stage_since)}` });
  return rows;
}

/** Вкладка «Связи»: «Ждёт задачу» и кто ждёт эту (#4798 §9). */
export function LinksRows({ task, flow, onRefresh }: { task: Task; flow: TaskFlow; onRefresh: () => void }) {
  const [linkInput, setLinkInput] = useState('');
  const [err, setErr] = useState('');
  const run = async (fn: () => Promise<unknown>) => {
    setErr('');
    try { await fn(); flow.load(); onRefresh(); }
    catch (e) { setErr(e instanceof ApiError ? e.message : 'Не получилось'); }
  };
  const waits = flow.links.filter((l) => l.dir === 'waits');
  const blocks = flow.links.filter((l) => l.dir === 'blocks');
  return (
    <>
      <div className="ts-row">
        <span className="ts-k">Ждёт задачу</span>
        <div className="ts-v">
          {waits.map((l) => {
            const later = l.deadline_at && task.deadline_at && new Date(l.deadline_at) > new Date(task.deadline_at);
            return (
              <div key={`w${l.id}`} className="tf-row">
                <span>{l.closed ? '✓' : '⏳'} <button className="bb-link" onClick={() => navigate({ section: 'projects', projectId: l.project_id, taskId: l.id })}>#{l.id} — {l.title}</button>{l.assignee_name ? ` (${l.assignee_name})` : ''}</span>
                {later && !l.closed && <Badge tone="warn" title="Срок той задачи позже срока этой — сроки сами не меняются, решите вручную">срок позже вашего</Badge>}
                <Button variant="ghost" size="icon-sm" aria-label={`Убрать связь с #${l.id}`} onClick={() => void run(() => flowApi.removeLink(task.id, l.id))}><Icon name="close" size={13} /></Button>
              </div>
            );
          })}
          <form className="tf-row" onSubmit={(e) => { e.preventDefault(); const v = linkInput.trim(); if (!v) return; void run(async () => { await flowApi.addLink(task.id, v); setLinkInput(''); }); }}>
            <input className="ui-input ui-input-sm ts-input" style={{ maxWidth: 160 }} value={linkInput} onChange={(e) => setLinkInput(e.target.value)} placeholder="#номер" aria-label="Номер задачи, которую нужно завершить сначала" />
            <Button size="sm" variant="outline" type="submit" disabled={!linkInput.trim()}>Добавить</Button>
            <span className="ts-meta">исполнитель получит «можно приступать»</span>
          </form>
          {err && <div className="error-text" role="alert">{err}</div>}
        </div>
      </div>
      {blocks.length > 0 && (
        <div className="ts-row">
          <span className="ts-k">Её ждут</span>
          <div className="ts-v">
            {blocks.map((l) => (
              <div key={`b${l.id}`} className="tf-row">
                <button className="bb-link" onClick={() => navigate({ section: 'projects', projectId: l.project_id, taskId: l.id })}>#{l.id} — {l.title}</button>{l.assignee_name ? ` (${l.assignee_name})` : ''}
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  );
}

/** Вкладка «История», сверху: сдачи результата и ссылки для клиента. */
export function FlowRecords({ task, flow }: { task: Task; flow: TaskFlow }) {
  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    try { await fn(); if (ok) toastSaved(ok); flow.load(); } catch { /* ссылка уже отозвана */ }
  };
  return (
    <>
      {flow.handoffs.slice(0, 5).map((h) => (
        <div key={`h${h.id}`} className="ts-ev">
          <span>{when(h.created_at)}</span>
          <span><b>{h.author_name ?? 'Исполнитель'}</b> сдал результат, версия {h.version}{h.done_text ? ` — ${h.done_text.slice(0, 160)}` : ''}
            {h.decision && <> <Badge tone={h.decision === 'accepted' ? 'ok' : 'warn'}>{h.decision === 'accepted' ? 'принято' : 'возвращено'}{h.decision_note ? `: ${h.decision_note.slice(0, 60)}` : ''}</Badge></>}
          </span>
        </div>
      ))}
      {flow.shares.map((s) => (
        <div key={`s${s.id}`} className="ts-ev">
          <span>{when(s.created_at)}</span>
          <span>Ссылка клиенту · {s.revoked_at ? 'отозвана' : s.decision === 'approved' ? `согласовано${s.guest_name ? ` (${s.guest_name})` : ''}` : s.decision === 'changes' ? `просят изменения: ${s.decision_note ?? ''}` : 'ждём ответа'}
            {!s.revoked_at && (
              <>
                {' '}<button className="bb-link" onClick={() => { navigator.clipboard?.writeText(`${window.location.origin}/r/${s.token}`).then(() => toastSaved('Ссылка скопирована')).catch(() => undefined); }}>скопировать</button>
                {' · '}<button className="bb-link" onClick={() => void run(() => flowApi.revokeShare(task.id, s.id), 'Ссылка отозвана')}>отозвать</button>
              </>
            )}
          </span>
        </div>
      ))}
    </>
  );
}

/** «Есть препятствие» (#4798 §8, #4799 BOARD04): причина, что нужно, кто поможет, следующий шаг, дата. */
export function BlockerDialog({ task, users, onClose, onSaved }: { task: Task; users: User[]; onClose: () => void; onSaved: () => void }) {
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
export function ShareDialog({ task, onClose, onCreated }: { task: Task; onClose: () => void; onCreated: () => void }) {
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
