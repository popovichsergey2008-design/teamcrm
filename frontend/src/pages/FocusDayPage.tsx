import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import './focus-day.css';
import { Icon } from '../components/Icon';
import { EmptyState } from '../components/EmptyState';
import { SkeletonList } from '../components/Skeleton';
import { OnboardingCard } from '../components/OnboardingCard';
import { AssistantPings } from '../components/AssistantPings';
import { MeetingAgenda } from '../components/MeetingAgenda';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { promptText } from '../components/ui/dialog';
import { api, ApiError, FocusCandidate, FocusChangeReason, FocusHuddle, FocusItem, FocusToday } from '../lib/api';
import { navigate } from '../lib/router';
import { plural } from '../lib/chat-text';
import { deadlineBadge, priorityBadge } from '../lib/labels';
import { getSocket } from '../lib/socket';
import { setFocusSession, useFocusSession } from '../hooks/useFocusSession';
import { CloseDayDialog } from './CloseDayDialog';
import { TeamNow } from './TeamNow';
import { useAuth } from '../state/auth';

type Day = Extract<FocusToday, { enabled: true }>;

/**
 * «Фокус дня» по ТЗ-16: не список задач, а ответ на вопрос «что мне сделать сегодня
 * в первую очередь» — до трёх главных действий, собранных системой, с объяснением.
 *
 * Что здесь важно не сломать:
 * - Тройку собирает сервер (правила, не модель) при первом открытии за день. Экран
 *   только показывает и даёт поправить: принять, переставить, заменить, убрать.
 * - Принятый план система сама не меняет — новая срочная задача приходит
 *   предложением «может заменить #3», решает человек.
 * - Неважное не добивает экран до трёх: «третий слот свободен» — честный ответ.
 * - Остальное свёрнуто и грузится только по нажатию: это не реестр задач.
 */

const REASONS: { id: FocusChangeReason; label: string }[] = [
  { id: 'not_relevant', label: 'Не актуально' },
  { id: 'wrong_priority', label: 'Неверный приоритет' },
  { id: 'done', label: 'Уже сделано' },
  { id: 'blocked', label: 'Заблокировано' },
  { id: 'other', label: 'Другое' },
];

const RANK_LABEL: Record<number, string> = { 1: 'Главная миссия дня', 2: 'Важно', 3: 'Важно' };
const DATE_FMT = new Intl.DateTimeFormat('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' });

function greeting(): string {
  const h = new Date().getHours();
  if (h < 5) return 'Доброй ночи';
  if (h < 12) return 'Доброе утро';
  if (h < 18) return 'Добрый день';
  return 'Добрый вечер';
}

const kindIcon = (k: FocusItem['kind']) => (k === 'approval' ? 'handshake' : k === 'review' ? 'check-circle' : 'target');

