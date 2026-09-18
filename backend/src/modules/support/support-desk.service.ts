import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { AppException } from '../../common/http/app-exception';
import { AnthillService } from '../anthill/anthill.service';
import { AnthillRepository } from '../anthill/anthill.repository';
import { FilesService } from '../files/files.service';
import { RealtimeService } from '../realtime/realtime.service';
import { MeetingsService } from '../meetings/meetings.service';
import { ProjectsService } from '../projects/projects.service';
import { TasksRepository } from '../tasks/tasks.repository';
import { TasksService } from '../tasks/tasks.service';
import { SupportRepository } from './support.repository';
import { ContextInput, ConversationRow, QueueFilter, SupportDeskRepository } from './support-desk.repository';
import { ForecastService } from '../forecast/forecast.service';
import { HandbookService } from '../knowledge/handbook.service';
import { PlatformService } from '../platform/platform.service';
import { AiService } from '../ai/ai.service';
import { ActionRequest, describeAction, isUndoable, validAction } from './support-actions';
import { humanStatus, wantsHuman } from './support-text';
import { MAYBE_SUFFIX, META_RULES, NO_ANSWER_PHRASE, parseAnswer } from './support-ai';
import { Candidate, pickAgent } from './support-routing';

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
 *
 * Чья это служба. ANTHILL — коробочный продукт, поэтому отвечает ВЕНДОР: обращение
 * принадлежит организации обратившегося, а работают с ним люди техотдела платформы
 * (см. PlatformService). Клиент не настраивает нашу поддержку и не видит её кухню —
 * ни очереди, ни дежурных, ни известных проблем, ни сводки. Пока платформа не
 * назначена, работает прежний порядок: обращения принимает владелец организации —
 * выкладка не должна оставить людей без поддержки из-за незаполненной настройки.
 */
/**
 * На сколько инженеру открывается обращение.
 *
 * Двое суток: эскалация редко решается за час и почти никогда не живёт дольше двух
 * дней. Нужно ещё — специалист зовёт инженера повторно, и это осознанное действие, а
 * не молчаливое продление бессрочного пропуска.
 */
