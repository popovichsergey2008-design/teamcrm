import { FocusDayService } from '../focus/focus-day.service';
import { ProjectResolverService } from '../nl/project-resolver.service';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { AppException } from '../../common/http/app-exception';
import { localParts } from '../assistant/ping-rules';
import { zonedTime } from '../focus/close-day';
import { PushService } from '../notifications/push.service';
import { TelegramMirror } from '../notifications/telegram-mirror.service';
import { Actor, ProactiveService } from '../proactive/proactive.service';
import { ProactiveRepository } from '../proactive/proactive.repository';
import { ProactiveScheduler } from '../proactive/proactive.scheduler';
import { fingerprint, snoozeTarget } from '../proactive/proactive-rules';
import { actionInfinitive, firstName, guessGender, pastVerb, whenSaid } from '../../common/text/ru-grammar';
import type { ProposalRow } from '../proactive/proactive.repository';
import { TasksService } from '../tasks/tasks.service';
import { commitmentCardText, detectCommitment, DeadlineHint, looksCancelled, looksFulfilled, normalizeAction, similarity } from './commitment-rules';
import { CommitmentRow, CommitmentsRepository, MessageRow } from './commitments.repository';

const dateRu = (d: Date | string, tz: string) => new Date(d).toLocaleString('ru-RU', { timeZone: tz, day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });

/**
 * Охотник за обещаниями (ТЗ-21, этап 2).
 *
 * Находит «я пришлю смету сегодня» в чатах (включая личные), обсуждениях задач и встречах;
 * если по обещанию уже есть задача — привязывает её, а не плодит вторую (§20). Через срок
 * (или 24 ч без срока) проверяет: задача закрыта? автор прислал файл, ссылку, «отправил»?
 * Нет — мягко напоминает самому обещавшему; молчит дальше — сообщает тому, кто просил (§23–24).
 */
@Injectable()
export class CommitmentsService implements OnModuleInit {
  private readonly log = new Logger('Commitments');

  constructor(
    private readonly repo: CommitmentsRepository,
    private readonly proactive: ProactiveService,
    private readonly proactiveRepo: ProactiveRepository,
    private readonly scheduler: ProactiveScheduler,
    private readonly tasks: TasksService,
    private readonly push: PushService,
    private readonly telegram: TelegramMirror,
    /** «В мой Фокус» (ТЗ-21, этап 8): своё обещание — в тройку дня. */
    private readonly focus: FocusDayService,
    /** Проект задачи по обещанию (ТЗ-31): вместо «первого попавшегося» — определитель. */
    private readonly resolver: ProjectResolverService,
  ) {}

  onModuleInit(): void {
    this.proactive.register({ skill: 'commitment', execute: (a, p, action, params) => this.execute(a, p, action, params) });
    this.scheduler.add('обещания: поиск', () => this.scanAll());
    this.scheduler.add('обещания: проверка', () => this.checkDue());
  }

  // ───────────────────────── поиск ─────────────────────────

  async scanAll(): Promise<void> {
    for (const t of await this.repo.activeTenants()) {
      const tenantId = String(t.id);
      const settings = await this.proactiveRepo.tenantSettings(tenantId);
      if (!settings.enabled || !settings.commitments) continue;
      await this.scanSource(tenantId, 'chat_messages', settings.commitmentCheckHours, settings.commitmentMinConfidence).catch((e) => this.log.warn(`чаты ${tenantId}: ${(e as Error).message}`));
      await this.scanSource(tenantId, 'task_comments', settings.commitmentCheckHours, settings.commitmentMinConfidence).catch((e) => this.log.warn(`задачи ${tenantId}: ${(e as Error).message}`));
      await this.scanMeetings(tenantId, settings.commitmentCheckHours, settings.commitmentMinConfidence).catch((e) => this.log.warn(`встречи ${tenantId}: ${(e as Error).message}`));
    }
  }