export function FocusDayPage({ initial, onOpenTask, onJoinCall, active = true }: {
  initial: Day;
  onOpenTask: (projectId: string, taskId: string) => void;
  onJoinCall: (roomId: string) => void;
  active?: boolean;
}) {
  const { user } = useAuth();
  const [day, setDay] = useState<Day>(initial);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [why, setWhy] = useState<Set<string>>(new Set());
  // «Остальные» и «ждут решения» — одна ленивая выборка с сервера
  const [backlog, setBacklog] = useState<FocusCandidate[] | null>(null);
  const [backlogOpen, setBacklogOpen] = useState<null | 'all' | 'decisions'>(null);
  // куда ставим: свободное место или замена (тогда спросим, почему)
  const [placing, setPlacing] = useState<FocusCandidate | null>(null);
  const [asking, setAsking] = useState<null | { itemId: string; mode: 'remove' } | { key: string; rank: number; mode: 'replace' }>(null);
  const [criticalOpen, setCriticalOpen] = useState(false);
  // перед стартом фокуса: встреча раньше его конца (п. 132)
  const [meetingSoon, setMeetingSoon] = useState<null | { item: FocusItem; title: string; minutesLeft: number }>(null);
  const { session } = useFocusSession();
  const [closing, setClosing] = useState(false);
  const [huddleOpen, setHuddleOpen] = useState<string | null>(null);

  const apply = (next: FocusToday) => {
    if (next.enabled) setDay(next);
  };

  const reload = useCallback(async () => {
    try {
      const next = await api.focusToday();
      apply(next);
      setBacklog(null);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Не удалось обновить фокус');
    }
  }, []);

  // Первый показ — данные только что пришли от обёртки, второй запрос ни к чему.
  const first = useRef(true);
  useEffect(() => {
    if (!active) return;
    if (first.current) first.current = false; else void reload();
    // Задачу закрыли из карточки, согласовали в чате, план поменяли с телефона —
    // экран не должен врать.
    const refresh = () => { void reload(); };
    window.addEventListener('teamcrm:tasks-changed', refresh);
    const socket = getSocket();
    socket.on('focus.day.updated', refresh);
    return () => {
      window.removeEventListener('teamcrm:tasks-changed', refresh);
      socket.off('focus.day.updated', refresh);
    };
  }, [active, reload]);

  const run = async (fn: () => Promise<FocusToday | unknown>) => {
    setBusy(true); setErr('');
    try {
      const next = await fn();
      if (next && typeof next === 'object' && 'enabled' in (next as FocusToday)) apply(next as FocusToday);
      setBacklog(null);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Не получилось — попробуйте ещё раз');
    } finally {
      setBusy(false);
    }
  };

  const loadBacklog = useCallback(async () => {
    try { setBacklog(await api.focusBacklog()); } catch { setBacklog([]); }
  }, []);
  useEffect(() => { if (backlogOpen && backlog === null) void loadBacklog(); }, [backlogOpen, backlog, loadBacklog]);

  const top = useMemo(() => [...day.top].sort((a, b) => a.rank - b.rank), [day.top]);
  const activeItems = top.filter((i) => i.status === 'active');
  const freeRanks = [1, 2, 3].filter((r) => !top.some((i) => i.rank === r));
  const doneCount = top.filter((i) => i.status === 'done').length;
  const proposed = day.plan.status === 'proposed';
  const mission = top.find((i) => i.rank === 1);

  const open = (i: { taskId: string | null; projectId?: string | null }) => {
    if (i.taskId && i.projectId) onOpenTask(i.projectId, i.taskId);
  };

  /** В фокус: на свободное место сразу, иначе — выбрать, что заменить. */
  const place = (c: FocusCandidate) => {
    if (freeRanks.length) void run(() => api.focusAdd(c.key));
    else setPlacing(c);
  };

  const move = (item: FocusItem, dir: -1 | 1) => {
    const ids = top.map((i) => i.id);
    const at = ids.indexOf(item.id);
    const to = at + dir;
    if (to < 0 || to >= ids.length) return;
    [ids[at], ids[to]] = [ids[to], ids[at]];
    void run(() => api.focusReorder(ids));
  };

  const decide = async (item: FocusItem, approve: boolean) => {
    if (!item.approvalId) return;
    let note: string | undefined;
    if (!approve) {
      const text = await promptText({ title: 'Почему отказываете?', placeholder: 'Причина увидит автор', confirmLabel: 'Отказать', minLength: 3 });
      if (!text) return;
      note = text;
    }
    await run(async () => {
      await api.decideApproval(item.approvalId!, approve, note);
      window.dispatchEvent(new Event('teamcrm:tasks-changed'));
      return api.focusToday();
    });
  };

  /** Войти в глубокий фокус по действию плана: сначала — нет ли встречи раньше конца. */
  const startFocus = async (item: FocusItem, minutes = 50, skipCheck = false) => {
    setErr('');
    if (!skipCheck) {
      const pre = await api.focusPreflight(minutes).catch(() => ({ meeting: null }));
      if (pre.meeting) { setMeetingSoon({ item, title: pre.meeting.title, minutesLeft: pre.meeting.minutesLeft }); return; }
    }
    setMeetingSoon(null);
    await run(async () => {
      setFocusSession(await api.focusStart({ taskId: item.taskId, itemId: item.id, minutes }));
      return api.focusToday();
    });
  };

  const toggleWhy = (id: string) => setWhy((s) => {
    const n = new Set(s);
    if (n.has(id)) n.delete(id); else n.add(id);
    return n;
  });

  const reasonPicker = (onPick: (r: FocusChangeReason) => void) => (
    <div className="fd-reasons" role="group" aria-label="Почему?">
      <span className="dim">Почему?</span>
      {REASONS.map((r) => (
        <button key={r.id} type="button" className="fd-chip" disabled={busy} onClick={() => onPick(r.id)}>{r.label}</button>
      ))}
      <button type="button" className="fd-chip fd-chip-ghost" onClick={() => setAsking(null)}>Отмена</button>
    </div>
  );

  const card = (item: FocusItem) => {
    const done = item.status === 'done';
    const due = deadlineBadge(item.deadlineAt, done);
    const prio = priorityBadge(item.priority);
    const isMission = item.rank === 1;
    const showWhy = why.has(item.id);
    return (
      <article
        key={item.id}
        className={`fd-card${isMission ? ' fd-mission' : ''}${done ? ' fd-done' : ''}${item.unavailable ? ' fd-gone' : ''}`}
        aria-label={`#${item.rank} ${RANK_LABEL[item.rank]}`}
      >
        <div className="fd-card-top">
          <span className="fd-rank">#{item.rank} {RANK_LABEL[item.rank]}</span>
          {item.pinned && !editing && <span className="fd-pin" title="Закреплено вами — пересчёт его не вытеснит"><Icon name="pin" size={12} /></span>}
          {done && <Badge tone="ok"><Icon name="check" size={11} /> Сделано</Badge>}
          {editing && !done && (
            <span className="fd-edit">
              <Button variant="ghost" size="sm" aria-label="Выше" title="Выше" disabled={busy || item.rank === 1} onClick={() => move(item, -1)}><Icon name="arrow-up" size={14} /></Button>
              <Button variant="ghost" size="sm" aria-label="Ниже" title="Ниже" disabled={busy || item.rank === top.length} onClick={() => move(item, 1)}><Icon name="arrow-down" size={14} /></Button>
              <Button
                variant="ghost" size="sm" disabled={busy}
                aria-pressed={item.pinned}
                title={item.pinned ? 'Открепить' : 'Закрепить: пересчёт не вытеснит'}
                onClick={() => void run(() => api.focusPin(item.id, !item.pinned))}
              ><Icon name="pin" size={14} /></Button>
              <Button variant="ghost" size="sm" disabled={busy} onClick={() => setAsking({ itemId: item.id, mode: 'remove' })}><Icon name="close" size={14} /> Убрать</Button>
            </span>
          )}
        </div>

        {item.unavailable ? (
          <div className="fd-gone-body">
            <span className="dim">Эта задача больше недоступна.</span>
            <Button variant="outline" size="sm" onClick={() => setBacklogOpen('all')}>Заменить</Button>
          </div>
        ) : (
          <>
            <button type="button" className="fd-title" onClick={() => open(item)} disabled={!item.taskId}>
              <Icon name={kindIcon(item.kind)} size={isMission ? 18 : 15} /> {item.title}
            </button>
            <div className="fd-meta">
              {item.projectName && <Badge tone="outline">{item.projectName}</Badge>}
              {due && <Badge tone={due.tone} title={due.title}><Icon name="clock" size={11} />{due.label}</Badge>}
              {prio && <Badge tone={prio.tone}>{prio.label}</Badge>}
              {item.kind === 'task' && item.checklistTotal > 0 && (
                <span className="fd-check"><Icon name="check-circle" size={13} /> {item.checklistDone} из {item.checklistTotal}</span>
              )}
              {item.kind === 'review' && item.assigneeName && <span className="dim">сдал(а): {item.assigneeName}</span>}
            </div>
            {isMission && item.checklistTotal > 0 && (
              <div className="fd-progress" role="progressbar" aria-valuemin={0} aria-valuemax={item.checklistTotal} aria-valuenow={item.checklistDone} aria-label="Чек-лист">
                <span style={{ width: `${Math.round((item.checklistDone / item.checklistTotal) * 100)}%` }} />
              </div>
            )}
            <div className="fd-actions">
              {item.kind === 'approval' && !done && (
                <>
                  <Button variant="primary" size="sm" disabled={busy} onClick={() => void decide(item, true)}><Icon name="check" size={14} /> Согласовать</Button>
                  <Button variant="outline" size="sm" disabled={busy} onClick={() => void decide(item, false)}>Отказать</Button>
                </>
              )}
              {item.kind === 'review' && !done && item.taskId && (
                <Button variant={isMission ? 'primary' : 'outline'} size="sm" onClick={() => open(item)}><Icon name="check-circle" size={14} /> Открыть и принять</Button>
              )}
              {item.kind === 'task' && !done && item.taskId && !session && (
                <Button
                  variant={isMission ? 'primary' : 'outline'} size="sm" disabled={busy}
                  onClick={() => void startFocus(item)}
                ><Icon name="target" size={14} /> {isMission ? 'Войти в глубокий фокус · 50 мин' : 'Фокус · 50 мин'}</Button>
              )}
              {item.kind === 'task' && !done && isMission && item.taskId && (
                <Button variant="ghost" size="sm" onClick={() => open(item)}><Icon name="board" size={14} /> Открыть задачу</Button>
              )}
              {item.reasons.length > 0 && (
                <Button variant="ghost" size="sm" aria-expanded={showWhy} onClick={() => toggleWhy(item.id)}>
                  <Icon name="sparkles" size={13} /> Почему эта задача?
                </Button>
              )}
            </div>
            {showWhy && (
              <ul className="fd-why">
                {item.reasons.map((r) => <li key={r}>{r}</li>)}
              </ul>
            )}
          </>
        )}
        {meetingSoon?.item.id === item.id && (
          <div className="fd-meeting" role="alertdialog" aria-label="Скоро встреча">
            <span><Icon name="calendar" size={14} /> У вас встреча «{meetingSoon.title}» через {meetingSoon.minutesLeft} мин.</span>
            <span className="fd-banner-acts">
              {meetingSoon.minutesLeft >= 5 && (
                <Button variant="primary" size="sm" disabled={busy} onClick={() => void startFocus(item, meetingSoon.minutesLeft, true)}>Фокус на {meetingSoon.minutesLeft} мин</Button>
              )}
              <Button variant="outline" size="sm" disabled={busy} onClick={() => void startFocus(item, 50, true)}>Начать 50 минут всё равно</Button>
              <Button variant="ghost" size="sm" onClick={() => setMeetingSoon(null)}>Отмена</Button>
            </span>
          </div>
        )}
        {asking && 'itemId' in asking && asking.itemId === item.id && reasonPicker((r) => {
          setAsking(null);
          void run(() => api.focusRemove(item.id, r));
        })}
      </article>
    );
  };

  const emptySlot = (rank: number) => (
    <div key={`free-${rank}`} className="fd-card fd-free">
      <span className="fd-rank">#{rank}</span>
      <span className="dim">{rank === 1 ? 'Главная миссия свободна.' : 'Слот свободен.'}</span>
      <Button variant="outline" size="sm" onClick={() => setBacklogOpen('all')}><Icon name="plus" size={14} /> Добавить вручную</Button>
    </div>
  );

  /**
   * Созвон → фокус (п. 74–76): одно поручение — «важнее вашего #N?», несколько —
   * сводкой «N новых действий, из них срочных M». Принятый план без согласия не меняется.
   */
  const huddleCard = (h: FocusHuddle) => {
    const one = h.items.length === 1 ? h.items[0] : null;
    const due = one ? deadlineBadge(one.deadlineAt) : null;
    const expanded = huddleOpen === h.meetingId;
    return (
      <section key={h.meetingId} className="fd-huddle" aria-label={`После встречи «${h.title}»`}>
        <div className="fd-huddle-line">
          <Icon name="video" size={16} />
          {one ? (
            <span>
              На встрече «{h.title}» зафиксировано: <b>{one.title}</b>{due ? ` · ${due.label}` : ''}.
              {h.suggestRank && <> QEVO AI считает это важнее вашего #{h.suggestRank}.</>}
            </span>
          ) : h.items.length > 1 ? (
            <span>
              После встречи «{h.title}» у вас {h.items.length} {plural(h.items.length, 'новое действие', 'новых действия', 'новых действий')}
              {h.urgent ? ` · срочных ${h.urgent}` : ''}{h.regular ? ` · обычных ${h.regular}` : ''}.
            </span>
          ) : (
            <span>Со встречи «{h.title}» ждут разбора {h.pendingDrafts} {plural(h.pendingDrafts, 'поручение', 'поручения', 'поручений')} на вас.</span>
          )}
        </div>
        <span className="fd-banner-acts">
          {one && h.suggestRank && (
            <Button variant="primary" size="sm" disabled={busy} onClick={() => void run(() => api.focusAdd(one.key, h.suggestRank ?? undefined, 'wrong_priority'))}>
              <Icon name="pin" size={13} /> Закрепить как #{h.suggestRank}
            </Button>
          )}
          {one && one.taskId && (
            <Button variant="outline" size="sm" onClick={() => setBacklogOpen('all')}>Открыть в списке</Button>
          )}
          {h.items.length > 1 && (
            <Button variant="outline" size="sm" aria-expanded={expanded} onClick={() => setHuddleOpen(expanded ? null : h.meetingId)}>Посмотреть</Button>
          )}
          {h.pendingDrafts > 0 && (
            <Button variant="ghost" size="sm" onClick={() => navigate({ section: 'chat', view: 'meetings' })}>Разобрать черновики ({h.pendingDrafts})</Button>
          )}
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => void run(() => api.focusDismiss(`huddle:${h.meetingId}`))}>В список</Button>
        </span>
        {expanded && (
          <ul className="fd-huddle-list">
            {h.items.map((c) => (
              <li key={c.key}>
                <span>{c.title}{c.reasons[0] ? <span className="dim"> · {c.reasons.filter((r) => !r.startsWith('поручили')).slice(0, 1).join('')}</span> : null}</span>
                <Button variant="outline" size="sm" disabled={busy} onClick={() => place({ key: c.key, kind: 'task', taskId: c.taskId, approvalId: null, title: c.title, projectName: null, score: c.score, reasons: c.reasons })}>
                  <Icon name="target" size={13} /> В фокус
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>
    );
  };

  const decisions = (backlog ?? []).filter((c) => c.kind !== 'task');
  const listed = backlogOpen === 'decisions' ? decisions : (backlog ?? []);
  const critical = day.criticalCandidate;

  return (
    <div className="focus-page fd-page">
      <header className="fd-head">
        <div>
          <div className="focus-hello">{greeting()}, {user?.fullName?.split(' ')[0] ?? ''}!</div>
          <div className="dim">{DATE_FMT.format(new Date())}</div>
        </div>
        {top.length > 0 && (
          <div className="fd-score" aria-label={`Сделано ${doneCount} из ${top.length} главных`}>
            <b>{doneCount} / {top.length}</b> <span className="dim">главных</span>
          </div>
        )}
      </header>

      {err && <div className="tv2-callout tv2-callout-danger" role="alert"><Icon name="alert" size={15} /> {err}</div>}

      {/* Предложение системы — пока человек его не принял (п. 34). */}
      {proposed && top.length > 0 && (
        <section className="fd-banner" aria-label="Предложение QEVO AI">
          <span className="fd-banner-text"><Icon name="sparkles" size={16} /> QEVO AI подготовил ваш фокус дня</span>
          <span className="fd-banner-acts">
            <Button variant="primary" size="sm" disabled={busy} onClick={() => void run(api.focusAccept)}><Icon name="check" size={14} /> Принять</Button>
            <Button variant={editing ? 'secondary' : 'outline'} size="sm" aria-pressed={editing} onClick={() => setEditing((v) => !v)}><Icon name="edit" size={14} /> Настроить</Button>
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => void run(api.focusRecalculate)}><Icon name="refresh" size={14} /> Пересчитать</Button>
          </span>
        </section>
      )}
      {!proposed && top.length > 0 && (
        <div className="fd-accepted">
          <span className="dim"><Icon name="check" size={13} /> План на сегодня принят</span>
          <Button variant="ghost" size="sm" aria-pressed={editing} onClick={() => setEditing((v) => !v)}><Icon name="edit" size={13} /> {editing ? 'Готово' : 'Настроить'}</Button>
          {day.plan.feedback == null ? (
            <span className="fd-feedback">
              <span className="dim">Полезный план?</span>
              <Button variant="ghost" size="sm" aria-label="Полезный" onClick={() => void run(async () => { await api.focusFeedback(1); return api.focusToday(); })}><Icon name="thumbs-up" size={14} /></Button>
              <Button variant="ghost" size="sm" aria-label="Не полезный" onClick={() => void run(async () => { await api.focusFeedback(-1); return api.focusToday(); })}><Icon name="thumbs-down" size={14} /></Button>
            </span>
          ) : <span className="dim">Спасибо за оценку</span>}
        </div>
      )}

      {/* Новая критичная задача после принятия — только предложение (п. 38). */}
      {critical && (
        <section className="fd-critical" role="status">
          <div className="fd-critical-line">
            <Icon name="zap" size={16} />
            <span>Появилась новая критичная задача. Она может заменить #{critical.replaceRank}.</span>
            <Button variant="outline" size="sm" aria-expanded={criticalOpen} onClick={() => setCriticalOpen((v) => !v)}>Посмотреть</Button>
          </div>
          {criticalOpen && (
            <div className="fd-critical-body">
              <b>{critical.title}</b>
              {critical.reasons.length > 0 && <ul className="fd-why">{critical.reasons.map((r) => <li key={r}>{r}</li>)}</ul>}
              <span className="fd-banner-acts">
                <Button variant="primary" size="sm" disabled={busy} onClick={() => setAsking({ key: critical.key, rank: critical.replaceRank, mode: 'replace' })}>
                  Поставить #{critical.replaceRank}
                </Button>
                <Button variant="ghost" size="sm" disabled={busy} onClick={() => void run(() => api.focusDismiss(critical.key))}>Не сейчас</Button>
              </span>
              {asking && 'key' in asking && asking.key === critical.key && reasonPicker((r) => {
                setAsking(null); setCriticalOpen(false);
                void run(() => api.focusAdd(critical.key, critical.replaceRank, r));
              })}
            </div>
          )}
        </section>
      )}

      {day.huddle.map(huddleCard)}

      <OnboardingCard />
      <MeetingAgenda onJoin={onJoinCall} />

      {top.length === 0 ? (
        <EmptyState
          icon="target"
          title="На сегодня критичных задач нет"
          hint="Сроки не горят, ничего не ждёт вашего решения. Можно выбрать задачу самому."
          action={{ label: 'Выбрать задачу самостоятельно', onClick: () => setBacklogOpen('all') }}
        />
      ) : (
        <section className="fd-top" aria-label="Три главных действия дня">
          {mission ? card(mission) : emptySlot(1)}
          {mission?.status === 'done' && activeItems.length < 3 && (
            <div className="fd-note">
              <Icon name="check-circle" size={15} /> Главная миссия завершена.
              <Button variant="ghost" size="sm" onClick={() => setBacklogOpen('all')}>Добавить ещё одну важную задачу</Button>
            </div>
          )}
          <div className="fd-pair">
            {[2, 3].map((r) => {
              const it = top.find((i) => i.rank === r);
              return it ? card(it) : emptySlot(r);
            })}
          </div>
        </section>
      )}

      {/* Решение заказчика: вместо колонки «Требует моего решения» — одна строка. */}
      {day.waitingDecision > 0 && (
        <button type="button" className="fd-row" aria-expanded={backlogOpen === 'decisions'} onClick={() => setBacklogOpen((v) => (v === 'decisions' ? null : 'decisions'))}>
          <Icon name="handshake" size={15} /> Ждут вашего решения: <b>{day.waitingDecision}</b>
          <Icon name={backlogOpen === 'decisions' ? 'chevron-up' : 'chevron-down'} size={14} />
        </button>
      )}
      <button type="button" className="fd-row" aria-expanded={backlogOpen === 'all'} onClick={() => setBacklogOpen((v) => (v === 'all' ? null : 'all'))}>
        <Icon name="list" size={15} /> Остальные задачи и действия ({day.backlogCount})
        <Icon name={backlogOpen === 'all' ? 'chevron-up' : 'chevron-down'} size={14} />
      </button>

      {backlogOpen && (
        <section className="fd-backlog" aria-label="Остальные действия">
          {backlog === null && <SkeletonList rows={4} />}
          {backlog !== null && listed.length === 0 && <div className="dim fd-empty">Здесь пусто.</div>}
          {listed.map((c) => (
            <div key={c.key} className={`fd-bl-row${c.blocked ? ' fd-bl-blocked' : ''}`}>
              <div className="fd-bl-main">
                <span className="fd-bl-title"><Icon name={kindIcon(c.kind)} size={13} /> {c.title}</span>
                <span className="dim fd-bl-sub">{[c.projectName, ...c.reasons.slice(0, 2)].filter(Boolean).join(' · ')}</span>
              </div>
              {placing?.key === c.key ? (
                <span className="fd-place">
                  <span className="dim">Вместо:</span>
                  {activeItems.map((i) => (
                    <Button key={i.id} variant="outline" size="sm" disabled={busy} onClick={() => { setPlacing(null); setAsking({ key: c.key, rank: i.rank, mode: 'replace' }); }}>#{i.rank}</Button>
                  ))}
                  <Button variant="ghost" size="sm" onClick={() => setPlacing(null)}>Отмена</Button>
                </span>
              ) : (
                <Button variant="outline" size="sm" disabled={busy} onClick={() => place(c)}><Icon name="target" size={13} /> В фокус</Button>
              )}
              {asking && 'key' in asking && asking.key === c.key && reasonPicker((r) => {
                setAsking(null);
                void run(() => api.focusAdd(c.key, asking.rank, r));
              })}
            </div>
          ))}
        </section>
      )}

      {/* Кто чем занят — без «ты свободен?» (п. 61). */}
      <TeamNow meId={user?.id} />

      {/* «Завершить день» — по нажатию, поверх работы само не открывается (п. 80). */}
      {day.closeDay.workdayClosedUntil ? (
        <section className="fd-closed" role="status">
          <Icon name="moon" size={16} />
          <span>День завершён. Тихо до {new Date(day.closeDay.workdayClosedUntil).toLocaleString('ru-RU', { weekday: 'short', hour: '2-digit', minute: '2-digit' })} — отдыхайте.</span>
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => void run(api.focusReopen)}>Я ещё поработаю</Button>
        </section>
      ) : day.closeDay.available && (
        <section className="fd-closeday">
          <Button variant="outline" onClick={() => setClosing(true)}><Icon name="moon" size={15} /> Завершить день и подвести итоги</Button>
        </section>
      )}
      <CloseDayDialog
        open={closing}
        onClose={() => setClosing(false)}
        onClosed={(next) => { setClosing(false); apply(next); }}
      />

      {/* Напоминания секретаря — ниже тройки: главное на экране — план, а не россыпь. */}
      <AssistantPings today={day.plan.date} onOpenTask={onOpenTask} onPlanned={() => void reload()} />
    </div>
  );
}
