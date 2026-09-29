import { Injectable, Logger } from '@nestjs/common';
import { AppException } from '../../common/http/app-exception';
import { AiService } from '../ai/ai.service';
import { TasksService } from '../tasks/tasks.service';
import { SecretaryService } from '../secretary/secretary.service';
import { PromptsService } from '../prompts/prompts.service';
import { matchProjectInText } from '../nl/task-draft';
import { matchUserInText } from '../nl/nl.match';
import { withinWorkHours } from '../assistant/ping-rules';
import { ChatsRepository } from '../chats/chats.repository';
import { RealtimeService } from '../realtime/realtime.service';
import { acceptedText, askText, shouldAsk } from './ask-rules';
import { dedupKeyOf, ExtractedAction, parseAnalysis, RefCatalog, resolveProject } from './analysis-schema';
import { missingParts, resolveRoles, taskReadiness } from './roles-rules';
import { autoCreateVerdict, overLimit, quality, undoVerdict } from './policy-rules';
import { ChatAnalysisRepository, DueChatRow, MessageRow } from './chat-analysis.repository';
import { closedSegments, Segment, SegmentMessage } from './segments';

/**
 * Разбор переписки: что агент понял (ТЗ-12, этап 1).
 *
 * На этом этапе агент НИЧЕГО НЕ СОЗДАЁТ. Он читает затихшие разговоры и записывает, что
 * в них увидел, вместе с сообщениями, из которых это выросло. Смысл этапа — посмотреть
 * на своих переписках, насколько он попадает, ПРЕЖДЕ чем давать ему что-то делать.
 *
 * Границы, установленные заказчиком 29.09 и заложенные в код, а не в настройку:
 *   * личные переписки и заметки себе не разбираются вовсе (условие в репозитории);
 *   * мгновенного разбора каждого сообщения нет — только затихший разговор;
 *   * режим по умолчанию «только предлагать»; автосоздание (этап 4) — режим, который
 *     владелец включает сам, и даже тогда оно срабатывает только на готовое поручение
 *     после перепроверки по базе и отменяется одним нажатием в течение суток.
 */

const FALLBACK_SYSTEM = [
  'Ты разбираешь рабочую переписку команды и находишь в ней смыслы. Ты ничего не создаёшь —',
  'только сообщаешь, что понял. Отвечай строго в JSON.',
  '',
  'Виды наблюдений:',
  '— task: поручение, которое кто-то взялся или обязан сделать;',
  '— decision: принятое решение («решили оставить старую форму до релиза»);',
  '— meeting: договорённость о встрече или созвоне;',
  '— question: вопрос, на который нужен ответ;',
  '— status: сообщение о ходе работы («API готов, осталось протестировать»);',
  '— blocker: помеха, из-за которой работа стоит;',
  '— idea: мысль без обязательства («можно было бы когда-нибудь переделать»).',
  '',
  'Правила, которые важнее всего:',
  '1. Смотри на ВЕСЬ разговор, а не на отдельную реплику. «Я посмотрю сегодня» — задача',
  '   только если выше просили посмотреть; тогда постановщик это автор просьбы.',
  '2. Возвращай ФИНАЛЬНОЕ состояние разговора. Поручение отменили — не возвращай задачу.',
  '   Сменили исполнителя или срок — верни последний вариант.',
  '3. Не задача: шутка, пример, цитата, гипотеза, пересказ прошлого («я вчера сделал»),',
  '   отказ, отмена, размышление без обязательства, вопрос, кусок кода, сообщение бота.',
  '4. Людей и проекты называй ТОЛЬКО пометками из справочника (например u3, p1). Если',
  '   подходящей пометки нет — оставь поле пустым. Не придумывай номера.',
  '5. У каждого наблюдения перечисли сообщения-источники по их id из переписки. Роли:',
  '   instruction — само поручение, acceptance — согласие взять, correction — правка,',
  '   cancellation — отмена, decision — решение, context — остальное.',
  '6. Уверенность ставь честно: 0.95 и выше — только когда сказано прямым текстом.',
  '7. Пустой список actions — нормальный и частый ответ. Обычная переписка не должна',
  '   порождать ничего.',
  '',
  'Формат ответа:',
  '{"actions":[{"type":"task","title":"...","description":"...","project_ref":"p1",',
  '"assigner_ref":"u1","assignee_ref":"u2","deadline":"2026-10-02T18:00:00+03:00",',
  '"meeting_at":null,"confidence":{"intent":0.95,"project":0.9,"assigner":0.95,"assignee":0.9},',
  '"sources":[{"message_id":"881","role":"instruction"}]}]}',
].join('\n');