  /** Новые сообщения после курсора; при первом запуске — с текущего места, без истории. */
  async scanSource(tenantId: string, source: 'chat_messages' | 'task_comments', checkHours: number, minConf = 0.7): Promise<number> {
    let cur = await this.repo.cursor(tenantId, source);
    if (!cur) {
      await this.repo.setCursor(tenantId, source, await this.repo.maxId(tenantId, source));
      return 0;
    }
    const rows = source === 'chat_messages' ? await this.repo.chatMessages(tenantId, cur) : await this.repo.taskComments(tenantId, cur);
    let found = 0;
    for (const m of rows) {
      const type = source === 'chat_messages' ? 'chat' : 'task';
      await this.afterMessage(tenantId, type, m);
      if (await this.fromMessage(tenantId, type, m, checkHours, minConf)) found++;
      cur = m.id;
    }
    if (rows.length) await this.repo.setCursor(tenantId, source, cur);
    return found;
  }

  /** Новое сообщение закрывает открытые обещания: автор прислал результат или их отменили. */
  private async afterMessage(tenantId: string, type: 'chat' | 'task', m: MessageRow) {
    const open = await this.repo.openIn(tenantId, type, m.container_id);
    for (const c of open) {
      if (new Date(m.created_at).getTime() <= new Date(c.source_at).getTime()) continue;
      const repliesToPromise = !!m.reply_to_id && (c.source_message_ids ?? []).map(String).includes(String(m.reply_to_id));
      if (String(c.speaker_user_id) === String(m.author_id) && looksFulfilled({ body: m.body, hasFile: m.has_file, repliesToPromise })) {
        await this.close(c, 'fulfilled', 'message');
      } else if (looksCancelled(m.body) && (String(m.author_id) === String(c.assigner_user_id) || String(m.author_id) === String(c.speaker_user_id))) {
        await this.close(c, 'cancelled', null);
      }
    }
  }

  private toAbs(hint: DeadlineHint | null, at: Date, tz: string): Date | null {
    if (!hint) return null;
    if (hint.kind === 'relative') return new Date(at.getTime() + hint.minutes * 60_000);
    return zonedTime(hint.date, hint.time, tz);
  }

  private async fromMessage(tenantId: string, type: 'chat' | 'task', m: MessageRow, checkHours: number, minConf = 0.7): Promise<boolean> {
    const at = new Date(m.created_at);
    const l = localParts(at, m.tz);
    const d = detectCommitment(m.body, { date: l.date, hour: l.hour, minute: l.minute, isoDow: l.dow === 0 ? 7 : l.dow });
    if (!d || d.confidence < minConf) return false;
    let assigner = m.reply_author_id && m.reply_author_id !== m.author_id ? m.reply_author_id
      : m.prev_author_id && m.prev_author_id !== m.author_id ? m.prev_author_id : null;
    if (!assigner && type === 'chat' && m.kind === 'dm') assigner = await this.repo.dmPeer(m.container_id, m.author_id);
    const deadlineAt = this.toAbs(d.deadline, at, m.tz);
    const linked = await this.findTask(tenantId, m.author_id, d.action, type === 'chat' ? m.id : null);
    const checkAt = deadlineAt ?? new Date(at.getTime() + checkHours * 3600_000);
    const id = await this.repo.insert({
      tenantId, sourceType: type, sourceId: m.container_id, messageIds: [m.id], sourceAt: at, quote: m.body,
      speaker: m.author_id, assigner, projectId: m.project_id, action: d.action, normalized: normalizeAction(d.action),
      deadlineAt, deadlineText: d.deadline?.text ?? null, confidence: d.confidence,
      status: linked ? (linked.closed ? 'fulfilled' : 'tracked') : 'detected', linkedTaskId: linked?.id ?? null, checkAt,
    });
    return !!id;
  }

