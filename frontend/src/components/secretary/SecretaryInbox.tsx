import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, AssistantProposal, Commitment, ProactivePrefs, ProactiveQuality, ProactiveQualityExtra, ProactiveSettings, ProposalSummary } from '../../lib/api';
import { getSocket } from '../../lib/socket';
import { fetchBlob } from '../AuthedMedia';
import { navigate } from '../../lib/router';
import { Icon } from '../Icon';
import { EmptyState } from '../EmptyState';
import { CareEmpty } from '../care/CareEmpty';
import { SkeletonList } from '../Skeleton';
import { Button } from '../ui/button';
import { Checkbox } from '../ui/checkbox';
import { confirmAction } from '../ui/dialog';
import { DropdownMenu, MenuItem, MenuSeparator } from '../ui/dropdown-menu';
import { Select } from '../ui/select';
import { OptionSelect } from '../ui/option-select';
import './secretary.css';
import { feedback } from '../../lib/feedback';

/**
 * Ящик проактивного секретаря (ТЗ-21, §10): не журнал сделанного, а то, что ждёт
 * решения человека. У каждой карточки одно и то же устройство — что увидел, почему
 * это важно, что предлагаю и что изменится после нажатия. Ничего не выполняется без
 * кнопки; «больше не предлагать» глушит этот вид предложений, а не весь навык.
 */

const SECTIONS: { key: AssistantProposal['section']; title: string; icon: 'alert' | 'handshake' | 'reply' | 'record' | 'sun' }[] = [
  { key: 'attention', title: 'Требуют внимания', icon: 'alert' },
  { key: 'commitments', title: 'Обещания', icon: 'handshake' },
  { key: 'replies', title: 'Черновики ответов', icon: 'reply' },
  { key: 'meetings', title: 'После встреч', icon: 'record' },
  { key: 'morning', title: 'Сегодня утром', icon: 'sun' },
];

const REASONS: { key: string; label: string }[] = [
  { key: 'already_done', label: 'Уже сделано' },
  { key: 'not_needed', label: 'Не нужно' },
  { key: 'wrong_person', label: 'Не тот человек' },
  { key: 'wrong_deadline', label: 'Не тот срок' },
  { key: 'wrong_context', label: 'Не понял контекст' },
  { key: 'other', label: 'Другое' },
];

const SKILL_TITLE: Record<string, string> = {
  commitment: 'Обещания', workload: 'Страж нагрузки', reply: 'Ответы', followup: 'После встреч с клиентом',
  brief: 'Утренняя сводка', decision: 'Решения', postcall: 'Итоги встреч',
};

function when(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return d.toDateString() === new Date().toDateString() ? time : `${d.getDate()}.${String(d.getMonth() + 1).padStart(2, '0')} ${time}`;
}

export type SecretaryTab = 'inbox' | 'commitments' | 'settings';

export function SecretaryInbox({ tab, focusId, onNavigate }: { tab: SecretaryTab; focusId?: string | null; onNavigate: () => void }) {
  if (tab === 'commitments') return <Commitments onNavigate={onNavigate} />;
  if (tab === 'settings') return <Settings />;
  return <Inbox focusId={focusId ?? null} onNavigate={onNavigate} />;
}

/** Сводка для вкладки и меню: сколько ждёт решения. */
export function useProposalSummary(): ProposalSummary | null {
  const [s, setS] = useState<ProposalSummary | null>(null);
  useEffect(() => {
    const load = () => api.proposalsSummary().then(setS).catch(() => undefined);
    load();
    const socket = getSocket();
    socket.on('assistant.proposal', load);
    return () => { socket.off('assistant.proposal', load); };
  }, []);
  return s;
}

