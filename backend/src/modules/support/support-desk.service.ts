import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { AppException } from '../../common/http/app-exception';
import { AnthillService } from '../anthill/anthill.service';
import { AnthillRepository } from '../anthill/anthill.repository';
import { FilesService } from '../files/files.service';
import { RealtimeService } from '../realtime/realtime.service';
import { MeetingsService } from '../meetings/meetings.service';
import { ProjectsService } from '../projects/projects.service';
import { TasksService } from '../tasks/tasks.service';
import { SupportRepository } from './support.repository';
import { ContextInput, ConversationRow, SupportDeskRepository } from './support-desk.repository';
import { humanStatus, wantsHuman } from './support-text';

/**
 * Служба заботы: живой разговор вместо заявок (ТЗ-8).
 *
 * Здесь собрана вся механика обращения: первая линия AnthillBot, передача человеку,
 * подключение специалиста, подтверждение решения самим человеком и оценка.
 *
 * Три правила, на которых всё держится, — и каждое вытекает прямо из ТЗ:
 *
 * 1. Живой разговор у человека ОДИН. Открыл поддержку второй раз, пока прежняя
 *    проблема не закрыта, — это то же обращение. Иначе у специалиста два окна об
 *    одном и том же, а человек объясняет дважды (разд. 2.4).
 * 2. Кнопка «позвать человека» работает ВСЕГДА, и слова «человек», «специалист»,
 *    «не помогло» переводят разговор сами (разд. 9). ИИ — помощь, а не барьер.
 * 3. Закрывает разговор только тот, кто обратился (разд. 21). «Решено» у специалиста
 *    переводит в «проверьте, пожалуйста» — и ждёт ответа.
 */
@Injectable()
export class SupportDeskService implements OnModuleInit {
  private readonly log = new Logger('SupportDesk');

  constructor(
    private readonly repo: SupportDeskRepository,
    private readonly realtime: RealtimeService,
    private readonly files: FilesService,
    private readonly agent: AnthillService,
    private readonly agentRepo: AnthillRepository,
    private readonly tasks: TasksService,
    private readonly projects: ProjectsService,
    private readonly support: SupportRepository,
    private readonly meetings: MeetingsService,
  ) {}

  /**
   * Подписываемся на разбор созвонов.
   *
   * Итог созвона из поддержки должен вернуться в тот разговор, из которого звонили.
   * Встречи о поддержке не знают — мы приходим к ним сами.
   */
  onModuleInit(): void {
    this.meetings.onCallProcessed(async (e) => {
      if (e.roomId) await this.huddleFinished(e.roomId, e.meetingId, e.summary);
    });
    /*
      Задача закрыта — говорим тем, кто её ждал (разд. 25).

      Человек, обратившийся неделю назад, узнаёт о починке сам, а не проверяет по
      своей инициативе. Подписка по той же причине, что и на разбор созвона.
    */
    this.tasks.onTaskClosed(async (e) => { await this.notifyFixDeployed(e.taskId, e.title); });
  }

  // ── что показать в панели ──
  /**
   * Состояние службы заботы для человека: живой разговор, история и кто сейчас дежурит.
   *
   * Время ответа честное: медиана за две недели. Нет данных — не выдумываем цифру,
   * панель скажет «ищем свободного специалиста» (разд. 6).
   */
  async desk(tenantId: string, user: { userId: string; role: string }) {
    const [active, mine, agents, eta] = await Promise.all([
      this.repo.activeOf(tenantId, user.userId),
      this.repo.mine(tenantId, user.userId),
      this.repo.agents(tenantId),
      this.repo.medianFirstResponse(tenantId),
    ]);
    const online = new Set(this.realtime.onlineUsers(tenantId));
    return {
      conversation: active ? await this.view(tenantId, active) : null,
      history: mine.map((c) => ({
        id: String(c.id),
        subject: c.subject,
        status: c.status,
        statusText: humanStatus(c.status),
        agentName: c.agent_name,
        messages: c.messages,
        createdAt: c.created_at,
        closedAt: c.closed_at,
        csat: c.csat_score,
      })),
      team: agents.map((a) => ({
        userId: a.user_id,
        name: a.full_name,
        online: online.has(a.user_id),
        status: a.presence_status,
        skills: a.skills ?? [],
      })),
      /** Секунды до первого ответа или null — «обещать нечего». */
      etaSeconds: eta,
      isAgent: await this.isAgent(tenantId, user),
    };
  }