  async scanMeetings(tenantId: string, checkHours: number, minConf = 0.7): Promise<number> {
    const cur = await this.repo.cursor(tenantId, 'meetings');
    if (!cur) {
      await this.repo.setCursor(tenantId, 'meetings', await this.repo.maxId(tenantId, 'meetings'));
      return 0;
    }
    let found = 0;
    let last = cur;
    for (const mt of await this.repo.meetingsDone(tenantId, cur)) {
      for (const s of await this.repo.segments(mt.id)) {
        const at = new Date(mt.at);
        const l = localParts(at, s.tz);
        const d = detectCommitment(s.text, { date: l.date, hour: l.hour, minute: l.minute, isoDow: l.dow === 0 ? 7 : l.dow });
        if (!d || d.confidence < minConf) continue;
        const deadlineAt = this.toAbs(d.deadline, at, s.tz);
        const linked = await this.findTask(tenantId, s.speaker_user_id, d.action, null);
        const id = await this.repo.insert({
          tenantId, sourceType: 'meeting', sourceId: mt.id, messageIds: [], sourceAt: at, offsetSec: Number(s.start_sec),
          quote: s.text, speaker: s.speaker_user_id,
          assigner: mt.created_by && mt.created_by !== s.speaker_user_id ? mt.created_by : null,
          projectId: mt.project_id, action: d.action, normalized: normalizeAction(d.action), deadlineAt,
          deadlineText: d.deadline?.text ?? null, confidence: d.confidence,
          status: linked ? (linked.closed ? 'fulfilled' : 'tracked') : 'detected', linkedTaskId: linked?.id ?? null,
          checkAt: deadlineAt ?? new Date(at.getTime() + checkHours * 3600_000),
        });
        if (id) found++;
      }
      last = mt.id;
    }
    if (last !== cur) await this.repo.setCursor(tenantId, 'meetings', last);
    return found;
  }

  /** Задача по обещанию уже есть (§20)? Из этого сообщения — точно; иначе по похожести. */
  private async findTask(tenantId: string, assignee: string, action: string, messageId: string | null) {
    const rows = await this.repo.similarTasks(tenantId, assignee, messageId);
    const exact = rows.find((r) => r.from_message);
    if (exact) return exact;
    return rows.find((r) => similarity(action, r.title) >= 0.6) ?? null;
  }

  // ───────────────────────── проверка ─────────────────────────

  async checkDue(): Promise<void> {
    for (const c of await this.repo.due()) {
      try { await this.check(c); } catch (e) { this.log.warn(`обещание ${c.id}: ${(e as Error).message}`); }
    }
  }

  private async check(c: CommitmentRow) {
    const settings = await this.proactiveRepo.tenantSettings(String(c.tenant_id));
    if (c.linked_task_id && (await this.repo.taskClosed(String(c.linked_task_id)))) return this.close(c, 'fulfilled', 'task');
    // «Напомнить мне завтра» (#1525): личное напоминание обещавшему, своим сроком
    if (c.self_remind_at && new Date(c.self_remind_at).getTime() <= Date.now()) {
      await this.remindSpeaker(c, String(c.tenant_id));
      await this.repo.update(String(c.id), { self_remind_at: null });
      if (new Date(c.check_at).getTime() > Date.now()) return;
    }
    if (c.status === 'tracked') {
      // задача есть и открыта — обещание живёт её жизнью; заглянем ещё раз через сутки
      return this.repo.update(String(c.id), { check_at: new Date(Date.now() + 24 * 3600_000) });
    }
    // «если через 24 часа задача не создана» — задачу могли поставить руками уже после обещания
    if (!c.linked_task_id) {
      const later = await this.findTask(String(c.tenant_id), String(c.speaker_user_id), c.action_text,
        c.source_type === 'chat' && c.source_message_ids?.[0] ? String(c.source_message_ids[0]) : null);
      if (later) {
        await this.repo.update(String(c.id), { status: 'tracked', linked_task_id: later.id, check_at: new Date(Date.now() + 24 * 3600_000) });
        if (later.closed) return this.close({ ...c, linked_task_id: later.id }, 'fulfilled', 'task');
        return this.proactive.resolveBySource(String(c.tenant_id), 'commitment', c.source_type, String(c.source_id), `Задача #${later.id} уже есть`).catch(() => undefined);
      }
    }
    if (c.status === 'detected') {
      /*
        #1525, документ: «через 24 часа … тихо и деликатно присылает карточку исполнителю
        и руководителю» — обе сразу. Руководитель — тот, кто просил (ответ, собеседник,
        автор встречи или задачи); не нашли — ответственный за проект, иначе владелец.
      */
      const manager = c.assigner_user_id && String(c.assigner_user_id) !== String(c.speaker_user_id)
        ? { id: String(c.assigner_user_id), byRole: false }
        : await this.repo.managerFor(String(c.tenant_id), c.project_id ? String(c.project_id) : null, String(c.speaker_user_id))
          .then((id) => (id ? { id, byRole: true } : null));
      await this.proposeTo(c, String(c.speaker_user_id), 'self', settings.commitmentCheckHours);
      if (manager) await this.proposeTo(c, manager.id, manager.byRole ? 'manager' : 'assigner', settings.commitmentCheckHours);
      return this.repo.update(String(c.id), {
        status: 'needs_followup', reminded_at: new Date(), remind_count: (c.remind_count ?? 0) + 1,
        ...(manager ? { escalated_at: new Date() } : {}),
        check_at: new Date(Date.now() + 24 * 3600_000),
      });
    }
    // needs_followup: карточки уже у обоих; две недели раз в сутки смотрим, не появилась ли задача
    const age = Date.now() - new Date(c.source_at).getTime();
    return this.repo.update(String(c.id), { check_at: new Date(Date.now() + (age < 14 * 24 * 3600_000 ? 24 : 30 * 24) * 3600_000) });
  }