@Injectable()
export class ChatAnalysisService {
  private readonly log = new Logger('ChatAnalysis');

  constructor(
    private readonly repo: ChatAnalysisRepository,
    private readonly ai: AiService,
    private readonly prompts: PromptsService,
    private readonly tasks: TasksService,
    /** Журнал действий ИИ: по нему видно, сколько работы он снял с людей. */
    private readonly secretary: SecretaryService,
    /** Чаты — только через репозиторий: службы связались бы в круг. */
    private readonly chats: ChatsRepository,
    private readonly realtime: RealtimeService,
  ) {}

  /** Сообщение от бота всем, кто видит чат. */
  private async say(tenantId: string, chatId: string, body: string) {
    const chat = await this.chats.get(tenantId, chatId);
    if (!chat) return null;
    const message = await this.chats.addMessage({
      tenantId, chatId, authorId: null as unknown as string, body, fileId: null, isAi: true,
    });
    const to = chat.kind === 'project'
      ? await this.chats.teamIds(tenantId)
      : await this.chats.memberIds(chatId);
    this.realtime.emitToUsers(tenantId, to, 'chat.message', { chatId, message });
    return message;
  }

  // ── настройки ──

  settings(tenantId: string) {
    return this.repo.settings(tenantId);
  }

  saveSettings(
    tenantId: string,
    patch: { enabled?: boolean; quietMinutes?: number; mode?: string; askInChat?: boolean; monthlyLimitUsd?: number | null },
  ) {
    return this.repo.saveSettings(tenantId, patch);
  }

  /**
   * Счётчики попадания и расход — то, на что владелец смотрит, прежде чем включать
   * автосоздание (ТЗ разд. 58). Решение «включать или нет» должно опираться на цифры с
   * его собственных переписок, а не на наше обещание.
   */
  async stats(tenantId: string) {
    const [counts, settings, spent] = await Promise.all([
      this.repo.qualityCounts(tenantId),
      this.repo.settings(tenantId),
      this.repo.spentThisMonth(tenantId),
    ]);
    const limit = settings.monthly_limit_usd != null ? Number(settings.monthly_limit_usd) : null;
    return {
      quality: quality(counts),
      spentUsd: Math.round(spent * 100) / 100,
      limitUsd: limit,
      limitReached: overLimit(spent, limit),
    };
  }

  setChatAnalysis(tenantId: string, chatId: string, on: boolean) {
    return this.repo.setChatAnalysis(tenantId, chatId, on);
  }

  /** Наблюдения — только по тем чатам, которые человеку и так видны. */
  actions(tenantId: string, userId: string, o: { chatId?: string | null; limit?: number }) {
    return this.repo.actions(tenantId, userId, o);
  }

  runs(tenantId: string, userId: string, limit?: number) {
    return this.repo.runs(tenantId, userId, limit);
  }

  // ── что делать с наблюдением ──

