import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Avatar } from '../components/Avatar';
import { DatePicker } from '../components/DatePicker';
import { EmptyState } from '../components/EmptyState';
import { Icon } from '../components/Icon';
import { useAuth } from '../state/auth';
import { useVoiceInput } from '../hooks/useVoiceInput';
import { addReminder, MAX_REMINDERS, reminderRows, ReminderUnit, toMinutes } from '../lib/reminders';
import { WorkSettingsPanel } from '../components/WorkSettingsPanel';
import { meetingUrl, shareMeeting } from './MeetingPage';
import { CalendarSyncPanel } from '../components/CalendarSyncPanel';
import { GoogleFilesBlock } from '../components/google/GoogleFilesBlock';
import { api, ApiError, request } from '../lib/api';
import { feedback } from '../lib/feedback';
import { navigate } from '../lib/router';
import {
  addDays, daysOf, DaySegment, DUE_LABEL, dueMark, isDayOff, layoutDay, rangeTitle, splitByDay,
  startOfDay, timeToFraction,
} from '../lib/calendar-grid';
import type { User } from '../types';
import { overlayProps } from '../lib/overlay';
import { toastSaved } from '../lib/notifications';
import { useStickyCheck } from '../lib/sticky-checks';
import { MeetingGuests } from '../components/MeetingGuests';
import { Button } from '../components/ui/button';
import { Checkbox } from '../components/ui/checkbox';
import { confirmAction } from '../components/ui/dialog';
import { Field, Textarea } from '../components/ui/field';
import { Input } from '../components/ui/input';
import { Select } from '../components/ui/select';
import { initialsOf } from '../lib/initials';
import { plural } from '../lib/chat-text';
import { DropdownMenu, MenuGroup, MenuItem, MenuSeparator } from '../components/ui/dropdown-menu';
import type { CalBlock } from '../lib/api';
import { DeadlinesBar } from './calendar/DeadlinesBar';
import { TaskTimeDialog, fmtMinutes } from './calendar/TaskTimeDialog';
import { FocusDialog } from './calendar/FocusDialog';
import { BlockDialog } from './calendar/BlockDialog';
import { DRAG_TASK, PlanPanel } from './calendar/PlanPanel';
import { SyncStatus } from './calendar/SyncStatus';
import { ShareTimeDialog } from './calendar/ShareTimeDialog';
import { PlanDayDialog } from './calendar/PlanDayDialog';
import { EventCardPanel } from './calendar/EventCardPanel';
import { CommonTimeDialog, PollDialog } from './calendar/MeetingTimeDialogs';
import { askScope } from './calendar/askScope';
import { PhraseBar } from './calendar/PhraseBar';
import { AssistantPanel } from './calendar/AssistantPanel';
import { FirstRun, useConnect } from './calendar/ConnectCalendar';
import { MeetingPrep } from './calendar/MeetingPrep';
import { calApi, type CalPrefs, type CallItem, type WeekAssistant } from './calendar/cal-api';
import { DeclineBox, FocusGoalCard, PreviewBar, RescheduleBanner, type Proposed } from './calendar/TimeWork';
import { isTimeless } from './calendar/DeadlinesBar';
import { CalendarAgent, TimeAnalytics } from './calendar/CalendarAgent';
import { CallCard } from './calendar/CallCard';
import { getSocket } from '../lib/socket';
import './calendar/calendar.css';
import { DateInput } from '../components/DateInput';

type View = 'day' | 'week' | 'month' | 'list';

/** Элемент сетки: встреча или блок своего расписания (#4787). */
type GridItem = CalEvent | (CalBlock & { block: true });
const isBlock = (x: GridItem): x is CalBlock & { block: true } => (x as { block?: boolean }).block === true;
/** Телефон: другой основной вид и кнопка вместо перетаскивания (#4787, п. 4, 18). */
const isPhone = () => typeof window !== 'undefined' && window.matchMedia('(max-width: 700px)').matches;

export interface CalEvent {
  id: string;
  /** `external` — встреча из чужого календаря: показываем, но не трогаем. */
  scope: 'personal' | 'company' | 'external' | 'call';
  /** #4892, п. 0: созвон QEVO без встречи — из журнала созвонов. */
  call?: CallItem;
  /** Название источника для внешней встречи: «Google-календарь». */
  source?: string;
  title: string;
  description: string | null;
  location: string | null;
  meetRoomId: string | null;
  /** Встреча поставлена по договорённости в чате — отсюда в переписку (ТЗ-12, этап 6). */
  sourceChatId?: string | null;
  sourceMessageId?: string | null;
  startsAt: string;
  endsAt: string;
  allDay: boolean;
  color: string | null;
  isPrivate: boolean;
  ownerId: string;
  canEdit: boolean;
  myStatus: 'invited' | 'accepted' | 'declined' | null;
  /** Напоминания в минутах до начала. */
  reminders?: number[];
  participants: { userId: string; fullName: string | null; status: string; isOrganizer: boolean; isCoOrganizer?: boolean; avatarUrl: string | null }[];
  /** Созвон у встречи (ТЗ-14) и его постоянная ссылка. */
  isCall?: boolean;
  meeting?: { publicId: string; url: string | null; accessPolicy: AccessPolicy; earlyJoinMin: number; guestsAllowed: boolean } | null;
  /** #4787, п. 17: встреча из повторяющейся серии */
  seriesId?: string | null;
  seriesRule?: string | null;
}

type AccessPolicy = 'trusted' | 'waiting_room' | 'host_required';
const POLICY_OPTIONS: { key: AccessPolicy; label: string }[] = [
  { key: 'trusted', label: 'Участники входят сразу, остальные — через зал ожидания' },
  { key: 'waiting_room', label: 'Все через зал ожидания' },
  { key: 'host_required', label: 'Ждать организатора' },
];
const EARLY_OPTIONS = [0, 5, 10, 15, 30, 60];

interface CalTask {
  id: string; title: string; deadline_at: string; project_id: string; status: string;
  /** Приоритет и завершение: по ним календарь и отличает горящее от сделанного. */
  priority?: string | null;
  closed_at?: string | null;
}
interface Work { workStart: string; workEnd: string; weekendDays: number[]; holidays: string[] }

const VIEW_LABEL: Record<View, string> = { day: 'День', week: 'Неделя', month: 'Месяц', list: 'Список' };
/** Напоминания, которые предлагаем галочками. Своё время добавляется полем рядом. */
const REMINDER_CHOICES = [0, 5, 10, 15, 60, 1440];
/**
 * Что отмечено у новой встречи.
 *
 * Три напоминания, а не одно: за час — чтобы успеть подготовиться, за 10 минут —
 * чтобы закончить текущее дело, за 5 — чтобы дойти. Каждое из них человек и так
 * ставил руками, а забытое напоминание стоит пропущенной встречи.
 */
const DEFAULT_REMINDERS = [0, 5, 10, 60]; // #4766: и в момент начала
const HOURS = Array.from({ length: 24 }, (_, h) => h);
const HOUR_HEIGHT = 44; // высота часа в сетке, совпадает с .cal-hour в стилях
const hhmm = (iso: string) => new Date(iso).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
const pad = (n: number) => String(n).padStart(2, '0');
/** Локальное значение для DatePicker. Через toISOString нельзя — он уводит в UTC и сдвигает день. */
const isoLocal = (d: Date) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;

/**
 * Ближайшие полчаса от текущего момента.
 *
 * Кнопка «Событие» раньше брала «следующий час», и в 23:30 это уезжало на завтрашнюю
 * полночь: человек жал «создать», а событие оказывалось в другом дне с временем 00:00.
 */
function nextHalfHour(): Date {
  const d = new Date();
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() > 30 ? 60 : 30);
  return d;
}

/**
 * Файл встречи → в календарь человека.
 *
 * Через blob, а не прямой ссылкой: файл лежит за авторизацией, и <a href> дал бы 401
 * без единого объяснения — браузер просто открыл бы пустую страницу.
 */
async function downloadIcs(id: string): Promise<void> {
  try {
    const blob = await api.calendarIcs(id);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'meeting.ics';
    a.click();
    URL.revokeObjectURL(url);
  } catch { /* кнопка — удобство; молчаливый отказ лучше пугающей ошибки поверх формы */ }
}

/**
 * Щелчок по сроку задачи открывает саму задачу.
 *
 * Календарь показывает срок, но работа идёт в карточке: без перехода человек видит
 * напоминание и не может ничего с ним сделать, кроме как искать задачу руками.
 */
function openTask(t: { id: string; project_id: string }): void {
  navigate({ section: 'projects', projectId: String(t.project_id), taskId: String(t.id) });
}

/**
 * Срок задачи в календаре.
 *
 * Одна плашка на все виды — неделя, месяц и список: три почти одинаковых куска
 * разметки разъехались бы на первой же правке, и просроченное краснело бы в одном
 * месте из трёх.
 *
 * Цвет ВСЕГДА со словом: «просрочено», «срочно», «важно» — в подсказке и для тех,
 * кто цвета не различает. Одним цветом ничего сказать нельзя.
 */
const dueTime = (iso: string) => (isTimeless(iso) ? 'весь день' : new Date(iso).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }));

function DueChip({ task, compact }: { task: CalTask; compact?: boolean }) {
  const mark = dueMark(task);
  // #4920, п. 7: срок без времени — «весь день», а не выдуманные 21:00 или 00:00
  const time = dueTime(task.deadline_at);
  return (
    <button
      className={`cal-chip cal-chip-task due-${mark}`}
      onClick={() => openTask(task)}
      title={`${DUE_LABEL[mark]} · ${time} · ${task.title} — открыть карточку`}
    >
      <Icon name={mark === 'done' ? 'check' : mark === 'overdue' ? 'alert' : 'flag'} size={11} />
      {!compact && <span className="cal-chip-time">{time}</span>}
      <span className="cal-chip-text">{task.title}</span>
    </button>
  );
}

/** Имя организатора — то, что человек ищет глазами первым: кто зовёт. */
function organizerOf(e: CalEvent): string | null {
  return e.participants.find((p) => p.isOrganizer)?.fullName ?? null;
}

/**
 * Короткая подпись события: место или первая строка описания.
 *
 * «Просто маленькая плашка без описания» — жалоба ровно об этом: на плитке было
 * только время и название, и понять, о чём встреча, можно было лишь открыв её.
 */
function subtitleOf(e: CalEvent): string {
  const place = (e.location ?? '').trim();
  if (place) return place;
  const desc = (e.description ?? '').trim().split(String.fromCharCode(10))[0] ?? '';
  return desc.slice(0, 80);
}

/** Подсказка при наведении: время, кто зовёт, кто приглашён и о чём встреча. */
function hint(e: CalEvent): string {
  const lines = [`${e.allDay ? 'Весь день' : `${hhmm(e.startsAt)}–${hhmm(e.endsAt)}`} · ${e.title}`];
  const org = organizerOf(e);
  if (org) lines.push(`Создал: ${org}`);
  const guests = e.participants.filter((p) => !p.isOrganizer);
  if (guests.length) {
    lines.push(`Приглашены: ${guests.map((p) => `${p.fullName}${p.status === 'declined' ? ' (отказался)' : p.status === 'invited' ? ' (не ответил)' : ''}`).join(', ')}`);
  }
  if (e.scope === 'external') lines.push(`Из внешнего календаря: ${e.source ?? 'подключённый календарь'} — здесь не правится`);
  if (e.location) lines.push(`Место: ${e.location}`);
  if (e.description) lines.push(e.description.slice(0, 200));
  return lines.join(String.fromCharCode(10));
}