  private sourceOf(c: CommitmentRow): { label: string; link: string } {
    const title = c.source_title ? `«${c.source_title}»` : '';
    if (c.source_type === 'chat') return { label: `Чат ${title}`.trim(), link: `/chat/${c.source_id}` };
    if (c.source_type === 'task') return { label: `Задача ${title}`.trim(), link: c.project_id ? `/projects/${c.project_id}/task/${c.source_id}` : '/tasks' };
    const t = c.source_offset_sec != null ? `?t=${Math.floor(Number(c.source_offset_sec))}` : '';
    return { label: `Встреча ${title}`.trim(), link: `/meetings/${c.source_id}${t}` };
  }

  /**
   * Карточка в ящик (#1525, текст — дословно по документу). Обещавшему — о нём самом и
   * «Напомнить мне завтра»; руководителю — «Напомнить Глебу». Руководитель «по должности»
   * (не участник разговора) цитату и ссылку на источник видит, только если сам может его
   * открыть: личную переписку — никогда, там только «в личной переписке».
   */
  private async proposeTo(c: CommitmentRow, userId: string, role: 'self' | 'assigner' | 'manager', checkHours: number) {
    const tenantId = String(c.tenant_id);
    const tz = await this.proactiveRepo.timezoneOf(tenantId, userId);
    const sees = role !== 'manager' || (await this.repo.canSeeSource(tenantId, c, userId).catch(() => false));
    const src: { label: string; link: string | null } = sees ? this.sourceOf(c)
      : { label: c.source_type === 'chat' ? (c.chat_kind === 'dm' ? 'Личная переписка' : 'Чат') : c.source_type === 'task' ? 'Задача' : 'Встреча', link: null };
    const when = dateRu(c.source_at, tz);
    const overdue = !!c.deadline_at && new Date(c.deadline_at).getTime() < Date.now();
    const self = role === 'self';
    const card = commitmentCardText({
      self, speakerFullName: c.speaker_name ?? '', sourceType: c.source_type, chatKind: c.chat_kind ?? null,
      taskTitle: sees && c.source_type === 'task' ? c.source_title ?? null : null,
      saidWhen: whenSaid(localParts(new Date(c.source_at), tz).date, localParts(new Date(), tz).date),
      action: c.action_text,
      overdueText: overdue ? c.deadline_text ?? 'срок' : null,
      hoursPassed: overdue ? checkHours : (Date.now() - new Date(c.source_at).getTime()) / 3600_000,
    });
    const name = firstName(c.speaker_name) || c.speaker_name || '';
    const actions = [
      ...(c.linked_task_id ? [] : [{ key: 'create_task', label: 'Создать задачу в проект', risk: 'high_write', primary: true }]),
      self ? { key: 'remind_me', label: card.remindLabel, risk: 'low_write' } : { key: 'remind', label: card.remindLabel, risk: 'low_write' },
      // своё обещание — сразу в тройку дня (ТЗ-21, этап 8)
      ...(self ? [{ key: 'focus', label: 'В мой Фокус', risk: 'low_write' }] : []),
      { key: 'done', label: 'Уже выполнено', risk: 'low_write' },
      { key: 'untrack', label: 'Не отслеживать', risk: 'low_write' },
    ];
    await this.proactive.propose({
      tenantId, userId, skill: 'commitment',
      kind: `${c.source_type}:${c.source_id}`,
      sourceType: c.source_type, sourceId: String(c.source_id), sourceAt: c.source_at,
      sourceLabel: `${src.label}, ${when}`, sourceLink: src.link,
      title: card.text,
      summary: sees ? `«${c.quote.slice(0, 280)}»` : '',
      why: `${c.linked_task_id ? '' : 'Задачи по этому обещанию в QEVO нет. '}Ответа в переписке не видно.`,
      recommend: self ? 'Отметьте, если уже сделано, или поставьте задачу — так обещание не потеряется.'
        : `Поставьте задачу или напомните — ${name} пока не ${pastVerb('отреагировал', guessGender(c.speaker_name))}.`,
      effect: self ? 'Задача появится на вас со сроком из обещания и ссылкой на разговор.'
        : `Задача появится на ${c.speaker_name} со сроком из обещания; «${card.remindLabel}» — личное уведомление.`,
      // тихо (документ): без пуша, кроме просроченного срока
      priority: overdue ? 1 : 2,
      confidence: Number(c.confidence),
      actions,
      payload: { commitmentId: String(c.id), dueAt: c.deadline_at, role },
      fingerprint: fingerprint({ skill: 'commitment', sourceType: 'commitment', sourceId: String(c.id), entity: self ? 'self' : 'assigner' }),
      expiresAt: new Date(Date.now() + 14 * 24 * 3600_000),
    });
  }