  /** Разговор целиком: сообщения, участники, контекст. */
  async conversation(tenantId: string, user: { userId: string; role: string }, id: string) {
    const conv = await this.repo.byId(tenantId, id);
    if (!conv) throw AppException.notFound('Разговор не найден');
    await this.assertCanSee(tenantId, user, conv);
    return this.view(tenantId, conv);
  }

  private async view(tenantId: string, conv: ConversationRow) {
    const [messages, participants, context] = await Promise.all([
      this.repo.messages(String(conv.id)),
      this.repo.participants(String(conv.id)),
      this.repo.context(String(conv.id)),
    ]);
    return {
      id: String(conv.id),
      subject: conv.subject,
      status: conv.status,
      statusText: humanStatus(conv.status),
      priority: conv.priority,
      agentId: conv.assigned_agent_id ? String(conv.assigned_agent_id) : null,
      userId: String(conv.user_id),
      createdAt: conv.created_at,
      firstResponseAt: conv.first_response_at,
      resolvedAt: conv.resolved_at,
      closedAt: conv.closed_at,
      csat: conv.csat_score,
      reopens: conv.reopens,
      participants,
      context: context ?? null,
      messages: messages.map((m) => ({
        id: String(m.id),
        kind: m.author_kind,
        authorId: m.author_id ? String(m.author_id) : null,
        authorName: m.author_kind === 'ai' ? 'AnthillBot' : m.author_name,
        body: m.body,
        fileId: m.file_id ? String(m.file_id) : null,
        fileName: m.file_name,
        contentType: m.content_type,
        sizeBytes: m.size_bytes ? Number(m.size_bytes) : null,
        createdAt: m.created_at,
      })),
    };
  }

  // ── обращение ──
  /**
   * Написать в поддержку.
   *
   * Разговор заводится сам при первом сообщении: анкеты, темы обращения и выбора
   * категории здесь нет намеренно (разд. 2.2) — человек просто пишет, что случилось.
   */
  async send(
    tenantId: string, user: { userId: string; role: string },
    text: string, ctx?: ContextInput | null, fileId?: string | null,
  ) {
    const body = String(text ?? '').trim();
    if (!body && !fileId) throw AppException.validation('Напишите, что случилось');

    let conv = await this.repo.activeOf(tenantId, user.userId);
    const fresh = !conv;
    if (!conv) {
      conv = (await this.repo.create(tenantId, user.userId, body || 'Вложение'))!;
      await this.repo.addParticipant(String(conv.id), user.userId, 'user');
    }
    if (ctx) await this.repo.saveContext(String(conv.id), ctx);

    const msg = await this.repo.addMessage({
      tenantId, conversationId: String(conv.id), authorId: user.userId, kind: 'user', body, fileId,
    });
    this.emit(tenantId, conv, 'support.message.created', { conversationId: String(conv.id), messageId: String(msg?.id) });

    /*
      Просьба о человеке слышна сразу.

      «Позови специалиста», «не помогло», «хочу инженера» — это не вопрос к ИИ, а
      просьба передать разговор. Заставлять человека искать глазами кнопку в такой
      момент — ровно то, на что жалуются во всех поддержках (разд. 9).
    */
    if (wantsHuman(body)) {
      await this.callHuman(tenantId, user, String(conv.id));
      return this.conversation(tenantId, user, String(conv.id));
    }

    // Пока специалист не подключился, отвечает помощник — он и есть первая линия.
    if (!conv.assigned_agent_id) {
      if (fresh) await this.repo.setStatus(tenantId, String(conv.id), 'ai');
      void this.answerByAi(tenantId, user, String(conv.id), body, ctx ?? null);
    } else if (conv.status === 'waiting_user') {
      // человек ответил на «проверьте, пожалуйста» — разговор снова в работе
      await this.repo.setStatus(tenantId, String(conv.id), 'in_progress');
    }
    return this.conversation(tenantId, user, String(conv.id));
  }

