import { useCallback, useEffect, useMemo, useRef, useState, Suspense, lazy } from 'react';
import { focusSize } from '../lib/focus-size';
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
import { FOCUS_MINUTES, readFocusMinutes, saveFocusMinutes, setFocusSession, useFocusSession } from '../hooks/useFocusSession';
import { DropdownMenu, MenuItem } from '../components/ui/dropdown-menu';
import { CloseDayDialog } from './CloseDayDialog';
import { TeamNow } from './TeamNow';
import { MorningPlan } from './focus/MorningPlan';
import { MainCard, ReviewsBlock } from './focus/MainCard';
import { ReviewRun } from './focus/ReviewRun';
import { Replan } from './focus/Replan';
import { Agreements } from './focus/Agreements';
import { FirstDay } from './focus/FirstDay';
import { dur, focusApi, PlusDay } from './focus/focus-api';
import { useAuth } from '../state/auth';
import { helloName } from '../lib/hello-name';
import { feedback } from '../lib/feedback';
// приглашение на демо ИИ-созвона (ТЗ-24) — отдельным куском, не в стартовой сборке
const AiDemoInvite = lazy(() => import('../components/AiDemoInvite'));
// персональный брифинг (ТЗ-27) — своим куском: экран и тройка не ждут его загрузки
const FocusBriefCard = lazy(() => import('../components/FocusBriefCard'));

