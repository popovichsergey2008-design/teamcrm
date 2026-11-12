import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { AppException } from '../../common/http/app-exception';
import { runsBackground } from '../../common/process-role';
import { DbService } from '../../database/db.service';
import { AiService } from '../ai/ai.service';
import { CalendarMailService } from '../calendar/calendar-mail.service';
import { CalendarService } from '../calendar/calendar.service';
import { InboxRepository } from '../notifications/inbox.repository';
import { RealtimeService } from '../realtime/realtime.service';
import { TelegramSender } from '../telegram/telegram.sender';
import { TelegramService } from '../telegram/telegram.service';
import { CalendarPlusRepository } from './calendar-plus.repository';
import { CalendarPlusService, topicWords } from './calendar-plus.service';

type Viewer = { userId: string; role: string };

const AGENDA_SYSTEM = [
  'Ты секретарь встречи. По фактам ниже составь повестку на русском.',
  'Правила: только данные факты, ничего не выдумывай; 3–5 пунктов, нумерованных «1. »;',
  'номера задач (#123) и пометки «просрочено» сохраняй; последний пункт — «Кто и к какому сроку»;',
  'без вступлений и выводов.',
].join('\n');

interface EventView {
  id: string; title: string; description: string | null; startsAt: string | Date; endsAt: string | Date; canEdit: boolean;
  meetRoomId: string | null; sourceChatId?: string | null;
  meeting: { publicId: string; url: string | null } | null;
  participants: { userId: string; fullName: string | null; status: string; isOrganizer: boolean }[];
}

/**
 * Карточка встречи = подготовка (#4892, п. 6): «Войти в звонок», участники, повестка от
 * ИИ (из обсуждения в чате, открытых и просроченных задач по теме — её можно править),
 * итоги прошлой встречи с теми же людьми и материалы. За N минут до начала (по умолчанию
 * 10) — подготовка в QEVO и в Telegram с кнопкой «Войти». Повестка участникам уходит
 * только по кнопке «Отправить повестку».
 */