  /**
   * Ответ первой линии — AnthillBot.
   *
   * Работает тем же агентом, что и в остальной системе: он умеет искать по задачам,
   * переписке и базе знаний и отвечать со ссылками на источники. Отдельного
   * «бота поддержки» не заводим — это была бы вторая голова с другими знаниями.
   *
   * Ответ пишем в разговор как сообщение помощника. Ошибка ИИ не должна выглядеть
   * тишиной: тогда зовём человека, а не оставляем обращение без ответа.
   */
  private async answerByAi(
    tenantId: string, user: { userId: string; role: string }, conversationId: string,
    question: string, ctx: ContextInput | null,
  ) {
    try {
      const conv = await this.repo.byId(tenantId, conversationId);
      if (!conv) return;
      let sessionId = conv.ai_session_id ? String(conv.ai_session_id) : '';
      if (!sessionId) {
        const s = await this.agentRepo.createSession(tenantId, user.userId, null);
        sessionId = String(s.id);
        await this.repo.setAiSession(conversationId, sessionId);
      }
      const where = ctx?.route || ctx?.url ? `\n\nЧеловек сейчас на экране: ${ctx?.route ?? ctx?.url}.` : '';
      const err = ctx?.lastError ? `\nПоследняя ошибка на экране: ${ctx.lastError}.` : '';
      let text = '';
      await this.agent.ask(
        tenantId, user, sessionId,
        `Ты — первая линия службы заботы TeamCRM. Ответь коротко и по делу, предложи конкретное '
        + 'действие. Если не знаешь или нужна правка в системе — так и скажи и предложи позвать '
        + 'специалиста.\n\nВопрос: ${question}${where}${err}`,
        null,
        (e) => { if (e.type === 'delta') text += e.text; },
        () => false,
      );
      const answer = text.trim();
      if (!answer) throw new Error('пустой ответ');
      const msg = await this.repo.addMessage({
        tenantId, conversationId, authorId: null, kind: 'ai', body: answer,
      });
      const after = await this.repo.byId(tenantId, conversationId);
      if (after) this.emit(tenantId, after, 'support.message.created', { conversationId, messageId: String(msg?.id) });
    } catch (e) {
      this.log.warn(`ИИ не ответил в разговоре ${conversationId}: ${(e as Error).message}`);
      await this.repo.addMessage({
        tenantId, conversationId, authorId: null, kind: 'system',
        body: 'Помощник сейчас не отвечает — зову специалиста.',
      });
      await this.callHuman(tenantId, user, conversationId).catch(() => undefined);
    }
  }

  /**
   * «Позвать человека» (разд. 8, 9).
   *
   * Никакой повторной анкеты: специалист получает разговор целиком — переписку,
   * контекст, что уже пробовал помощник.
   */
  async callHuman(tenantId: string, user: { userId: string; role: string }, id: string) {
    const conv = await this.repo.byId(tenantId, id);
    if (!conv) throw AppException.notFound('Разговор не найден');
    await this.assertCanSee(tenantId, user, conv);
    if (conv.assigned_agent_id) return this.view(tenantId, conv);

    const next = (await this.repo.setStatus(tenantId, id, 'waiting_agent'))!;
    await this.repo.addMessage({
      tenantId, conversationId: id, authorId: null, kind: 'system',
      body: 'Зовём специалиста — он подключится к этому разговору.',
    });
    // Дежурным — сразу, событием: очередь должна оживать без перезагрузки страницы.
    const team = await this.deskTeam(tenantId);
    this.realtime.emitToUsers(tenantId, team, 'support.queue.changed', { conversationId: id });
    this.emit(tenantId, next, 'support.status.changed', { conversationId: id, status: next.status });
    return this.view(tenantId, next);
  }