/**
 * Календарь: события людей и компании, задачи со сроком отдельным слоем.
 *
 * Неделя — основной вид: рабочая неделя это то, что человек планирует. День нужен, когда
 * встреч много, месяц — чтобы увидеть загрузку целиком, список — чтобы прочитать ближайшее
 * подряд, не разбирая сетку.
 */
export function CalendarPage({ onStartCall }: { onStartCall: (roomId: string) => void }) {
  const { user } = useAuth();
  // настройка рабочего времени живёт рядом с сеткой, на которую влияет
  const [workOpen, setWorkOpen] = useState(false);
  /** Панель синхронизации: ссылка на наш календарь и адреса чужих. */
  const [syncOpen, setSyncOpen] = useState(false);
  // на телефоне основной вид — день (#4787, п. 18); выбранный вид запоминается (п. 19)
  const [view, setView] = useState<View>(() => (localStorage.getItem('teamcrm.calendarView') as View) || (isPhone() ? 'day' : 'week'));
  const [anchor, setAnchor] = useState<Date>(() => new Date());
  const [events, setEvents] = useState<CalEvent[]>([]);
  const [tasks, setTasks] = useState<CalTask[]>([]);
  /** #4787: просроченные — отдельным списком; блоки — время на задачи и фокус. */
  const [overdue, setOverdue] = useState<CalTask[]>([]);
  const [blocks, setBlocks] = useState<CalBlock[]>([]);
  const [taskTime, setTaskTime] = useState<{ taskId?: string | null; block?: CalBlock | null; at?: Date | null } | null>(null);
  const [focusDlg, setFocusDlg] = useState<{ at?: Date | null } | null>(null);
  const [openBlock, setOpenBlock] = useState<CalBlock | null>(null);
  const [planOpen, setPlanOpen] = useState(() => !isPhone() && localStorage.getItem('teamcrm.calendarPlan') !== '0');
  const [planKey, setPlanKey] = useState(0);
  /** «Отменить изменение» (#4787, п. 19): плашка на 10 секунд после правки. */
  const [undo, setUndo] = useState<{ text: string; run: () => Promise<unknown> } | null>(null);
  useEffect(() => { if (!undo) return; const t = window.setTimeout(() => setUndo(null), 10_000); return () => window.clearTimeout(t); }, [undo]);
  /** «Поделиться временем» — запись по ссылке (#4787, п. 6–8). */
  const [shareOpen, setShareOpen] = useState(false);
  /** «Помоги спланировать день» (#4787, п. 14). */
  const [planDayOpen, setPlanDayOpen] = useState(false);
  /** Общее время и опрос времени (#4787, п. 15). */
  const [commonOpen, setCommonOpen] = useState(false);
  const [pollOpen, setPollOpen] = useState(false);
  const [work, setWork] = useState<Work>({ workStart: '09:00', workEnd: '18:00', weekendDays: [0, 6], holidays: [] });
  // было в браузере — теперь у человека: тот же выбор на телефоне и на другом компьютере
  const [showTasks, setShowTasks] = useStickyCheck('calendar.showTasks', localStorage.getItem('teamcrm.calendarTasks') !== '0');
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [editing, setEditing] = useState<Partial<CalEvent> | null>(null);
  const [people, setPeople] = useState<User[]>([]);
  /** #4892: личные часы и подключения, ассистент недели, пунктирные окна, созвоны. */
  const [prefs, setPrefs] = useState<CalPrefs | null>(null);
  const [week, setWeek] = useState<WeekAssistant | null>(null);
  const [assistOpen, setAssistOpen] = useState(() => localStorage.getItem('teamcrm.calendarAssist') !== '0');
  const [assistKey, setAssistKey] = useState(0);
  const [windows, setWindows] = useState<{ startsAt: string; endsAt: string; label: string }[]>([]);
  const [calls, setCalls] = useState<CallItem[]>([]);
  /** #4892, п. 7: встречи с готовыми итогами → разбор; п. 8–9: предпросмотр пунктиром. */
  const [summaries, setSummaries] = useState<Record<string, string>>({});
  /** #4892, п. 12–13: ИИ-агент и аналитика времени. */
  const [agent, setAgent] = useState<string | null>(() => { try { return new URLSearchParams(window.location.search).get('agent'); } catch { return null; } });
  const [analyticsOpen, setAnalyticsOpen] = useState(false);
  const [preview, setPreview] = useState<{ items: Proposed[]; apply: () => Promise<unknown>; text: string } | null>(null);
  const loadPrefs = useCallback(() => calApi.prefs().then(setPrefs).catch(() => undefined), []);
  useEffect(() => { void loadPrefs(); }, [loadPrefs]);

  const days = useMemo(() => daysOf(view, anchor), [view, anchor]);
  const from = days[0];
  const to = addDays(days[days.length - 1], 1);

  const reload = useCallback(async () => {
    setErr('');
    try {
      const r = await api.calendarRange(from.toISOString(), to.toISOString(), showTasks);
      // Чужие встречи (Google) идут тем же ответом и в том же списке: календарь у
      // человека один. Отличаются они видом и тем, что их нельзя править.
      setEvents([...r.events, ...(r.external ?? [])]);
      setTasks(r.tasks ?? []);
      setOverdue(r.overdue ?? []);
      setBlocks(r.blocks ?? []);
      setPlanKey((k) => k + 1);
      setAssistKey((k) => k + 1);
      setWork(r.work);
      // созвоны QEVO, в том числе начатые из чата (#4892, п. 0)
      calApi.calls(from.toISOString(), to.toISOString()).then(setCalls).catch(() => setCalls([]));
      request<{ event_id: string; meeting_id: string }[]>('GET', `/calendar/plus/summaries?from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}`)
        .then((rows) => setSummaries(Object.fromEntries(rows.map((x) => [String(x.event_id), String(x.meeting_id)])))).catch(() => undefined);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Не удалось загрузить календарь');
    } finally {
      setLoading(false);
    }
    // from/to считаются из days — зависимость по строкам, иначе перезапрос на каждый рендер
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [from.getTime(), to.getTime(), showTasks]);

  useEffect(() => { void reload(); }, [reload]);
  const connect = useConnect(() => { void loadPrefs(); void reload(); });
  // фокус переехал из-за встречи, план дня стал блоками, кто-то отказался — сетка обновляется сама
  useEffect(() => {
    const sock = getSocket();
    const onChanged = () => { void reload(); };
    const onMoved = (e: { title: string; body: string }) => { toastSaved(e.title, e.body); void reload(); };
    sock.on('calendar.changed', onChanged);
    sock.on('calendar.focus-moved', onMoved);
    return () => { sock.off('calendar.changed', onChanged); sock.off('calendar.focus-moved', onMoved); };
  }, [reload]);
  /** «Разложить по неделе» (п. 8): ИИ раскладывает, сетка показывает пунктиром, ставим по «Применить». */
  const planWeek = async () => {
    try {
      const r = await request<{ placements: { taskId: string; title: string; startsAt: string; endsAt: string; label: string }[]; unplaced: { title: string }[] }>(
        'POST', '/calendar/plus/plan-week', { from: from.toISOString(), to: to.toISOString() });
      if (!r.placements.length) { toastSaved('Разложить не получилось', r.unplaced.length ? 'до сроков нет свободных окон' : 'задач со сроком на этой неделе нет'); return; }
      setPreview({
        items: r.placements.map((x) => ({ startsAt: x.startsAt, endsAt: x.endsAt, label: `предложено: ${x.title}` })),
        text: `ИИ разложил ${new Set(r.placements.map((x) => x.taskId)).size} ${plural(new Set(r.placements.map((x) => x.taskId)).size, 'задачу', 'задачи', 'задач')} в свободные окна${r.unplaced.length ? ` · не влезло: ${r.unplaced.length}` : ''}`,
        apply: () => request('POST', '/calendar/plus/plan-week/apply', { placements: r.placements.map((x) => ({ taskId: x.taskId, startsAt: x.startsAt, endsAt: x.endsAt })) }),
      });
    } catch (e) { setErr(e instanceof ApiError ? e.message : 'Не удалось разложить'); }
  };
  // первый вход: карточка недели появляется, как только календарь подключён
  useEffect(() => {
    if (!prefs || prefs.onboarded || !prefs.connected.any) return;
    calApi.assistant(from.toISOString(), to.toISOString()).then(setWeek).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefs]);
  // ссылка из уведомления «/calendar?event=…» открывает встречу
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get('event');
    if (id) calApi.event(id).then((e) => setEditing(e as Partial<CalEvent>)).catch(() => undefined);
  }, []);
  // «Нужно ещё время» после фокуса (#4787, п. 13) — сразу к подбору времени для задачи
  useEffect(() => {
    try {
      const id = sessionStorage.getItem('calendar.planTask');
      if (id) { sessionStorage.removeItem('calendar.planTask'); setTaskTime({ taskId: id }); }
    } catch { /* без хранилища — просто календарь */ }
  }, []);
  useEffect(() => { api.listUsers().then(setPeople).catch(() => undefined); }, []);

  const switchView = (v: View) => { setView(v); localStorage.setItem('teamcrm.calendarView', v); };
  const toggleTasks = () => {
    const next = !showTasks;
    setShowTasks(next);
    localStorage.setItem('teamcrm.calendarTasks', next ? '1' : '0');
  };

  const move = (dir: -1 | 1) => {
    if (view === 'month') setAnchor(new Date(anchor.getFullYear(), anchor.getMonth() + dir, 1));
    else setAnchor(addDays(anchor, dir * (view === 'week' ? 7 : view === 'list' ? 14 : 1)));
  };

  /** Щелчок по свободному месту — это и есть создание: форма открывается уже с временем. */
  const createAt = (day: Date, hour: number) => {
    const start = new Date(day);
    start.setHours(hour, 0, 0, 0);
    openNew(start);
  };

  /** Кнопка «Событие»: ближайшие полчаса, а не полночь и не завтрашний день. */
  const createNow = () => openNew(nextHalfHour());

  /**
   * Надиктованная встреча.
   *
   * Человек уже сказал вслух и время, и участников — форма должна открыться заполненной,
   * иначе голос экономит одно нажатие и добавляет пять. Что разобрать не удалось,
   * остаётся значением по умолчанию: пустая форма после диктовки выглядит как поломка.
   */
  const [voiceErr, setVoiceErr] = useState('');
  // что услышала система и что не смогла разобрать — человек должен это видеть,
  // иначе «поставил не то время» невозможно ни объяснить, ни поправить
  const [heard, setHeard] = useState<{ text: string; warnings: string[] } | null>(null);
  const voice = useVoiceInput(async (text) => {
    setVoiceErr('');
    setHeard(null);
    try {
      // «завтра в 15» — это местное завтра человека, поэтому «сейчас» присылаем своё
      const draft = await api.nlParseEvent(text, isoLocal(new Date()));
      setHeard({ text: draft.source || text, warnings: draft.warnings ?? [] });
      feedback('ai.completed');
      const start = draft.startsAt ? new Date(draft.startsAt) : nextHalfHour();
      const end = draft.endsAt ? new Date(draft.endsAt) : new Date(start.getTime() + 3600_000);
      setEditing({
        title: draft.title,
        description: draft.description ?? undefined,
        location: draft.location ?? undefined,
        startsAt: start.toISOString(),
        endsAt: end.toISOString(),
        allDay: draft.allDay,
        scope: 'personal',
        participants: draft.participantIds.map((id) => ({ userId: id, isOrganizer: false })) as any,
      });
    } catch (e) {
      setVoiceErr(e instanceof ApiError ? e.message : 'Не удалось разобрать встречу');
    }
  });

  const openNew = (start: Date) => {
    const end = new Date(start.getTime() + 3600_000);
    setEditing({ startsAt: start.toISOString(), endsAt: end.toISOString(), scope: 'personal', participants: [] });
  };

  const respond = async (id: string, status: 'accepted' | 'declined') => {
    try {
      await api.calendarRespond(id, status);
      await reload();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Не удалось ответить');
    }
  };

  const callEvents: CalEvent[] = calls.map((c) => ({
    id: c.id, scope: 'call', title: c.title, description: null, location: null, meetRoomId: null, sourceChatId: c.chatId,
    startsAt: c.startsAt, endsAt: c.endsAt, allDay: false, color: null, isPrivate: false, ownerId: '', canEdit: false, myStatus: null,
    participants: [], call: c,
  }));
  const timed = [...events, ...callEvents].filter((e) => !e.allDay);
  // свои рабочие часы, если заданы, — иначе компании (#4892, п. 0)
  const gridWork: Work = prefs?.ownHours ? { ...work, workStart: prefs.workStart, workEnd: prefs.workEnd } : work;
  /** Накладки — свои встречи, пересекающиеся между собой (#4892, п. 2: красным). */
  const clash = useMemo(() => {
    const mine = events.filter((e) => !e.allDay && e.myStatus !== 'declined').sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));
    const ids = new Set<string>();
    for (let i = 0; i < mine.length; i++) {
      for (let j = i + 1; j < mine.length && Date.parse(mine[j].startsAt) < Date.parse(mine[i].endsAt); j++) {
        ids.add(String(mine[i].id)); ids.add(String(mine[j].id));
      }
    }
    return ids;
  }, [events]);
  /** #4920, п. 4: созвон открывается своей карточкой, а не общим списком встреч. */
  const [callCard, setCallCard] = useState<string | null>(null);
  const openCall = (c: CallItem) => setCallCard(c.id);
  const allDay = events.filter((e) => e.allDay);

  // встречи и блоки — в одной раскладке: блок не должен ложиться поверх встречи невидимо
  const segmentsByDay = useMemo(() => {
    const items: GridItem[] = [...timed, ...blocks.map((b) => ({ ...b, block: true as const }))];
    const per: DaySegment<GridItem>[][] = days.map(() => []);
    for (const e of items) for (const seg of splitByDay(e, days)) per[seg.dayIndex].push(seg);
    return per.map((list) => layoutDay(list));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [events, blocks, days, calls]);

  const allDayOf = (day: Date) => allDay.filter((e) => splitByDay(e, [day]).length > 0);

  /** Сводка дня (#4787, п. 19): только по реальному расписанию. */
  const today0 = startOfDay(new Date()).getTime();
  const isToday = (iso: string) => startOfDay(new Date(iso)).getTime() === today0;
  const meetingsToday = timed.filter((e) => isToday(e.startsAt) && e.myStatus !== 'declined').length;
  const minutesOf = (b: CalBlock) => Math.round((Date.parse(b.endsAt) - Date.parse(b.startsAt)) / 60000);
  const taskMinToday = blocks.filter((b) => b.kind === 'task' && isToday(b.startsAt)).reduce((n, b) => n + minutesOf(b), 0);
  const focusMinToday = blocks.filter((b) => b.kind === 'focus' && isToday(b.startsAt)).reduce((n, b) => n + minutesOf(b), 0);
  const showSummary = days.some((d) => startOfDay(d).getTime() === today0);
  /** Свободно сегодня: рабочие часы минус встречи и блоки (#4892, п. 0 — честно, без противоречий). */
  const freeTodayMin = (() => {
    const [sh, sm] = gridWork.workStart.split(':').map(Number);
    const [eh, em] = gridWork.workEnd.split(':').map(Number);
    const ws = new Date(today0); ws.setHours(sh, sm || 0, 0, 0);
    const we = new Date(today0); we.setHours(eh, em || 0, 0, 0);
    const spans = [
      ...timed.filter((e) => isToday(e.startsAt) && e.myStatus !== 'declined').map((e) => [Date.parse(e.startsAt), Date.parse(e.endsAt)]),
      ...blocks.filter((b) => isToday(b.startsAt)).map((b) => [Date.parse(b.startsAt), Date.parse(b.endsAt)]),
    ].map(([a, b]) => [Math.max(a, ws.getTime()), Math.min(b, we.getTime())]).filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
    let busyMs = 0; let cs = -1; let ce = -1;
    for (const [a, b] of spans) { if (a > ce) { if (ce > cs) busyMs += ce - cs; cs = a; ce = b; } else ce = Math.max(ce, b); }
    if (ce > cs) busyMs += ce - cs;
    return Math.max(0, Math.round((we.getTime() - ws.getTime() - busyMs) / 60000));
  })();

  /** Ближайший созвон (п. 18): идёт сейчас или начнётся в ближайшие 15 минут. */
  const now = Date.now();
  const nextCall = timed
    .filter((e) => e.meetRoomId && e.myStatus !== 'declined' && Date.parse(e.endsAt) > now && Date.parse(e.startsAt) - now <= 15 * 60_000)
    .sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt))[0];

  const togglePlan = () => {
    const next = !planOpen;
    setPlanOpen(next);
    localStorage.setItem('teamcrm.calendarPlan', next ? '1' : '0');
  };

  return (
    <div className="page calendar-page cal-v2">
      {/*
        Шапка (#4787, п. 1): слева — Сегодня ← → и вид; справа — Создать и Настройки.
        Рабочие часы, Google и прочее — в меню настроек, а не россыпью иконок, о
        назначении которых надо догадываться.
      */}
      <div className="cal-head">
        <div className="cal-nav">
          <button className="ui-btn ui-btn-outline ui-btn-sm" onClick={() => setAnchor(new Date())}>Сегодня</button>
          <button className="ui-btn ui-btn-ghost ui-btn-sm" onClick={() => move(-1)} aria-label="Назад"><Icon name="chevron-left" size={16} /></button>
          <button className="ui-btn ui-btn-ghost ui-btn-sm" onClick={() => move(1)} aria-label="Вперёд"><Icon name="chevron-right" size={16} /></button>
          <h2 className="cal-title">{rangeTitle(view, days)}</h2>
          <span className="kv2-seg cal-views" role="group" aria-label="Вид календаря">
            {(Object.keys(VIEW_LABEL) as View[]).map((v) => (
              <button key={v} className="kv2-seg-btn" aria-pressed={view === v} onClick={() => switchView(v)}>
                {VIEW_LABEL[v]}
              </button>
            ))}
          </span>
        </div>
        <div className="cal-actions">
          <div className="cal-new-row">
            <DropdownMenu
              align="end"
              trigger={<button className="ui-btn ui-btn-primary ui-btn-sm cal-create"><Icon name="plus" size={15} /> Создать</button>}
            >
              <MenuItem icon={<Icon name="video" size={15} />} onSelect={() => createNow()}>Встречу</MenuItem>
              <MenuItem icon={<Icon name="check-circle" size={15} />} onSelect={() => setTaskTime({})}>Время на выполнение задачи</MenuItem>
              <MenuItem icon={<Icon name="target" size={15} />} onSelect={() => setFocusDlg({})}>Глубокий фокус</MenuItem>
              <MenuItem icon={<Icon name="users" size={15} />} onSelect={() => setCommonOpen(true)}>Встречу в общее свободное время</MenuItem>
              <MenuItem icon={<Icon name="list" size={15} />} onSelect={() => setPollOpen(true)}>Опрос времени встречи</MenuItem>
              <MenuSeparator />
              <MenuItem icon={<Icon name="sparkles" size={15} />} onSelect={() => setPlanDayOpen(true)}>Помоги спланировать день</MenuItem>
            </DropdownMenu>
            <button
              className={`ui-btn ui-btn-primary ui-btn-sm cal-new-mic${voice.recording ? ' cal-mic-on' : ''}`}
              onClick={voice.toggle}
              disabled={voice.transcribing}
              title={voice.recording ? 'Остановить запись' : 'Продиктовать встречу голосом'}
              aria-label={voice.recording ? 'Остановить запись' : 'Продиктовать встречу голосом'}
            >
              <Icon name={voice.transcribing ? 'clock' : 'mic'} size={15} />
            </button>
          </div>
          <button className="ui-btn ui-btn-outline ui-btn-sm" onClick={() => setAgent('')} title="Команды календарю обычным языком: «перенеси все мои встречи завтра на пятницу»">
            <Icon name="sparkles" size={15} /><span className="cal-hide-phone"> ИИ-агент</span>
          </button>
          <button className="ui-btn ui-btn-ghost ui-btn-sm" onClick={() => setAnalyticsOpen(true)} title="Куда уходит время: встречи, фокус, остальное">
            <Icon name="chart" size={15} /><span className="cal-hide-phone"> Аналитика</span>
          </button>
          <button className="ui-btn ui-btn-outline ui-btn-sm" onClick={() => setShareOpen(true)} title="Ссылка, по которой клиент или коллега сам выберет время">
            <Icon name="link" size={15} /><span className="cal-hide-phone"> Поделиться временем</span>
          </button>
          <DropdownMenu
            align="end"
            trigger={<button className="ui-btn ui-btn-ghost ui-btn-sm" aria-label="Настройки календаря" title="Настройки календаря"><Icon name="settings" size={15} /><span className="cal-hide-phone"> Настройки</span></button>}
          >
            <MenuGroup label="Подключённые календари">
              <div className="cal-menu-status"><SyncStatus onSynced={() => void reload()} /></div>
            </MenuGroup>
            <MenuSeparator />
            <MenuItem icon={<Icon name="clock" size={15} />} onSelect={() => setWorkOpen(true)}>Рабочие часы, выходные, праздники</MenuItem>
            <MenuItem icon={<Icon name="refresh" size={15} />} onSelect={() => setSyncOpen(true)}>Google и другие календари</MenuItem>
            <MenuSeparator />
            <MenuItem icon={<Icon name={showTasks ? 'eye-off' : 'eye'} size={15} />} onSelect={() => toggleTasks()}>
              {showTasks ? 'Скрыть сроки задач' : 'Показывать сроки задач'}
            </MenuItem>
            <MenuItem icon={<Icon name="sparkles" size={15} />} onSelect={() => { const n = !assistOpen; setAssistOpen(n); if (!n) setWindows([]); localStorage.setItem('teamcrm.calendarAssist', n ? '1' : '0'); }}>
              {assistOpen ? 'Скрыть «Ассистент недели»' : 'Показать «Ассистент недели»'}
            </MenuItem>
            <MenuItem icon={<Icon name="plug" size={15} />} onSelect={() => connect.start('yandex')}>Яндекс Календарь</MenuItem>
            <MenuItem icon={<Icon name="plug" size={15} />} onSelect={() => connect.start('outlook')}>Outlook</MenuItem>
            <MenuItem icon={<Icon name="clock" size={15} />} onSelect={() => { void calApi.savePrefs({ onboarded: false }).then(setPrefs); }}>Мои часы, обед и пояс</MenuItem>
            <MenuItem icon={<Icon name="download" size={15} />} onSelect={() => { void api.calendarExportLink().then((l) => { if (l.url) window.open(l.url, '_blank', 'noopener'); }); }}>Выгрузить мои события (.ics)</MenuItem>
            <MenuItem icon={<Icon name="list" size={15} />} onSelect={togglePlan}>
              {planOpen ? 'Скрыть «Задачи для планирования»' : 'Показать «Задачи для планирования»'}
            </MenuItem>
          </DropdownMenu>
        </div>
      </div>

      {showSummary && (
        <div className="cal-summary" aria-label="Сводка на сегодня">
          {/* #4892, п. 0: без взаимоисключающих фраз — встречи, свободное время, фокус */}
          <span>Сегодня: {meetingsToday} {plural(meetingsToday, 'встреча', 'встречи', 'встреч')}</span>
          {/* #4920, п. 8: в выходной рабочих часов нет — «9 ч свободно» было неправдой */}
          {isDayOff(new Date(today0), gridWork)
            ? <span>· выходной</span>
            : <span>· {freeTodayMin ? fmtMinutes(freeTodayMin) : '0 мин'} свободно</span>}
          {taskMinToday > 0 && <span>· {fmtMinutes(taskMinToday)} на задачи</span>}
          {focusMinToday ? <span>· {fmtMinutes(focusMinToday)} фокуса</span> : isDayOff(new Date(today0), gridWork) ? null : (
            <span>· фокус не запланирован → <button className="cal-due-link" onClick={() => setFocusDlg({})}>Поставить</button></span>
          )}
          <button className="cal-due-link" onClick={() => setPlanDayOpen(true)}>Помоги спланировать день</button>
          {nextCall && (
            <button className="ui-btn ui-btn-primary ui-btn-sm cal-join" onClick={() => onStartCall(nextCall.meetRoomId!)}>
              <Icon name="video" size={14} /> Войти в созвон: {nextCall.title}
            </button>
          )}
        </div>
      )}

      {err && <div className="tv2-callout tv2-callout-danger" role="alert"><Icon name="alert" size={15} /> {err}</div>}
      {(voice.error || voiceErr) && <div className="tv2-callout tv2-callout-danger" role="alert"><Icon name="alert" size={15} /> {voice.error || voiceErr}</div>}
      {heard && (
        <div className="cal-heard">
          <span className="dim">Услышано:</span> «{heard.text}»
          {heard.warnings.length > 0 && <span className="cal-heard-warn"> · {heard.warnings.join(' · ')}</span>}
          <button className="ui-btn ui-btn-ghost ui-btn-sm" onClick={() => setHeard(null)} title="Скрыть">
            <Icon name="close" size={12} />
          </button>
        </div>
      )}
      {voice.recording && (
        <div className="dim cal-voice-hint">
          Говорите: «созвон с Петром завтра в 15 на час в переговорной». Нажмите ещё раз, чтобы закончить.
        </div>
      )}

      {/* #4892, п. 1: первый вход — подключение и карточка недели */}
      {prefs && !prefs.onboarded && (
        <FirstRun
          prefs={prefs}
          week={week}
          onPrefs={setPrefs}
          onConnected={() => { void loadPrefs(); void reload(); }}
          onSkip={() => { void calApi.savePrefs({ onboarded: true }).then(setPrefs); }}
          onFix={() => {
            void calApi.savePrefs({ onboarded: true }).then(setPrefs);
            setAssistOpen(true); localStorage.setItem('teamcrm.calendarAssist', '1');
            window.setTimeout(() => document.getElementById('cal-assistant')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 150);
          }}
        />
      )}
      {prefs && prefs.onboarded && !prefs.connected.any && (
        <div className="cal-connect-line dim">
          <Icon name="plug" size={13} /> Подключить{' '}
          <button className="cal-link" onClick={() => connect.start('google')}>Google</button> или{' '}
          <button className="cal-link" onClick={() => connect.start('yandex')}>Яндекс</button> календарь
          {' · '}<button className="cal-link" onClick={() => connect.start('outlook')}>Outlook</button>
        </div>
      )}
      {connect.dialogs}
      {(view === 'week' || view === 'day') && (
        <PhraseBar
          onCreated={() => void reload()}
          onEdit={(d) => setEditing({ title: d.title, description: d.description, startsAt: d.startsAt, endsAt: d.endsAt, allDay: d.allDay, scope: 'personal', participants: d.participantIds.map((id) => ({ userId: id, isOrganizer: false })) as CalEvent['participants'] })}
        />
      )}

      {workOpen && (
        <WorkSettingsPanel
          canManage={user?.role === 'owner'}
          onClose={() => { setWorkOpen(false); reload(); }}
        />
      )}

      {/* Закрыли синхронизацию — сразу перечитываем календарь: подключённые встречи
          должны появиться, а не ждать перелистывания недели. */}
      {syncOpen && <CalendarSyncPanel onClose={() => { setSyncOpen(false); reload(); }} />}

      {showTasks && <DeadlinesBar tasks={tasks} overdue={overdue} days={days} />}

      <div className={`cal-body${planOpen || assistOpen ? ' with-plan' : ''}`}>
        <div className="cal-main">
          {view === 'list' ? (
            <ListView days={days} events={events} tasks={showTasks ? tasks : []} blocks={blocks} onOpen={setEditing} onOpenBlock={setOpenBlock} onRespond={respond} />
          ) : view === 'month' ? (
            <MonthGrid days={days} events={events} tasks={showTasks ? tasks : []} work={work} anchor={anchor} onOpen={setEditing} onCreate={(d) => createAt(d, 10)} />
          ) : (
            <TimeGrid
              days={days}
              work={gridWork}
              clash={clash}
              windows={[...windows, ...(preview?.items ?? [])]}
              summaries={summaries}
              dueTasks={showTasks ? tasks : []}
              onOpenCall={openCall}
              segments={segmentsByDay}
              allDayOf={allDayOf}
              onOpen={setEditing}
              onOpenBlock={setOpenBlock}
              onCreate={createAt}
              onDropTask={(taskId, at) => setTaskTime({ taskId, at })}
            />
          )}
        </div>
        {(assistOpen || planOpen) && (
          <div className="cal-side">
            {assistOpen && (
              <AssistantPanel
                from={from.toISOString()} to={to.toISOString()} refreshKey={assistKey}
                onChanged={() => void reload()}
                onWindows={setWindows}
                onClose={() => { setAssistOpen(false); setWindows([]); localStorage.setItem('teamcrm.calendarAssist', '0'); }}
              />
            )}
            {assistOpen && <FocusGoalCard from={from.toISOString()} to={to.toISOString()} refreshKey={assistKey} onPreview={setPreview} />}
            {planOpen && <PlanPanel refreshKey={planKey} onPlan={(taskId) => setTaskTime({ taskId })} onClose={togglePlan} onPlanWeek={() => void planWeek()} />}
          </div>
        )}
      </div>
      {(view === 'week' || view === 'day') && (
        <div className="cal-legend dim" aria-label="Обозначения">
          <span><i className="lg meet" /> встречи</span><span><i className="lg focus" /> фокус</span>
          <span><i className="lg due" /> сроки задач</span><span><i className="lg clash" /> накладка</span>
          <span><i className="lg free" /> свободно — предлагает ассистент</span>
        </div>
      )}

      {taskTime && (
        <TaskTimeDialog
          taskId={taskTime.taskId}
          block={taskTime.block}
          at={taskTime.at}
          onClose={() => setTaskTime(null)}
          onSaved={() => { setTaskTime(null); void reload(); }}
        />
      )}
      {commonOpen && (
        <CommonTimeDialog
          meId={user?.id ? String(user.id) : undefined}
          onClose={() => setCommonOpen(false)}
          onPoll={() => { setCommonOpen(false); setPollOpen(true); }}
          onPick={(v) => {
            setCommonOpen(false);
            setEditing({ startsAt: v.startsAt, endsAt: v.endsAt, scope: 'personal', participants: v.participantIds.map((id) => ({ userId: id, isOrganizer: false })) as CalEvent['participants'] });
          }}
        />
      )}
      {pollOpen && <PollDialog onClose={() => setPollOpen(false)} onDecided={() => { setPollOpen(false); void reload(); }} />}
      {planDayOpen && <PlanDayDialog onClose={() => setPlanDayOpen(false)} onSaved={() => { setPlanDayOpen(false); void reload(); }} />}
      {callCard && <CallCard id={callCard} onClose={() => setCallCard(null)} onJoin={onStartCall} />}
      {agent !== null && (
        <CalendarAgent initial={agent || undefined} onClose={() => setAgent(null)} onApplied={() => { setAgent(null); void reload(); }} />
      )}
      {analyticsOpen && (
        <TimeAnalytics
          from={from.toISOString()} to={to.toISOString()} boss={user?.role === 'owner' || user?.role === 'manager'}
          onClose={() => setAnalyticsOpen(false)} onChanged={() => void reload()}
        />
      )}
      {preview && (
        <PreviewBar
          text={preview.text}
          onCancel={() => setPreview(null)}
          onApply={async () => { await preview.apply(); setPreview(null); toastSaved('Готово', 'блоки поставлены в календарь'); await reload(); }}
        />
      )}
      {undo && (
        <div className="cal-undo" role="status">
          <span>{undo.text}</span>
          <button className="cal-due-link" onClick={() => { const u = undo; setUndo(null); void u.run().then(() => { toastSaved('Изменение отменено'); return reload(); }).catch(() => undefined); }}>Отменить изменение</button>
        </div>
      )}
      {shareOpen && <ShareTimeDialog onClose={() => { setShareOpen(false); void reload(); }} />}
      {focusDlg && <FocusDialog at={focusDlg.at} onClose={() => setFocusDlg(null)} onSaved={() => { setFocusDlg(null); void reload(); }} />}
      {openBlock && (
        <BlockDialog
          block={openBlock}
          onClose={() => setOpenBlock(null)}
          onChanged={() => { setOpenBlock(null); void reload(); }}
          onReschedule={(b) => { setOpenBlock(null); setTaskTime({ block: b }); }}
          onUndo={setUndo}
        />
      )}

      {loading && <div className="dim" style={{ padding: 12 }}>Загружаю…</div>}

      {editing && (
        <EventDialog
          value={editing}
          people={people}
          onClose={() => setEditing(null)}
          onSaved={async () => { setEditing(null); await reload(); }}
          onStartCall={onStartCall}
          onRespond={respond}
          onUndo={setUndo}
          summaryMeetingId={editing.id ? summaries[String(editing.id)] : undefined}
        />
      )}
    </div>
  );
}