function Inbox({ focusId, onNavigate }: { focusId: string | null; onNavigate: () => void }) {
  const [items, setItems] = useState<AssistantProposal[] | null>(null);
  const [history, setHistory] = useState<AssistantProposal[] | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [summary, setSummary] = useState<ProposalSummary | null>(null);

  const load = useCallback(() => {
    api.proposals().then((r) => {
      setItems(r.items);
      const fresh = r.items.filter((p) => p.status === 'new').map((p) => p.id);
      if (fresh.length) void api.proposalsSeen(fresh).catch(() => undefined);
    }).catch(() => setItems([]));
    api.proposalsSummary().then(setSummary).catch(() => undefined);
  }, []);

  useEffect(() => {
    load();
    const socket = getSocket();
    socket.on('assistant.proposal', load);
    return () => { socket.off('assistant.proposal', load); };
  }, [load]);

  // карточка из push или ссылки: если её нет среди открытых (уже решена) — подтянуть отдельно
  const [focused, setFocused] = useState<AssistantProposal | null>(null);
  useEffect(() => {
    if (!focusId || !items) return;
    if (items.some((p) => p.id === focusId)) {
      requestAnimationFrame(() => document.getElementById(`proposal-${focusId}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' }));
    } else {
      api.proposal(focusId).then(setFocused).catch(() => setFocused(null));
    }
  }, [focusId, items]);

  useEffect(() => {
    if (showHistory && !history) api.proposals({ history: true }).then((r) => setHistory(r.items)).catch(() => setHistory([]));
  }, [showHistory, history]);

  const replace = (p: AssistantProposal | null, id: string) => {
    setItems((list) => (list ?? []).flatMap((x) => (x.id !== id ? [x] : p && ['new', 'seen', 'failed'].includes(p.status) ? [p] : [])));
    setHistory(null);
  };

  if (items === null) return <SkeletonList rows={4} />;

  const elsewhere = summary?.elsewhere;
  const more = elsewhere ? [
    elsewhere.pings ? `напоминаний — ${elsewhere.pings}` : '',
    elsewhere.chatActions ? `действий из чатов — ${elsewhere.chatActions}` : '',
    elsewhere.meetingDrafts ? `черновиков после встреч — ${elsewhere.meetingDrafts}` : '',
    elsewhere.news ? `объявлений к ознакомлению — ${elsewhere.news}` : '',
  ].filter(Boolean) : [];

  return (
    <div className="sp-inbox">
      {focused && !items.some((p) => p.id === focused.id) && (
        <ProposalCard p={focused} focused onDone={() => setFocused(null)} onNavigate={onNavigate} />
      )}

      {/* ТЗ-34 «Сегодня» п.3.2: пустой секретарь — карточка заботы */}
      {items.length === 0 && !focused && <CareEmpty k="secretary" />}
      {items.length === 0 && !focused && (
        <EmptyState
          icon="check-circle"
          compact
          title="Решать сейчас нечего"
          hint="Сюда приходят обещания из переписки и встреч, риски перегруза и черновики — всё, что ждёт вашего решения."
        />
      )}

      {SECTIONS.map((s) => {
        const list = items.filter((p) => p.section === s.key);
        if (!list.length) return null;
        return (
          <section key={s.key} className="sp-section">
            <div className="drawer-section-title"><Icon name={s.icon} size={14} /> {s.title} · {list.length}</div>
            {list.map((p) => (
              <ProposalCard key={p.id} p={p} focused={p.id === focusId} onDone={(next) => replace(next, p.id)} onNavigate={onNavigate} />
            ))}
          </section>
        );
      })}

      {more.length > 0 && (
        <div className="dim sp-elsewhere">Ещё ждут решения в других местах: {more.join(', ')}.</div>
      )}

      <button className="sp-history-toggle" onClick={() => setShowHistory((v) => !v)}>
        <Icon name={showHistory ? 'chevron-up' : 'chevron-down'} size={14} /> История решений
      </button>
      {showHistory && history === null && <SkeletonList rows={3} />}
      {showHistory && history?.length === 0 && <div className="dim sp-elsewhere">Пока ничего не решено.</div>}
      {showHistory && history?.map((p) => (
        <div key={p.id} className="sp-history-row">
          <span className={`sp-status sp-status-${p.status}`}>{statusLabel(p.status)}</span>
          <span className="sp-history-title">{p.title}</span>
          <span className="dim">{when(p.resolvedAt ?? p.createdAt)}</span>
          {p.result && <div className="dim sp-history-result">{p.result}</div>}
        </div>
      ))}
    </div>
  );
}

function statusLabel(s: AssistantProposal['status']): string {
  return ({ executed: 'Сделано', dismissed: 'Отклонено', expired: 'Неактуально', failed: 'Сбой', snoozed: 'Отложено' } as Record<string, string>)[s] ?? 'Открыто';
}

function ProposalCard({ p, focused, onDone, onNavigate }: {
  p: AssistantProposal;
  focused?: boolean;
  onDone: (next: AssistantProposal | null) => void;
  onNavigate: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(p.error ?? '');
  const [result, setResult] = useState<{ text: string; link: string | null } | null>(null);
  const [askReason, setAskReason] = useState(false);
  const [rated, setRated] = useState(false);
  const open = ['new', 'seen', 'snoozed', 'failed'].includes(p.status);
  /** Письмо клиенту (ТЗ-21): текст правится прямо в карточке и уходит поправленным. */
  const editable = p.payload.editable === true;
  const [body, setBody] = useState(String(p.payload.body ?? ''));
  const [subject, setSubject] = useState(String(p.payload.subject ?? ''));

  const go = (link: string | null) => {
    if (!link) return;
    onNavigate();
    navigate(link);
  };

  /*
    Быстрый выбор проекта (ТЗ-31, §29): задача по обещанию из лички — проект не ясен.
    Сервер отвечает «к какому проекту?» с вариантами; выбрали — то же действие ещё раз.
  */
  const [pick, setPick] = useState<{ action: AssistantProposal['actions'][number]; candidates: { id: string; name: string }[]; projects: { id: string; name: string }[] } | null>(null);

  const act = async (a: AssistantProposal['actions'][number], extra?: Record<string, unknown>) => {
    if (a.risk === 'external' && !(await confirmAction({ title: `${a.label}?`, description: p.effect ?? undefined, confirmLabel: a.label }))) return;
    setBusy(true); setErr('');
    try {
      // «Скопировать» — в буфер до запроса: сервер только отметит, что текст подготовлен
      if (a.key === 'copy') await navigator.clipboard.writeText(editable ? body : String(p.payload.body ?? p.summary ?? '')).catch(() => undefined);
      const params = { ...(editable ? { body, subject } : {}), ...(extra ?? {}) };
      const r = await api.proposalAct(p.id, a.key, Object.keys(params).length ? params : undefined);
      setPick(null);
      feedback('action.confirmed');
      setResult({ text: r.text, link: r.link });
      window.dispatchEvent(new Event('teamcrm:tasks-changed'));
      // карточка остаётся на экране с результатом, пока человек не уйдёт с вкладки;
      // осталась открытой (черновики планерки) — через миг снова доступны кнопки
      setTimeout(() => {
        onDone(r.proposal);
        if (r.proposal && ['new', 'seen'].includes(r.proposal.status)) setResult(null);
      }, 2500);
    } catch (e) {
      const d = e instanceof ApiError ? (e.details as { code?: string; candidates?: { id: string; name: string }[]; projects?: { id: string; name: string }[] } | undefined) : undefined;
      if (d?.code === 'PROJECT_REQUIRED' && d.projects?.length) {
        setPick({ action: a, candidates: d.candidates ?? [], projects: d.projects });
        return;
      }
      setErr(e instanceof ApiError ? e.message : 'Не получилось — попробуйте ещё раз');
    } finally { setBusy(false); }
  };

  const dismiss = async (mute: boolean, reason?: string) => {
    setBusy(true);
    try { await api.proposalDismiss(p.id, { mute, reason }); onDone(null); }
    catch (e) { setErr(e instanceof ApiError ? e.message : 'Не получилось'); setBusy(false); }
  };

  const snooze = async (preset: 'hour' | 'afternoon' | 'tomorrow') => {
    setBusy(true);
    try { await api.proposalSnooze(p.id, preset); onDone(null); }
    catch (e) { setErr(e instanceof ApiError ? e.message : 'Не получилось'); setBusy(false); }
  };

  const rate = async (useful: boolean, reason?: string) => {
    setAskReason(false); setRated(true);
    await api.proposalFeedback(p.id, useful, reason).catch(() => undefined);
  };

  // «Поставить задачей» у брифа — кнопка у каждого черновика планерки, не в общем ряду
  const actions = [...p.actions].filter((a) => !(p.skill === 'brief' && a.key === 'task')).sort((a, b) => Number(!!b.primary) - Number(!!a.primary));
  const taskAction = p.actions.find((a) => a.key === 'task');

  return (
    <article id={`proposal-${p.id}`} className={`sp-card sp-p${p.priority}${focused ? ' sp-focus' : ''}`}>
      <div className="sp-head">
        <span className={`sp-prio sp-prio-${p.priority}`}>{p.priorityLabel}</span>
        {p.source.label && (
          p.source.link
            ? <button className="sp-src" onClick={() => go(p.source.link)} title="Открыть источник">{p.source.label}</button>
            : <span className="sp-src">{p.source.label}</span>
        )}
        <span className="sp-time">{when(p.source.at ?? p.createdAt)}</span>
      </div>
      <div className="sp-title">{p.title}</div>
      {p.skill === 'brief' ? <Brief p={p} onGo={go} busy={busy} onTask={open && taskAction ? (ref) => void act(taskAction, { ref }) : null} /> : editable && open && !result ? (
        <div className="sp-letter">
          {p.payload.email ? <input className="input" value={subject} onChange={(e) => setSubject(e.target.value)} aria-label="Тема письма" /> : null}
          <textarea className="input" rows={8} value={body} onChange={(e) => setBody(e.target.value)} aria-label="Текст для клиента" />
        </div>
      ) : p.summary && <div className="sp-summary">{p.summary}</div>}
      <dl className="sp-why">
        {p.why && <><dt>Почему</dt><dd>{p.why}</dd></>}
        {p.recommend && <><dt>Предлагаю</dt><dd>{p.recommend}</dd></>}
        {p.effect && <><dt>Что изменится</dt><dd>{p.effect}</dd></>}
      </dl>
      {p.confidence < 0.75 && <div className="sp-unsure">Не уверен — проверьте источник.</div>}
      {err && <div className="error-text sp-err"><Icon name="alert" size={12} /> {err}</div>}
      {result && (
        <div className="sp-result">
          <Icon name="check" size={14} /> {result.text}
          {result.link && <button className="sp-src" onClick={() => go(result.link)}>Открыть</button>}
        </div>
      )}
      {pick && open && !result && (
        <div className="sp-pick" role="group" aria-label="К какому проекту относится задача">
          <div className="sp-pick-q">К какому проекту относится задача?</div>
          <div className="sp-pick-row">
            {pick.candidates.map((c) => (
              <Button key={c.id} size="sm" variant="outline" disabled={busy} onClick={() => void act(pick.action, { projectId: c.id })}>{c.name}</Button>
            ))}
            <OptionSelect
              className="sp-pick-other"
              value=""
              aria-label="Выбрать другой проект"
              onChange={(e) => { if (e.target.value) void act(pick.action, { projectId: e.target.value }); }}
            >
              <option value="">{pick.candidates.length ? 'Другой…' : 'Выберите проект…'}</option>
              {pick.projects.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
            </OptionSelect>
          </div>
        </div>
      )}
      {open && !result && !pick && (
        <div className="sp-actions">
          {actions.map((a) => (
            <Button key={a.key} size="sm" variant={a.primary ? 'primary' : 'outline'} disabled={busy} onClick={() => void act(a)}>
              {a.label}
            </Button>
          ))}
          <DropdownMenu trigger={<Button size="icon-sm" variant="ghost" aria-label="Ещё" title="Отложить или отклонить"><Icon name="more" size={16} /></Button>}>
            <MenuItem icon={<Icon name="clock" size={14} />} onSelect={() => void snooze('hour')}>Отложить на час</MenuItem>
            <MenuItem icon={<Icon name="clock" size={14} />} onSelect={() => void snooze('afternoon')}>После обеда</MenuItem>
            <MenuItem icon={<Icon name="calendar" size={14} />} onSelect={() => void snooze('tomorrow')}>Завтра утром</MenuItem>
            <MenuSeparator />
            <MenuItem icon={<Icon name="close" size={14} />} onSelect={() => void dismiss(false, 'not_needed')}>Не нужно</MenuItem>
            <MenuItem icon={<Icon name="eye-off" size={14} />} onSelect={() => void dismiss(true)} destructive>Больше не предлагать такое</MenuItem>
          </DropdownMenu>
        </div>
      )}
      <div className="sp-rate">
        {rated ? <span className="dim">Спасибо, учту.</span> : askReason ? (
          <>
            {REASONS.map((r) => <button key={r.key} className="sp-chip" onClick={() => void rate(false, r.key)}>{r.label}</button>)}
          </>
        ) : (
          <>
            <button className="sp-icon-btn" onClick={() => void rate(true)} title="Полезно" aria-label="Полезно"><Icon name="thumbs-up" size={13} /></button>
            <button className="sp-icon-btn" onClick={() => setAskReason(true)} title="Бесполезно" aria-label="Бесполезно"><Icon name="thumbs-down" size={13} /></button>
          </>
        )}
      </div>
    </article>
  );
}

/**
 * Утренний бриф (ТЗ-21, этап 7; #1525): «Доброе утро, …! Вот главное на сегодня:»,
 * пункты, голос — если есть, и черновики утренней планерки — каждый ставится задачей
 * в 1 клик. Голос грузим по нажатию: файл личный и весит сотни килобайт.
 */
type StandupDraft = { ref: string; title: string; projectId: string; link: string | null; taskId: string | null };

function Brief({ p, onGo, busy, onTask }: { p: AssistantProposal; onGo: (link: string | null) => void; busy: boolean; onTask: ((ref: string) => void) | null }) {
  const lines = (p.payload.lines as string[] | undefined) ?? (p.summary ?? '').split('\n');
  const intro = p.payload.intro as string | undefined;
  const outro = p.payload.outro as string | undefined;
  const drafts = (p.payload.drafts as StandupDraft[] | undefined) ?? [];
  const audioId = p.payload.audioFileId as string | null | undefined;
  const links = (p.payload.links as { label: string; path: string }[] | undefined) ?? [];
  const [url, setUrl] = useState<string | null>(null);
  const [state, setState] = useState<'idle' | 'loading' | 'failed'>('idle');
  useEffect(() => () => { if (url) URL.revokeObjectURL(url); }, [url]);
  const listen = async () => {
    if (!audioId) return;
    setState('loading');
    try { setUrl(URL.createObjectURL(await fetchBlob(audioId))); setState('idle'); } catch { setState('failed'); }
  };
  return (
    <div className="sp-brief">
      {intro && <p>{intro}</p>}
      <ul>{lines.filter(Boolean).map((l, i) => <li key={i}>{l}</li>)}</ul>
      {outro && <p>{outro}</p>}
      {audioId && (url
        ? <audio src={url} controls autoPlay />
        : <Button size="sm" variant="outline" disabled={state === 'loading'} onClick={() => void listen()}>
            <Icon name="play" size={14} /> {state === 'loading' ? 'Загружаю…' : state === 'failed' ? 'Не загрузилось — ещё раз' : 'Слушать'}
          </Button>)}
      {drafts.length > 0 && (
        <div className="sp-standup" role="group" aria-label="Черновики для утренней планерки">
          <div className="sp-pick-q">Черновики для утренней планерки</div>
          {drafts.map((d) => (
            <div key={d.ref} className="sp-draft">
              <span>{d.title}</span>
              {d.taskId
                ? <Button size="sm" variant="ghost" onClick={() => onGo(`/projects/${d.projectId}/task/${d.taskId}`)}><Icon name="check" size={13} /> Задача #{d.taskId}</Button>
                : onTask && <Button size="sm" variant="outline" disabled={busy} onClick={() => onTask(d.ref)}>Поставить задачей</Button>}
            </div>
          ))}
        </div>
      )}
      {links.length > 0 && (
        <div className="sp-actions">
          {links.map((l) => <Button key={l.path + l.label} size="sm" variant="ghost" onClick={() => onGo(l.path)}>{l.label}</Button>)}
        </div>
      )}
    </div>
  );
}

/** «Обещания» (§99): мои и данные мне, с цитатой и источником. */
function Commitments({ onNavigate }: { onNavigate: () => void }) {
  const [items, setItems] = useState<Commitment[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const load = useCallback(() => { api.commitments().then(setItems).catch(() => setItems([])); }, []);
  useEffect(() => {
    load();
    const socket = getSocket();
    socket.on('assistant.proposal', load);
    return () => { socket.off('assistant.proposal', load); };
  }, [load]);

  const mark = async (c: Commitment, done: boolean) => {
    setBusy(c.id);
    try { await (done ? api.commitmentFulfilled(c.id) : api.commitmentDismiss(c.id)); load(); }
    catch { /* следующая загрузка покажет как есть */ }
    finally { setBusy(null); }
  };

  const [note, setNote] = useState('');
  const toFocus = async (c: Commitment) => {
    setBusy(c.id);
    try { setNote((await api.commitmentFocus(c.id)).text); load(); window.dispatchEvent(new Event('teamcrm:focus-changed')); }
    catch (e) { setNote(e instanceof ApiError ? e.message : 'Не получилось'); }
    finally { setBusy(null); }
  };

  if (items === null) return <SkeletonList rows={4} />;
  if (!items.length) {
    return (
      <EmptyState
        icon="handshake"
        compact
        title="Открытых обещаний нет"
        hint="Секретарь замечает «сделаю», «пришлю завтра» в чатах, комментариях и встречах и напоминает, если срок прошёл, а дела не видно."
      />
    );
  }
  const groups: [string, Commitment[]][] = [
    ['Я обещал', items.filter((c) => c.mine)],
    ['Мне обещали', items.filter((c) => !c.mine)],
  ];
  return (
    <div className="sp-inbox">
      {note && <div className="dim sp-elsewhere">{note}</div>}
      {groups.map(([title, list]) => list.length > 0 && (
        <section key={title} className="sp-section">
          <div className="drawer-section-title"><Icon name="handshake" size={14} /> {title} · {list.length}</div>
          {list.map((c) => (
            <div key={c.id} className="sp-commit">
              <div className="sp-title">{c.mine ? c.action : `${c.speaker}: ${c.action}`}</div>
              <div className="sp-quote">«{c.quote}»</div>
              <div className="sp-meta">
                {c.deadlineAt ? <span className={new Date(c.deadlineAt) < new Date() ? 'sp-late' : ''}>срок {when(c.deadlineAt)}</span> : c.deadlineText ? <span>{c.deadlineText}</span> : <span>без срока</span>}
                {c.status === 'tracked' && <span>· есть задача</span>}
                {c.status === 'needs_followup' && <span className="sp-late">· напомнил</span>}
                {c.source.link
                  ? <button className="sp-src" onClick={() => { onNavigate(); navigate(c.source.link!); }}>{c.source.label}</button>
                  : <span>· {c.source.label}</span>}
              </div>
              <div className="sp-actions">
                {c.mine && (
                  <Button size="sm" variant="outline" disabled={busy === c.id} onClick={() => void toFocus(c)}>
                    <Icon name="target" size={13} /> В мой Фокус
                  </Button>
                )}
                <Button size="sm" variant="outline" disabled={busy === c.id} onClick={() => void mark(c, true)}>Выполнено</Button>
                <Button size="sm" variant="ghost" disabled={busy === c.id} onClick={() => void mark(c, false)}>Не отслеживать</Button>
              </div>
            </div>
          ))}
        </section>
      ))}
    </div>
  );
}

/** Личные настройки и — владельцу — навыки компании и их качество (§89, §110). */
function Settings() {
  const [prefs, setPrefs] = useState<ProactivePrefs | null>(null);
  const [company, setCompany] = useState<ProactiveSettings | null>(null);
  const [quality, setQuality] = useState<ProactiveQuality[]>([]);
  const [extra, setExtra] = useState<ProactiveQualityExtra | null>(null);
  const [note, setNote] = useState('');

  useEffect(() => {
    api.proactivePrefs().then(setPrefs).catch(() => undefined);
    api.proactiveSettings().then((s) => {
      setCompany(s);
      api.proactiveQuality(30).then((q) => { setQuality(q.skills); setExtra(q.extra); }).catch(() => undefined);
    }).catch(() => setCompany(null)); // не владелец — блока компании нет
  }, []);

  const savePrefs = async (patch: Partial<Omit<ProactivePrefs, 'mutes'>>) => {
    setPrefs((p) => (p ? { ...p, ...patch } : p));
    try { setPrefs(await api.saveProactivePrefs(patch)); setNote('Сохранено'); }
    catch { setNote('Не сохранилось'); }
  };
  const saveCompany = async (patch: Partial<ProactiveSettings>) => {
    setCompany((c) => (c ? { ...c, ...patch } : c));
    try { setCompany(await api.saveProactiveSettings(patch)); setNote('Сохранено'); }
    catch (e) { setNote(e instanceof ApiError ? e.message : 'Не сохранилось'); }
  };

  if (!prefs) return <SkeletonList rows={4} />;
  return (
    <div className="sp-settings">
      <div className="drawer-section-title"><Icon name="user" size={14} /> Для меня</div>
      <label className="sp-field">
        <span>Сколько беспокоить</span>
        <Select
          ariaLabel="Сколько беспокоить"
          value={prefs.level}
          onValueChange={(v) => void savePrefs({ level: v as ProactivePrefs['level'] })}
          options={[
            { value: 'normal', label: 'Обычно — срочное приходит уведомлением' },
            { value: 'quiet', label: 'Тихо — только значок, без уведомлений' },
            { value: 'off', label: 'Выключено — ничего не предлагать' },
          ]}
        />
      </label>
      <label className="sp-field">
        <span>Уведомлений в день, не больше</span>
        <input
          className="input sp-num" type="number" min={1} max={50} value={prefs.dailyLimit}
          onChange={(e) => setPrefs({ ...prefs, dailyLimit: Number(e.target.value) || 1 })}
          onBlur={() => void savePrefs({ dailyLimit: prefs.dailyLimit })}
        />
      </label>
      <Checkbox checked={prefs.morningAudio} onCheckedChange={(v) => void savePrefs({ morningAudio: !!v })} label="Утренняя сводка голосом" />
      {prefs.briefAvailable && (
        <>
          <Checkbox checked={!!prefs.briefAt} onCheckedChange={(v) => void savePrefs({ briefAt: v ? '09:00' : '' })} label="Утренний бриф руководителя с черновиками планерки" />
          {prefs.briefAt && (
            <label className="sp-field sp-inline">
              <span>Присылать в</span>
              <input className="input sp-num" type="time" value={prefs.briefAt}
                     onChange={(e) => setPrefs({ ...prefs, briefAt: e.target.value })}
                     onBlur={(e) => { if (e.target.value) void savePrefs({ briefAt: e.target.value }); }} />
            </label>
          )}
        </>
      )}
      {prefs.mutes.length > 0 && (
        <div className="sp-mutes">
          <div className="dim">Больше не предлагать:</div>
          {prefs.mutes.map((m) => (
            <div key={`${m.skill}:${m.kind}`} className="sp-mute">
              <span>{SKILL_TITLE[m.skill] ?? m.skill}{m.kind ? ` · ${m.kind}` : ''}</span>
              <Button size="sm" variant="ghost" onClick={() => api.proactiveUnmute(m.skill, m.kind).then(setPrefs).catch(() => undefined)}>Вернуть</Button>
            </div>
          ))}
        </div>
      )}

      {company && (
        <>
          <div className="drawer-section-title sp-gap"><Icon name="building" size={14} /> Для компании</div>
          <Checkbox checked={company.enabled} onCheckedChange={(v) => void saveCompany({ enabled: !!v })} label="Проактивный секретарь включён" />
          <div className="sp-indent">
            <Checkbox checked={company.commitments} onCheckedChange={(v) => void saveCompany({ commitments: !!v })} label="Следить за обещаниями (чаты, комментарии, встречи)" />
            <Checkbox checked={company.workloadGuard} onCheckedChange={(v) => void saveCompany({ workloadGuard: !!v })} label="Предупреждать о перегрузе при постановке задачи" />
            <Checkbox checked={company.clientFollowup} onCheckedChange={(v) => void saveCompany({ clientFollowup: !!v })} label="Письмо клиенту после встречи" />
            <Checkbox checked={company.externalSend} onCheckedChange={(v) => void saveCompany({ externalSend: !!v })} label="Разрешить отправку клиентам (после подтверждения)" />
            <Checkbox checked={company.morningAudio} onCheckedChange={(v) => void saveCompany({ morningAudio: !!v })} label="Утренняя сводка голосом" />
            <Checkbox checked={company.secondBrain} onCheckedChange={(v) => void saveCompany({ secondBrain: !!v })} label="Память компании: поиск по чатам и встречам" />
            <Checkbox checked={company.telegramDelivery} onCheckedChange={(v) => void saveCompany({ telegramDelivery: !!v })} label="Дублировать срочное в Telegram" />
            <label className="sp-field">
              <span>Карточка обещавшему и руководителю через, ч</span>
              <input className="input sp-num" type="number" min={2} max={168} value={company.commitmentCheckHours}
                     onChange={(e) => setCompany({ ...company, commitmentCheckHours: Number(e.target.value) || 24 })}
                     onBlur={() => void saveCompany({ commitmentCheckHours: company.commitmentCheckHours })} />
            </label>
            <label className="sp-field">
              <span>Порог уверенности для обещаний: {Math.round(company.commitmentMinConfidence * 100)}% — выше порог, меньше лишнего</span>
              <input type="range" min={50} max={95} step={5} value={Math.round(company.commitmentMinConfidence * 100)}
                     onChange={(e) => setCompany({ ...company, commitmentMinConfidence: Number(e.target.value) / 100 })}
                     onMouseUp={() => void saveCompany({ commitmentMinConfidence: company.commitmentMinConfidence })}
                     onTouchEnd={() => void saveCompany({ commitmentMinConfidence: company.commitmentMinConfidence })}
                     onKeyUp={() => void saveCompany({ commitmentMinConfidence: company.commitmentMinConfidence })} />
            </label>
            <div className="dim">Вызовов ИИ в сутки на компанию, не больше:</div>
            {([['smart_reply', 'Готовые ответы'], ['client_followup', 'Письма клиентам'], ['morning_voice', 'Утренний голос']] as const).map(([k, label]) => (
              <label key={k} className="sp-field sp-inline">
                <span>{label}</span>
                <input className="input sp-num" type="number" min={0} max={5000} value={company.aiDailyLimits?.[k] ?? 0}
                       onChange={(e) => setCompany({ ...company, aiDailyLimits: { ...company.aiDailyLimits, [k]: Number(e.target.value) || 0 } })}
                       onBlur={() => void saveCompany({ aiDailyLimits: company.aiDailyLimits })} />
              </label>
            ))}
          </div>
          {extra && (extra.replies.total > 0 || extra.commitments.total > 0) && (
            <div className="dim sp-note">
              {extra.replies.total > 0 && <div>Готовые ответы: {extra.replies.total}, взяли как есть {extra.replies.acceptedPct ?? 0}%, поправили {extra.replies.editedPct ?? 0}%, скрыли {extra.replies.dismissedPct ?? 0}%.</div>}
              {extra.commitments.total > 0 && <div>Обещания: {extra.commitments.total}, выполнено {extra.commitments.fulfilledPct ?? 0}%, сняли {extra.commitments.untrackedPct ?? 0}%, с напоминанием {extra.commitments.remindedPct ?? 0}%.</div>}
            </div>
          )}
          {quality.length > 0 && (
            <>
              <div className="drawer-section-title sp-gap"><Icon name="chart" size={14} /> Качество за 30 дней</div>
              <table className="sp-quality">
                <thead><tr><th>Навык</th><th>Всего</th><th>Приняли</th><th>Мимо</th></tr></thead>
                <tbody>
                  {quality.map((q) => (
                    <tr key={q.skill}>
                      <td>{SKILL_TITLE[q.skill] ?? q.skill}</td><td>{q.total}</td><td>{q.acceptRate}%</td>
                      <td>{q.falsePositiveRate == null ? '—' : `${q.falsePositiveRate}%`}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </>
      )}
      {note && <div className="dim sp-note">{note}</div>}
    </div>
  );
}