  // ── сторона специалиста ──
  /** Очередь дежурного: кто ждёт, с чем и сколько уже. */
  async queue(tenantId: string, user: { userId: string; role: string }) {
    await this.assertAgent(tenantId, user);
    const rows = await this.repo.queue(tenantId);
    return rows.map((c) => ({
      id: String(c.id),
      subject: c.subject,
      status: c.status,
      statusText: humanStatus(c.status),
      userName: c.user_name,
      agentName: c.agent_name,
      waitingSince: c.created_at,
      lastAt: c.last_at,
      priority: c.priority,
    }));
  }

  /** Специалист берёт разговор: человек сразу видит, кто ему отвечает. */
  async join(tenantId: string, user: { userId: string; role: string }, id: string) {
    await this.assertAgent(tenantId, user);
    const conv = await this.repo.byId(tenantId, id);
    if (!conv) throw AppException.notFound('Разговор не найден');
    const next = (await this.repo.assign(tenantId, id, user.userId))!;
    await this.repo.addParticipant(id, user.userId, 'agent');
    await this.repo.addMessage({
      tenantId, conversationId: id, authorId: user.userId, kind: 'system', body: 'подключился к разговору',
    });
    this.emit(tenantId, next, 'support.agent.joined', { conversationId: id, agentId: user.userId });
    return this.view(tenantId, next);
  }

  /** Ответ специалиста. Первый ответ фиксируем — по нему считается SLA. */
  async reply(tenantId: string, user: { userId: string; role: string }, id: string, text: string, fileId?: string | null) {
    const conv = await this.repo.byId(tenantId, id);
    if (!conv) throw AppException.notFound('Разговор не найден');
    await this.assertAgent(tenantId, user);
    const body = String(text ?? '').trim();
    if (!body && !fileId) throw AppException.validation('Пустое сообщение');

    if (!conv.assigned_agent_id) await this.repo.assign(tenantId, id, user.userId);
    await this.repo.addParticipant(id, user.userId, 'agent');
    await this.repo.markFirstResponse(tenantId, id);
    const msg = await this.repo.addMessage({
      tenantId, conversationId: id, authorId: user.userId, kind: 'agent', body, fileId,
    });
    const next = (await this.repo.setStatus(tenantId, id, 'in_progress'))!;
    this.emit(tenantId, next, 'support.message.created', { conversationId: id, messageId: String(msg?.id) });
    return this.view(tenantId, next);
  }

  /**
   * «Кажется, решено».
   *
   * Разговор НЕ закрывается: он переходит в «проверьте, пожалуйста» и ждёт слова
   * человека (разд. 21). Закрытие чужой рукой — самый обидный вид формализма.
   */
  async resolve(tenantId: string, user: { userId: string; role: string }, id: string, text?: string) {
    await this.assertAgent(tenantId, user);
    const conv = await this.repo.byId(tenantId, id);
    if (!conv) throw AppException.notFound('Разговор не найден');
    if (text?.trim()) {
      await this.repo.addMessage({
        tenantId, conversationId: id, authorId: user.userId, kind: 'agent', body: text.trim(),
      });
    }
    await this.repo.markFirstResponse(tenantId, id);
    const next = (await this.repo.resolve(tenantId, id))!;
    await this.repo.addMessage({
      tenantId, conversationId: id, authorId: null, kind: 'system',
      body: 'Проверьте, пожалуйста: всё работает?',
    });
    this.emit(tenantId, next, 'support.resolved', { conversationId: id });
    return this.view(tenantId, next);
  }