const GRANT_HOURS = 48;

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
    private readonly forecast: ForecastService,
    private readonly tasksRepo: TasksRepository,
    private readonly handbook: HandbookService,
    private readonly platform: PlatformService,
    private readonly ai: AiService,
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

  /**
   * В какой организации работать с этим разговором.
   *
   * Обращение принадлежит организации ОБРАТИВШЕГОСЯ, а отвечает на него техотдел
   * вендора — люди из другой организации. Поэтому рабочую организацию берём у самого
   * разговора, но только для техотдела: всем остальным отдаём их собственную, и чужой
   * разговор для них просто не существует (запрос вернёт «не найдено»).
   *
   * Зовётся контроллером перед каждой ручкой с номером разговора — одним местом
   * вместо проверки, размазанной по двум десяткам методов.
   */
  async deskTenant(user: { userId: string; tenantId: string }, id: string): Promise<string> {
    const role = await this.platform.roleOf(user.userId);
    if (!role) return user.tenantId;
    // Инженеру чужой разговор открывается только с живым доступом; без него обращение
    // для него не существует — запрос уйдёт в его организацию и вернёт «не найдено».
    if (role === 'engineer' && !(await this.repo.hasLiveGrant(id, user.userId))) return user.tenantId;
    const conv = await this.repo.byIdAny(id);
    return conv ? String(conv.tenant_id) : user.tenantId;
  }

  // ── что показать в панели ──
  /**
   * Состояние службы заботы для человека: живой разговор, история и кто сейчас дежурит.
   *
   * Время ответа честное: медиана за две недели. Нет данных — не выдумываем цифру,
   * панель скажет «ищем свободного специалиста» (разд. 6).
   */
  async desk(tenantId: string, user: { userId: string; role: string }) {
    const platform = await this.platform.tenantId();
    const [active, mine, people, eta, incident] = await Promise.all([
      this.repo.activeOf(tenantId, user.userId),
      this.repo.mine(tenantId, user.userId),
      this.deskPeople(tenantId),
      // Время ответа — по всей службе: она одна на всех клиентов, а не своя у каждого.
      this.repo.medianFirstResponse(platform ? null : tenantId),
      this.repo.openIncident(platform ?? tenantId),
    ]);
    // «На связи» считается в организации самого человека: комнаты присутствия свои у каждой.
    const online = new Set<string>();
    for (const t of new Set(people.map((p) => p.tenantId))) {
      for (const id of this.realtime.onlineUsers(t)) online.add(`${t}:${id}`);
    }
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
      team: people.map((p) => ({
        userId: p.userId,
        name: p.name,
        online: online.has(`${p.tenantId}:${p.userId}`),
        status: p.status,
        skills: p.skills,
      })),
      /** Секунды до первого ответа или null — «обещать нечего». */
      etaSeconds: eta,
      /*
        Открытый сбой виден каждому, кто откроет панель (разд. 43).

        Человек, у которого «всё сломалось», должен узнать об этом раньше, чем
        напишет: иначе двадцать человек по очереди объясняют одну и ту же аварию.
      */
      incident: incident ? { id: incident.id, title: incident.title, message: incident.message } : null,
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
    const [messages, participants, context, actions] = await Promise.all([
      this.repo.messages(String(conv.id)),
      this.repo.participants(String(conv.id)),
      this.repo.context(String(conv.id)),
      this.repo.actions(String(conv.id)),
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
      /** Первый ответ ЧЕЛОВЕКА; ответ помощника — рядом и отдельно. */
      firstResponseAt: conv.human_first_response_at,
      aiFirstResponseAt: conv.ai_first_response_at,
      /** `agent` — отвечает помощник, `copilot` — молчит и работает на специалиста. */
      aiMode: conv.ai_mode,
      intent: conv.intent,
      requiredSkill: conv.required_skill,
      aiSummary: conv.ai_summary,
      /** Записку видит только тот, кто работает в разговоре: клиенту она не уходит. */
      handoffNote: conv.handoff_note,
      resolvedAt: conv.resolved_at,
      closedAt: conv.closed_at,
      csat: conv.csat_score,
      reopens: conv.reopens,
      participants,
      context: context ?? null,
      /** Предложенные действия: их человек и разрешает (разд. 38). */
      actions: actions.map((a) => ({
        id: a.id, action: a.action, preview: a.preview, status: a.status,
        approved: a.approved_by_user, createdAt: a.created_at,
      })),
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
      // Справочник должен быть на месте к первому же вопросу новой компании.
      void this.handbook.ensure(tenantId);
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

    /*
      Известная поломка узнаётся в первую же минуту (разд. 42).

      Если мы о ней уже знаем и чиним — человеку не нужно ни доказывать её, ни ждать
      специалиста: он сразу получает честный ответ и номер задачи.
    */
    if (!conv.assigned_agent_id) {
      const known = await this.matchKnownIssue(tenantId, body, (ctx as ContextInput | null)?.lastError);
      if (known) {
        await this.repo.addMessage({
          tenantId, conversationId: String(conv.id), authorId: null, kind: 'system',
          body: `Похоже на известную проблему: «${known.title}» (задача #${known.task_id}). `
            + 'Исправление уже готовится — сообщим, когда выйдет. Если у вас что-то другое, напишите, позовём специалиста.',
        });
        return this.conversation(tenantId, user, String(conv.id));
      }
    }

    /*
      Помощник отвечает, только пока он СОБЕСЕДНИК (02_ANTHILLBOT §7).

      Раньше условием было «специалист ещё не назначен» — и пока обращение ждало в
      очереди, помощник продолжал говорить поверх уже позванного человека. Теперь режим
      живёт в самом разговоре: попросили специалиста — помощник замолчал, даже если тот
      ещё не взял разговор.
    */
    if (conv.ai_mode === 'agent' && !conv.assigned_agent_id) {
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
        /*
          Вопрос идёт ПЕРВЫМ, указания — после и коротко.

          Сначала здесь была стена инструкций, а вопрос человека прятался в её конце.
          Планировщик читал это как разговор без данных, не звал ни одного инструмента,
          и человек получал «не нашёл подтверждения» на простое «как ставятся задачи».
          Модель отвечает на то, что видит первым, — значит, первым должен идти вопрос.
        */
        `${question}\n\n`
        + `(Это вопрос в службу заботы ANTHILL. Отвечай коротко и по делу: что нажать и где `
        + `это находится. Про устройство системы отвечай по справочнику ANTHILL из базы знаний `
        + `и называй раздел, откуда взят ответ. Если ответа там нет или нужна правка в системе — `
        + `скажи прямо и предложи позвать специалиста.${where}${err})\n\n${META_RULES}`,
        null,
        (e) => { if (e.type === 'delta') text += e.text; },
        () => false,
      );
      const verdict = parseAnswer(text);
      if (!verdict.text) throw new Error('пустой ответ');
      // Что помощник понял — в само обращение: по этому его потом маршрутизировать.
      await this.repo.saveAiVerdict(tenantId, conversationId, {
        confidence: verdict.confidence, intent: verdict.intent, skill: verdict.skill,
        priority: verdict.priority, summary: verdict.summary,
      });

      /*
        Низкая уверенность — не повод придумывать (02_ANTHILLBOT §5).

        Догадка с оговорками выглядит как ответ, и человек уходит её проверять вместо
        того, чтобы получить помощь. Честнее сказать прямо и позвать специалиста.
      */
      if (verdict.confidence === 'low') {
        await this.repo.addMessage({
          tenantId, conversationId, authorId: null, kind: 'ai', body: NO_ANSWER_PHRASE,
        });
        await this.repo.markAiResponse(tenantId, conversationId);
        await this.callHuman(tenantId, user, conversationId, 'low_confidence');
        return;
      }

      const answer = verdict.confidence === 'medium' ? verdict.text + MAYBE_SUFFIX : verdict.text;
      const msg = await this.repo.addMessage({
        tenantId, conversationId, authorId: null, kind: 'ai', body: answer,
      });
      await this.repo.markAiResponse(tenantId, conversationId);
      const after = await this.repo.byId(tenantId, conversationId);
      if (after) this.emit(tenantId, after, 'support.message.created', { conversationId, messageId: String(msg?.id) });
    } catch (e) {
      this.log.warn(`ИИ не ответил в разговоре ${conversationId}: ${(e as Error).message}`);
      await this.repo.addMessage({
        tenantId, conversationId, authorId: null, kind: 'system',
        body: 'Помощник сейчас не отвечает — зову специалиста.',
      });
      await this.callHuman(tenantId, user, conversationId, 'ai_error').catch(() => undefined);
    }
  }

  /**
   * «Позвать человека» (разд. 8, 9).
   *
   * Никакой повторной анкеты: специалист получает разговор целиком — переписку,
   * контекст, что уже пробовал помощник.
   */
  async callHuman(
    tenantId: string, user: { userId: string; role: string }, id: string,
    reason: 'requested' | 'low_confidence' | 'ai_error' = 'requested',
  ) {
    const conv = await this.repo.byId(tenantId, id);
    if (!conv) throw AppException.notFound('Разговор не найден');
    await this.assertCanSee(tenantId, user, conv);
    if (conv.assigned_agent_id) return this.view(tenantId, conv);

    /*
      С этой минуты помощник — копилот, а не собеседник.

      Человека уже позвали: ещё один ответ бота поверх этого читается как «тебя не
      услышали». Дальше он работает на специалиста и молчит, пока его не вернут явно.
    */
    await this.repo.setAiMode(tenantId, id, 'copilot', reason);
    void this.writeHandoffNote(tenantId, id, reason);
    await this.repo.markQueued(tenantId, id, reason === 'requested');
    const next = (await this.repo.setStatus(tenantId, id, 'waiting_agent'))!;
    await this.repo.addMessage({
      tenantId, conversationId: id, authorId: null, kind: 'system',
      body: 'Зовём специалиста — он подключится к этому разговору.',
    });
    // Дежурным — сразу, событием: очередь должна оживать без перезагрузки страницы.
    await this.notifyDesk(tenantId, 'support.queue.changed', { conversationId: id });
    this.emit(tenantId, next, 'support.status.changed', { conversationId: id, status: next.status });
    /*
      Ищем исполнителя сразу.

      Обращение, лежащее в очереди «пока кто-нибудь заметит», — и есть та поддержка, от
      которой уходят. Выбор делается по навыку и загрузке; не нашли — разговор остаётся
      видимым в очереди, и его возьмут руками.
    */
    await this.route(tenantId, next);
    return this.view(tenantId, (await this.repo.byId(tenantId, id))!);
  }

  /**
   * Записка специалисту: что уже было до него.
   *
   * Иначе первый вопрос живого человека — «расскажите, что случилось», хотя человек
   * уже всё рассказал боту. Готовим в стороне от ответа: обращение должно встать в
   * очередь немедленно, а не ждать модель (02_ANTHILLBOT §14).
   */
  private async writeHandoffNote(
    tenantId: string, id: string, reason: string,
  ): Promise<void> {
    try {
      const messages = await this.repo.messages(id);
      const talk = messages
        .filter((m) => m.author_kind === 'user' || m.author_kind === 'ai')
        .slice(-12)
        .map((m) => `${m.author_kind === 'user' ? 'Человек' : 'Помощник'}: ${String(m.body ?? '').slice(0, 400)}`)
        .join('\n');
      if (!talk.trim()) return;
      const why = reason === 'low_confidence' ? 'помощник не был уверен в ответе'
        : reason === 'ai_error' ? 'помощник не смог ответить'
          : 'человек попросил специалиста';
      const note = await this.ai.generate(
        tenantId,
        'Ты готовишь записку специалисту поддержки перед тем, как он вступит в разговор. '
        + 'Три коротких пункта по-русски, без вступлений и без выдумок: '
        + '«Суть», «Что уже предложил помощник», «Что человек уже пробовал». '
        + 'Если чего-то в переписке не было — так и напиши «не пробовали». Максимум 60 слов.',
        `Причина передачи: ${why}.\n\nПереписка:\n${talk}`,
        'support_handoff',
      );
      if (note?.trim()) await this.repo.saveHandoffNote(tenantId, id, note.trim());
    } catch (e) {
      // Записка — удобство, а не условие передачи: без неё специалист прочитает переписку.
      this.log.warn(`записка о передаче ${id}: ${(e as Error).message}`);
    }
  }

  /**
   * Вернуть помощника в разговор.
   *
   * Только явным решением специалиста (02_ANTHILLBOT §9): после подключения человека
   * бот по умолчанию остаётся копилотом, и «сам вернулся» — худшее, что он может
   * сделать посреди живого разговора.
   */
  async returnAi(tenantId: string, user: { userId: string; role: string }, id: string) {
    await this.assertCanWork(tenantId, user, id);
    const conv = await this.repo.byId(tenantId, id);
    if (!conv) throw AppException.notFound('Разговор не найден');
    await this.repo.setAiMode(tenantId, id, 'agent');
    await this.repo.addMessage({
      tenantId, conversationId: id, authorId: user.userId, kind: 'system',
      body: 'вернул помощника в разговор — дальше отвечает он',
    });
    return this.view(tenantId, (await this.repo.byId(tenantId, id))!);
  }

  /**
   * Назначить обращение самому подходящему дежурному.
   *
   * Зовётся, когда обращение встаёт в очередь. Выбор — чистой функцией (support-routing),
   * здесь только сбор данных и запись решения. Никого не нашли — обращение остаётся в
   * очереди: молча повесить его на перегруженного хуже, чем оставить видимым.
   *
   * Ошибка маршрутизатора не должна ломать эскалацию: человек позвал специалиста, и это
   * должно случиться, даже если выбрать исполнителя не удалось.
   */
  private async route(tenantId: string, conv: ConversationRow): Promise<void> {
    try {
      if (conv.assigned_agent_id) return;
      const people = await this.deskPeople(tenantId);
      if (!people.length) return;

      const [loads, previousAgentId, tenantAgentIds, staff] = await Promise.all([
        this.repo.loadByAgent(),
        this.repo.previousAgent(String(conv.user_id), String(conv.id)),
        this.repo.agentsOfTenant(String(conv.tenant_id)),
        this.platform.onDuty(),
      ]);
      const load = new Map(loads.map((l) => [String(l.agent_id), Number(l.n)]));
      const limits = new Map(staff.map((x) => [String(x.user_id), Number(x.max_conversations ?? 5)]));
      const online = new Set<string>();
      for (const t of new Set(people.map((p) => p.tenantId))) {
        for (const id of this.realtime.onlineUsers(t)) online.add(id);
      }

      const candidates: Candidate[] = people.map((p) => ({
        userId: p.userId,
        skills: p.skills ?? [],
        onDuty: true, // deskPeople отдаёт только дежурящих
        online: online.has(p.userId),
        load: load.get(p.userId) ?? 0,
        maxLoad: limits.get(p.userId) ?? 5,
      }));

      const decision = pickAgent(
        { requiredSkill: conv.required_skill, previousAgentId, tenantAgentIds },
        candidates,
      );
      await this.repo.logRouting({
        conversationId: String(conv.id), agentId: decision.agentId, reason: decision.reason,
        skill: conv.required_skill, candidates: decision.considered,
      });
      if (!decision.agentId) return;

      const next = await this.repo.assignIfFree(tenantId, String(conv.id), decision.agentId, decision.reason);
      if (!next) return; // кто-то успел взять руками — так и надо
      await this.repo.addParticipant(String(conv.id), decision.agentId, 'agent');
      await this.repo.logAssignment(String(conv.id), decision.agentId, decision.reason, null);
      const who = await this.repo.userNameAny(decision.agentId);
      await this.repo.addMessage({
        tenantId, conversationId: String(conv.id), authorId: null, kind: 'system',
        body: `Разговор ведёт ${who ?? 'специалист'} — подключится сейчас.`,
      });
      const home = await this.platform.tenantId();
      this.realtime.emitToUsers(home ?? tenantId, [decision.agentId], 'support.assignment.created', {
        conversationId: String(conv.id),
      });
      this.emit(tenantId, next, 'support.agent.joined', {
        conversationId: String(conv.id), agentId: decision.agentId,
      });
    } catch (e) {
      // Человек позвал специалиста — это должно случиться, даже если выбрать некого.
      this.log.warn(`маршрутизация обращения ${conv.id}: ${(e as Error).message}`);
    }
  }

  /**
   * Назначить руками.
   *
   * Маршрутизатор ошибается, и человек обязан иметь возможность его поправить. Себе
   * разговор берёт любой дежурный, на другого — только руководство: перекидывать чужую
   * работу через всю службу не должен тот, кто просто мимо проходил.
   */
  async assign(tenantId: string, user: { userId: string; role: string }, id: string, agentId?: string | null) {
    await this.assertAgent(tenantId, user);
    const conv = await this.repo.byId(tenantId, id);
    if (!conv) throw AppException.notFound('Разговор не найден');
    const target = String(agentId ?? user.userId);
    if (target !== String(user.userId)) await this.assertManage(tenantId, user);
    if (await this.platform.tenantId()) {
      if (!(await this.platform.canDesk(target))) {
        throw AppException.validation('Назначать можно только на дежурного первой линии');
      }
    }

    if (conv.assigned_agent_id && String(conv.assigned_agent_id) !== target) {
      await this.repo.unassign(tenantId, id);
    }
    const next = await this.repo.assignIfFree(tenantId, id, target, 'вручную');
    if (!next) return this.view(tenantId, (await this.repo.byId(tenantId, id))!);
    await this.repo.addParticipant(id, target, 'agent');
    await this.repo.logAssignment(id, target, 'вручную', user.userId);
    const who = await this.repo.userNameAny(target);
    await this.repo.addMessage({
      tenantId, conversationId: id, authorId: null, kind: 'system',
      body: `Разговор ведёт ${who ?? 'специалист'}.`,
    });
    await this.notifyDesk(tenantId, 'support.assignment.changed', { conversationId: id });
    this.emit(tenantId, next, 'support.agent.joined', { conversationId: id, agentId: target });
    return this.view(tenantId, next);
  }

  /** Снять с себя: обращение возвращается в очередь и может уйти другому. */
  async unassign(tenantId: string, user: { userId: string; role: string }, id: string) {
    await this.assertAgent(tenantId, user);
    const conv = await this.repo.byId(tenantId, id);
    if (!conv) throw AppException.notFound('Разговор не найден');
    if (String(conv.assigned_agent_id ?? '') !== String(user.userId)) {
      await this.assertManage(tenantId, user);
    }
    const next = (await this.repo.unassign(tenantId, id))!;
    await this.repo.logAssignment(id, null, 'снят', user.userId);
    await this.repo.addMessage({
      tenantId, conversationId: id, authorId: null, kind: 'system',
      body: 'Ищем другого специалиста — разговор вернулся в очередь.',
    });
    await this.notifyDesk(tenantId, 'support.queue.changed', { conversationId: id });
    // Вернулось в очередь — сразу пробуем найти кому: ждать человека незачем.
    void this.route(tenantId, next);
    return this.view(tenantId, next);
  }

  // ── сторона специалиста ──
  /**
   * Очередь дежурного: кто ждёт, с чем и сколько уже.
   *
   * У техотдела она одна на всех клиентов — потому рядом с именем человека стоит
   * название его организации: без него специалист не понимает, у кого сломалось.
   */
  async queue(tenantId: string, user: { userId: string; role: string }, filter: QueueFilter = {}) {
    await this.assertAgent(tenantId, user);
    const platform = await this.platform.tenantId();
    // «Только мои» разбирается здесь: номер человека знает сервис, а не запрос из браузера.
    const f: QueueFilter = { ...filter, assignedTo: filter.assignedTo === 'me' ? user.userId : null };
    const rows = await this.repo.queue(platform ? null : tenantId, f);
    return rows.map((c) => ({
      id: String(c.id),
      subject: c.subject,
      status: c.status,
      statusText: humanStatus(c.status),
      userName: c.user_name,
      orgName: c.tenant_name,
      /** Что помощник понял: по этому обращение маршрутизируют и по нему же его узнают. */
      requiredSkill: c.required_skill,
      aiSummary: c.ai_summary,
      agentName: c.agent_name,
      agentId: c.assigned_agent_id ? String(c.assigned_agent_id) : null,
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
    await this.repo.setAiMode(tenantId, id, 'copilot');
    const next = (await this.repo.assign(tenantId, id, user.userId))!;
    await this.repo.addParticipant(id, user.userId, 'agent');
    await this.repo.logAssignment(id, user.userId, 'взял себе', user.userId);
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
    // Инженер отвечает только там, куда его позвали; дежурный — в любом разговоре.
    await this.assertCanWork(tenantId, user, id);
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
      await this.repo.bumpEscalation(tenantId, id);
      const back = (await this.repo.reopen(tenantId, id))!;
      await this.repo.addMessage({
        tenantId, conversationId: id, authorId: null, kind: 'system',
        body: 'Человек ответил, что проблема осталась — разговор снова в работе.',
      });
      await this.notifyDesk(tenantId, 'support.queue.changed', { conversationId: id });
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
    await this.repo.bumpEscalation(tenantId, id);
    const next = (await this.repo.reopen(tenantId, id))!;
    await this.repo.addMessage({
      tenantId, conversationId: id, authorId: user.userId, kind: 'user',
      body: text?.trim() || 'Эта проблема снова появилась.',
    });
    await this.notifyDesk(tenantId, 'support.queue.changed', { conversationId: id });
    this.emit(tenantId, next, 'support.status.changed', { conversationId: id, status: next.status });
    return this.view(tenantId, next);
  }

  /** Снимок экрана или файл к обращению: их и присылают вместо тысячи слов. */
  async attach(
    tenantId: string, user: { userId: string; role: string },
    file: { buffer: Buffer; originalname: string; mimetype: string }, text: string,
    conversationId?: string | null,
  ) {
    /*
      Специалист отвечает файлом в чужую организацию.

      Файл кладём ТУДА, где живёт разговор: иначе человек его не откроет — файлы
      читаются в своей организации, а отдаёт их ручка поддержки по разговору.
    */
    if (conversationId) {
      const conv = await this.repo.byIdAny(conversationId);
      if (!conv) throw AppException.notFound('Разговор не найден');
      if (String(conv.user_id) !== String(user.userId)) {
        await this.assertAgent(String(conv.tenant_id), user);
        const asAgent = await this.files.upload({
          tenantId: String(conv.tenant_id), userId: user.userId, buffer: file.buffer,
          fileName: file.originalname, contentType: file.mimetype, ownerKind: 'support',
        });
        return this.reply(String(conv.tenant_id), user, String(conv.id), text, String(asAgent.id));
      }
    }
    const uploaded = await this.files.upload({
      tenantId, userId: user.userId, buffer: file.buffer, fileName: file.originalname,
      contentType: file.mimetype, ownerKind: 'support',
    });
    return this.send(tenantId, user, text, null, String(uploaded.id));
  }

  /**
   * Файл из разговора.
   *
   * Снимок экрана лежит в организации ОБРАЩЕНИЯ, а открыть его должен и специалист
   * вендора, и сам человек. Обычная ручка файлов смотрит только в свою организацию,
   * поэтому у поддержки своя: право проверяем по разговору, а файл отдаём из той
   * организации, где он лежит. Чужой файл так не достать — он должен быть приложен
   * к сообщению именно этого разговора.
   */
  async fileOf(user: { userId: string; role: string }, id: string, fileId: string) {
    const conv = await this.repo.byIdAny(id);
    if (!conv) throw AppException.notFound('Разговор не найден');
    await this.assertCanSee(String(conv.tenant_id), user, conv);
    if (!(await this.repo.hasFile(id, fileId))) throw AppException.notFound('Файл не найден');
    return this.files.getForDownload(String(conv.tenant_id), fileId);
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
    // Инженер приходит из техотдела вендора — он в другой организации, чем обращение.
    if (await this.platform.tenantId()) {
      const role = await this.platform.roleOf(engineerId);
      if (!role) throw AppException.validation('В разговор зовём только людей техотдела');
    }
    const who = await this.repo.userNameAny(engineerId);
    if (!who) throw AppException.notFound('Такого сотрудника нет');
    // Звать в разговор его же автора незачем: он и так здесь, и он здесь главный.
    if (String(conv.user_id) === String(engineerId)) {
      throw AppException.validation('Этот человек и есть автор обращения');
    }

    /*
      Доступ выдаётся на срок, а не навсегда (03_RBAC §5).

      Инженера зовут починить конкретную поломку. Право читать чужую переписку,
      выданное «на всякий случай» и бессрочно, — ровно то, чего коммерческая поддержка
      себе позволить не может. Участником разговора он останется и после: он тут писал,
      это история; читать обращение позволяет только живой доступ.
    */
    const grant = await this.repo.grantEngineer(id, engineerId, user.userId, GRANT_HOURS);
    await this.repo.addParticipant(id, engineerId, 'engineer');
    await this.repo.addMessage({
      tenantId, conversationId: id, authorId: user.userId, kind: 'system',
      body: `добавил в разговор: ${who} — инженер видит переписку и контекст этого обращения`,
    });
    this.log.log(`инженер ${engineerId} допущен к обращению ${id} до ${grant?.expires_at?.toISOString?.() ?? '—'}`);
    const home = await this.platform.tenantId();
    this.realtime.emitToUsers(home ?? tenantId, [engineerId], 'support.agent.joined', { conversationId: id });
    const next = (await this.repo.byId(tenantId, id))!;
    this.emit(tenantId, next, 'support.agent.joined', { conversationId: id, agentId: engineerId });
    return this.view(tenantId, next);
  }

  /**
   * Отозвать доступ инженера.
   *
   * Эскалация кончилась — кончается и право читать обращение. Из участников разговора
   * его не убираем: переписка должна остаться читаемой как она была.
   */
  async revokeEngineer(tenantId: string, user: { userId: string; role: string }, id: string, engineerId: string) {
    await this.assertAgent(tenantId, user);
    const conv = await this.repo.byId(tenantId, id);
    if (!conv) throw AppException.notFound('Разговор не найден');
    const n = await this.repo.revokeGrants(id, engineerId, user.userId);
    if (n) {
      const who = await this.repo.userNameAny(engineerId);
      await this.repo.addMessage({
        tenantId, conversationId: id, authorId: user.userId, kind: 'system',
        body: `доступ инженера${who ? ` ${who}` : ''} к обращению закрыт`,
      });
    }
    return this.view(tenantId, (await this.repo.byId(tenantId, id))!);
  }

  /**
   * Что открыто инженеру прямо сейчас.
   *
   * Вся его видимость: общей очереди у инженера нет — он подключается по эскалации, а
   * не разбирает поток обращений (01_ARCHITECTURE §3).
   */
  async escalations(user: { userId: string; role: string }) {
    if (!(await this.platform.isEngineer(user.userId))) {
      throw AppException.forbidden('Это список эскалаций инженера');
    }
    const rows = await this.repo.escalationsOf(user.userId);
    return rows.map((c) => ({
      id: String(c.id),
      subject: c.subject,
      status: c.status,
      statusText: humanStatus(c.status),
      userName: c.user_name,
      orgName: c.tenant_name,
      agentName: c.agent_name,
      waitingSince: c.created_at,
      lastAt: c.updated_at,
      priority: c.priority,
      accessUntil: c.expires_at,
    }));
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
    await this.assertCanWork(tenantId, user, id);
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

    /*
      Баг живёт в проекте поддержки ВЕНДОРА, а не клиента.

      Чинит продукт разработчик, у него и доска: задача в проекте клиента была бы
      работой, которую он не может сделать, и висела бы у него на виду укором.
    */
    const home = await this.deskHome(tenantId);
    let project = await this.support.project(home);
    if (!project) {
      const created = await this.projects.create(home, { name: 'Поддержка' });
      await this.support.setProject(home, String(created.id));
      project = { id: String(created.id), name: created.name };
    }
    const task = await this.tasks.create(home, {
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

  /** Кому из инженеров открыт разговор: видно тому, кто в нём работает. */
  async grants(tenantId: string, user: { userId: string; role: string }, id: string) {
    await this.assertCanWork(tenantId, user, id);
    const rows = await this.repo.grantsOf(id);
    return rows.map((g) => ({
      engineerId: g.engineer_id,
      name: g.full_name,
      expiresAt: g.expires_at,
      revokedAt: g.revoked_at,
      live: !g.revoked_at && new Date(g.expires_at).getTime() > Date.now(),
    }));
  }

  /** Диагностика для специалиста (разд. 17): весь технический контекст одним местом. */
  async diagnostics(tenantId: string, user: { userId: string; role: string }, id: string) {
    await this.assertCanWork(tenantId, user, id);
    const conv = await this.repo.byId(tenantId, id);
    if (!conv) throw AppException.notFound('Разговор не найден');
    const [ctx, issues, routing] = await Promise.all([
      this.repo.context(id), this.repo.issues(id), this.repo.routingOf(id),
    ]);
    return {
      context: ctx ?? null,
      issues: issues.map((i) => ({
        taskId: i.task_id, projectId: i.project_id, title: i.title,
        type: i.issue_type, closed: !!i.closed_at,
      })),
      /** Почему обращение у этого человека: первое, что спросят при неудачном выборе. */
      routing: routing.map((r) => ({
        reason: r.reason, agentName: r.full_name, skill: r.required_skill, at: r.created_at,
      })),
      sla: {
        createdAt: conv.created_at,
        queuedAt: conv.queued_at,
        assignedAt: conv.assigned_at,
        escalationLevel: conv.escalation_level,
        aiFirstResponseAt: conv.ai_first_response_at,
        firstResponseAt: conv.human_first_response_at,
        resolvedAt: conv.resolved_at,
        reopens: conv.reopens,
      },
    };
  }

  /**
   * Метрики службы заботы (разд. 30) — техотделу.
   *
   * Цифры службы, а не клиентской организации: как МЫ отвечаем и как нас оценивают.
   * Клиенту они не показываются: это управленческие цифры вендора.
   */
  async dashboard(tenantId: string, user: { userId: string; role: string }) {
    await this.assertAgent(tenantId, user);
    const platform = await this.platform.tenantId();
    const d = await this.repo.dashboard(platform ? null : tenantId);
    const num = (v: string | null | undefined) => (v === null || v === undefined ? null : Number(v));
    return {
      total: Number(d?.total ?? 0),
      active: Number(d?.active ?? 0),
      waiting: Number(d?.waiting ?? 0),
      resolved: Number(d?.resolved ?? 0),
      /** Первый ответ ЧЕЛОВЕКА — скорость живой команды, не смазанная секундами бота. */
      firstResponseSeconds: num(d?.first_median) ? Math.round(num(d?.first_median)!) : null,
      aiResponseSeconds: num(d?.ai_median) ? Math.round(num(d?.ai_median)!) : null,
      /** Сколько разговоров помощник не закрыл сам и сколько из них — из-за неуверенности. */
      escalated: Number(d?.escalated ?? 0),
      escalatedUnsure: Number(d?.escalated_unsure ?? 0),
      resolutionSeconds: num(d?.resolution_median) ? Math.round(num(d?.resolution_median)!) : null,
      csatAvg: num(d?.csat_avg) ? Number(num(d?.csat_avg)!.toFixed(2)) : null,
      csatCount: Number(d?.csat_count ?? 0),
      reopened: Number(d?.reopened ?? 0),
      solvedByAi: Number(d?.ai_only ?? 0),
    };
  }

  // ── MVP 3: действия с разрешения, известные проблемы, сбой, копилот ──
  /**
   * Предложить сделать что-то за человека (разд. 38).
   *
   * Пока он не нажал «Разрешить», не происходит НИЧЕГО: в базе лежит предложение с
   * подписью, которую он читает. Это и отличает помощь от доступа к чужому аккаунту.
   */
  async proposeAction(tenantId: string, user: { userId: string; role: string }, id: string, req: ActionRequest) {
    await this.assertCanWork(tenantId, user, id);
    const conv = await this.repo.byId(tenantId, id);
    if (!conv) throw AppException.notFound('Разговор не найден');
    if (!validAction(req)) throw AppException.validation('Непонятно, что именно сделать');

    const before = await this.currentState(tenantId, req);
    const preview = describeAction({ ...req, labels: { ...req.labels, entity: before.label ?? req.labels?.entity } });
    const row = await this.repo.proposeAction({
      conversationId: id, actorId: user.userId,
      // В какой роли человек предложил правку в чужой системе — половина ответа на
      // вопрос «почему это произошло», который однажды зададут.
      actorRole: await this.platform.roleOf(user.userId),
      action: req.kind,
      entityType: req.kind.startsWith('task') ? 'task' : 'project',
      entityId: String(req.entityId), preview,
      params: { value: req.value ?? null, labels: req.labels ?? {} },
      before: before.state,
    });
    await this.repo.addMessage({
      tenantId, conversationId: id, authorId: user.userId, kind: 'system',
      body: `предлагает: ${preview}${isUndoable(req.kind) ? ' Если что — вернём как было.' : ''}`,
    });
    const next = (await this.repo.byId(tenantId, id))!;
    this.emit(tenantId, next, 'support.action.proposed', { conversationId: id, actionId: String(row?.id) });
    return this.view(tenantId, next);
  }

  /**
   * Слово человека по предложенному действию.
   *
   * «Разрешить» — выполняем и записываем «до» и «после»; «Отклонить» — не делаем
   * ничего и тоже записываем: отказ — такой же факт разговора, как согласие.
   */
  async decideAction(
    tenantId: string, user: { userId: string; role: string }, id: string, actionId: string, allow: boolean,
    sign?: { ip?: string | null; userAgent?: string | null },
  ) {
    const conv = await this.repo.byId(tenantId, id);
    if (!conv) throw AppException.notFound('Разговор не найден');
    if (String(conv.user_id) !== String(user.userId)) {
      throw AppException.forbidden('Разрешить действие может только тот, кто обратился');
    }
    const act = await this.repo.action(actionId);
    if (!act || String(act.conversation_id) !== String(id)) throw AppException.notFound('Действие не найдено');
    if (act.status !== 'proposed') throw AppException.conflict('Это действие уже решено');

    if (!allow) {
      await this.repo.decideAction(actionId, 'declined', false, null, sign);
      await this.repo.addMessage({
        tenantId, conversationId: id, authorId: user.userId, kind: 'system', body: 'не разрешил это действие',
      });
      return this.view(tenantId, (await this.repo.byId(tenantId, id))!);
    }

    const req: ActionRequest = {
      kind: act.action as ActionRequest['kind'],
      entityId: String(act.entity_id),
      value: (act.params_json?.value as string | null) ?? null,
    };
    await this.runAction(tenantId, user, req);
    // Действие выполнено в организации обращения и от имени того, кто его разрешил.
    const after = await this.currentState(tenantId, req);
    await this.repo.decideAction(actionId, 'done', true, after.state, sign);
    await this.repo.addMessage({
      tenantId, conversationId: id, authorId: null, kind: 'system',
      body: `Сделано: ${act.preview}${isUndoable(req.kind) ? ' Можно вернуть как было.' : ''}`,
    });
    const next = (await this.repo.byId(tenantId, id))!;
    this.emit(tenantId, next, 'support.action.done', { conversationId: id, actionId });
    return this.view(tenantId, next);
  }

  /** Вернуть как было — там, где это осмысленно (см. isUndoable). */
  async undoAction(tenantId: string, user: { userId: string; role: string }, id: string, actionId: string) {
    const conv = await this.repo.byId(tenantId, id);
    if (!conv) throw AppException.notFound('Разговор не найден');
    await this.assertCanSee(tenantId, user, conv);
    const act = await this.repo.action(actionId);
    if (!act || act.status !== 'done') throw AppException.conflict('Отменять нечего');
    const kind = act.action as ActionRequest['kind'];
    if (!isUndoable(kind)) throw AppException.conflict('Это действие отменить нельзя');

    const before = (act.before_json ?? {}) as Record<string, string | null>;
    /*
      Возвращаем от имени ХОЗЯИНА обращения, даже если кнопку нажал специалист.

      Специалист вендора в этой организации чужой: его нет ни в проекте, ни в задаче,
      и правка от его имени либо не пройдёт по правам, либо оставит в истории задачи
      человека, которого там никто не знает.
    */
    await this.runAction(tenantId, { userId: String(conv.user_id), role: 'member' }, {
      kind, entityId: String(act.entity_id), value: before.value ?? null,
    });
    await this.repo.decideAction(actionId, 'undone', act.approved_by_user, before);
    await this.repo.addMessage({
      tenantId, conversationId: id, authorId: user.userId, kind: 'system', body: 'вернул как было',
    });
    return this.view(tenantId, (await this.repo.byId(tenantId, id))!);
  }

  /** Что сейчас: нужно и для подписи предложения, и для записи «до». */
  private async currentState(tenantId: string, req: ActionRequest): Promise<{ state: Record<string, unknown> | null; label: string | null }> {
    if (req.kind === 'project.columns') {
      const project = await this.projects.getOrThrow(tenantId, String(req.entityId));
      return { state: null, label: project.name };
    }
    const task = await this.tasksRepo.findById(tenantId, String(req.entityId));
    if (!task) throw AppException.notFound('Задача не найдена');
    const value = req.kind === 'task.deadline'
      ? (task.deadline_at ? new Date(task.deadline_at as unknown as string).toISOString() : null)
      : req.kind === 'task.assignee' ? (task.assignee_id ? String(task.assignee_id) : null)
        : String(task.project_id);
    return { state: { value }, label: task.title };
  }

  /** Само действие. Каждое — вызов уже существующей части CRM, а не новая логика. */
  private async runAction(tenantId: string, user: { userId: string; role: string }, req: ActionRequest): Promise<void> {
    switch (req.kind) {
      case 'task.deadline':
        await this.forecast.setEstimateDeadline(tenantId, String(req.entityId), { deadline: req.value ?? null });
        return;
      case 'task.assignee':
        await this.forecast.assign(tenantId, String(req.entityId), String(req.value), user.userId, true);
        return;
      case 'task.project':
        await this.tasks.moveToProject(tenantId, String(req.entityId), user, String(req.value));
        return;
      case 'project.columns':
        await this.projects.ensureDefaultColumns(tenantId, String(req.entityId));
        return;
      default:
        throw AppException.validation('Неизвестное действие');
    }
  }

  // ── известные проблемы (разд. 42) ──
  /**
   * Где живут известные проблемы, сбои и справочник — в организации ВЕНДОРА.
   *
   * Поломка продукта одна на всех клиентов: заводить её заново в каждой организации
   * значит рассказывать о ней столько раз, сколько у нас клиентов.
   */
  private async deskHome(fallback: string): Promise<string> {
    return (await this.platform.tenantId()) ?? fallback;
  }

  async knownIssues(tenantId: string, user: { userId: string; role: string }) {
    await this.assertAgent(tenantId, user);
    const rows = await this.repo.knownIssues(await this.deskHome(tenantId));
    return rows.map((k) => ({
      id: k.id, taskId: k.task_id, title: k.title, pattern: k.pattern,
      active: k.active, fixed: !!k.closed_at,
    }));
  }

  /** Пометить задачу известной проблемой: дальше система узнаёт её в чужих обращениях. */
  async addKnownIssue(
    tenantId: string, user: { userId: string; role: string },
    taskId: string, title: string, pattern: string,
  ) {
    await this.assertManage(tenantId, user);
    const row = await this.repo.addKnownIssue(await this.deskHome(tenantId), taskId, title, pattern, user.userId);
    return { id: String(row?.id), taskId };
  }

  async setKnownIssueActive(tenantId: string, user: { userId: string; role: string }, id: string, active: boolean) {
    await this.assertManage(tenantId, user);
    await this.repo.setKnownIssueActive(await this.deskHome(tenantId), id, active);
    return this.knownIssues(tenantId, user);
  }

  /**
   * Узнать известную проблему в обращении.
   *
   * Сравниваем слова-приметы с текстом и последней ошибкой. Совпало — говорим сразу,
   * в первую же минуту: «похоже на известную проблему, исправление готовится». Это
   * честнее, чем заставлять человека доказывать поломку, о которой мы уже знаем.
   */
  private async matchKnownIssue(tenantId: string, text: string, lastError?: string | null) {
    const hay = `${text} ${lastError ?? ''}`.toLowerCase();
    if (hay.trim().length < 4) return null;
    const rows = await this.repo.knownIssues(await this.deskHome(tenantId));
    return rows.find((k) => k.active && !k.closed_at && k.pattern
      .split(',')
      .map((w) => w.trim().toLowerCase())
      .filter((w) => w.length >= 3)
      .some((w) => hay.includes(w))) ?? null;
  }

  // ── массовый сбой (разд. 43) ──
  /**
   * Объявить сбой.
   *
   * Одно честное сообщение вместо двадцати одинаковых разговоров: его видят все, у
   * кого открыт разговор, и все, кто откроет панель.
   */
  async declareIncident(tenantId: string, user: { userId: string; role: string }, title: string, message: string) {
    await this.assertIncident(tenantId, user);
    const platform = await this.platform.tenantId();
    const inc = await this.repo.createIncident(platform ?? tenantId, title, message, user.userId);
    // Авария у вендора касается ВСЕХ клиентов сразу, а не той организации, из которой её заметили.
    const live = await this.repo.liveConversations(platform ? null : tenantId);
    for (const c of live) {
      await this.repo.addMessage({
        tenantId: c.tenant_id, conversationId: c.id, authorId: null, kind: 'system',
        body: `${title}. ${message}`,
      });
    }
    for (const t of new Set(live.map((c) => c.tenant_id))) {
      this.realtime.emitToTenant(t, 'support.incident', { id: inc?.id, title, message, status: 'open' });
    }
    return inc;
  }

  /** Починили — сказать всем, кому говорили о сбое. */
  async resolveIncident(tenantId: string, user: { userId: string; role: string }, id: string) {
    await this.assertIncident(tenantId, user);
    const platform = await this.platform.tenantId();
    const inc = await this.repo.resolveIncident(platform ?? tenantId, id);
    if (!inc) throw AppException.notFound('Открытого сбоя с таким номером нет');
    const live = await this.repo.liveConversations(platform ? null : tenantId);
    for (const c of live) {
      await this.repo.addMessage({
        tenantId: c.tenant_id, conversationId: c.id, authorId: null, kind: 'system',
        body: `Исправлено: ${inc.title}. Обновите страницу, пожалуйста.`,
      });
    }
    for (const t of new Set(live.map((c) => c.tenant_id))) {
      this.realtime.emitToTenant(t, 'support.incident', { id: inc.id, status: 'resolved' });
    }
    return { resolved: true };
  }

  /**
   * Копилот дежурного (разд. 41).
   *
   * Готовит специалисту то, на что у него уходит первая пара минут: короткое резюме
   * проблемы, что проверить и похоже ли это на известную поломку. Клиенту сам ничего
   * не отправляет — после подключения человека ИИ молчит, пока его не попросят.
   */
  async copilot(tenantId: string, user: { userId: string; role: string; tenantId?: string }, id: string) {
    await this.assertCanWork(tenantId, user, id);
    const conv = await this.repo.byId(tenantId, id);
    if (!conv) throw AppException.notFound('Разговор не найден');
    const [messages, ctx] = await Promise.all([this.repo.messages(id), this.repo.context(id)]);
    const c = (ctx ?? {}) as Record<string, string | null>;
    const talk = messages
      .filter((m) => m.author_kind !== 'system')
      .slice(-14)
      .map((m) => `${m.author_kind === 'user' ? 'Человек' : m.author_kind === 'ai' ? 'Помощник' : 'Специалист'}: ${String(m.body ?? '').slice(0, 400)}`)
      .join('\n');
    const known = await this.matchKnownIssue(tenantId, talk, c.last_error);

    let text = '';
    try {
      /*
        Копилот думает в организации САМОГО специалиста, а не клиента.

        Его сессия не должна ходить инструментами по чужим задачам и переписке: всё,
        что ему нужно, уже лежит в подсказке — сам разговор и экран человека. И это
        не та сессия, что у первой линии: та принадлежит клиенту и живёт у него.
      */
      const home = user.tenantId ?? tenantId;
      const session = await this.agentRepo.createSession(home, user.userId, null);
      await this.agent.ask(
        home, user, String(session.id),
        'Ты помогаешь специалисту поддержки. По переписке ниже дай ТРИ коротких раздела: '
        + '«Суть» (одно предложение), «Что проверить» (2–4 пункта), «Что сказать человеку» (одна фраза). '
        + `Без вступлений.\n\nПереписка:\n${talk}\n\nЭкран: ${c.route ?? '—'}, ошибка: ${c.last_error ?? 'нет'}.`,
        null,
        (e) => { if (e.type === 'delta') text += e.text; },
        () => false,
      );
    } catch (e) {
      this.log.warn(`копилот поддержки ${id}: ${(e as Error).message}`);
    }

    return {
      summary: text.trim() || null,
      known: known ? { id: known.id, taskId: known.task_id, title: known.title } : null,
    };
  }

  /**
   * «Вопрос снят» — человек закрывает разговор сам (разд. 21).
   *
   * Вопрос часто отпадает без всякого ответа: разобрался, передумал, нашёл сам.
   * Заставлять в этом случае ждать специалиста, чтобы тот нажал «решено», — глупо;
   * закрыть свой разговор вправе тот, кто его завёл, и в любой момент.
   */
  async closeByUser(tenantId: string, user: { userId: string; role: string }, id: string, csat?: number | null) {
    const conv = await this.repo.byId(tenantId, id);
    if (!conv) throw AppException.notFound('Разговор не найден');
    if (String(conv.user_id) !== String(user.userId)) {
      throw AppException.forbidden('Закрыть разговор может только тот, кто обратился');
    }
    if (conv.closed_at) return this.view(tenantId, conv);
    await this.repo.addMessage({
      tenantId, conversationId: id, authorId: null, kind: 'system',
      body: 'Вопрос снят — разговор закрыт. Если проблема вернётся, откройте его заново.',
    });
    const score = csat && csat >= 1 && csat <= 4 ? csat : null;
    const next = (await this.repo.close(tenantId, id, score, null))!;
    await this.notifyDesk(tenantId, 'support.queue.changed', { conversationId: id });
    this.emit(tenantId, next, 'support.status.changed', { conversationId: id, status: 'closed' });
    return this.view(tenantId, next);
  }

  // ── справочник: то, из чего отвечает помощник ──
  /**
   * Что знает помощник: разделы справочника и не отстали ли они от системы.
   *
   * Смотрим по организации вендора: справочник везде один и тот же, а показывать
   * сто одинаковых состояний незачем.
   */
  async handbookState(tenantId: string, user: { userId: string; role: string }) {
    await this.assertManage(tenantId, user);
    return this.handbook.state(await this.deskHome(tenantId));
  }

  /** Обновить справочник во всех организациях — право техотдела. */
  async loadHandbook(tenantId: string, user: { userId: string; role: string }) {
    await this.assertManage(tenantId, user);
    const home = await this.deskHome(tenantId);
    const mine = await this.handbook.load(home, user.userId);
    // Клиентам справочник нужен не меньше: их помощник ищет ответ в их же базе знаний.
    void this.handbook.syncAll();
    return mine;
  }

  // ── кто отвечает ──
  /**
   * Кто отвечает в службе заботы: техотдел вендора.
   *
   * Пока платформа не назначена — прежний порядок: дежурные самой организации, а если
   * их нет, её владелец. Этот запасной путь существует ради одного: выкладка не должна
   * оставить людей без поддержки, если настройку платформы забыли прописать.
   */
  private async deskPeople(tenantId: string): Promise<{
    userId: string; name: string; tenantId: string; skills: string[]; status: string | null;
  }[]> {
    if (await this.platform.tenantId()) {
      const staff = await this.platform.onDuty();
      return staff.map((p) => ({
        userId: String(p.user_id), name: p.full_name, tenantId: String(p.tenant_id),
        skills: p.skills ?? [], status: null,
      }));
    }
    const agents = await this.repo.agents(tenantId);
    if (agents.length) {
      return agents.map((a) => ({
        userId: String(a.user_id), name: a.full_name, tenantId,
        skills: a.skills ?? [], status: a.presence_status,
      }));
    }
    /*
      Владелец организации как приёмщик обращений — только вне боя (03_RBAC §18).

      В коробочном продукте это недопустимо: владелец компании-клиента получил бы права
      нашей поддержки только потому, что переменную окружения забыли прописать. В бою
      пустой список честнее — он виден сразу, а тихая раздача прав не видна никогда.
    */
    if (!this.platform.fallbackAllowed()) return [];
    const owner = await this.repo.owner(tenantId);
    return owner
      ? [{ userId: String(owner.id), name: owner.full_name, tenantId, skills: [], status: null }]
      : [];
  }

  /**
   * Событие всем, кто принимает обращения.
   *
   * Комната присутствия строится из пары «организация + человек», поэтому техотделу
   * шлём в ЕГО организацию, а не в ту, где живёт обращение: иначе событие уходит в
   * пустоту и очередь оживает только по F5.
   */
  private async notifyDesk(tenantId: string, event: string, payload: Record<string, unknown>): Promise<void> {
    for (const p of await this.deskPeople(tenantId)) {
      this.realtime.emitToUsers(p.tenantId, [p.userId], event, payload);
    }
  }

  /**
   * Работа с очередью и обращениями.
   *
   * Инженера здесь нет намеренно: он не первая линия и общей очереди не видит
   * (01_ARCHITECTURE §3 и §8, 03_RBAC §3). Ему открыты только те разговоры, куда его
   * позвали, — см. `canWork`.
   */
  private async isAgent(tenantId: string, user: { userId: string; role: string }): Promise<boolean> {
    if (await this.platform.tenantId()) return this.platform.canDesk(user.userId);
    const people = await this.deskPeople(tenantId);
    return people.some((p) => p.userId === String(user.userId));
  }

  /**
   * Право работать в КОНКРЕТНОМ разговоре.
   *
   * Дежурный первой линии работает в любом; инженер — только там, где у него живой
   * доступ. Проверка по разговору, а не по человеку: право инженера кончается вместе
   * с эскалацией, ради которой его позвали.
   */
  private async canWork(tenantId: string, user: { userId: string; role: string }, conversationId: string): Promise<boolean> {
    if (await this.isAgent(tenantId, user)) return true;
    if (!(await this.platform.isEngineer(user.userId))) return false;
    return this.repo.hasLiveGrant(conversationId, user.userId);
  }

  private async assertCanWork(tenantId: string, user: { userId: string; role: string }, conversationId: string): Promise<void> {
    if (!(await this.canWork(tenantId, user, conversationId))) {
      throw AppException.forbidden('Это разговор службы заботы');
    }
  }

  /** Настройки службы: состав отдела, известные проблемы, справочник. */
  private async assertManage(tenantId: string, user: { userId: string; role: string }): Promise<void> {
    if (await this.platform.tenantId()) {
      if (await this.platform.canManage(user.userId)) return;
      throw AppException.forbidden('Это настройки службы заботы');
    }
    await this.assertAgent(tenantId, user);
  }

  /** Массовый сбой объявляет и закрывает дежурный по авариям или руководство службы. */
  private async assertIncident(tenantId: string, user: { userId: string; role: string }): Promise<void> {
    if (await this.platform.tenantId()) {
      if (await this.platform.canIncident(user.userId)) return;
      throw AppException.forbidden('Сбой объявляет дежурный по авариям');
    }
    await this.assertAgent(tenantId, user);
  }

  private async assertAgent(tenantId: string, user: { userId: string; role: string }): Promise<void> {
    if (!(await this.isAgent(tenantId, user))) throw AppException.forbidden('Это разговор службы заботы');
  }

  /** Разговор видит тот, кто обратился, и дежурные: чужие обращения не читают. */
  private async assertCanSee(tenantId: string, user: { userId: string; role: string }, conv: ConversationRow): Promise<void> {
    if (String(conv.user_id) === String(user.userId)) return;
    await this.assertCanWork(tenantId, user, String(conv.id));
  }

  /** Событие — участникам разговора и дежурным: панель оживает без перезагрузки. */
  private emit(tenantId: string, conv: ConversationRow, event: string, payload: Record<string, unknown>): void {
    const to = [String(conv.user_id)];
    if (conv.assigned_agent_id) to.push(String(conv.assigned_agent_id));
    this.realtime.emitToUsers(tenantId, to, event, payload);
  }
}