@Injectable()
export class MeetingPrepService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('MeetingPrep');
  private timer?: NodeJS.Timeout;
  private busy = false;

  constructor(
    private readonly db: DbService,
    private readonly repo: CalendarPlusRepository,
    private readonly calendar: CalendarService,
    private readonly ai: AiService,
    private readonly realtime: RealtimeService,
    private readonly inbox: InboxRepository,
    private readonly tg: TelegramService,
    private readonly sender: TelegramSender,
    private readonly mail: CalendarMailService,
  ) {}

  onModuleInit(): void {
    if (!runsBackground()) return;
    this.timer = setInterval(() => void this.tick(), 60_000);
    this.timer.unref?.();
  }

  onModuleDestroy(): void { if (this.timer) clearInterval(this.timer); }

  /** Ссылка из Telegram открывает звонок сразу, без лишних экранов (?join=1). */
  private joinUrl(publicId: string | null): string | null {
    const url = this.mail.meetUrl(publicId);
    return url ? `${url}?join=1` : null;
  }

  async card(tenantId: string, user: Viewer, eventId: string) {
    const ev = await this.calendar.details(tenantId, user, eventId) as unknown as EventView;
    const peopleIds = ev.participants.filter((p) => p.status !== 'declined').map((p) => String(p.userId));
    const [agenda, prev, files, linked] = await Promise.all([
      this.repo.agenda(tenantId, eventId),
      this.repo.previousMeeting(tenantId, eventId, ev.title, peopleIds),
      this.repo.eventFiles(tenantId, eventId),
      this.db.many<{ id: string; title: string; project_id: string }>(
        `SELECT t.id::text, t.title, t.project_id::text FROM calendar_event_tasks l JOIN tasks t ON t.id = l.task_id AND t.deleted_at IS NULL
          WHERE l.tenant_id = $1 AND l.event_id = $2 ORDER BY l.created_at LIMIT 8`, [tenantId, eventId]),
    ]);
    const agreements = prev ? await this.repo.meetingAgreements(tenantId, prev.meeting_id) : [];
    const prefs = await this.repo.prefs(tenantId, user.userId);
    return {
      eventId, title: ev.title, startsAt: ev.startsAt, endsAt: ev.endsAt, canEdit: ev.canEdit,
      people: ev.participants.filter((p) => p.status !== 'declined').map((p) => (String(p.userId) === String(user.userId) ? 'вы' : (p.fullName ?? '').split(' ')[0])),
      publicId: ev.meeting?.publicId ?? null, meetRoomId: ev.meetRoomId,
      agenda: agenda ? { body: agenda.body, auto: !agenda.edited_by, sentAt: agenda.sent_at, source: this.sourceOf(agenda.facts) } : null,
      previous: prev ? {
        meetingId: prev.meeting_id, title: prev.title, date: prev.happened_at,
        items: agreements.map((a) => ({ title: a.title, assignee: a.assignee, deadlineAt: a.deadline_at, done: a.done, taskId: a.task_id, projectId: a.project_id })),
      } : null,
      materials: [
        ...files.map((f) => ({ kind: 'doc' as const, title: f.title, url: f.url })),
        ...(prev ? [{ kind: 'protocol' as const, title: `протокол ${new Date(prev.happened_at).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' })}`, meetingId: prev.meeting_id }] : []),
        ...linked.map((t) => ({ kind: 'task' as const, title: `задача #${t.id}`, taskId: t.id, projectId: t.project_id, hint: t.title })),
      ],
      prepMin: prefs?.prep_min ?? 10,
    };
  }

  private sourceOf(facts: unknown): string {
    const list = Array.isArray(facts) ? facts as { kind?: string }[] : [];
    const chat = list.some((f) => f.kind === 'chat');
    const task = list.some((f) => f.kind === 'task' || f.kind === 'overdue');
    return chat && task ? 'собрана из обсуждения в чате и открытых задач' : chat ? 'собрана из обсуждения в чате' : task ? 'собрана из открытых задач по теме' : 'собрана по встрече';
  }

  /** Факты для повестки: задачи темы (просроченные первыми), невыполненное с прошлой встречи, обсуждение в чате. */
  async collect(tenantId: string, user: Viewer, ev: EventView) {
    const peopleIds = ev.participants.filter((p) => p.status !== 'declined').map((p) => String(p.userId));
    const tasks = await this.repo.tasksByTopic(tenantId, user.userId, user.role === 'owner' || user.role === 'manager',
      topicWords(ev.title), peopleIds, 4);
    const prev = await this.repo.previousMeeting(tenantId, String(ev.id), ev.title, peopleIds);
    const undone = prev ? (await this.repo.meetingAgreements(tenantId, prev.meeting_id)).filter((a) => !a.done) : [];
    const chatId = ev.sourceChatId ?? null;
    const lines = chatId ? (await this.repo.chatLines(tenantId, chatId, 15)).reverse() : [];
    const facts = [
      ...tasks.map((t) => ({ kind: t.overdue_days ? 'overdue' : 'task', id: t.id, text: `${t.title} — #${t.id}${t.overdue_days ? ` (просрочено ${t.overdue_days} дн.)` : ''}` })),
      ...undone.map((a) => ({ kind: 'previous', text: `${a.assignee ?? 'Кто-то'} — ${a.title}: с прошлой встречи не сделано` })),
      ...lines.map((l) => ({ kind: 'chat', text: `${l.author ?? ''}: ${l.body.slice(0, 300)}` })),
    ];
    return { facts, tasks };
  }

  /** Собрать повестку (ИИ формулирует, без него — факты правилами). Сохраняется только по save. */
  async generate(tenantId: string, user: Viewer, eventId: string, save: boolean) {
    const ev = await this.calendar.details(tenantId, user, eventId) as unknown as EventView;
    const { facts, tasks } = await this.collect(tenantId, user, ev);
    const rules = [
      ...facts.filter((f) => f.kind !== 'chat').slice(0, 4).map((f, i) => `${i + 1}. ${f.text}`),
    ];
    let body = rules.length ? [...rules, `${rules.length + 1}. Кто и к какому сроку`].join('\n') : '';
    if (facts.some((f) => f.kind === 'chat') || !body) {
      try {
        const answer = await this.ai.generate(tenantId, AGENDA_SYSTEM,
          [`Встреча: ${ev.title}`, ev.description ? `Описание: ${ev.description}` : '', 'Факты:', ...facts.map((f) => `- ${f.text}`)].filter(Boolean).join('\n'),
          'meeting_agenda');
        const clean = answer.trim();
        if (clean && /^\s*1[.)]/.test(clean) && clean.length < 2000) body = clean;
      } catch (e) {
        this.log.warn(`повестка ${eventId}: модель не ответила — ${(e as Error).message}`);
      }
    }
    if (!body) body = `1. Цель встречи «${ev.title}»\n2. Что мешает\n3. Кто и к какому сроку`;
    if (save) {
      if (!ev.canEdit) throw AppException.forbidden('Повестку меняет организатор встречи');
      await this.repo.saveAgenda(tenantId, eventId, new Date(ev.startsAt), body, facts.map((f) => ({ kind: f.kind, id: (f as { id?: string }).id })), null);
      for (const t of tasks) {
        await this.db.query(
          `INSERT INTO calendar_event_tasks (tenant_id, event_id, task_id, source, created_by) VALUES ($1, $2, $3, 'linked', $4)
           ON CONFLICT (event_id, task_id) DO NOTHING`, [tenantId, eventId, t.id, user.userId]).catch(() => undefined);
      }
    }
    return { body, facts: facts.length };
  }

  async saveAgenda(tenantId: string, user: Viewer, eventId: string, body: string) {
    const ev = await this.calendar.details(tenantId, user, eventId) as unknown as EventView;
    if (!ev.canEdit) throw AppException.forbidden('Повестку меняет организатор встречи');
    const text = (body ?? '').trim().slice(0, 4000);
    if (!text) throw AppException.validation('Повестка пустая');
    const prev = await this.repo.agenda(tenantId, eventId);
    await this.repo.saveAgenda(tenantId, eventId, new Date(ev.startsAt), text, prev?.facts ?? [], user.userId);
    return this.card(tenantId, user, eventId);
  }

  /** «Отправить повестку» — участникам в QEVO и в Telegram. Сама не уходит. */
  async sendAgenda(tenantId: string, user: Viewer, eventId: string) {
    const ev = await this.calendar.details(tenantId, user, eventId) as unknown as EventView;
    if (!ev.canEdit) throw AppException.forbidden('Повестку отправляет организатор встречи');
    const agenda = await this.repo.agenda(tenantId, eventId);
    if (!agenda) throw AppException.validation('Сначала соберите повестку');
    const to = ev.participants.filter((p) => p.status !== 'declined' && String(p.userId) !== String(user.userId)).map((p) => String(p.userId));
    const when = new Date(ev.startsAt).toLocaleString('ru-RU', { weekday: 'short', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow' });
    for (const uid of to) {
      await this.inbox.record({
        tenantId, userId: uid, mailId: null, eventKey: 'calendar.agenda', title: `Повестка: ${ev.title}`.slice(0, 255),
        body: agenda.body.slice(0, 500), path: `/calendar?event=${eventId}`, details: { eventId },
      }).catch(() => undefined);
      void this.telegram(tenantId, uid, `Повестка встречи «${ev.title}» (${when})\n\n${agenda.body}`, ev.meeting?.publicId ?? null).catch(() => undefined);
    }
    this.realtime.emitToUsers(tenantId, to, 'calendar.agenda', { eventId, title: ev.title, startsAt: ev.startsAt, body: agenda.body });
    await this.repo.markAgendaSent(tenantId, eventId);
    return { sent: to.length };
  }

  private async telegram(tenantId: string, userId: string, text: string, publicId: string | null): Promise<boolean> {
    if (!this.sender.enabled) return false;
    const chatId = await this.tg.chatIdOf(tenantId, userId).catch(() => null);
    if (!chatId) return false;
    const url = this.joinUrl(publicId);
    await this.sender.sendMessage(chatId, text.slice(0, 3800), url ? { inline_keyboard: [[{ text: 'Войти в звонок', url }]] } : undefined);
    return true;
  }

  /** Раз в минуту: подготовка к встречам, до которых осталось prep_min минут. */
  async tick(): Promise<number> {
    if (this.busy) return 0;
    this.busy = true;
    let n = 0;
    try {
      for (const r of await this.repo.duePrep()) {
        try {
          await this.repo.markPrepSent(r.event_id, r.user_id, r.starts_at);
          const agenda = await this.repo.agenda(r.tenant_id, r.event_id);
          const prev = await this.db.one<{ n: number }>(
            `SELECT count(*)::int AS n FROM calendar_event_tasks WHERE event_id = $1`, [r.event_id]);
          const lines = (agenda?.body ?? '').split('\n').filter(Boolean).slice(0, 3);
          const time = `${r.starts_at.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow' })}–${r.ends_at.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow' })}`;
          const prep = lines.length ? lines.join(' · ') : prev?.n ? `связанных задач: ${prev.n}` : 'повестки нет — откройте карточку встречи';
          this.realtime.emitToUsers(r.tenant_id, [r.user_id], 'calendar.reminder', {
            eventId: r.event_id, title: r.title, startsAt: r.starts_at, minutesBefore: r.prep_min, location: null,
            publicId: r.public_id ?? null, prep,
          });
          await this.inbox.record({
            tenantId: r.tenant_id, userId: r.user_id, mailId: null, eventKey: 'calendar.prep',
            title: `Через ${r.prep_min} мин: ${r.title}`.slice(0, 255), body: prep.slice(0, 500),
            path: r.public_id ? `/meet/${r.public_id}` : `/calendar?event=${r.event_id}`, details: { eventId: r.event_id },
          }).catch(() => undefined);
          const text = [`Через ${r.prep_min} минут: ${r.title} · ${time}`, ...(lines.length ? ['', 'Повестка:', ...lines] : [])].join('\n');
          await this.telegram(r.tenant_id, r.user_id, text, r.public_id).catch(() => false);
          n++;
        } catch (e) {
          this.log.warn(`подготовка ${r.event_id}: ${(e as Error).message}`);
        }
      }
    } finally {
      this.busy = false;
    }
    return n;
  }

  /** Повестка правилами из задач темы — для встреч, созданных фразой и «Найти время». */
  agendaFromTasks = CalendarPlusService.agendaFromTasks;
}