  /**
   * Слово человека: закрыть или вернуть в работу (разд. 21, 31).
   *
   * Оценку спрашиваем здесь же и только при закрытии: отдельная анкета после
   * разговора — ещё один шаг, который никто не делает.
   */
  async confirm(
    tenantId: string, user: { userId: string; role: string }, id: string,
    ok: boolean, csat?: number | null, reason?: string | null,
  ) {
    const conv = await this.repo.byId(tenantId, id);
    if (!conv) throw AppException.notFound('Разговор не найден');
    if (String(conv.user_id) !== String(user.userId)) {
      throw AppException.forbidden('Закрыть разговор может только тот, кто обратился');
    }
    if (!ok) {
      const back = (await this.repo.reopen(tenantId, id))!;
      await this.repo.addMessage({
        tenantId, conversationId: id, authorId: null, kind: 'system',
        body: 'Человек ответил, что проблема осталась — разговор снова в работе.',
      });
      const team = await this.deskTeam(tenantId);
      this.realtime.emitToUsers(tenantId, team, 'support.queue.changed', { conversationId: id });
      this.emit(tenantId, back, 'support.status.changed', { conversationId: id, status: back.status });
      return this.view(tenantId, back);
    }
    const score = csat && csat >= 1 && csat <= 4 ? csat : null;
    const next = (await this.repo.close(tenantId, id, score, reason?.slice(0, 64) ?? null))!;
    this.emit(tenantId, next, 'support.status.changed', { conversationId: id, status: 'closed' });
    return this.view(tenantId, next);
  }

  /** «Эта проблема снова появилась» (разд. 23) — со всем прошлым контекстом. */
  async reopen(tenantId: string, user: { userId: string; role: string }, id: string, text?: string) {
    const conv = await this.repo.byId(tenantId, id);
    if (!conv) throw AppException.notFound('Разговор не найден');
    if (String(conv.user_id) !== String(user.userId)) throw AppException.forbidden('Это не ваш разговор');
    const next = (await this.repo.reopen(tenantId, id))!;
    await this.repo.addMessage({
      tenantId, conversationId: id, authorId: user.userId, kind: 'user',
      body: text?.trim() || 'Эта проблема снова появилась.',
    });
    const team = await this.deskTeam(tenantId);
    this.realtime.emitToUsers(tenantId, team, 'support.queue.changed', { conversationId: id });
    this.emit(tenantId, next, 'support.status.changed', { conversationId: id, status: next.status });
    return this.view(tenantId, next);
  }

  /** Снимок экрана или файл к обращению: их и присылают вместо тысячи слов. */
  async attach(
    tenantId: string, user: { userId: string; role: string },
    file: { buffer: Buffer; originalname: string; mimetype: string }, text: string,
  ) {
    const uploaded = await this.files.upload({
      tenantId, userId: user.userId, buffer: file.buffer, fileName: file.originalname,
      contentType: file.mimetype, ownerKind: 'support',
    });
    const conv = await this.repo.activeOf(tenantId, user.userId);
    if (conv && String(conv.assigned_agent_id ?? '') && String(conv.user_id) !== String(user.userId)) {
      return this.reply(tenantId, user, String(conv.id), text, String(uploaded.id));
    }
    return this.send(tenantId, user, text, null, String(uploaded.id));
  }