  /** Личное напоминание обещавшему: пуш + Telegram. */
  private async remindSpeaker(c: CommitmentRow, tenantId: string) {
    const tz = await this.proactiveRepo.timezoneOf(tenantId, String(c.speaker_user_id));
    const src = this.sourceOf(c);
    const text = `Напоминание: вы обещали ${actionInfinitive(c.action_text)} (${src.label}, ${dateRu(c.source_at, tz)}).`;
    await this.push.personal({ tenantId, userId: String(c.speaker_user_id), eventKey: 'assistant.commitment', title: 'Вы обещали', body: text, path: src.link });
    await this.telegram.push(tenantId, String(c.speaker_user_id), text).catch(() => false);
  }

  private async close(c: CommitmentRow, status: 'fulfilled' | 'cancelled' | 'dismissed', by: string | null) {
    await this.repo.update(String(c.id), status === 'fulfilled'
      ? { status, fulfilled_at: new Date(), fulfilled_by: by ?? 'user' }
      : status === 'cancelled' ? { status, cancelled_at: new Date() } : { status });
    const text = status === 'fulfilled' ? (by === 'task' ? 'Задача закрыта — обещание выполнено' : 'Обещание выполнено') : 'Обещание снято';
    await this.proactive.resolveBySource(String(c.tenant_id), 'commitment', c.source_type, String(c.source_id), text).catch(() => undefined);
  }

  // ───────────────────────── кнопки карточки ─────────────────────────