  /**
   * Завести задачу по наблюдению.
   *
   * Единственный путь, которым разбор переписки превращается в задачу: её заводит
   * ЧЕЛОВЕК, нажав кнопку. Сам агент ничего не создаёт — это решение заказчика.
   *
   * Постановщик — тот, кто поручил в переписке, а не тот, кто нажал «завести».
   * Нажавший лишь подтвердил чужое поручение, и приписывать его себе неправильно
   * (так же сделано в задачах со встреч).
   */
  async confirm(
    tenantId: string, userId: string, id: string,
    patch: { projectId?: string; assigneeId?: string; title?: string } = {},
  ) {
    const a = await this.repo.one(tenantId, userId, id);
    if (!a) throw AppException.notFound('Наблюдение не найдено');
    if (a.action_type !== 'task') throw AppException.validation('Задачей может стать только поручение');
    if (a.created_entity_id) throw AppException.conflict('Задача по этому наблюдению уже заведена');
    if (['rejected', 'cancelled'].includes(a.status)) throw AppException.conflict('Наблюдение уже закрыто');

    const projectId = patch.projectId ?? a.project_id;
    if (!projectId) throw AppException.validation('Выберите проект для задачи');

    const task = await this.tasks.create(tenantId, {
      projectId: String(projectId),
      title: String(patch.title ?? a.title).slice(0, 255),
      description: a.description || undefined,
      assigneeId: (patch.assigneeId ?? a.assignee_id) ?? undefined,
      managerId: a.assigner_id ?? undefined,
      deadlineAt: a.deadline_at ?? undefined,
      // Откуда задача взялась — в той же вставке: письмо уходит сразу и должно назвать
      // постановщиком автора поручения, а не нажавшего кнопку.
    } as any, userId, { sourceChatMessageId: a.instruction_message_id ?? null });

    await this.repo.markAction(tenantId, id, { status: 'confirmed', entityType: 'task', entityId: String(task.id) });
    /*
      Поправка человека — это промах агента, и именно такие промахи в автосоздании ушли
      бы людям. Заполненный пробел промахом не считаем: агент честно сказал «не знаю».
    */
    await this.repo.markCorrections(tenantId, id, {
      project: !!(a.project_id && patch.projectId && String(patch.projectId) !== String(a.project_id)),
      assignee: !!(a.assignee_id && patch.assigneeId && String(patch.assigneeId) !== String(a.assignee_id)),
    });
    void this.secretary.record({
      tenantId, userId: a.assigner_id ?? userId, kind: 'nl_task',
      summary: `Задача из переписки: «${task.title}»`, subjectType: 'task', subjectId: task.id,
    });
    return { actionId: id, task };
  }

  /** «Это не задача». Наблюдение не удаляем: по отказам видно, где агент ошибается. */
  async reject(tenantId: string, userId: string, id: string) {
    const a = await this.repo.one(tenantId, userId, id);
    if (!a) throw AppException.notFound('Наблюдение не найдено');
    if (a.created_entity_id) throw AppException.conflict('По наблюдению уже заведена задача');
    await this.repo.markAction(tenantId, id, { status: 'rejected' });
    return { actionId: id, status: 'rejected' };
  }

  /**
   * Отменить задачу, которую агент завёл сам (ТЗ разд. 26).
   *
   * Задача уходит в корзину обычным удалением со всеми его проверками и журналом —
   * отдельного «тихого» пути убрать задачу у агента нет. Наблюдение запоминает отмену:
   * это самый дорогой вид промаха, и счётчик попадания его учитывает.
   */
  async undo(tenantId: string, user: { userId: string; role: string }, id: string) {
    const a = await this.repo.one(tenantId, user.userId, id);
    if (!a) throw AppException.notFound('Наблюдение не найдено');
    return this.undoAction(tenantId, user, a);
  }

  /**
   * То же из карточки задачи. Раздел «Разбор переписки» открыт только руководству, а
   * исполнитель, которому агент по ошибке поручил работу, отменить её вправе — и должен
   * мочь это сделать там, где задачу видит. Обычное удаление из карточки промах бы не
   * засчитало.
   */
  async undoByTask(tenantId: string, user: { userId: string; role: string }, taskId: string) {
    const a = await this.repo.byCreatedTask(tenantId, taskId);
    if (!a) throw AppException.notFound('Эту задачу агент не заводил сам — её удаляют обычным способом');
    return this.undoAction(tenantId, user, a);
  }