  // ── MVP 2: инженер, баг, созвон, метрики ──
  /**
   * Подключить инженера к разговору (разд. 11, 12).
   *
   * Инженер приходит в ТОТ ЖЕ разговор и видит его целиком — переписку, контекст, что
   * уже проверил специалист. Ради этого модуль и строился: человеку не приходится
   * объяснять свою проблему второй раз новому человеку (разд. 2.4).
   */
  async addEngineer(tenantId: string, user: { userId: string; role: string }, id: string, engineerId: string) {
    await this.assertAgent(tenantId, user);
    const conv = await this.repo.byId(tenantId, id);
    if (!conv) throw AppException.notFound('Разговор не найден');
    const who = await this.repo.userName(tenantId, engineerId);
    if (!who) throw AppException.notFound('Такого сотрудника нет');
    // Звать в разговор его же автора незачем: он и так здесь, и он здесь главный.
    if (String(conv.user_id) === String(engineerId)) {
      throw AppException.validation('Этот человек и есть автор обращения');
    }

    await this.repo.addParticipant(id, engineerId, 'engineer');
    await this.repo.addMessage({
      tenantId, conversationId: id, authorId: user.userId, kind: 'system',
      body: `добавил в разговор: ${who} — инженер видит всю переписку и контекст`,
    });
    this.realtime.emitToUsers(tenantId, [engineerId], 'support.agent.joined', { conversationId: id });
    const next = (await this.repo.byId(tenantId, id))!;
    this.emit(tenantId, next, 'support.agent.joined', { conversationId: id, agentId: engineerId });
    return this.view(tenantId, next);
  }

  /**
   * Завести баг из разговора (разд. 24).
   *
   * В задачу уезжает всё, что нужно разработчику и что у нас уже собрано: что
   * случилось, где, в каком браузере и сборке, последняя ошибка и ссылка на сам
   * разговор. Переписывать это руками — ровно та работа, ради отмены которой
   * поддержка и собирает контекст.
   */
  async createBug(tenantId: string, user: { userId: string; role: string }, id: string, title?: string) {
    await this.assertAgent(tenantId, user);
    const conv = await this.repo.byId(tenantId, id);
    if (!conv) throw AppException.notFound('Разговор не найден');

    const [messages, ctx] = await Promise.all([
      this.repo.messages(id),
      this.repo.context(id),
    ]);
    const c = (ctx ?? {}) as Record<string, string | null>;
    const talk = messages
      .filter((m) => m.author_kind !== 'system')
      .slice(-12)
      .map((m) => `${m.author_kind === 'user' ? 'Человек' : m.author_kind === 'ai' ? 'AnthillBot' : m.author_name ?? 'Специалист'}: ${String(m.body ?? '').slice(0, 400)}`)
      .join('\n');
    const description = [
      '**Из разговора службы заботы.**',
      '',
      '**Что произошло**',
      talk || conv.subject,
      '',
      '**Где**',
      `Адрес: ${c.url ?? '—'}`,
      `Раздел: ${c.route ?? '—'}${c.entity_type ? ` · ${c.entity_type} #${c.entity_id}` : ''}`,
      `Браузер: ${c.browser ?? '—'} · ${c.os ?? '—'}`,
      `Сборка: ${c.app_version ?? '—'}${c.build_id ? ` (${c.build_id})` : ''}`,
      c.last_error ? `Последняя ошибка: ${c.last_error}` : '',
      c.request_id ? `Request ID: ${c.request_id}` : '',
      '',
      `Обращение №${id}.`,
    ].filter(Boolean).join('\n');

    // Баг живёт в проекте поддержки: он и заведён для такой работы.
    let project = await this.support.project(tenantId);
    if (!project) {
      const created = await this.projects.create(tenantId, { name: 'Поддержка' });
      await this.support.setProject(tenantId, String(created.id));
      project = { id: String(created.id), name: created.name };
    }
    const task = await this.tasks.create(tenantId, {
      projectId: String(project.id),
      title: (title?.trim() || conv.subject || 'Разобраться с обращением').slice(0, 200),
      description,
      priority: conv.priority === 'critical' ? 'urgent' : 'normal',
    } as never, user.userId);

    await this.repo.linkIssue(id, String(task.id));
    await this.repo.addMessage({
      tenantId, conversationId: id, authorId: user.userId, kind: 'system',
      body: `завёл задачу #${task.id} — «${task.title}». Сообщим, когда исправление выйдет.`,
    });
    const next = (await this.repo.byId(tenantId, id))!;
    this.emit(tenantId, next, 'support.issue.linked', { conversationId: id, taskId: String(task.id) });
    return { taskId: String(task.id), projectId: String(project.id), conversation: await this.view(tenantId, next) };
  }