  private async execute(a: Actor, p: ProposalRow, action: string, params: Record<string, unknown> = {}) {
    const c = await this.repo.get(a.tenantId, String(p.payload.commitmentId));
    if (!c) throw AppException.notFound('Обещание не найдено');
    // карточка руководителя (#1525) — его собственная: ящик выдал её только ему
    const ownCard = !!p.user_id && String(p.user_id) === String(a.userId) && p.payload?.role === 'manager';
    const isParty = ownCard || [c.speaker_user_id, c.assigner_user_id].map(String).includes(String(a.userId));
    if (!isParty) throw AppException.forbidden('Это обещание касается других людей');
    if (action === 'done') {
      await this.close(c, 'fulfilled', 'user');
      return { text: 'Отмечено выполненным' };
    }
    if (action === 'untrack') {
      await this.close(c, 'dismissed', null);
      return { text: 'Больше не отслеживаю это обещание' };
    }
    if (action === 'remind') {
      await this.remindSpeaker(c, a.tenantId);
      await this.repo.update(String(c.id), { reminded_at: new Date(), remind_count: (c.remind_count ?? 0) + 1 });
      return { text: `Напомнил: ${c.speaker_name}` };
    }
    if (action === 'remind_me') {
      // «Напомнить мне завтра» — в 9:00 следующего рабочего дня по поясу обещавшего
      if (String(c.speaker_user_id) !== String(a.userId)) throw AppException.forbidden('Напомнить себе — только о своём обещании');
      const tz = await this.proactiveRepo.timezoneOf(a.tenantId, a.userId);
      const l = localParts(new Date(), tz);
      const t = snoozeTarget('tomorrow', { date: l.date, hour: l.hour, minute: l.minute, isoDow: l.dow === 0 ? 7 : l.dow });
      const at = t.kind === 'local' ? zonedTime(t.date, t.time, tz) : new Date(Date.now() + 24 * 3600_000);
      await this.repo.update(String(c.id), { self_remind_at: at });
      const day = l.dow === 5 || l.dow === 6 ? 'в понедельник' : 'завтра';
      return { text: `Напомню ${day} в 9:00` };
    }
    if (action === 'create_task') {
      if (c.linked_task_id) return { text: `Задача #${c.linked_task_id} уже есть` };
      const task = await this.ensureTask(a, c, params.projectId ? String(params.projectId) : null);
      return { text: `Задача #${task.id} поставлена на ${c.speaker_name}`, link: `/projects/${task.projectId}/task/${task.id}` };
    }
    if (action === 'focus') {
      if (String(c.speaker_user_id) !== String(a.userId)) throw AppException.forbidden('В фокус — только своё обещание');
      const task = await this.ensureTask(a, c, params.projectId ? String(params.projectId) : null);
      const link = `/projects/${task.projectId}/task/${task.id}`;
      try {
        await this.focus.add({ tenantId: a.tenantId, userId: a.userId, role: a.role }, { key: `task:${task.id}` });
        return { text: `В фокусе дня: «${c.action_text}»`, link: '/focus' };
      } catch (e) {
        // задача уже есть — не теряем её: человек поставит в фокус сам
        const why = e instanceof AppException ? e.message : 'не получилось';
        return { text: `Задача #${task.id} создана, в фокус не встала: ${why}`, link };
      }
    }
    throw AppException.validation('Такого действия нет');
  }