  private async undoAction(tenantId: string, user: { userId: string; role: string }, a: any) {
    const id = String(a.id);
    const verdict = undoVerdict({
      status: a.status, createdAt: new Date(a.updated_at), now: new Date(),
      userId: user.userId, role: user.role, assignerId: a.assigner_id, assigneeId: a.assignee_id,
    });
    if (!verdict.ok) throw AppException.conflict(verdict.reason);

    if (a.created_entity_id) {
      await this.tasks.removeByPerson(tenantId, String(a.created_entity_id), user, {
        reason: 'Отмена задачи, заведённой разбором переписки',
      });
    }
    await this.repo.markUndone(tenantId, id, user.userId);
    const who = await this.chats.userName(tenantId, user.userId);
    await this.say(tenantId, a.chat_id, `${who ?? 'Кто-то из команды'} отменил задачу «${a.title}» — убрал её в корзину.`);
    return { actionId: id, status: 'cancelled' };
  }

  // ── разбор ──

  /**
   * Один проход по чатам, где разговор затих.
   *
   * `tenantId` задан — разбираем только эту организацию: так ходит кнопка «прогнать
   * сейчас», и чужие переписки она задевать не должна. Без него — обычный проход
   * планировщика по всем.
   *
   * Ошибка в одном чате не отменяет остальные: это N независимых разговоров.
   */
  async tick(now = new Date(), tenantId: string | null = null): Promise<number> {
    let analyzed = 0;
    const chats = await this.repo.dueChats(now, tenantId);
    /*
      Потолок расхода. Достигнут — разбор организации стоит до следующего месяца, а экран
      настроек говорит об этом прямо. Отметка «докуда разобрано» при этом не двигается:
      переписка дождётся, когда владелец поднимет потолок.
    */
    const stopped = new Map<string, boolean>();
    for (const chat of chats) {
      try {
        if (!stopped.has(chat.tenant_id)) {
          const limit = chat.monthly_limit_usd != null ? Number(chat.monthly_limit_usd) : null;
          const over = limit != null && overLimit(await this.repo.spentThisMonth(chat.tenant_id), limit);
          stopped.set(chat.tenant_id, over);
          if (over) this.log.warn(`организация ${chat.tenant_id}: потолок расхода на разбор исчерпан`);
        }
        if (stopped.get(chat.tenant_id)) continue;
        analyzed += await this.analyzeChat(chat, now);
      } catch (e) {
        this.log.warn(`чат ${chat.chat_id}: ${(e as Error).message}`);
      }
    }
    // Ответы на прежние вопросы — в том же проходе: отдельного перехвата сообщений нет.
    await this.collectAnswers(now).catch((e) => this.log.warn(`сбор ответов: ${(e as Error).message}`));
    return analyzed;
  }

  /**
   * Разобрать затихшие отрезки одного чата.
   *
   * Отметку «докуда разобрано» двигаем ПОСЛЕ каждого удачного отрезка. Сбой прерывает
   * чат на этом месте: оставшиеся сообщения дождутся следующего прохода. Терять
   * переписку из-за недоступной модели нельзя (разд. 61).
   */
  private async analyzeChat(chat: DueChatRow, now: Date): Promise<number> {
    const messages = await this.repo.messagesAfter(chat.tenant_id, chat.chat_id, chat.last_message_id);
    if (!messages.length) return 0;

    const quietMs = Math.max(chat.quiet_minutes, 1) * 60_000;
    const segments = closedSegments(messages.map(toSegmentMessage), quietMs, now);
    if (!segments.length) return 0;

    let done = 0;
    for (const seg of segments) {
      const part = messages.filter((m) => Number(m.id) >= Number(seg.startId) && Number(m.id) <= Number(seg.endId));
      const ok = await this.analyzeSegment(chat, part, seg, 'segment');
      if (!ok) break;
      done++;
    }
    return done;
  }