  /**
   * Задача закрыта — сказать об этом тем, кто её ждал (разд. 25).
   *
   * Зовётся из закрытия задачи: человек, обратившийся неделю назад, узнаёт о
   * починке сам, а не проверяет по своей инициативе.
   */
  async notifyFixDeployed(taskId: string, taskTitle: string): Promise<void> {
    try {
      const rows = await this.repo.conversationsOfTask(taskId);
      for (const r of rows) {
        await this.repo.addMessage({
          tenantId: r.tenant_id, conversationId: r.conversation_id, authorId: null, kind: 'system',
          body: `Мы выпустили исправление по «${taskTitle}». Обновите страницу и проверьте, пожалуйста.`,
        });
        await this.repo.setStatus(r.tenant_id, r.conversation_id, 'waiting_user');
        this.realtime.emitToUsers(r.tenant_id, [r.user_id], 'support.status.changed', {
          conversationId: r.conversation_id, status: 'waiting_user',
        });
      }
    } catch (e) {
      // Весть о починке — приятная мелочь, а не причина ронять закрытие задачи.
      this.log.warn(`весть об исправлении задачи ${taskId}: ${(e as Error).message}`);
    }
  }

  /**
   * Созвон из поддержки (разд. 13).
   *
   * Комнату создаёт обычный созвон CRM — со звуком, видео, демонстрацией экрана и
   * записью. Здесь мы только помечаем, что разговор ведётся по этому обращению:
   * по этой пометке итог с расшифровкой и разбором вернётся в саму поддержку.
   */
  async startHuddle(tenantId: string, user: { userId: string; role: string }, id: string, roomId: string) {
    const conv = await this.repo.byId(tenantId, id);
    if (!conv) throw AppException.notFound('Разговор не найден');
    await this.assertCanSee(tenantId, user, conv);
    await this.repo.startHuddle(id, roomId, user.userId);
    await this.repo.addMessage({
      tenantId, conversationId: id, authorId: user.userId, kind: 'system', body: 'начал созвон',
    });
    this.emit(tenantId, conv, 'support.call.started', { conversationId: id, roomId });
    return { roomId };
  }

  /** Итог созвона — обратно в разговор: что произошло, что проверили, что дальше. */
  async huddleFinished(roomId: string, meetingId: string | null, summary: string | null): Promise<void> {
    try {
      const h = await this.repo.huddleByRoom(roomId);
      if (!h) return;
      await this.repo.finishHuddle(h.id, meetingId);
      await this.repo.addMessage({
        tenantId: h.tenant_id, conversationId: h.conversation_id, authorId: null, kind: 'system',
        body: summary?.trim()
          ? `Итог созвона:\n${summary.trim().slice(0, 4000)}`
          : 'Созвон завершён — расшифровка и разбор появятся в разделе «Встречи».',
      });
      const conv = await this.repo.byId(h.tenant_id, h.conversation_id);
      if (conv) this.emit(h.tenant_id, conv, 'support.call.ended', { conversationId: h.conversation_id });
    } catch (e) {
      this.log.warn(`итог созвона ${roomId}: ${(e as Error).message}`);
    }
  }