  /** Задача по обещанию: уже связанная — она; иначе новая на обещавшего, со сроком и цитатой. */
  private async ensureTask(a: Actor, c: CommitmentRow, chosen: string | null = null): Promise<{ id: string; projectId: string }> {
    if (c.linked_task_id) {
      const t = await this.repo.taskRef(a.tenantId, String(c.linked_task_id));
      if (t) return t;
    }
    /*
      Проект (ТЗ-31, §29). Раньше обещание из личной переписки молча уезжало в «основной»
      проект компании. Теперь: проект источника (чат проекта, задача, встреча) или
      выбранный человеком; иначе — определитель, и если он не уверен, карточка
      открывает быстрый выбор проекта с вариантами.
    */
    let projectId = chosen ?? (c.project_id ? String(c.project_id) : null);
    let predicted: { projectId: string | null; confidence: number; resolution: string; reasonCodes: string[] } | null = null;
    if (!projectId) {
      const r = await this.resolver.resolve(a.tenantId, { userId: a.userId, role: a.role }, {
        text: `${c.action_text} ${c.quote}`,
        peopleIds: [c.speaker_user_id, c.assigner_user_id],
      });
      predicted = r;
      if (r.level === 'HIGH') projectId = r.projectId;
      else {
        const options = [...(r.projectId ? [{ projectId: r.projectId, name: r.projectName }] : []), ...r.alternatives]
          .map((x) => ({ id: String(x.projectId), name: String(x.name) }));
        throw new AppException('UNPROCESSABLE', 'К какому проекту относится задача?', {
          code: 'PROJECT_REQUIRED', field: 'project_id',
          candidates: options.slice(0, 3),
          projects: r.projects.slice(0, 60).map((p) => ({ id: String(p.id), name: p.name })),
        });
      }
    }
    if (!projectId) throw new AppException('UNPROCESSABLE', 'К какому проекту относится задача?', { code: 'PROJECT_REQUIRED', field: 'project_id' });
    if (chosen) await this.tasks.assertProject(a.tenantId, chosen, { userId: a.userId, role: a.role });
    const src = this.sourceOf(c);
    const task = await this.tasks.create(a.tenantId, {
      projectId,
      title: c.action_text.charAt(0).toUpperCase() + c.action_text.slice(1),
      description: `Обещание из разговора (${src.label}):\n«${c.quote.slice(0, 1500)}»`,
      assigneeId: String(c.speaker_user_id),
      deadlineAt: c.deadline_at ? new Date(c.deadline_at).toISOString() : undefined,
    } as any, a.userId, { sourceChatMessageId: c.source_type === 'chat' && c.source_message_ids?.[0] ? String(c.source_message_ids[0]) : null });
    if (chosen || predicted) {
      void this.resolver.feedback(a.tenantId, a.userId, 'commitment', {
        predictedProjectId: predicted?.projectId ?? null, selectedProjectId: projectId, confidence: predicted?.confidence ?? null,
        resolution: predicted?.resolution ?? null, reasonCodes: predicted?.reasonCodes ?? [], taskId: String(task.id),
      });
    }
    await this.repo.update(String(c.id), {
      status: 'tracked', linked_task_id: String(task.id),
      check_at: c.deadline_at && new Date(c.deadline_at).getTime() > Date.now() ? new Date(c.deadline_at) : new Date(Date.now() + 24 * 3600_000),
    });
    return { id: String(task.id), projectId: String(task.project_id) };
  }

  // ───────────────────────── экран «Обещания» ─────────────────────────

  async list(a: Actor) {
    const rows = await this.repo.forUser(a.tenantId, a.userId);
    return rows.map((c) => {
      const src = this.sourceOf(c);
      return {
        id: String(c.id), action: c.action_text, quote: c.quote.slice(0, 300), status: c.status,
        mine: String(c.speaker_user_id) === String(a.userId),
        speaker: c.speaker_name, assigner: c.assigner_name ?? null,
        deadlineAt: c.deadline_at, deadlineText: c.deadline_text, sourceAt: c.source_at,
        source: { type: c.source_type, label: src.label, link: src.link },
        taskId: c.linked_task_id ? String(c.linked_task_id) : null,
        confidence: Number(c.confidence),
      };
    });
  }

  /** «В мой Фокус» из экрана «Обещания» — то же, что кнопка карточки. */
  async toFocus(a: Actor, id: string) {
    const c = await this.repo.get(a.tenantId, String(id));
    if (!c || String(c.speaker_user_id) !== String(a.userId)) throw AppException.notFound('Обещание не найдено');
    return this.execute(a, { payload: { commitmentId: String(c.id) } } as unknown as ProposalRow, 'focus');
  }

  /** Отметить из экрана «Обещания» (§99): выполнено / не отслеживать. */
  async mark(a: Actor, id: string, status: 'fulfilled' | 'dismissed') {
    const c = await this.repo.get(a.tenantId, String(id));
    if (!c || ![c.speaker_user_id, c.assigner_user_id].map(String).includes(String(a.userId))) throw AppException.notFound('Обещание не найдено');
    await this.close(c, status, 'user');
    return { ok: true };
  }
}