  /**
   * Спросить в чате о непонятном поручении (ТЗ-12, разд. 17–18).
   *
   * Не больше ОДНОГО вопроса за проход, даже если непонятных поручений несколько: три
   * подряд сообщения бота в рабочем чате выглядят как поломка, а не как помощь.
   * Остальные останутся в разборе — их дооформят руками.
   */
  private async askAbout(
    chat: DueChatRow,
    saved: { id: string; action: ExtractedAction; status: string; cancelled: boolean }[],
  ): Promise<void> {
    const working = withinWorkHours(new Date(), chat.timezone, {
      workStart: String(chat.work_start).slice(0, 5),
      workEnd: String(chat.work_end).slice(0, 5),
      weekendDays: chat.weekend_days ?? [0, 6],
      holidays: chat.holidays ?? [],
    });

    for (const s of saved) {
      const missing = missingParts({
        projectId: s.action.projectId, assigneeId: s.action.assigneeId,
        assignerId: s.action.assignerId, cancelled: s.cancelled,
      });
      const ok = shouldAsk({
        type: s.action.type, status: s.status, intentConfidence: s.action.confidence.intent,
        asked: false, missing, working, enabled: chat.ask_in_chat,
      });
      if (!ok) continue;

      const who = s.action.assignerId ? await this.chats.userName(chat.tenant_id, s.action.assignerId) : null;
      const projects = await this.repo.projects(chat.tenant_id, 5);
      const body = askText({
        who,
        title: s.action.title,
        needProject: !s.action.projectId,
        needAssignee: !s.action.assigneeId,
        projectNames: projects.map((p) => p.name),
      });
      const message = await this.say(chat.tenant_id, chat.chat_id, body);
      if (message) {
        await this.repo.markAsked(chat.tenant_id, s.id, String(message.id));
        this.log.log(`чат ${chat.chat_id}: спросили о поручении «${s.action.title}»`);
      }
      return; // один вопрос за проход
    }
  }