  /** Диагностика для специалиста (разд. 17): весь технический контекст одним местом. */
  async diagnostics(tenantId: string, user: { userId: string; role: string }, id: string) {
    await this.assertAgent(tenantId, user);
    const conv = await this.repo.byId(tenantId, id);
    if (!conv) throw AppException.notFound('Разговор не найден');
    const [ctx, issues] = await Promise.all([this.repo.context(id), this.repo.issues(id)]);
    return {
      context: ctx ?? null,
      issues: issues.map((i) => ({
        taskId: i.task_id, projectId: i.project_id, title: i.title,
        type: i.issue_type, closed: !!i.closed_at,
      })),
      sla: {
        createdAt: conv.created_at,
        firstResponseAt: conv.first_response_at,
        resolvedAt: conv.resolved_at,
        reopens: conv.reopens,
      },
    };
  }

  /** Метрики службы заботы для руководителя (разд. 30). */
  async dashboard(tenantId: string, user: { userId: string; role: string }) {
    if (user.role !== 'owner' && user.role !== 'manager') {
      throw AppException.forbidden('Сводка службы заботы — для руководства');
    }
    const d = await this.repo.dashboard(tenantId);
    const num = (v: string | null | undefined) => (v === null || v === undefined ? null : Number(v));
    return {
      total: Number(d?.total ?? 0),
      active: Number(d?.active ?? 0),
      waiting: Number(d?.waiting ?? 0),
      resolved: Number(d?.resolved ?? 0),
      firstResponseSeconds: num(d?.first_median) ? Math.round(num(d?.first_median)!) : null,
      resolutionSeconds: num(d?.resolution_median) ? Math.round(num(d?.resolution_median)!) : null,
      csatAvg: num(d?.csat_avg) ? Number(num(d?.csat_avg)!.toFixed(2)) : null,
      csatCount: Number(d?.csat_count ?? 0),
      reopened: Number(d?.reopened ?? 0),
      solvedByAi: Number(d?.ai_only ?? 0),
    };
  }

  // ── дежурные ──
  async team(tenantId: string) {
    const agents = await this.repo.agents(tenantId);
    const online = new Set(this.realtime.onlineUsers(tenantId));
    return agents.map((a) => ({
      userId: a.user_id, name: a.full_name, skills: a.skills ?? [],
      online: online.has(a.user_id), status: a.presence_status,
    }));
  }

  async setAgent(tenantId: string, user: { userId: string; role: string }, userId: string, active: boolean, skills: string[]) {
    if (user.role !== 'owner' && user.role !== 'manager') {
      throw AppException.forbidden('Дежурных назначает руководство');
    }
    await this.repo.setAgent(tenantId, userId, active, skills.slice(0, 12));
    return this.team(tenantId);
  }

  /** Кому показывать очередь: дежурные, а если их нет — владелец компании. */
  private async deskTeam(tenantId: string): Promise<string[]> {
    const agents = await this.repo.agents(tenantId);
    if (agents.length) return agents.map((a) => a.user_id);
    const owner = await this.repo.owner(tenantId);
    return owner ? [String(owner.id)] : [];
  }

  private async isAgent(tenantId: string, user: { userId: string; role: string }): Promise<boolean> {
    const team = await this.deskTeam(tenantId);
    return team.includes(String(user.userId));
  }

  private async assertAgent(tenantId: string, user: { userId: string; role: string }): Promise<void> {
    if (!(await this.isAgent(tenantId, user))) throw AppException.forbidden('Это разговор службы заботы');
  }

  /** Разговор видит тот, кто обратился, и дежурные: чужие обращения не читают. */
  private async assertCanSee(tenantId: string, user: { userId: string; role: string }, conv: ConversationRow): Promise<void> {
    if (String(conv.user_id) === String(user.userId)) return;
    await this.assertAgent(tenantId, user);
  }

  /** Событие — участникам разговора и дежурным: панель оживает без перезагрузки. */
  private emit(tenantId: string, conv: ConversationRow, event: string, payload: Record<string, unknown>): void {
    const to = [String(conv.user_id)];
    if (conv.assigned_agent_id) to.push(String(conv.assigned_agent_id));
    this.realtime.emitToUsers(tenantId, to, event, payload);
  }
}