const ZEN_KEY = 'teamcrm.focusZen';
const readZen = () => { try { return localStorage.getItem(ZEN_KEY) === '1'; } catch { return false; } };
const track = (e: Parameters<typeof api.focusBriefEvent>[0]) => { void api.focusBriefEvent(e).catch(() => undefined); };

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
  { id: 'not_relevant', label: 'Неактуально' },
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
  // #1568: сколько длится фокус — выбор человека, запоминается
  const [focusMin, setFocusMin] = useState(readFocusMinutes);
  const pickFocusMin = (v: number) => { setFocusMin(v); saveFocusMinutes(v); };
  const [closing, setClosing] = useState(false);
  const [huddleOpen, setHuddleOpen] = useState<string | null>(null);
  // Дзен-режим (ТЗ-27, п. 38–39): только тройка, начатое и таймер; таймер сам не запускает
  const [zen, setZen] = useState(readZen);
  const toggleZen = () => {
    const next = !zen;
    setZen(next);
    try { localStorage.setItem(ZEN_KEY, next ? '1' : '0'); } catch { /* только на этом устройстве */ }
    if (next) track('zen_enabled');
  };
  const boss = user?.role === 'owner' || user?.role === 'manager';
  /*
    #4891: ёмкость дня, таймлайн, главный результат, проверки блоком, плашка после «Готово».
    Фаза дня (утро / день / вечер) решает, что наверху; тройка и её правила — прежние.
  */
  const [plus, setPlus] = useState<PlusDay | null>(null);
  const [runList, setRunList] = useState<FocusCandidate[] | null>(null);
  const [doneInfo, setDoneInfo] = useState<null | { title: string | null; minutes: number; progress: { done: number; total: number; deepMin: number }; notified: string | null; next: { itemId: string; taskId: string | null; title: string | null } | null }>(null);
  const loadPlus = useCallback(async () => {
    try { const d = await focusApi.day(); setPlus(d.enabled ? d : null); } catch { /* блоки ТЗ не обязательны для тройки */ }
  }, []);
  useEffect(() => { if (active) void loadPlus(); }, [active, loadPlus, day.plan.status, day.top]);
  useEffect(() => {
    const onDone = (e: Event) => {
      const d = (e as CustomEvent<{ taskId: string | null; title: string | null; minutes: number }>).detail;
      void focusApi.afterDone(d.taskId, d.minutes).then((r) => { if (r) setDoneInfo({ title: d.title, ...r }); window.dispatchEvent(new Event('teamcrm:tasks-changed')); }).catch(() => undefined);
    };
    window.addEventListener('teamcrm:focus-done', onDone);
    return () => window.removeEventListener('teamcrm:focus-done', onDone);
  }, []);
  const phase = plus?.phase ?? 'day';
  // мягкое напоминание в конце рабочего дня ведёт сюда с ?close=1 (#4891, п. 10)
  useEffect(() => {
    if (!active || !/[?&]close=1/.test(window.location.search)) return;
    setClosing(true);
    try { window.history.replaceState(window.history.state, '', window.location.pathname); } catch { /* адрес останется — не страшно */ }
  }, [active]);
  const briefOn = !!day.brief && day.brief.enabled;

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
  const doneItems = top.filter((i) => i.status === 'done');
  const doneCount = top.filter((i) => i.status === 'done').length;
  const proposed = day.plan.status === 'proposed';
  const mission = top.find((i) => i.rank === 1);

  const open = (i: { taskId: string | null; projectId?: string | null }) => {
    if (i.taskId && i.projectId) onOpenTask(i.projectId, i.taskId);
  };

  /**
   * В фокус: на свободное место или на место сделанного — сразу, без вопросов (#1533);
   * если все три заняты делом — выбрать, какую задачу заменить (по названию, не по номеру).
   */
  const place = (c: FocusCandidate) => {
    if (freeRanks.length || doneItems.length) void run(() => api.focusAdd(c.key));
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
      const text = await promptText({ title: 'Почему отказываете?', placeholder: 'Причину увидит автор', confirmLabel: 'Отказать', minLength: 3 });
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
  const startFocus = async (item: FocusItem, minutes = focusMin, skipCheck = false) => {
    setErr('');
    if (!skipCheck) {
      const pre = await api.focusPreflight(minutes).catch(() => ({ meeting: null }));
      if (pre.meeting) { setMeetingSoon({ item, title: pre.meeting.title, minutesLeft: pre.meeting.minutesLeft }); return; }
    }
    setMeetingSoon(null);
    await run(async () => {
      setFocusSession(await api.focusStart({ taskId: item.taskId, itemId: item.id, minutes }));
      if (briefOn) track('deep_work_from_brief');
      return api.focusToday();
    });
  };

  /** «Взять в работу» (ТЗ-27, п. 24): задача — в «В работе», статус — «работаю», без таймера. */
  const takeToWork = (item: FocusItem) => run(async () => {
    const next = await api.focusTakeToWork(item.id);
    window.dispatchEvent(new Event('teamcrm:tasks-changed'));
    feedback('focus.started');
    return next;
  });

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
    // #4767: короткое решение или глубокая работа — по оценке; без оценки время выбирает человек
    const size = focusSize(item.kind, item.estimateMin);
    const minutesFor = size.minutes ?? focusMin;
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
          {editing && done && (
            <span className="fd-edit">
              <Button variant="ghost" size="sm" disabled={busy} title="Убрать из тройки — место освободится" onClick={() => void run(() => api.focusRemove(item.id, 'done'))}><Icon name="close" size={14} /> Убрать</Button>
            </span>
          )}
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
              {item.taskId && <span className="dim fd-num"> #{item.taskId}</span>}
            </button>
            {item.about && <p className="fd-about">{item.about.split('\n')[0]}</p>}
            <div className="fd-meta">
              {item.projectName && <Badge tone="outline">{item.projectName}</Badge>}
              {due && <Badge tone={due.tone} title={due.title}><Icon name="clock" size={11} />{due.label}</Badge>}
              {prio && <Badge tone={prio.tone}>{prio.label}</Badge>}
              {/* #4892, п. 8: тот же блок, что в календаре, — сдвинули там, видно здесь */}
              {item.calendarBlock && (
                <Badge tone="outline" title="Время на задачу в календаре"><Icon name="calendar" size={11} />{new Date(item.calendarBlock.startsAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}–{new Date(item.calendarBlock.endsAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}</Badge>
              )}
              {/* #4767: короткое решение / глубокая работа — по оценке задачи */}
              {item.status !== 'done' && <Badge tone="outline" title={size.minutes === null ? 'У задачи нет оценки — время фокуса выберите сами' : 'По оценке задачи'}>{size.label}</Badge>}
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
              {/*
                #1563: глубокий фокус — и для проверки чужой работы. У руководителя тройка дня
                бывает целиком из «Проверить и принять», и кнопки фокуса у него не было вовсе.
              */}
              {(item.kind === 'task' || item.kind === 'review') && !done && item.taskId && !session && (
                <span className="fd-focus-start">
                  <Button
                    variant={isMission && item.kind === 'task' ? 'primary' : item.kind === 'review' ? 'outline' : 'ghost'} size="sm" disabled={busy}
                    onClick={() => void startFocus(item, minutesFor)}
                  ><Icon name="target" size={14} /> {item.kind === 'review'
                    ? (isMission ? 'Глубокий фокус на проверку' : 'Фокус на проверку')
                    : (isMission ? 'Войти в глубокий фокус' : 'Фокус')} · {minutesFor} мин</Button>
                  {/* #1568: длительность — рядом с кнопкой, выбор запоминается */}
                  {/* оценки нет — длительность выбирает человек (#1568); есть — берём из неё (#4767) */}
                  {size.minutes === null && (
                    <DropdownMenu align="start" trigger={(
                      <Button variant="outline" size="sm" disabled={busy} aria-label={`Длительность фокуса: ${focusMin} мин. Изменить`} title="Оценки нет — сколько длится фокус, выберите сами">
                        <Icon name="clock" size={13} /> {focusMin} мин <Icon name="chevron-down" size={12} />
                      </Button>
                    )}>
                      {FOCUS_MINUTES.map((m) => (
                        <MenuItem key={m} onSelect={() => pickFocusMin(m)}>
                          {m} минут{m === focusMin ? ' ✓' : ''}
                        </MenuItem>
                      ))}
                    </DropdownMenu>
                  )}
                </span>
              )}
              {item.kind === 'task' && !done && item.taskId && !item.startedAt && (
                <Button variant="outline" size="sm" disabled={busy} title="Задача — в «В работе», статус — «работаю над задачей». Таймер не запускается." onClick={() => void takeToWork(item)}>
                  <Icon name="play" size={13} /> Взять в работу
                </Button>
              )}
              {item.kind === 'task' && !done && item.startedAt && (
                <span className="fd-started"><Icon name="play" size={12} /> В работе</span>
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
              <Button variant="outline" size="sm" disabled={busy} onClick={() => void startFocus(item, focusMin, true)}>Начать {focusMin} минут всё равно</Button>
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
  // #4704: две строки — два разных списка: решения отдельно, задачи отдельно
  const listed = backlogOpen === 'decisions' ? decisions : (backlog ?? []).filter((c) => c.kind === 'task');
  const critical = day.criticalCandidate;

  const plusDecisions = (backlog ?? []).filter((c) => c.kind !== 'task');
  useEffect(() => { if (plus && (plus.decisions > 0 || plus.capacity.reviewsMin > 0) && backlog === null) void loadBacklog(); }, [plus, backlog, loadBacklog]);
  const reviewsSlot = plus?.timeline.find((t) => t.kind === 'reviews');
  const mainItem = plus?.main ? top.find((i) => i.id === plus.main!.itemId) : undefined;

  const closeDayBlock = day.closeDay.workdayClosedUntil ? (
    <section className="fd-closed fd-secondary" role="status">
      <Icon name="moon" size={16} />
      <span>День завершён. Тихо до {new Date(day.closeDay.workdayClosedUntil).toLocaleString('ru-RU', { weekday: 'short', hour: '2-digit', minute: '2-digit' })} — отдыхайте.</span>
      <Button variant="ghost" size="sm" disabled={busy} onClick={() => void run(api.focusReopen)}>Я ещё поработаю</Button>
    </section>
  ) : day.closeDay.available ? (
    <section className="fd-closeday fd-secondary">
      <Button variant={phase === 'evening' ? 'primary' : 'outline'} onClick={() => setClosing(true)}><Icon name="moon" size={15} /> Завершить день и подвести итоги</Button>
    </section>
  ) : null;

  return (
    <div className={`focus-page fd-page${zen ? ' fd-zen' : ''}`}>
      <header className="fd-head">
        <div>
          {/* ТЗ 10.11: пока имя не введено в «Давайте познакомимся», — без имени (не начало почты) */}
          <div className="focus-hello">{greeting()}{helloName(user) ? `, ${helloName(user)}` : ''}!</div>
          <div className="dim">{DATE_FMT.format(new Date())}</div>
        </div>
        <div className="fd-head-side">
          {top.length > 0 && (
            <div className="fd-score" aria-label={`Сделано ${doneCount} из ${top.length} главных`}>
              <b>{doneCount} / {top.length}</b> <span className="dim">главных</span>
            </div>
          )}
          <Button variant={zen ? 'secondary' : 'outline'} size="sm" aria-pressed={zen} title="Только главное: тройка, начатая работа и таймер" onClick={toggleZen}>
            <Icon name={zen ? 'eye' : 'eye-off'} size={14} /> {zen ? 'Выйти из Дзена' : 'Дзен-режим'}
          </Button>
        </div>
      </header>

      {/* Персональный брифинг (ТЗ-27): прочитал → понял → тройка сразу ниже. */}
      {/* #4891, п. 6: плашка результата после «Готово — задача сделана» */}
      {doneInfo && (
        <section className="fp-card fp-done" role="status" aria-label="Сделано">
          <div className="fp-head"><b><Icon name="check-circle" size={16} /> Сделано{doneInfo.title ? `: ${doneInfo.title}` : ''}</b>
            <button type="button" className="ui-btn ui-btn-ghost ui-btn-sm" aria-label="Закрыть" onClick={() => setDoneInfo(null)}><Icon name="close" size={14} /></button></div>
          <div className="dim">
            {dur(doneInfo.minutes)} в фокусе · {doneInfo.progress.done} из {doneInfo.progress.total} главных · глубокой работы сегодня {dur(doneInfo.progress.deepMin)}
            {doneInfo.notified ? ` · уведомление получил(а): ${doneInfo.notified}` : ''}
          </div>
          {doneInfo.next && (
            <div className="fp-acts">
              <span>Дальше: <b>{doneInfo.next.title}</b></span>
              <button type="button" className="ui-btn ui-btn-primary ui-btn-sm" disabled={busy} onClick={() => {
                const it = top.find((i) => i.id === doneInfo.next!.itemId); setDoneInfo(null); if (it) void startFocus(it);
              }}><Icon name="play" size={13} /> Начать</button>
              <button type="button" className="ui-btn ui-btn-outline ui-btn-sm" disabled={busy} onClick={() => {
                const it = top.find((i) => i.id === doneInfo.next!.itemId); setDoneInfo(null);
                if (it) window.setTimeout(() => void startFocus(it), 10 * 60_000);
                feedback('focus.started');
              }}>Сначала перерыв 10 мин</button>
              <button type="button" className="ui-btn ui-btn-ghost ui-btn-sm" onClick={() => { setDoneInfo(null); setBacklogOpen('all'); }}>Выбрать другую</button>
            </div>
          )}
        </section>
      )}

      {phase === 'evening' && closeDayBlock}

      {/* #4891, п. 1–2: утро — бриф, ёмкость дня, таймлайн; принятый план — полоса и таймлайн остаются */}
      {plus && (phase === 'morning' || proposed || plus.dayOff) && (
        <div className="fd-secondary">
          <MorningPlan day={plus} accepted={!proposed} busy={busy} onDay={(d) => { setPlus(d); void reload(); }}
            onEdit={() => setEditing(true)} onRefresh={() => void run(async () => { const r = await api.focusRefresh(); void loadPlus(); return r; })} onReload={() => void loadPlus()} />
        </div>
      )}

      {!plus && day.brief && day.brief.enabled && (
        <div className="fd-secondary">
          <Suspense fallback={null}><FocusBriefCard initial={day.brief} /></Suspense>
        </div>
      )}

      {err && <div className="tv2-callout tv2-callout-danger" role="alert"><Icon name="alert" size={15} /> {err}</div>}

      {/* Предложение системы — пока человек его не принял (п. 34). */}
      {proposed && top.length > 0 && !plus && (
        <section className="fd-banner fd-secondary" aria-label="Предложение QEVO AI">
          <span className="fd-banner-text"><Icon name="sparkles" size={16} /> QEVO AI подготовил ваш фокус дня</span>
          <span className="fd-banner-acts">
            <Button variant="primary" size="sm" disabled={busy} onClick={() => void run(api.focusAccept)}><Icon name="check" size={14} /> Принять</Button>
            <Button variant={editing ? 'secondary' : 'outline'} size="sm" aria-pressed={editing} onClick={() => setEditing((v) => !v)}><Icon name="edit" size={14} /> Настроить</Button>
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => void run(api.focusRefresh)}><Icon name="sparkles" size={14} /> Пересмотреть с ИИ</Button>
          </span>
        </section>
      )}
      {!proposed && top.length > 0 && (
        <div className="fd-accepted fd-secondary">
          <span className="dim"><Icon name="check" size={13} /> План на сегодня принят</span>
          <Button variant="ghost" size="sm" aria-pressed={editing} onClick={() => setEditing((v) => !v)}><Icon name="edit" size={13} /> {editing ? 'Готово' : 'Настроить'}</Button>
          <Button
            variant={doneItems.length ? 'outline' : 'ghost'} size="sm" disabled={busy}
            title={doneItems.length ? 'Сделанное уйдёт из тройки, на его место ИИ подберёт новые задачи' : 'ИИ подберёт новые задачи вместо незакреплённых'}
            onClick={() => void run(api.focusRefresh)}
          ><Icon name="sparkles" size={13} /> Пересмотреть с ИИ</Button>
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
      {plus && <div className="fd-secondary"><Replan onChanged={() => { void reload(); void loadPlus(); }} /></div>}
      {critical && !plus && (
        <section className="fd-critical" role="status">
          <div className="fd-critical-line">
            <Icon name="zap" size={16} />
            <span>
              {briefOn ? <><b>Появилось важное изменение.</b> «{critical.title}» стала критичной — может заменить #{critical.replaceRank}.</>
                : <>Появилась новая критичная задача. Она может заменить #{critical.replaceRank}.</>}
            </span>
            {briefOn && (
              <Button variant="outline" size="sm" disabled={busy} onClick={() => void run(async () => { await api.focusBriefRefresh(); return api.focusToday(); })}>
                <Icon name="refresh" size={13} /> Обновить брифинг
              </Button>
            )}
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
                <Button variant="ghost" size="sm" disabled={busy} onClick={() => void run(() => api.focusDismiss(critical.key))}>{briefOn ? 'Оставить текущий план' : 'Не сейчас'}</Button>
              </span>
              {asking && 'key' in asking && asking.key === critical.key && reasonPicker((r) => {
                setAsking(null); setCriticalOpen(false);
                void run(() => api.focusAdd(critical.key, critical.replaceRank, r));
              })}
            </div>
          )}
        </section>
      )}


      {top.length === 0 && plus?.firstDay ? (
        <FirstDay day={plus} onDone={(d) => { setPlus(d); void reload(); }} />
      ) : top.length === 0 ? (
        <EmptyState
          icon="target"
          title="На сегодня критичных задач нет"
          hint="Сроки не горят, ничего не ждёт вашего решения. Можно выбрать задачу самому."
          action={{ label: 'Выбрать задачу самостоятельно', onClick: () => setBacklogOpen('all') }}
        />
      ) : (
        <section className="fd-top" aria-label="Три главных действия дня">
          {/* #4767: короткие решения отдельно от глубокой работы */}
          {(() => {
            const groups = { short: [] as FocusItem[], medium: [] as FocusItem[], deep: [] as FocusItem[], unknown: [] as FocusItem[] };
            for (const it of top.filter((i) => i.status !== 'done')) groups[focusSize(it.kind, it.estimateMin).size].push(it);
            const part = (label: string, list: FocusItem[], each: number | null) => list.length
              ? `${label}: ${list.map((i) => `#${i.rank}`).join(', ')}${each ? ` (≈${list.reduce((n, i) => n + (focusSize(i.kind, i.estimateMin).minutes ?? 0), 0)} мин)` : ''}`
              : null;
            const line = [
              part('Короткие решения', groups.short, 10), part('Средние', groups.medium, 30),
              part('Глубокая работа', groups.deep, 60), part('Без оценки', groups.unknown, null),
            ].filter(Boolean).join(' · ');
            return line ? <div className="dim fd-split" style={{ fontSize: 13 }}>{line}</div> : null;
          })()}
          {plus?.main && mainItem && mainItem.rank === 1 && mainItem.status !== 'done' && !editing && !session ? (
            <MainCard card={plus.main} minutes={focusMin} onMinutes={pickFocusMin} busy={busy}
              onStart={() => void startFocus(mainItem)} onOpen={() => open(mainItem)}
              onTakeToWork={mainItem.kind === 'task' && !mainItem.startedAt ? () => void takeToWork(mainItem) : undefined}
              onWhy={() => undefined} reasons={mainItem.reasons} />
          ) : mission ? card(mission) : emptySlot(1)}
          {mission?.status === 'done' && activeItems.length < 3 && (
            <div className="fd-note">
              <Icon name="check-circle" size={15} /> Главная миссия завершена.
              <Button variant="outline" size="sm" disabled={busy} onClick={() => void run(api.focusRefresh)}><Icon name="sparkles" size={13} /> Пересмотреть с ИИ</Button>
              <Button variant="ghost" size="sm" onClick={() => setBacklogOpen('all')}>Выбрать самому</Button>
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

      {plus && (
        <ReviewsBlock count={plus.decisions} minutes={plus.capacity.reviewsMin} at={reviewsSlot ? new Date(reviewsSlot.startsAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }) : null}
          decisions={plusDecisions} onStart={setRunList} onSnoozed={() => { setBacklog(null); void loadPlus(); }} />
      )}
      {runList && (
        <ReviewRun items={runList} onOpenTask={(pid, tid) => { if (pid) onOpenTask(pid, tid); else void api.taskBrief(tid).then((t) => onOpenTask(t.projectId, tid)).catch(() => undefined); }}
          onClose={(changed) => { setRunList(null); if (changed) { setBacklog(null); void reload(); void loadPlus(); } }} />
      )}

      {/* Всё остальное — ниже тройки (ТЗ-27, п. 3): в Дзене прячется. */}
      <div className="fd-secondary fd-stack">
        {day.huddle.map(huddleCard)}
        {plus && <Agreements meId={user?.id} />}
        <Suspense fallback={null}><AiDemoInvite /></Suspense>
        <OnboardingCard />
        <MeetingAgenda onJoin={onJoinCall} />
      </div>

      {/* Решение заказчика: вместо колонки «Требует моего решения» — одна строка. */}
      {/* ТЗ-30 (п. 17): сданное ждёт проверки — от меня ничего не нужно, поэтому строкой, не в тройке */}
      {(day.waitingReview ?? 0) > 0 && (
        <div className="fd-row fd-secondary fd-row-static" role="status">
          <Icon name="check-circle" size={15} /> Ждут проверки: <b>{day.waitingReview}</b>
          <span className="dim"> — работа сдана, срок за вами не числится</span>
        </div>
      )}
      {day.waitingDecision > 0 && (
        <button type="button" className="fd-row fd-secondary" aria-expanded={backlogOpen === 'decisions'} onClick={() => setBacklogOpen((v) => (v === 'decisions' ? null : 'decisions'))}>
          <Icon name="handshake" size={15} /> Ждут вашего решения: <b>{day.waitingDecision}</b>
          <Icon name={backlogOpen === 'decisions' ? 'chevron-up' : 'chevron-down'} size={14} />
        </button>
      )}
      <button type="button" className="fd-row fd-secondary" aria-expanded={backlogOpen === 'all'} onClick={() => setBacklogOpen((v) => (v === 'all' ? null : 'all'))}>
        <Icon name="list" size={15} /> Остальные задачи ({day.backlogCount})
        <Icon name={backlogOpen === 'all' ? 'chevron-up' : 'chevron-down'} size={14} />
      </button>

      {backlogOpen && (
        <section className="fd-backlog fd-secondary" aria-label="Остальные действия">
          {backlog === null && <SkeletonList rows={4} />}
          {backlog !== null && listed.length === 0 && <div className="dim fd-empty">Здесь пусто.</div>}
          {listed.map((c) => (
            <div key={c.key} className={`fd-bl-row${c.blocked ? ' fd-bl-blocked' : ''}`}>
              <div className="fd-bl-main">
                <span className="fd-bl-title"><Icon name={kindIcon(c.kind)} size={13} /> {c.title}</span>
                <span className="dim fd-bl-sub">{[c.projectName, ...c.reasons.slice(0, 2)].filter(Boolean).join(' · ')}</span>
              </div>
              {placing?.key === c.key ? (
                <span className="fd-place" role="group" aria-label="Какую задачу заменить">
                  <span className="dim">Все три места заняты. Заменить:</span>
                  {activeItems.map((i) => (
                    <Button
                      key={i.id} variant="outline" size="sm" disabled={busy}
                      title={`Поставить «${c.title}» вместо «${i.title ?? `#${i.rank}`}»`}
                      onClick={() => { setPlacing(null); setAsking({ key: c.key, rank: i.rank, mode: 'replace' }); }}
                    >
                      {(i.title ?? `#${i.rank}`).length > 40 ? `${(i.title ?? '').slice(0, 40)}…` : (i.title ?? `#${i.rank}`)}
                    </Button>
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

      {/* Кто чем занят — без «ты свободен?» (п. 61); свой статус — рядом (#1535). */}
      <div className="fd-secondary fd-stack">
        <TeamNow meId={user?.id} onOpenPulse={boss ? () => { track('team_pulse_opened'); navigate({ section: 'radar' }); } : undefined} />
      </div>

      {/* «Завершить день» — по нажатию, поверх работы само не открывается (п. 80). */}
      {phase !== 'evening' && closeDayBlock}
      <CloseDayDialog
        open={closing}
        onClose={() => setClosing(false)}
        onClosed={(next) => { setClosing(false); apply(next); feedback('focus.dayCompleted', { el: document.querySelector('.fd-closeday, .fd-head') }); }}
      />

      {/* Напоминания секретаря — ниже тройки: главное на экране — план, а не россыпь. */}
      <div className="fd-secondary">
        <AssistantPings today={day.plan.date} onOpenTask={onOpenTask} onPlanned={() => void reload()} />
      </div>
    </div>
  );
}