  /**
   * Завести готовые поручения самому — только в режиме, который включил владелец
   * (ТЗ-12, разд. 14–15, 53, 55).
   *
   * Задачу заводим от имени СИСТЕМЫ, а не постановщика: он её не заводил, и журнал
   * задачи не должен приписывать ему нажатие. Постановщиком в самой задаче остаётся
   * автор поручения — ему и исполнителю уходит письмо с пометкой «по итогам переписки».
   *
   * О заведённом говорим в чате одним сообщением на проход: участники разговора должны
   * узнать, что из их переписки получилась задача, и где её отменить, если агент ошибся.
   */
  private async autoCreate(
    chat: DueChatRow,
    saved: { id: string; action: ExtractedAction; status: string; cancelled: boolean }[],
  ): Promise<void> {
    if (chat.mode !== 'auto_high') return;
    const made: { title: string; number: string; assignee: string | null; assigner: string | null }[] = [];

    for (const s of saved) {
      if (s.action.type !== 'task' || s.status !== 'ready') continue;
      try {
        const messageId = await this.repo.instructionOf(s.id);
        const facts = await this.repo.createFacts(chat.tenant_id, {
          projectId: s.action.projectId, assignerId: s.action.assignerId,
          assigneeId: s.action.assigneeId, messageId,
        });
        const verdict = autoCreateVerdict({ mode: chat.mode, type: s.action.type, status: s.status, facts });
        if (!verdict.create) {
          this.log.log(`наблюдение ${s.id}: не завожу сам — ${verdict.reason}`);
          continue;
        }

        const task = await this.tasks.create(chat.tenant_id, {
          projectId: String(s.action.projectId),
          title: s.action.title.slice(0, 255),
          description: s.action.description || undefined,
          assigneeId: s.action.assigneeId ?? undefined,
          managerId: s.action.assignerId ?? undefined,
          deadlineAt: s.action.deadlineAt ?? undefined,
        } as any, null, { sourceChatMessageId: messageId, createdByAi: true });

        await this.repo.markAction(chat.tenant_id, s.id, {
          status: 'auto_created', entityType: 'task', entityId: String(task.id),
        });
        s.status = 'auto_created';
        void this.secretary.record({
          tenantId: chat.tenant_id, userId: s.action.assignerId ?? null, kind: 'nl_task',
          summary: `Задача из переписки заведена агентом: «${task.title}»`, subjectType: 'task', subjectId: task.id,
        });
        const [assignee, assigner] = await Promise.all([
          s.action.assigneeId ? this.chats.userName(chat.tenant_id, s.action.assigneeId) : null,
          s.action.assignerId ? this.chats.userName(chat.tenant_id, s.action.assignerId) : null,
        ]);
        made.push({ title: task.title, number: String(task.id), assignee, assigner });
      } catch (e) {
        // Не завелось — наблюдение остаётся «готовым», его заведут руками.
        this.log.warn(`автосоздание по наблюдению ${s.id}: ${(e as Error).message}`);
      }
    }

    if (!made.length) return;
    const lines = made.map((m) => {
      const who = m.assigner && m.assignee && m.assigner === m.assignee
        ? `личная задача ${m.assignee}`
        : `постановщик ${m.assigner ?? '—'}, исполнитель ${m.assignee ?? '—'}`;
      return `• #${m.number} «${m.title}» — ${who}`;
    });
    await this.say(chat.tenant_id, chat.chat_id, [
      made.length === 1 ? 'Завёл задачу по итогам переписки:' : 'Завёл задачи по итогам переписки:',
      ...lines,
      'Если я ошибся — отменить можно в течение суток прямо в карточке задачи.',
    ].join('\n'));
  }

  /**
   * Не ответил ли кто-нибудь на наш вопрос.
   *
   * Ответ разбираем тем же сопоставлением, что и быстрая команда: название проекта
   * целиком и имя сотрудника по основе слова. Отвечать вправе тот, кого спросили, —
   * автор поручения. Чужая реплика с похожим словом наблюдение не дозаполняет.
   */
  private async collectAnswers(now: Date): Promise<number> {
    let filled = 0;
    for (const row of await this.repo.awaiting(now)) {
      try {
        const after = await this.repo.messagesAfterQuestion(row.tenant_id, row.chat_id, row.question_message_id);
        const mine = after.filter((m) => !m.is_ai && m.author_id && String(m.author_id) === String(row.assigner_id));
        if (!mine.length) continue;

        const text = mine.map((m) => String(m.body ?? '')).join('\n');
        const [people, projects] = await Promise.all([
          this.repo.people(row.tenant_id, row.chat_id, row.chat_project_id),
          this.repo.projects(row.tenant_id),
        ]);

        const projectId = row.project_id
          ? null
          : matchProjectInText(text, projects.map((p) => ({ id: String(p.id), name: p.name })));
        const assigneeId = row.assignee_id
          ? null
          : matchUserInText(text, people.map((p) => ({ id: String(p.id), name: p.name })));
        if (!projectId && !assigneeId) continue;

        const nextProject = row.project_id ?? projectId;
        const nextAssignee = row.assignee_id ?? assigneeId;
        const status = taskReadiness({
          projectId: nextProject, assigneeId: nextAssignee, assignerId: row.assigner_id,
          cancelled: false,
          confidence: {
            intent: Number(row.intent_confidence),
            // Названное человеком считаем твёрдым: это не догадка, а ответ.
            project: nextProject ? 1 : 0,
            assigner: Number(row.assigner_confidence),
            assignee: nextAssignee ? 1 : 0,
          },
        });

        await this.repo.fill(row.tenant_id, row.id, {
          projectId, assigneeId,
          projectConfidence: nextProject ? 1 : undefined,
          assigneeConfidence: nextAssignee ? 1 : undefined,
          status,
        });

        await this.say(row.tenant_id, row.chat_id, acceptedText({
          title: row.title,
          projectName: projects.find((p) => String(p.id) === String(nextProject))?.name ?? null,
          assigneeName: people.find((p) => String(p.id) === String(nextAssignee))?.name ?? null,
          ready: status === 'ready',
        }));
        filled++;
      } catch (e) {
        this.log.warn(`ответ по наблюдению ${row.id}: ${(e as Error).message}`);
      }
    }
    return filled;
  }