/** Сетка дня и недели: часы слева, события в колонках дней. */
function TimeGrid({ days, work, segments, allDayOf, onOpen, onOpenBlock, onCreate, onDropTask, clash, windows, onOpenCall, summaries, dueTasks }: {
  days: Date[];
  work: Work;
  /** #4892, п. 2: свои пересекающиеся встречи — красным; окна от ассистента — пунктиром. */
  clash: Set<string>;
  windows: { startsAt: string; endsAt: string; label: string }[];
  onOpenCall: (c: CallItem) => void;
  /** п. 7: «итоги готовы»; п. 8: сроки — без фиктивного времени в полосе «весь день», со временем — меткой на часе. */
  summaries: Record<string, string>;
  dueTasks: CalTask[];
  segments: DaySegment<GridItem>[][];
  allDayOf: (d: Date) => CalEvent[];
  onOpen: (e: CalEvent) => void;
  onOpenBlock: (b: CalBlock) => void;
  onCreate: (day: Date, hour: number) => void;
  /** Задача из панели «Задачи для планирования» брошена на сетку (#4787, п. 4). */
  onDropTask: (taskId: string, at: Date) => void;
}) {
  const today = startOfDay(new Date()).getTime();
  const workTop = timeToFraction(work.workStart);
  const workHeight = Math.max(timeToFraction(work.workEnd) - workTop, 0);
  const scrollRef = useRef<HTMLDivElement>(null);
  // отметка текущего времени (п. 19) — двигается сама, раз в минуту
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => { const t = window.setInterval(() => setNowMs(Date.now()), 60_000); return () => window.clearInterval(t); }, []);
  const nowFrac = (nowMs - startOfDay(new Date(nowMs)).getTime()) / 86_400_000;
  /** Брошенная задача: время — по месту в колонке, с шагом 15 минут. */
  const dropAt = (day: Date, e: React.DragEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const frac = Math.min(Math.max((e.clientY - rect.top) / rect.height, 0), 1);
    const mins = Math.round((frac * 24 * 60) / 15) * 15;
    const at = startOfDay(day);
    at.setMinutes(Math.min(mins, 23 * 60 + 45));
    return at;
  };

  /**
   * Прокрутка к началу рабочего дня.
   *
   * Сетка открывалась на полуночи, и человек видел пустую ночь, а щелчок «по первому
   * свободному месту» создавал событие в 00:00. Показываем час до начала работы —
   * чтобы было видно, что выше тоже есть время.
   */
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    // #4892, п. 0: открываемся ровно на начале рабочего дня, ночь — прокруткой
    el.scrollTop = Math.max(0, timeToFraction(work.workStart) * 24 * HOUR_HEIGHT - 4);
  }, [work.workStart, days.length]);

  // колонок ровно столько, сколько дней в виде: одна в дне, семь в неделе
  const columns = { ['--cal-days' as string]: String(days.length) } as React.CSSProperties;

  return (
    <div className="cal-grid" style={columns}>
      <div className="cal-corner" />
      {days.map((d) => (
        <div key={`h${d.getTime()}`} className={`cal-dayhead ${startOfDay(d).getTime() === today ? 'today' : ''} ${isDayOff(d, work) ? 'off' : ''}`}>
          <span className="cal-dayname">{d.toLocaleDateString('ru-RU', { weekday: 'short' })}</span>
          <span className="cal-daynum">{d.getDate()}</span>
        </div>
      ))}

      {/* События «весь день» — своей строкой. У них нет времени внутри суток, в сетке им не место */}
      <div className="cal-corner cal-allday-label">весь день</div>
      {days.map((d) => (
        <div key={`a${d.getTime()}`} className="cal-allday">
          {dueTasks.filter((t) => !t.closed_at && isTimeless(t.deadline_at) && startOfDay(new Date(t.deadline_at)).getTime() === startOfDay(d).getTime()).map((t) => (
            <button key={`due${t.id}`} className="cal-chip cal-chip-due" onClick={() => openTask(t)} title={`Срок ${startOfDay(d).getTime() === startOfDay(new Date()).getTime() ? 'сегодня' : 'в этот день'} · ${t.title}`}>
              <Icon name="flag" size={11} /><span className="cal-chip-text">срок{startOfDay(d).getTime() === startOfDay(new Date()).getTime() ? ' сегодня' : ''}: {t.title}</span>
            </button>
          ))}
          {allDayOf(d).map((e) => (
            <button
              key={e.id}
              className={`cal-chip ${e.scope === 'company' ? 'company' : ''} ${e.scope === 'external' ? 'external' : ''}`}
              onClick={() => onOpen(e)}
              title={hint(e)}
            >
              <span className="cal-chip-text">{e.title}</span>
            </button>
          ))}
        </div>
      ))}

      <div className="cal-scroll" style={columns} ref={scrollRef}>
        <div className="cal-hours">
          {HOURS.map((h) => <div key={h} className="cal-hour"><span>{String(h).padStart(2, '0')}:00</span></div>)}
        </div>
        {days.map((d, i) => (
          <div
            key={`c${d.getTime()}`}
            className={`cal-col ${isDayOff(d, work) ? 'off' : ''}`}
            onDragOver={(e) => { if (e.dataTransfer.types.includes(DRAG_TASK)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } }}
            onDrop={(e) => {
              const id = e.dataTransfer.getData(DRAG_TASK);
              if (!id) return;
              e.preventDefault();
              onDropTask(id, dropAt(d, e));
            }}
          >
            {/* рабочие часы подсвечены, остальное приглушено — по настройке организации */}
            <div className="cal-worktime" style={{ top: `${workTop * 100}%`, height: `${workHeight * 100}%` }} />
            {startOfDay(d).getTime() === startOfDay(new Date(nowMs)).getTime() && (
              <div className="cal-now" style={{ top: `${nowFrac * 100}%` }} aria-label="Сейчас" />
            )}
            {HOURS.map((h) => (
              <button key={h} className="cal-slot" onClick={() => onCreate(d, h)} aria-label={`Создать событие ${d.toLocaleDateString('ru-RU')} в ${h}:00`} />
            ))}
            {dueTasks.filter((t) => !t.closed_at && !isTimeless(t.deadline_at) && startOfDay(new Date(t.deadline_at)).getTime() === startOfDay(d).getTime()).map((t) => (
              <button key={`dm${t.id}`} className="cal-due-mark" style={{ top: `${((Date.parse(t.deadline_at) - startOfDay(d).getTime()) / 86_400_000) * 100}%` }}
                onClick={() => openTask(t)} title={`Срок: ${t.title} ${hhmm(t.deadline_at)}`}>
                Срок: {t.title} {hhmm(t.deadline_at)}
              </button>
            ))}
            {windows.filter((w) => startOfDay(new Date(w.startsAt)).getTime() === startOfDay(d).getTime()).map((w) => {
              const top = (Date.parse(w.startsAt) - startOfDay(d).getTime()) / 86_400_000;
              const h = (Date.parse(w.endsAt) - Date.parse(w.startsAt)) / 86_400_000;
              return (
                <div key={w.startsAt} className="cal-free-window" style={{ top: `${top * 100}%`, height: `${h * 100}%` }}>
                  {w.label} · {fmtMinutes(Math.round(h * 1440))}
                </div>
              );
            })}
            {segments[i]?.map((seg) => isBlock(seg.event) ? (
              <button
                key={`b${seg.event.id}-${seg.dayIndex}`}
                className={`cal-event cal-block ${seg.event.kind === 'focus' ? 'focus' : 'task'}${seg.event.taskDone ? ' done' : ''}`}
                style={{
                  top: `${seg.top * 100}%`,
                  height: `${seg.height * 100}%`,
                  left: `${(seg.column / seg.columns) * 100}%`,
                  width: `${(1 / seg.columns) * 100}%`,
                }}
                onClick={() => onOpenBlock(seg.event as CalBlock)}
                title={`${seg.event.kind === 'focus' ? 'Глубокий фокус' : `Время на задачу №${seg.event.taskId}`} · ${hhmm(seg.event.startsAt)}–${hhmm(seg.event.endsAt)} · ${seg.event.title}`}
              >
                <span className="cal-event-time">
                  <Icon name={seg.event.kind === 'focus' ? 'target' : 'check-circle'} size={11} />
                  {hhmm(seg.event.startsAt)}–{hhmm(seg.event.endsAt)}
                </span>
                <span className="cal-event-title">{seg.event.kind === 'task' ? `№${seg.event.taskId} ${seg.event.title}` : seg.event.title}</span>
              </button>
            ) : (
              <button
                key={`${seg.event.id}-${seg.dayIndex}`}
                className={`cal-event ${seg.event.scope === 'company' ? 'company' : ''} ${seg.event.scope === 'external' ? 'external' : ''} ${seg.event.scope === 'call' ? 'call' : ''} ${clash.has(String(seg.event.id)) ? 'clash' : ''} ${seg.event.myStatus === 'declined' ? 'declined' : ''} ${seg.event.myStatus === 'invited' ? 'invited' : ''}`}
                style={{
                  top: `${seg.top * 100}%`,
                  height: `${seg.height * 100}%`,
                  left: `${(seg.column / seg.columns) * 100}%`,
                  width: `${(1 / seg.columns) * 100}%`,
                }}
                onClick={() => { const ev = seg.event as CalEvent; if (ev.call) onOpenCall(ev.call); else onOpen(ev); }}
                title={(seg.event as CalEvent).call ? `${hhmm(seg.event.startsAt)}–${hhmm(seg.event.endsAt)} · ${seg.event.title}${(seg.event as CalEvent).call!.summaryReady ? ' · итоги готовы' : ''}` : clash.has(String(seg.event.id)) ? `Накладка · ${hint(seg.event as CalEvent)}` : hint(seg.event as CalEvent)}
              >
                <span className="cal-event-time">
                  {seg.continuesFrom ? '↑ ' : ''}{hhmm(seg.event.startsAt)}–{hhmm(seg.event.endsAt)}
                  {seg.event.participants.length > 1 && (
                    <span className="cal-event-people"><Icon name="users" size={11} /> {seg.event.participants.length}</span>
                  )}
                </span>
                <span className="cal-event-title">{seg.event.title}</span>
                {((seg.event as CalEvent).call?.summaryReady || summaries[String(seg.event.id)]) && <span className="cal-event-sub">итоги готовы</span>}
                {(seg.event as CalEvent).call?.live && <span className="cal-event-sub">идёт сейчас</span>}
                {/*
                  Подпись под названием: место, а если его нет — первая строка описания.
                  Пустая плашка «Встреча» без единого слова о том, что это за встреча, —
                  ровно то, на что жаловались. Прячется сама, когда плитка короткая:
                  за это отвечает высота в стилях, а не расчёт в коде.
                */}
                {subtitleOf(seg.event) && <span className="cal-event-sub">{subtitleOf(seg.event)}</span>}
                {/* организатор виден прямо на плитке: «кто зовёт» — первый вопрос к встрече */}
                {organizerOf(seg.event) && <span className="cal-event-who">{organizerOf(seg.event)}</span>}
              </button>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

/** Месяц: только факт занятости дня — время в такой клетке всё равно не прочитать. */
function MonthGrid({ days, events, tasks, work, anchor, onOpen, onCreate }: {
  days: Date[]; events: CalEvent[]; tasks: CalTask[]; work: Work; anchor: Date;
  onOpen: (e: CalEvent) => void; onCreate: (d: Date) => void;
}) {
  const today = startOfDay(new Date()).getTime();
  return (
    <div className="cal-month">
      {['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'].map((d) => <div key={d} className="cal-month-head">{d}</div>)}
      {days.map((d) => {
        const dayEvents = events.filter((e) => splitByDay(e, [d]).length > 0);
        const dayTasks = tasks.filter((t) => startOfDay(new Date(t.deadline_at)).getTime() === startOfDay(d).getTime() && !t.closed_at); // выполненные не кричат (#4787, п. 2)
        return (
          <div
            key={d.getTime()}
            className={`cal-month-cell ${d.getMonth() !== anchor.getMonth() ? 'other' : ''} ${isDayOff(d, work) ? 'off' : ''} ${startOfDay(d).getTime() === today ? 'today' : ''}`}
            onDoubleClick={() => onCreate(d)}
          >
            <span className="cal-month-num">{d.getDate()}</span>
            {/*
              Сколько плашек показать, решает высота клетки, а не число: раньше три
              события и два срока растягивали клетку, и сетка месяца ехала. Теперь
              содержимое прокручивается внутри клетки, а не двигает её края.
            */}
            <div className="cal-month-items">
              {dayEvents.map((e) => (
                <button
                  key={e.id}
                  className={`cal-chip ${e.scope === 'company' ? 'company' : ''} ${e.scope === 'external' ? 'external' : ''}`}
                  onClick={() => onOpen(e)}
                  title={hint(e)}
                >
                  {!e.allDay && <span className="cal-chip-time">{hhmm(e.startsAt)}</span>}
                  <span className="cal-chip-text">{e.title}</span>
                </button>
              ))}
              {dayTasks.map((t) => <DueChip key={t.id} task={t} compact />)}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** Список: ближайшее подряд. Нужен, когда важно прочитать, а не разглядывать сетку. */
function ListView({ days, events, tasks, blocks, onOpen, onOpenBlock, onRespond }: {
  days: Date[]; events: CalEvent[]; tasks: CalTask[]; blocks: CalBlock[];
  onOpen: (e: CalEvent) => void; onOpenBlock: (b: CalBlock) => void; onRespond: (id: string, s: 'accepted' | 'declined') => void;
}) {
  const rows = days.map((d) => ({
    day: d,
    events: events.filter((e) => splitByDay(e, [d]).length > 0),
    blocks: blocks.filter((b) => splitByDay(b, [d]).length > 0),
    // выполненные по умолчанию не кричат (#4787, п. 2)
    tasks: tasks.filter((t) => startOfDay(new Date(t.deadline_at)).getTime() === startOfDay(d).getTime() && !t.closed_at),
  })).filter((r) => r.events.length || r.tasks.length || r.blocks.length);

  if (!rows.length) {
    return <EmptyState icon="calendar" title="Впереди пусто" hint="На ближайшие две недели событий нет. Щёлкните по сетке в виде «Неделя», чтобы назначить встречу." />;
  }

  return (
    <div className="cal-list">
      {rows.map((r) => (
        <div key={r.day.getTime()} className="cal-list-day">
          <div className="cal-list-date">{r.day.toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' })}</div>
          {r.events.map((e) => (
            <div key={e.id} className="cal-list-row">
              <span className="cal-list-time">{e.allDay ? 'весь день' : `${hhmm(e.startsAt)}–${hhmm(e.endsAt)}`}</span>
              <button className="cal-list-title" onClick={() => onOpen(e)}>
                <span>{e.title}</span>
                {/* кто зовёт и о чём — прямо в списке: ради этого не должно приходиться открывать событие */}
                <span className="cal-list-sub dim">
                  {organizerOf(e) ? `Создал: ${organizerOf(e)}` : ''}
                  {e.participants.length > 1 ? ` · участников: ${e.participants.length}` : ''}
                  {e.description ? ` · ${e.description.slice(0, 90)}` : ''}
                </span>
              </button>
              {e.myStatus === 'invited' && (
                <span className="cal-list-answer">
                  <button className="ui-btn ui-btn-outline ui-btn-sm" onClick={() => onRespond(e.id, 'accepted')}>Принять</button>
                  <button className="ui-btn ui-btn-ghost ui-btn-sm" onClick={() => onRespond(e.id, 'declined')}>Отклонить</button>
                </span>
              )}
            </div>
          ))}
          {/* время на задачи и фокус (#4787) — своими строками со значком */}
          {r.blocks.map((b) => (
            <div key={`b${b.id}`} className={`cal-list-row cal-list-block ${b.kind}`}>
              <span className="cal-list-time">{hhmm(b.startsAt)}–{hhmm(b.endsAt)}</span>
              <button className="cal-list-title" onClick={() => onOpenBlock(b)}>
                <span><Icon name={b.kind === 'focus' ? 'target' : 'check-circle'} size={13} /> {b.kind === 'task' ? `№${b.taskId} ${b.title}` : b.title}</span>
                <span className="cal-list-sub dim">{b.kind === 'focus' ? 'Глубокий фокус' : `Время на задачу${b.projectName ? ` · ${b.projectName}` : ''}`}</span>
              </button>
            </div>
          ))}
          {r.tasks.map((t) => {
            const mark = dueMark(t);
            return (
              <div key={t.id} className={`cal-list-row cal-list-due due-${mark}`}>
                <span className="cal-list-time">
                  {dueTime(t.deadline_at)}
                  {' · '}{DUE_LABEL[mark]}
                </span>
                <button className="cal-list-title" onClick={() => openTask(t)} title="Открыть карточку задачи">
                  <span>{t.title}</span>
                </button>
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

/**
 * Сдвиг конца вслед за началом.
 *
 * Человек меняет время начала — и ждёт, что встреча просто переедет, сохранив длительность.
 * Без этого он каждый раз правит два поля, а забыв второе, получает событие «с 15:00 до 11:00».
 */
function shiftEnd(nextStart: string, prevStart: string, prevEnd: string): string {
  const a = new Date(prevStart);
  const b = new Date(prevEnd);
  const next = new Date(nextStart);
  if ([a, b, next].some((d) => Number.isNaN(d.getTime()))) return prevEnd;
  const moved = new Date(next.getTime() + Math.max(b.getTime() - a.getTime(), 0));
  const pad2 = (n: number) => String(n).padStart(2, '0');
  return `${moved.getFullYear()}-${pad2(moved.getMonth() + 1)}-${pad2(moved.getDate())}T${pad2(moved.getHours())}:${pad2(moved.getMinutes())}`;
}

/** Создание и правка события. Одна форма на оба случая: разница только в кнопках снизу. */
function EventDialog({ value, people, onClose, onSaved, onStartCall, onRespond, onUndo, summaryMeetingId }: {
  value: Partial<CalEvent>;
  people: User[];
  onClose: () => void;
  onSaved: () => void;
  onStartCall: (roomId: string) => void;
  onRespond: (id: string, s: 'accepted' | 'declined') => void;
  /** «Отменить изменение» (#4787, п. 19) */
  onUndo?: (u: { text: string; run: () => Promise<unknown> }) => void;
  /** #4892, п. 7: у встречи готовы итоги — ссылка на протокол. */
  summaryMeetingId?: string;
}) {
  const { user: me } = useAuth();
  /** п. 10: отказ с причиной и «Перенести» с лучшими слотами. */
  const [declining, setDeclining] = useState(false);
  const [moveOpen, setMoveOpen] = useState(false);
  const meId = me?.id ? String(me.id) : undefined;
  /** Повтор новой встречи (#4787, п. 17) */
  const [repeat, setRepeat] = useState<{ freq: string; until: string }>({ freq: '', until: '' });
  const [privateHabit, rememberPrivate] = useStickyCheck('calendar.event.private', false);
  const [form, setForm] = useState({
    title: value.title ?? '',
    description: value.description ?? '',
    location: value.location ?? '',
    startsAt: isoLocal(new Date(value.startsAt ?? Date.now())),
    endsAt: isoLocal(new Date(value.endsAt ?? Date.now() + 3600_000)),
    allDay: !!value.allDay,
    // у новой встречи — привычный выбор человека; у существующей — как сохранено
    isPrivate: value.id ? !!value.isPrivate : privateHabit,
    scope: (value.scope ?? 'personal') as 'personal' | 'company',
    participantIds: (value.participants ?? []).filter((p) => !p.isOrganizer).map((p) => String(p.userId)),
    // у новой встречи напоминания стоят сразу — за час, за 15 и за 5 минут;
    // «ни одного» человек выбирает осознанно, сняв галочки
    reminders: value.id ? (value.reminders ?? []) : DEFAULT_REMINDERS,
    // созвон и правила входа (ТЗ-14)
    isCall: !!value.isCall,
    accessPolicy: (value.meeting?.accessPolicy ?? 'trusted') as AccessPolicy,
    earlyJoinMin: value.meeting?.earlyJoinMin ?? 15,
    guestsAllowed: value.meeting?.guestsAllowed ?? true,
    coOrganizerIds: (value.participants ?? []).filter((p) => p.isCoOrganizer).map((p) => String(p.userId)),
  });
  /*
    «Созвон» у новой встречи включается сам, как только позвали людей (решение заказчика
    05.10), — пока человек не тронул галочку руками. Тронул — его выбор главнее.
  */
  const [callTouched, setCallTouched] = useState(!!value.id);
  const isCall = callTouched ? form.isCall : (form.participantIds.length > 0 && !form.allDay);
  const [showAccess, setShowAccess] = useState(false);
  /** Встреча с созвоном только что создана — показываем её ссылку, а не закрываем окно молча (§44). */
  const [created, setCreated] = useState<{ publicId: string; title: string; when: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  // комната встречи: появляется и после выдачи гостевой ссылки — тогда «Войти в созвон» нужен сразу
  const [roomId] = useState<string | null>(value.meetRoomId ?? null);
  // своё время напоминания: число и единица рядом, чтобы не считать минуты в уме
  const [ownValue, setOwnValue] = useState('');
  const [ownUnit, setOwnUnit] = useState<ReminderUnit>('minutes');

  const addOwn = () => {
    const minutes = toMinutes(Number(ownValue), ownUnit);
    if (!Number.isFinite(minutes)) return;
    setForm((prev) => ({ ...prev, reminders: addReminder(prev.reminders, minutes) }));
    setOwnValue('');
  };
  /** Кто из команды занят в выбранное время и мешает ли это сохранить встречу. */
  const [busyPeople, setBusyPeople] = useState<Record<string, { text: string; blocking: boolean }>>({});
  /** «Найти время» прямо в форме события (#4892, п. 4). */
  const [findOpen, setFindOpen] = useState(false);
  const isNew = !value.id;
  const canEdit = isNew || !!value.canEdit;

  /**
   * Занятость коллег на выбранное время.
   *
   * Спрашиваем с задержкой: человек крутит время туда-сюда, и запрос на каждое движение
   * — это лишний десяток походов в сеть. Показываем ДО сохранения, чтобы отказ «занят»
   * не оказался неожиданностью уже после нажатия кнопки.
   */
  useEffect(() => {
    if (!canEdit || !people.length) return;
    const ids = people.filter((u) => u.role !== 'client' && u.isActive !== false).map((u) => String(u.id));
    if (!ids.length) return;
    const t = setTimeout(() => {
      const from = new Date(form.startsAt);
      const to = new Date(form.endsAt);
      if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || to <= from) return;
      // само редактируемое событие из занятости исключаем: иначе его участники
      // показываются занятыми на нём же
      api.calendarBusy(from.toISOString(), to.toISOString(), ids, value.id ? String(value.id) : undefined)
        .then((r) => {
          const map: Record<string, { text: string; blocking: boolean }> = {};
          for (const [id, spans] of Object.entries(r.busy ?? {})) {
            if (!spans.length) continue;
            const away = spans.find((sp) => sp.kind === 'vacation' || sp.kind === 'sick');
            const meeting = spans.find((sp) => sp.kind === 'event');
            if (away) map[id] = { text: away.kind === 'sick' ? 'на больничном' : 'в отпуске', blocking: true };
            else if (meeting) map[id] = { text: 'занят', blocking: true };
            // «весь день» — это пометка на сутки (поездка, дежурство), а не занятое время
            else map[id] = { text: 'весь день занят делами', blocking: false };
          }
          setBusyPeople(map);
        })
        .catch(() => setBusyPeople({}));
    }, 350);
    return () => clearTimeout(t);
  }, [form.startsAt, form.endsAt, people, canEdit, value.id]);

  const save = async () => {
    if (!form.title.trim()) return setErr('Назовите событие');
    setBusy(true);
    setErr('');
    try {
      const body = {
        title: form.title.trim(),
        description: form.description.trim() || undefined,
        location: form.location.trim() || undefined,
        startsAt: new Date(form.startsAt).toISOString(),
        endsAt: new Date(form.endsAt).toISOString(),
        allDay: form.allDay,
        isPrivate: form.isPrivate,
        scope: form.scope,
        participantIds: form.participantIds,
        reminders: form.reminders,
        isCall,
        ...(isCall ? {
          accessPolicy: form.accessPolicy,
          earlyJoinMin: form.earlyJoinMin,
          guestsAllowed: form.guestsAllowed,
          coOrganizerIds: form.coOrganizerIds.filter((id) => form.participantIds.includes(id)),
        } : {}),
      };
      let scope: 'one' | 'following' | 'all' = 'one';
      if (!isNew && value.seriesId) {
        const s = await askScope('save');
        if (!s) return;
        scope = s;
      }
      const saved = isNew
        ? await api.calendarCreate(repeat.freq ? { ...body, repeat: { freq: repeat.freq, until: repeat.until || null } } : body)
        : await api.calendarUpdate(String(value.id), body, scope);
      // «Отменить изменение» (#4787, п. 19): прежние время и название — одним нажатием обратно
      if (!isNew && value.id && value.startsAt && value.endsAt) {
        const prev = { title: value.title, startsAt: value.startsAt, endsAt: value.endsAt };
        const id = String(value.id);
        onUndo?.({ text: scope === 'one' ? 'Встреча изменена' : 'Серия изменена', run: () => api.calendarUpdate(id, prev, scope) });
      }
      // встреча с созвоном создана — ссылка уже рабочая: показать её сразу, с «скопировать» и «поделиться»
      if (isNew && saved?.meeting?.publicId) {
        setCreated({ publicId: saved.meeting.publicId, title: form.title.trim(), when: form.startsAt });
        return;
      }
      onSaved();
      toastSaved(isNew ? 'Событие создано' : 'Событие сохранено', form.title.trim());
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Не удалось сохранить');
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!value.id) return;
    if (!(await confirmAction({
      title: `Удалить событие «${value.title}»?`,
      description: 'Участникам придёт письмо об отмене, а у гостей перестанет работать ссылка.',
      danger: true,
    }))) return;
    let scope: 'one' | 'following' | 'all' = 'one';
    if (value.seriesId) {
      const s = await askScope('delete');
      if (!s) return;
      scope = s;
    }
    try {
      await api.calendarDelete(String(value.id), scope);
      onSaved();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Не удалось удалить');
    }
  };

  const toggleParticipant = (id: string) => setForm((f) => ({
    ...f,
    participantIds: f.participantIds.includes(id)
      ? f.participantIds.filter((x) => x !== id)
      : [...f.participantIds, id],
  }));

  /*
    Встреча создана — показываем её ссылку сразу (ТЗ-14, §44): приглашения участникам ушли,
    а ссылку уже можно отправить кому угодно, не нажимая «начать звонок».
  */
  if (created) {
    const done = () => { onSaved(); toastSaved('Встреча создана', created.title); };
    return (
      <div className="drawer-overlay" {...overlayProps(done)}>
        <aside className="drawer ev-v2" onClick={(e) => e.stopPropagation()}>
          <div className="nl-v2-head">
            <h2 className="ui-modal-title"><Icon name="check-circle" size={20} /> Встреча создана</h2>
            <Button variant="ghost" size="icon-sm" onClick={done} aria-label="Закрыть"><Icon name="close" size={16} /></Button>
          </div>
          <div className="meeting-created">
            <b>{created.title}</b>
            <div className="dim">{new Date(created.when).toLocaleString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })}</div>
            {form.participantIds.length > 0 && <div className="dim">✓ Приглашения отправлены: {form.participantIds.length}</div>}
            <div className="cal-call-link">
              <code>{meetingUrl(created.publicId).replace(/^https?:\/\//, '')}</code>
            </div>
            <div className="dim" style={{ fontSize: 12 }}>
              Ссылка одна на всех и не изменится при переносе. Комната откроется сама в назначенное время.
            </div>
            <div className="cal-dialog-actions">
              <button className="ui-btn ui-btn-primary ui-btn-sm" onClick={async () => {
                const r = await shareMeeting(created.publicId, created.title);
                if (r === 'copied') toastSaved('Ссылка скопирована', meetingUrl(created.publicId));
              }}><Icon name="link" size={14} /> Скопировать / поделиться</button>
              <button className="ui-btn ui-btn-outline ui-btn-sm" onClick={() => { navigate({ section: 'meet', meetId: created.publicId }); done(); }}>
                <Icon name="phone" size={14} /> Открыть встречу
              </button>
              <button className="ui-btn ui-btn-ghost ui-btn-sm" onClick={done}>Готово</button>
            </div>
          </div>
        </aside>
      </div>
    );
  }

  return (
    <div className="drawer-overlay" {...overlayProps(onClose)}>
      <aside className="drawer ev-v2" onClick={(e) => e.stopPropagation()}>
        <div className="nl-v2-head">
          <h2 className="ui-modal-title"><Icon name="calendar" size={20} /> {isNew ? 'Новое событие' : value.title}</h2>
          <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Закрыть"><Icon name="close" size={16} /></Button>
        </div>

        {!isNew && organizerOf(value as CalEvent) && (
          <div className="cal-organizer">
            <Icon name="user" size={14} /> Создал: <b>{organizerOf(value as CalEvent)}</b>
          </div>
        )}
        {!canEdit && (
          <div className="tv2-callout tv2-callout-info">
            <Icon name="info" size={15} /> Событие создал другой человек — вы можете только ответить на приглашение.
          </div>
        )}

        <Field label="Название">
          <Input value={form.title} disabled={!canEdit} placeholder="Например: планёрка по запуску"
                 onChange={(e) => setForm({ ...form, title: e.target.value })} />
        </Field>

        <div className="tv2-grid2">
          <Field label="Начало">
            {/* Наш календарь вместо datetime-local: тот в тёмной теме выглядит чужеродно
                и в каждом браузере по-своему. У «весь день» время не спрашиваем вовсе. */}
            <DatePicker
              value={form.startsAt}
              withTime={!form.allDay}
              disabled={!canEdit}
              placeholder="когда начинаем"
              onChange={(v) => setForm((f) => ({ ...f, startsAt: v, endsAt: shiftEnd(v, f.startsAt, f.endsAt) }))}
            />
          </Field>
          <Field label="Конец">
            <DatePicker
              value={form.endsAt}
              withTime={!form.allDay}
              disabled={!canEdit}
              placeholder="когда заканчиваем"
              onChange={(v) => setForm({ ...form, endsAt: v })}
            />
          </Field>
        </div>

        {canEdit && !form.allDay && (
          <button type="button" className="ui-btn ui-btn-outline ui-btn-sm cal-find-btn" onClick={() => setFindOpen(true)}>
            <Icon name="search" size={14} /> Найти время{form.participantIds.length ? ` для ${form.participantIds.length + 1}` : ''}
          </button>
        )}
        {findOpen && (
          <CommonTimeDialog
            meId={meId}
            initialIds={form.participantIds}
            initialMinutes={Math.max(15, Math.round((Date.parse(new Date(form.endsAt).toISOString()) - Date.parse(new Date(form.startsAt).toISOString())) / 60000))}
            exceptEventId={value.id ? String(value.id) : undefined}
            onClose={() => setFindOpen(false)}
            onPoll={() => setFindOpen(false)}
            onPick={(v) => {
              setFindOpen(false);
              setForm((f) => ({ ...f, startsAt: isoLocal(new Date(v.startsAt)), endsAt: isoLocal(new Date(v.endsAt)), participantIds: v.participantIds }));
            }}
          />
        )}

        <div className="ev-checks">
          <Checkbox checked={form.allDay} disabled={!canEdit}
                    onCheckedChange={(on) => setForm({ ...form, allDay: on })} label="Весь день" />
          <Checkbox checked={form.isPrivate} disabled={!canEdit}
                    onCheckedChange={(on) => { setForm({ ...form, isPrivate: on }); if (!value.id) rememberPrivate(on); }}
                    label={<span title="Другие увидят только занятое время, без названия">Приватное</span>} />
          <Checkbox checked={form.scope === 'company'} disabled={!canEdit}
                    onCheckedChange={(on) => setForm({ ...form, scope: on ? 'company' : 'personal' })}
                    label={<span title="Событие компании видят все сотрудники">Событие компании</span>} />
        </div>

        <Field label="Место или ссылка">
          <Input value={form.location} disabled={!canEdit} placeholder="Переговорная, адрес или ссылка"
                 onChange={(e) => setForm({ ...form, location: e.target.value })} />
        </Field>

        <Field label="Описание и повестка">
          <Textarea rows={3} value={form.description} disabled={!canEdit}
                    onChange={(e) => setForm({ ...form, description: e.target.value })} />
        </Field>

        <h3 className="tv2-section-title">Напоминания</h3>
        <div className="cal-reminders">
          {reminderRows(form.reminders, REMINDER_CHOICES).map((r) => (
            <label key={r.minutes} className={`cal-reminder ${form.reminders.includes(r.minutes) ? 'on' : ''}`}>
              <input
                type="checkbox"
                checked={form.reminders.includes(r.minutes)}
                disabled={!canEdit}
                onChange={() => setForm((prev) => ({
                  ...prev,
                  reminders: prev.reminders.includes(r.minutes)
                    ? prev.reminders.filter((m) => m !== r.minutes)
                    : addReminder(prev.reminders, r.minutes),
                }))}
              />
              {r.label}
            </label>
          ))}
        </div>

        {canEdit && (
          <div className="cal-reminder-own">
            <span className="dim">Своё время:</span>
            <Input
              inputSize="sm"
              className="ev-own-num"
              type="number"
              min={0}
              max={20160}
              placeholder="30"
              aria-label="Своё время напоминания"
              value={ownValue}
              onChange={(e) => setOwnValue(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addOwn(); } }}
            />
            <Select
              ariaLabel="Единица времени"
              size="sm"
              value={ownUnit}
              onValueChange={(v) => setOwnUnit(v as ReminderUnit)}
              options={[{ value: 'minutes', label: 'минут' }, { value: 'hours', label: 'часов' }, { value: 'days', label: 'дней' }]}
            />
            <button
              className="ui-btn ui-btn-outline ui-btn-sm"
              type="button"
              onClick={addOwn}
              disabled={!ownValue || form.reminders.length >= MAX_REMINDERS}
            >
              Добавить
            </button>
          </div>
        )}
        <div className="ui-field-hint">
          Придёт письмом и всплывёт в приложении. Участникам — тоже.
          {form.reminders.length >= MAX_REMINDERS && ' Больше шести напоминаний на встречу не ставим.'}
        </div>

        {canEdit && (
          <>
            <h3 className="tv2-section-title">Участники</h3>
            {form.participantIds.some((id) => busyPeople[id]?.blocking) && (
              <div className="cal-busy-warn">
                <Icon name="alert" size={14} /> Кто-то из выбранных занят в это время. Если у человека
                включён запрет на пересечения, встречу сохранить не удастся — выберите другое время.
              </div>
            )}
            <div className="cal-people">
              {people.filter((u) => u.role !== 'client' && u.isActive !== false).map((u) => (
                <label key={u.id} className="call-starter-row">
                  <input type="checkbox" checked={form.participantIds.includes(String(u.id))}
                         onChange={() => toggleParticipant(String(u.id))} />
                  <Avatar path={u.avatarUrl ?? null} fallback={initialsOf(u.fullName)} className="avatar-sm" />
                  <span className="call-starter-name">{u.fullName}</span>
                  {/* соорганизатор: впускает, начинает раньше, завершает — если организатор опаздывает */}
                  {isCall && form.participantIds.includes(String(u.id)) && (
                    <button
                      type="button"
                      className={`cal-coorg${form.coOrganizerIds.includes(String(u.id)) ? ' active' : ''}`}
                      title="Соорганизатор: может начать встречу, впускать из зала ожидания и завершить её"
                      onClick={(e) => {
                        e.preventDefault();
                        const id = String(u.id);
                        setForm((f) => ({ ...f, coOrganizerIds: f.coOrganizerIds.includes(id) ? f.coOrganizerIds.filter((x) => x !== id) : [...f.coOrganizerIds, id] }));
                      }}
                    >
                      соорг.
                    </button>
                  )}
                  {/* занятость видно до сохранения — иначе отказ «занят» будет неожиданностью */}
                  {busyPeople[String(u.id)] && (
                    <span
                      className={`cal-busy ${busyPeople[String(u.id)].blocking ? '' : 'soft'}`}
                      title="В это время у человека уже есть событие"
                    >
                      {busyPeople[String(u.id)].text}
                    </span>
                  )}
                </label>
              ))}
            </div>
          </>
        )}

        {/*
          Созвон у встречи (ТЗ-14): постоянная ссылка — одна на всех, есть сразу, не
          меняется при переносе. По ней входят сотрудники (по правилам ниже) и гости.
        */}
        {!form.allDay && (canEdit || value.meeting) && (
          <div className="cal-call">
            {canEdit && (
              <Checkbox
                checked={isCall}
                onCheckedChange={(on) => { setCallTouched(true); setForm((f) => ({ ...f, isCall: on })); }}
                label={<span><b>Созвон</b> — у встречи будет постоянная ссылка, комната откроется сама в назначенное время</span>}
              />
            )}
            {isCall && value.meeting && (
              <div className="cal-call-link">
                <code title={meetingUrl(value.meeting.publicId)}>{meetingUrl(value.meeting.publicId).replace(/^https?:\/\//, '')}</code>
                <button type="button" className="ui-btn ui-btn-outline ui-btn-sm" onClick={async () => {
                  const r = await shareMeeting(value.meeting!.publicId, value.title ?? 'Встреча');
                  if (r === 'copied') toastSaved('Ссылка скопирована', meetingUrl(value.meeting!.publicId));
                }}><Icon name="link" size={14} /> Поделиться</button>
              </div>
            )}
            {/* Гости со стороны по email — личные ссылки, у сохранённой встречи с созвоном */}
            {isCall && canEdit && value.meeting && value.id && <MeetingGuests eventId={String(value.id)} />}
            {isCall && canEdit && (
              <>
                <button type="button" className="ui-btn ui-btn-ghost ui-btn-sm" onClick={() => setShowAccess((v) => !v)} aria-expanded={showAccess}>
                  <Icon name={showAccess ? 'chevron-down' : 'chevron-right'} size={14} /> Доступ и ранний вход
                </button>
                {showAccess && (
                  <div className="cal-call-access">
                    <div className="tv2-grid2">
                      <Field label="Кто входит">
                        <Select
                          ariaLabel="Кто входит"
                          className="tv2-wide"
                          value={form.accessPolicy}
                          onValueChange={(v) => setForm((f) => ({ ...f, accessPolicy: v as AccessPolicy }))}
                          options={POLICY_OPTIONS.map((o) => ({ value: o.key, label: o.label }))}
                        />
                      </Field>
                      <Field label="Ранний вход">
                        <Select
                          ariaLabel="Ранний вход"
                          className="tv2-wide"
                          value={String(form.earlyJoinMin)}
                          onValueChange={(v) => setForm((f) => ({ ...f, earlyJoinMin: Number(v) }))}
                          options={EARLY_OPTIONS.map((m) => ({ value: String(m), label: m ? `за ${m} мин` : 'только с начала' }))}
                        />
                      </Field>
                    </div>
                    <Checkbox
                      checked={form.guestsAllowed}
                      onCheckedChange={(on) => setForm((f) => ({ ...f, guestsAllowed: on }))}
                      label="Гости по ссылке — через зал ожидания"
                    />
                    <div className="ui-field-hint">Соорганизаторов отметьте «соорг.» в списке участников.</div>
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {!isNew && value.participants && value.participants.length > 0 && (
          <>
            <h3 className="tv2-section-title">Кто идёт</h3>
            {value.participants.map((p) => (
              <div key={p.userId} className="cal-participant">
                <Avatar path={p.avatarUrl} fallback={initialsOf(p.fullName)} className="avatar-sm" />
                <span className="call-starter-name">{p.fullName}</span>
                <span className={`cal-status cal-status-${p.status}`}>
                  {p.isOrganizer ? 'организатор' : `${p.isCoOrganizer ? 'соорганизатор · ' : ''}${p.status === 'accepted' ? 'идёт' : p.status === 'declined' ? 'отказался' : 'не ответил'}`}
                </span>
              </div>
            ))}
          </>
        )}

        {/* материалы встречи с Google Диска и протокол Google-документом (#1565) */}
        {/* #4787, п. 19: новое время пересекается с вашей же встречей — видно до сохранения */}
        {canEdit && meId && busyPeople[meId]?.blocking && (
          <div className="tv2-callout tv2-callout-danger" role="status"><Icon name="alert" size={15} /> Конфликт: у вас в это время уже есть встреча</div>
        )}
        {/* #4787, п. 17: повтор новой встречи */}
        {isNew && (
          <div className="cal-field">
            <span>Повторять</span>
            <div className="cal-q-row">
              <select className="ui-input" value={repeat.freq} onChange={(e) => setRepeat((r) => ({ ...r, freq: e.target.value }))} aria-label="Повторять">
                <option value="">Не повторять</option>
                <option value="daily">Каждый день</option>
                <option value="weekdays">По будням</option>
                <option value="weekly">Каждую неделю</option>
                <option value="biweekly">Каждые две недели</option>
                <option value="monthly">Каждый месяц</option>
              </select>
              {repeat.freq && (
                <label className="cal-check">до <DateInput className="ui-input" type="date" value={repeat.until} onChange={(e) => setRepeat((r) => ({ ...r, until: e.target.value }))} aria-label="Повторять до" /></label>
              )}
            </div>
          </div>
        )}
        {!isNew && value.seriesId && <div className="dim cal-small"><Icon name="refresh" size={12} /> Повторяющаяся встреча — при изменении спросим, менять только эту или всю серию</div>}
        {!isNew && value.id && <GoogleFilesBlock entityType="event" entityId={String(value.id)} compact />}
        {!isNew && value.id && summaryMeetingId && (
          <div className="tv2-callout tv2-callout-info"><Icon name="check-circle" size={15} /> Итоги готовы ·{' '}
            <button className="cal-link" onClick={() => { navigate({ section: 'chat', view: 'postcall', meetingId: summaryMeetingId }); onClose(); }}>протокол и задачи</button>
          </div>
        )}
        {/* #4892, п. 10: отказалась половина или ключевой участник — баннер переноса */}
        {!isNew && value.id && canEdit && <RescheduleBanner eventId={String(value.id)} onMoved={onSaved} />}
        {moveOpen && value.id && (
          <CommonTimeDialog
            meId={meId}
            title={`Перенести: ${value.title ?? 'встреча'}`}
            initialIds={(value.participants ?? []).filter((p) => !p.isOrganizer).map((p) => String(p.userId))}
            initialMinutes={Math.max(15, Math.round((Date.parse(String(value.endsAt)) - Date.parse(String(value.startsAt))) / 60000))}
            exceptEventId={String(value.id)}
            onClose={() => setMoveOpen(false)}
            onPoll={() => setMoveOpen(false)}
            onPick={(v) => {
              void request('POST', `/calendar/plus/events/${value.id}/reschedule`, { startsAt: v.startsAt, endsAt: v.endsAt })
                .then(() => { toastSaved('Встреча перенесена', 'приглашения обновлены'); setMoveOpen(false); onSaved(); })
                .catch((e) => { setErr(e instanceof ApiError ? e.message : 'Не удалось перенести'); setMoveOpen(false); });
            }}
          />
        )}
        {/* #4892, п. 6: карточка встречи = подготовка */}
        {!isNew && value.id && value.scope !== 'external' && (value.participants?.length ?? 0) > 1 && (
          <MeetingPrep
            eventId={String(value.id)}
            onJoin={(c) => {
              if (c.publicId) navigate({ section: 'meet', meetId: c.publicId });
              else if (c.meetRoomId) onStartCall(c.meetRoomId);
              onClose();
            }}
          />
        )}
        {/* #4787, п. 10–11: цель, связанные задачи, а после созвона — решения и кто что делает */}
        {!isNew && value.id && value.scope !== 'external' && (
          <EventCardPanel eventId={String(value.id)} canEdit={canEdit} past={!!value.endsAt && Date.parse(value.endsAt) < Date.now()} />
        )}

        {err && <div className="tv2-callout tv2-callout-danger" role="alert"><Icon name="alert" size={15} /> {err}</div>}

        <div className="cal-dialog-actions">
          {value.myStatus === 'invited' && value.id && !declining && (
            <>
              <button className="ui-btn ui-btn-primary ui-btn-sm" onClick={() => { onRespond(String(value.id), 'accepted'); onClose(); }}>Принять</button>
              <button className="ui-btn ui-btn-outline ui-btn-sm" onClick={() => setDeclining(true)}>Отклонить</button>
            </>
          )}
          {declining && value.id && <DeclineBox eventId={String(value.id)} onDone={onSaved} onCancel={() => setDeclining(false)} />}
          {canEdit && !isNew && value.id && (value.participants?.length ?? 0) > 1 && Date.parse(String(value.startsAt)) > Date.now() && (
            <button className="ui-btn ui-btn-outline ui-btn-sm" onClick={() => setMoveOpen(true)}><Icon name="clock" size={14} /> Перенести</button>
          )}
          {/* Встреча с созвоном — на её страницу: там время, состояние, проверка устройств и вход */}
          {value.meeting ? (
            <button className="ui-btn ui-btn-primary ui-btn-sm" onClick={() => { navigate({ section: 'meet', meetId: value.meeting!.publicId }); onClose(); }}>
              <Icon name="phone" size={14} /> Открыть встречу
            </button>
          ) : roomId && (
            <button className="ui-btn ui-btn-outline ui-btn-sm" onClick={() => { onStartCall(String(roomId)); onClose(); }}>
              <Icon name="phone" size={14} /> Войти в созвон
            </button>
          )}
          {/* Где договорились: встречу поставили по переписке — к ней одним нажатием */}
          {value.sourceChatId && (
            <button
              className="ui-btn ui-btn-outline ui-btn-sm"
              onClick={() => {
                navigate({ section: 'chat', chatId: String(value.sourceChatId) });
                // раздел откроется и сам подсветит строку — событием, адреса у сообщения нет
                if (value.sourceMessageId) {
                  window.setTimeout(() => window.dispatchEvent(new CustomEvent('teamcrm:chat-jump', {
                    detail: { chatId: String(value.sourceChatId), messageId: String(value.sourceMessageId) },
                  })), 300);
                }
                onClose();
              }}
              title="Встречу поставили по договорённости в чате"
            >
              <Icon name="chat" size={14} /> Открыть переписку
            </button>
          )}
          {/* Файл встречи: кладётся в Google, Outlook или календарь телефона одним щелчком */}
          {!isNew && (
            <button className="ui-btn ui-btn-outline ui-btn-sm" onClick={() => downloadIcs(String(value.id))} title="Добавить встречу в свой календарь — Google, Outlook, телефон">
              <Icon name="download" size={14} /> В свой календарь
            </button>
          )}
          {canEdit && !isNew && (
            <Button variant="ghost" size="sm" className="ev-delete" onClick={remove}><Icon name="trash" size={14} /> Удалить</Button>
          )}
          {canEdit && <Button variant="primary" onClick={save} loading={busy}>{busy ? 'Сохраняю…' : 'Сохранить'}</Button>}
        </div>
      </aside>
    </div>
  );
}
