import { Injectable, Logger } from '@nestjs/common';
import { AppException } from '../../common/http/app-exception';
import { AnthillService } from '../anthill/anthill.service';
import { AnthillRepository } from '../anthill/anthill.repository';
import { FilesService } from '../files/files.service';
import { RealtimeService } from '../realtime/realtime.service';
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
export class SupportDeskService {
  private readonly log = new Logger('SupportDesk');

  constructor(
    private readonly repo: SupportDeskRepository,
    private readonly realtime: RealtimeService,
    private readonly files: FilesService,
    private readonly agent: AnthillService,
    private readonly agentRepo: AnthillRepository,
  ) {}

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