  /** Разобрать один отрезок. Возвращает false, если проход не удался. */
  private async analyzeSegment(
    chat: DueChatRow, messages: MessageRow[], seg: Segment, mode: 'segment' | 'daily',
  ): Promise<boolean> {
    const runId = await this.repo.startRun({
      tenantId: chat.tenant_id, chatId: chat.chat_id, mode,
      startMessageId: seg.startId, endMessageId: seg.endId, messages: messages.length,
    });

    try {
      const [people, projects] = await Promise.all([
        this.repo.people(chat.tenant_id, chat.chat_id, chat.project_id),
        this.repo.projects(chat.tenant_id),
      ]);

      // Справочник: наружу уходят пометки, обратно принимаются только они (разд. 52).
      const userRef = new Map(people.map((p, i) => [String(p.id), `u${i + 1}`]));
      const projectRef = new Map(projects.map((p, i) => [String(p.id), `p${i + 1}`]));
      const catalog: RefCatalog = {
        users: new Map(people.map((p, i) => [`u${i + 1}`, String(p.id)])),
        projects: new Map(projects.map((p, i) => [`p${i + 1}`, String(p.id)])),
        messageIds: new Set(messages.map((m) => String(m.id))),
      };

      const payload = {
        today: new Date().toISOString(),
        timezone: chat.timezone,
        chat: {
          kind: chat.kind,
          title: chat.title,
          // Чат проекта сам по себе называет проект — это сильнейшее основание (разд. 9).
          project_ref: chat.project_id ? projectRef.get(String(chat.project_id)) ?? null : null,
        },
        people: people.map((p, i) => ({ ref: `u${i + 1}`, name: p.name })),
        projects: projects.map((p, i) => ({ ref: `p${i + 1}`, name: p.name })),
        messages: messages.map((m) => ({
          id: String(m.id),
          at: m.created_at,
          author_ref: m.author_id ? userRef.get(String(m.author_id)) ?? null : null,
          author: m.is_ai ? 'бот' : (m.author_name ?? 'неизвестно'),
          is_bot: m.is_ai,
          reply_to: m.reply_to_id,
          thread_root: m.thread_root_id,
          text: String(m.body ?? '').slice(0, 2000),
        })),
      };

      const prompt = await this.prompts.resolve(chat.tenant_id, 'chat.analysis', {}, chat.chat_id);
      const raw = await this.ai.generate(
        chat.tenant_id, prompt?.body ?? FALLBACK_SYSTEM, JSON.stringify(payload), 'chat_analysis',
        { promptVersionId: prompt?.versionId, model: prompt?.model, params: prompt?.params },
      );

      /*
        Проект берём САМИ, а не у модели.

        Живая проверка показала, чем это кончается иначе: в групповом чате, ни к какому
        проекту не привязанном, модель уверенно приписала задачу первому попавшемуся
        проекту организации. Твёрдых оснований ровно два — чат проекта и название,
        прозвучавшее в самом разговоре; остального не существует, и пусто честнее.
      */
      const said = messages.map((m) => String(m.body ?? '')).join('\n');
      const spoken = matchProjectInText(said, projects.map((p) => ({ id: String(p.id), name: p.name })));
      /*
        Кто НАЗВАН в разговоре. Без этого модель сама подбирает исполнителя по профилю
        («выгрузка» → бэкендщик), хотя в переписке его никто не упоминал, — поймано живой
        проверкой 29.09. Подбор по навыкам это отдельное решение, и выдавать его за
        прочитанное нельзя.
      */
      const namedInText = matchUserInText(said, people.map((p) => ({ id: String(p.id), name: p.name })));

      // Кто что написал: по авторству определяются постановщик и исполнитель.
      const authorOf = new Map(messages.map((m) => [String(m.id), m.author_id ? String(m.author_id) : null]));

      const actions = parseAnalysis(raw, catalog).map((a) => {
        const p = resolveProject({ chatProjectId: chat.project_id, spokenId: spoken });
        /*
          Роли — по самой переписке, а не по ответу модели (ТЗ разд. 10). Модель
          отвечает на вопрос «где здесь поручение», а «чьё оно» видно по тому, кто
          написал это сообщение. Неверный постановщик — худшая из ошибок функции.
        */
        const roles = resolveRoles({
          sources: a.sources.map((s) => ({ ...s, authorId: authorOf.get(s.messageId) ?? null })),
          modelAssigneeId: a.assigneeId,
          namedInText,
        });

        const fixed: ExtractedAction = {
          ...a,
          projectId: p.projectId,
          assignerId: roles.assignerId,
          assigneeId: roles.assigneeId,
          confidence: {
            ...a.confidence,
            project: p.confidence,
            assigner: roles.assignerConfidence,
            assignee: roles.assigneeConfidence,
          },
        };
        // Ключ от повторов считается в том числе по проекту и исполнителю — пересобираем.
        fixed.dedupKey = dedupKeyOf(fixed);

        /*
          Состояние наблюдения. Поручению его считаем: «готово» — человеку остаётся
          нажать «завести». Остальные виды на этом этапе просто замечены.
        */
        const status = fixed.type === 'task'
          ? taskReadiness({
            projectId: fixed.projectId, assigneeId: fixed.assigneeId, assignerId: fixed.assignerId,
            cancelled: roles.cancelled, confidence: fixed.confidence,
          })
          : 'detected';
        return { action: fixed, status, cancelled: roles.cancelled };
      });

      let stored = 0;
      /** Что записали в этот проход: из этого выбираем, о чём спросить. */
      const saved: { id: string; action: ExtractedAction; status: string; cancelled: boolean }[] = [];
      for (const { action: a, status, cancelled } of actions) {
        const id = await this.repo.addAction(chat.tenant_id, runId, chat.chat_id, a, status);
        if (!id) continue;
        stored++;
        saved.push({ id, action: a, status, cancelled });
      }
      await this.autoCreate(chat, saved);
      await this.askAbout(chat, saved);

      await this.repo.finishRun(runId, {
        status: 'done', model: prompt?.model ?? null,
        promptVersion: prompt?.version != null ? String(prompt.version) : null,
        actions: stored,
        // Всё, что модель вернула, но ключ отсёк как уже виденное.
        duplicates: actions.length - stored,
      });
      // Отметку двигаем только теперь: проход состоялся.
      await this.repo.moveCheckpoint(chat.tenant_id, chat.chat_id, seg.endId, runId);
      if (stored) this.log.log(`чат ${chat.chat_id}: наблюдений ${stored} из ${actions.length}`);
      return true;
    } catch (e) {
      const message = (e as Error).message || 'разбор не удался';
      await this.repo.finishRun(runId, { status: 'failed', error: message.slice(0, 500) });
      this.log.warn(`чат ${chat.chat_id}, отрезок ${seg.startId}–${seg.endId}: ${message}`);
      return false;
    }
  }
}

function toSegmentMessage(m: MessageRow): SegmentMessage {
  return { id: String(m.id), createdAt: new Date(m.created_at), authorId: m.author_id, isAi: m.is_ai };
}

export type { ExtractedAction };
