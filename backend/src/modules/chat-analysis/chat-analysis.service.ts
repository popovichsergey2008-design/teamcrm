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
import { autoLogDecision, noteReadiness, noteText, participantsOf, resolveTask, taskNumbersIn } from './journal-rules';
import { TaskActivityRepository } from '../tasks/task-activity.repository';
import {
  meetingAskText, meetingDescription, meetingParticipants, meetingReadiness, MEETING_MIN_INTENT, parseTimeAnswer,
  dayLabel,
} from './meeting-rules';
import { usersNamedInText } from '../nl/nl.match';
import { zonedToUtc } from '../tasks/recurrence';
import { CalendarService } from '../calendar/calendar.service';
import { TelegramMirror } from '../notifications/telegram-mirror.service';
import { alreadyCovered, chunks, cleanReasons, dailyDigest, keyMessages, rate } from './daily-rules';
import {
  canApplyChange, changeAskText, changeDoneText, changeReadiness, ChangeKind, CHANGE_MIN_INTENT,
  newAssigneeOf, parseYesNo, resolveChangeTarget, ruleCancellations,
} from './change-rules';
import { AwaitingRow, ChatAnalysisRepository, DueChatRow, MessageRow } from './chat-analysis.repository';
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
  '8. decision — только ПРИНЯТОЕ решение, а не предложение и не спор. «Может, оставим',
  '   старую форму?» — не решение; «решили: оставляем» — решение.',
  '9. Для status и blocker укажи task_ref из справочника tasks, если речь явно о',
  '   конкретной задаче. Не уверен — оставь пустым: о чужой задаче писать хуже, чем никуда.',
  '10. meeting — только ДОГОВОРЁННОСТЬ о встрече, а не «надо бы как-нибудь созвониться».',
  '   meeting_at — когда названы и дата, и время (в поясе timezone). Названа только дата —',
  '   meeting_at пусто, а дата в meeting_date как "2026-10-01". duration_minutes — если',
  '   сказали, сколько длится. Источник с предложением встречи — роль instruction.',
  '11. change — изменение УЖЕ ЗАВЕДЁННОЙ задачи из справочника tasks (from_this_chat —',
  '   заведены из этого чата): "change":"cancel" — отменили, "reassign" — отдали другому',
  '   (новый в assignee_ref), "deadline" — перенесли срок (новый в deadline). task_ref',
  '   обязателен. Новое поручение — это task, а не change. «По #1473 — пока не делай,',
  '   клиент передумал» — это change cancel к задаче #1473, а НЕ status: статус говорит о ходе',
  '   работы, а отмена, «не делай», «отбой», «пусть лучше X», «давайте до понедельника» о',
  '   заведённой задаче — это изменение.',
  '12. Сообщения бота (is_bot) — никогда не источник: он пересказывает уже сделанное.',
  '',
  'Формат ответа:',
  '{"actions":[{"type":"task","title":"...","description":"...","project_ref":"p1",',
  '"assigner_ref":"u1","assignee_ref":"u2","task_ref":null,"deadline":"2026-10-02T18:00:00+03:00",',
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
    /** Журнал задачи: строка из переписки должна быть видна и в её истории. */
    private readonly activity: TaskActivityRepository,
    /** Встречу ставим через обычный календарь: приглашения, напоминания, пересечения — его. */
    private readonly calendar: CalendarService,
    /** Полная сводка дня — в Telegram, как и вечерний свод. */
    private readonly telegram: TelegramMirror,
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
    patch: {
      enabled?: boolean; quietMinutes?: number; mode?: string; askInChat?: boolean; monthlyLimitUsd?: number | null;
      dailyEnabled?: boolean; dailyHour?: number; dailySummary?: boolean;
    },
  ) {
    return this.repo.saveSettings(tenantId, patch);
  }

  /**
   * Счётчики попадания и расход — то, на что владелец смотрит, прежде чем включать
   * автосоздание (ТЗ разд. 58). Решение «включать или нет» должно опираться на цифры с
   * его собственных переписок, а не на наше обещание.
   */
  async stats(tenantId: string) {
    const [counts, settings, spent, feedback, versions] = await Promise.all([
      this.repo.qualityCounts(tenantId),
      this.repo.settings(tenantId),
      this.repo.spentThisMonth(tenantId),
      this.repo.feedbackCounts(tenantId),
      this.repo.byVersion(tenantId),
    ]);
    const limit = settings.monthly_limit_usd != null ? Number(settings.monthly_limit_usd) : null;
    const q = quality(counts);
    return {
      quality: q,
      /*
        Метрики ТЗ разд. 58 поверх счётчиков этапа 4: доля «не хватило данных», ложные
        срабатывания (отвергнуто, отменено, «это не задача» в отзыве) и пропуски — задачи,
        которые люди завели из сообщения руками, хотя агент это сообщение не отметил.
      */
      metrics: {
        clarificationRate: rate(counts.needsClarification, counts.tasksDetected),
        falsePositiveRate: rate(counts.rejected + counts.undone + (feedback.reasons.not_action ?? 0), q.reviewed),
        feedbackRight: feedback.right,
        feedbackWrong: feedback.wrong,
        reasons: feedback.reasons,
        missed: feedback.missed,
      },
      versions: versions.map((v) => ({
        model: v.model, promptVersion: v.prompt_version, rulesVersion: v.rules_version,
        detected: Number(v.detected), reviewed: Number(v.reviewed), rejected: Number(v.rejected),
        corrected: Number(v.corrected), wrong: Number(v.wrong),
      })),
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
    patch: { projectId?: string; assigneeId?: string; title?: string; taskId?: string; startsAt?: string } = {},
  ) {
    const a = await this.repo.one(tenantId, userId, id);
    if (!a) throw AppException.notFound('Наблюдение не найдено');
    // Решение — в журнал, статус и блокер — в обсуждение задачи; задачей становится только поручение.
    if (a.action_type === 'decision') return this.logDecision(tenantId, a, userId, patch.title);
    if (a.action_type === 'status' || a.action_type === 'blocker') {
      return this.noteToTask(tenantId, a, userId, patch.taskId ?? a.task_id ?? null);
    }
    if (a.action_type === 'meeting') return this.scheduleMeeting(tenantId, a, userId, patch.startsAt ?? null);
    if (a.action_type === 'change') return this.applyChange(tenantId, a, { userId, role: await this.repo.roleOf(tenantId, userId) });
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

  /**
   * Записать решение в журнал (ТЗ разд. 24).
   *
   * `userId` пуст — записал агент сам (режим владельца). Участники решения — авторы
   * сообщений, из которых оно выросло: кто решал, тот и подписан, а не нажавший.
   */
  private async logDecision(tenantId: string, a: any, userId: string | null, title?: string) {
    if (a.created_entity_id) throw AppException.conflict('Это решение уже в журнале');
    if (['rejected', 'cancelled'].includes(a.status)) throw AppException.conflict('Наблюдение уже закрыто');
    const sources = await this.repo.sourcesOf(String(a.id));
    const main = sources.find((x) => x.role === 'decision') ?? sources[sources.length - 1] ?? null;
    const decisionId = await this.repo.addDecision({
      tenantId,
      projectId: a.project_id ?? null,
      chatId: String(a.chat_id),
      actionId: String(a.id),
      sourceMessageId: main?.message_id ?? null,
      text: String(title?.trim() || a.title).slice(0, 1000),
      details: String(a.description ?? ''),
      participants: participantsOf(sources.map((x) => ({ authorId: x.author_id }))),
      decidedAt: main ? new Date(main.created_at) : new Date(),
      createdBy: userId,
    });
    await this.repo.markAction(tenantId, String(a.id), {
      status: userId ? 'confirmed' : 'auto_created', entityType: 'decision', entityId: decisionId,
    });
    return { actionId: String(a.id), decisionId };
  }

  /**
   * Статус или блокер — строкой в обсуждение задачи (ТЗ разд. 5.8, 5.9).
   *
   * Новой задачи не заводим никогда. Пишем ТОЛЬКО по нажатию человека, даже в режиме
   * автосоздания: это слова в чужой задаче, их видят все её участники, и ошибка тут —
   * ложь о чужой работе.
   */
  private async noteToTask(tenantId: string, a: any, userId: string, taskId: string | null) {
    if (a.created_entity_id) throw AppException.conflict('Это уже добавлено в задачу');
    if (['rejected', 'cancelled'].includes(a.status)) throw AppException.conflict('Наблюдение уже закрыто');
    if (!taskId) throw AppException.validation('Непонятно, к какой задаче это относится — укажите номер задачи');
    const task = await this.repo.noteTarget(tenantId, String(taskId));
    if (!task) throw AppException.notFound('Задача не найдена или в корзине');

    const sources = await this.repo.sourcesOf(String(a.id));
    const main = sources.find((x) => x.author_id) ?? sources[0] ?? null;
    const body = noteText({
      type: a.action_type, title: a.title, author: main?.author_name ?? null,
      chat: a.chat_title ?? null, quote: main?.body ?? null,
    });
    const comment = await this.repo.addTaskNote(tenantId, task.id, body);
    await this.activity.log(tenantId, task.id, userId, `chat_${a.action_type}`, {
      commentId: comment?.id ?? null, actionId: String(a.id),
    });
    // false: строка внутренняя, в комнату заказчика её слать незачем
    this.realtime.emitScoped(tenantId, task.project_id, 'task.comment_added',
      { taskId: task.id, commentId: comment?.id ?? null, authorId: null }, false);

    await this.repo.markAction(tenantId, String(a.id), { status: 'confirmed', entityType: 'task_comment', entityId: comment?.id ?? null });
    await this.repo.setActionTask(tenantId, String(a.id), task.id);
    return { actionId: String(a.id), taskId: task.id, commentId: comment?.id ?? null };
  }

  /**
   * Применить изменение уже заведённой задачи (ТЗ разд. 30–32).
   *
   * Путь один и из чата («да» постановщика), и из панели: задачу меняет ЧЕЛОВЕК своими
   * правами — постановщик или владелец. Отмена — обычное удаление в корзину со всеми
   * проверками, переназначение — обычная правка, перенос — как решение о переносе срока.
   * Своего «тихого» пути менять задачи у агента нет.
   */
  private async applyChange(tenantId: string, a: any, user: { userId: string; role: string }) {
    if (a.created_entity_id || ['rejected', 'cancelled', 'confirmed'].includes(a.status)) {
      throw AppException.conflict('Это изменение уже рассмотрено');
    }
    const kind = a.change_kind as ChangeKind | null;
    if (!kind || !a.task_id) throw AppException.validation('Непонятно, что и в какой задаче поменять');
    const state = (await this.repo.taskStates(tenantId, [String(a.task_id)])).get(String(a.task_id));
    if (!state) throw AppException.notFound('Задача не найдена или уже в корзине');
    if (!canApplyChange({ userId: user.userId, role: user.role, creatorId: state.created_by })) {
      throw AppException.forbidden('Решает постановщик задачи или владелец');
    }

    const taskId = String(a.task_id);
    if (kind === 'cancel') {
      await this.tasks.removeByPerson(tenantId, taskId, user, { reason: 'Поручение отменили в переписке' });
    } else if (kind === 'reassign') {
      if (!a.assignee_id) throw AppException.validation('Непонятно, кому передать задачу');
      await this.tasks.update(tenantId, taskId, { assigneeId: String(a.assignee_id) } as any, user.userId);
    } else {
      if (!a.deadline_at) throw AppException.validation('Непонятно, на какой срок перенести');
      await this.tasks.setDeadlineByDecision(tenantId, taskId, user, new Date(a.deadline_at));
    }
    await this.repo.markAction(tenantId, String(a.id), { status: 'confirmed', entityType: 'task', entityId: taskId });

    const tz = await this.repo.timezoneOf(tenantId);
    await this.say(tenantId, String(a.chat_id), changeDoneText({
      kind, taskId, title: state.title,
      assigneeName: a.assignee_id ? await this.chats.userName(tenantId, String(a.assignee_id)) : null,
      deadlineLabel: a.deadline_at ? deadlineLabel(new Date(a.deadline_at), tz) : null,
    }));
    return { actionId: String(a.id), taskId, change: kind };
  }

  /**
   * Поставить встречу из переписки в календарь (ТЗ разд. 34–37).
   *
   * Только нажатием человека — даже в режиме автосоздания: приглашения уходят письмами,
   * а письмо не отзовёшь. Организатор — автор предложения, а не нажавший: событие в
   * календаре принадлежит ему, и переносить его вправе он. Пересечения, напоминания и
   * приглашения — обычные календарные, со всеми их проверками.
   *
   * `startsAt` — время, которое человек поставил сам, если агент его не узнал.
   */
  private async scheduleMeeting(tenantId: string, a: any, userId: string, startsAt: string | null) {
    if (a.created_entity_id) throw AppException.conflict('Эта встреча уже в календаре');
    if (['rejected', 'cancelled'].includes(a.status)) throw AppException.conflict('Наблюдение уже закрыто');
    const organizer = a.assigner_id ? String(a.assigner_id) : String(userId);
    const participants: string[] = (a.participant_ids ?? []).map(String);
    if (participants.length < 2) throw AppException.validation('Встрече нужны хотя бы двое участников');

    const start = startsAt ? new Date(startsAt) : (a.meeting_at ? new Date(a.meeting_at) : null);
    if (!start || Number.isNaN(start.getTime())) throw AppException.validation('Укажите, когда встреча');
    if (start.getTime() <= Date.now()) throw AppException.validation('Это время уже прошло — выберите другое');
    const end = new Date(start.getTime() + (Number(a.duration_minutes) || 30) * 60_000);

    const sources = await this.repo.sourcesOf(String(a.id));
    const main = sources.find((x) => x.role === 'instruction') ?? sources[0] ?? null;
    const event = await this.calendar.create(tenantId, { userId: organizer, role: 'member' }, {
      title: String(a.title).slice(0, 255),
      description: meetingDescription({ chat: a.chat_title ?? null, quote: main?.body ?? null, details: String(a.description ?? '') }),
      startsAt: start.toISOString(),
      endsAt: end.toISOString(),
      scope: 'personal',
      participantIds: participants.filter((id) => id !== organizer),
    });
    const eventId = String((event as any).id);
    await this.repo.setEventSource(tenantId, eventId, String(a.chat_id), main?.message_id ?? null);
    await this.repo.markAction(tenantId, String(a.id), { status: 'confirmed', entityType: 'calendar_event', entityId: eventId });

    // Участники договаривались в чате — там и узнают, что встреча в календаре.
    const names = (await Promise.all(participants.map((id) => this.chats.userName(tenantId, id)))).filter(Boolean);
    const when = start.toLocaleString('ru-RU', {
      day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', timeZone: await this.repo.timezoneOf(tenantId),
    });
    await this.say(tenantId, String(a.chat_id),
      `Поставил встречу «${a.title}» на ${when}. Участники: ${names.join(', ')} — приглашения в календаре.`);
    return { actionId: String(a.id), eventId };
  }

  // ── качество ──

  /**
   * «ИИ определил правильно?» (ТЗ разд. 59). Отзыв о наблюдении — из панели разбора.
   * Причины — из короткого списка: иначе их не посчитать и на них не поучиться.
   */
  async feedback(tenantId: string, userId: string, actionId: string, correct: boolean, reasons: unknown) {
    const a = await this.repo.one(tenantId, userId, actionId);
    if (!a) throw AppException.notFound('Наблюдение не найдено');
    await this.repo.saveFeedback(tenantId, actionId, userId, correct, cleanReasons(correct, reasons));
    return { actionId, correct };
  }

  /**
   * То же из карточки задачи, заведённой по переписке. Карточку видит и тот, кто в
   * исходном чате не состоит, — отзыв оставить он вправе, переписку от этого не увидит.
   */
  async feedbackByTask(tenantId: string, userId: string, taskId: string, correct: boolean, reasons: unknown) {
    const a = await this.repo.actionOfTask(tenantId, taskId);
    if (!a) throw AppException.notFound('Эта задача заведена не из разбора переписки');
    await this.repo.saveFeedback(tenantId, String(a.id), userId, correct, cleanReasons(correct, reasons));
    return { actionId: String(a.id), correct };
  }

  /** Примеры для проверки (ТЗ разд. 59) — только по чатам, видным выгружающему. */
  examples(tenantId: string, userId: string) {
    return this.repo.examples(tenantId, userId);
  }

  // ── суточная сверка ──

  /**
   * Суточная сверка (ТЗ разд. 3.3, 19, 27–29).
   *
   * В заданный владельцем час по поясу организации агент ещё раз проходит весь день
   * переписки: разбор по затиханию видел её кусками. Уже разобранное узнаётся по
   * сообщениям-источникам и заново не пишется. Потом — короткая сводка руководству.
   *
   * День занимается ДО прохода: второй экземпляр сервера или повторный запуск в ту же
   * ночь не пройдут его ещё раз и не пришлют вторую сводку.
   */
  async daily(now = new Date()): Promise<number> {
    let done = 0;
    for (const t of await this.repo.dailyDue(now)) {
      if (!(await this.repo.claimDaily(t.tenant_id, t.local_date))) continue;
      try {
        const limit = t.monthly_limit_usd != null ? Number(t.monthly_limit_usd) : null;
        const over = limit != null && overLimit(await this.repo.spentThisMonth(t.tenant_id), limit);
        // Потолок исчерпан — не читаем, но сводку о том, что уже сделано за день, шлём.
        if (!over) await this.passDay(t.tenant_id, now);
        if (t.daily_summary) await this.sendDigest(t.tenant_id, new Date(now.getTime() - 24 * 3600_000), t.local_date);
        done++;
      } catch (e) {
        this.log.warn(`суточная сверка ${t.tenant_id}: ${(e as Error).message}`);
      }
    }
    return done;
  }

  /**
   * Сверка по кнопке — проверить настройку, не дожидаясь ночи. Сегодняшний день НЕ
   * занимает и сводку никому не шлёт: ночная сверка и сводка придут как обычно, а
   * сводку нажавший видит на экране.
   */
  async dailyNow(tenantId: string, now = new Date()) {
    const settings = await this.repo.settings(tenantId);
    if (!settings.enabled) throw AppException.conflict('Разбор переписки выключен');
    const limit = settings.monthly_limit_usd != null ? Number(settings.monthly_limit_usd) : null;
    if (limit != null && overLimit(await this.repo.spentThisMonth(tenantId), limit)) {
      throw AppException.conflict('Потолок расхода на этот месяц исчерпан');
    }
    const chats = await this.passDay(tenantId, now);
    const digest = dailyDigest(await this.repo.dayStats(tenantId, new Date(now.getTime() - 24 * 3600_000)));
    return { chats, digest: digest?.long ?? null };
  }

  /** Проход по дню одной организации: рабочие чаты, где за сутки была переписка. */
  private async passDay(tenantId: string, now: Date): Promise<number> {
    const since = new Date(now.getTime() - 24 * 3600_000);
    let chats = 0;
    for (const chat of await this.repo.dailyChats(tenantId, since)) {
      // Живой хвост не трогаем: его разберут, когда разговор затихнет.
      const until = new Date(now.getTime() - Math.max(chat.quiet_minutes, 1) * 60_000);
      const messages = await this.repo.messagesBetween(tenantId, chat.chat_id, since, until);
      let ok = true;
      for (const part of chunks(messages)) {
        const last = part[part.length - 1];
        const seg: Segment = {
          startId: String(part[0].id), endId: String(last.id),
          startedAt: new Date(part[0].created_at), endedAt: new Date(last.created_at), count: part.length,
        };
        ok = await this.analyzeSegment(chat, part, seg, 'daily');
        if (!ok) break; // модель недоступна — остальное дождётся затихания и следующей ночи
      }
      if (messages.length && ok) chats++;
    }
    return chats;
  }

  /** Сводка дня руководству (ТЗ разд. 27–28): короткая — строкой ассистента, полная — в Telegram. */
  private async sendDigest(tenantId: string, since: Date, localDate: string): Promise<void> {
    const digest = dailyDigest(await this.repo.dayStats(tenantId, since));
    if (!digest) return;
    for (const userId of await this.repo.managers(tenantId)) {
      const id = await this.repo.addDigestPing(tenantId, userId, digest.short, localDate);
      if (!id) continue; // уже присылали сегодня
      this.realtime.emitToUsers(tenantId, [userId], 'assistant.ping', { id, text: digest.short, taskId: null });
      void this.telegram.push(tenantId, userId, digest.long);
    }
  }

  // ── журнал решений ──

  decisions(tenantId: string, userId: string, o: { chatId?: string | null; projectId?: string | null; withRevoked?: boolean }) {
    return this.repo.decisions(tenantId, userId, o);
  }

  /**
   * Снять решение: записано по ошибке или передумали. Строка остаётся с пометкой —
   * «решали и передумали» тоже история. Снять могут руководство, записавший и участники.
   */
  async revokeDecision(tenantId: string, user: { userId: string; role: string }, id: string) {
    const d = await this.repo.oneDecision(tenantId, user.userId, id);
    if (!d) throw AppException.notFound('Решение не найдено');
    if (d.revoked_at) return { decisionId: id, revoked: true };
    const me = String(user.userId);
    const allowed = user.role === 'owner' || user.role === 'manager'
      || String(d.created_by ?? '') === me || (d.participants ?? []).map(String).includes(me);
    if (!allowed) throw AppException.forbidden('Снять решение могут участники, записавший или руководитель');
    await this.repo.revokeDecision(tenantId, id, user.userId);
    return { decisionId: id, revoked: true };
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
    /*
      Решение, которое агент записал сам, отменяется снятием из журнала — со своими
      правами (участники решения тоже вправе) и без сообщения в чат: запись в журнале
      ни на кого не ложилась, и шуметь об её снятии незачем.
    */
    if (a.created_entity_type === 'decision') {
      if (a.status !== 'auto_created') throw AppException.conflict('Отменить можно только то, что агент записал сам');
      await this.revokeDecision(tenantId, user, String(a.created_entity_id));
      await this.repo.markUndone(tenantId, id, user.userId);
      return { actionId: id, status: 'cancelled' };
    }
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
      /*
        Изменение заведённой задачи (ТЗ разд. 30): молча не трогаем — спрашиваем
        постановщика. Правила те же: уверенность, рабочее время, один вопрос за проход.
      */
      if (s.action.type === 'change') {
        if (!chat.ask_in_chat || !working || s.status !== 'ready' || !s.action.changeKind) continue;
        if (s.action.confidence.intent < CHANGE_MIN_INTENT || !s.action.assignerId || !s.action.taskId) continue;
        const state = (await this.repo.taskStates(chat.tenant_id, [String(s.action.taskId)])).get(String(s.action.taskId));
        if (!state) continue;
        const [who, assigneeName] = await Promise.all([
          this.chats.userName(chat.tenant_id, s.action.assignerId),
          s.action.assigneeId ? this.chats.userName(chat.tenant_id, s.action.assigneeId) : null,
        ]);
        const message = await this.say(chat.tenant_id, chat.chat_id, changeAskText({
          who, kind: s.action.changeKind as ChangeKind, taskId: String(s.action.taskId), title: state.title,
          assigneeName, deadlineLabel: s.action.deadlineAt ? deadlineLabel(s.action.deadlineAt, chat.timezone) : null,
        }));
        if (message) {
          await this.repo.markAsked(chat.tenant_id, s.id, String(message.id));
          this.log.log(`чат ${chat.chat_id}: спросили об изменении задачи #${s.action.taskId}`);
        }
        return; // один вопрос за проход
      }
      /*
        Встреча с датой, но без времени (ТЗ разд. 35): спрашиваем организатора. Те же
        ограничения, что у поручений: уверенность, рабочее время, один раз, один вопрос
        за проход.
      */
      if (s.action.type === 'meeting') {
        if (!chat.ask_in_chat || !working || s.status !== 'needs_clarification' || !s.action.meetingDate) continue;
        if (s.action.confidence.intent < MEETING_MIN_INTENT || !s.action.assignerId) continue;
        const who = await this.chats.userName(chat.tenant_id, s.action.assignerId);
        const message = await this.say(chat.tenant_id, chat.chat_id,
          meetingAskText({ who, title: s.action.title, date: s.action.meetingDate }));
        if (message) {
          await this.repo.markAsked(chat.tenant_id, s.id, String(message.id));
          this.log.log(`чат ${chat.chat_id}: спросили время встречи «${s.action.title}»`);
        }
        return; // один вопрос за проход
      }
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
   * Записать принятые решения в журнал самому — в режиме, который включил владелец
   * (ТЗ разд. 16: Decisions — AUTO LOG). В чат об этом не пишем: запись в журнале ни на
   * кого не ложится, а сообщение бота после каждого решения было бы шумом.
   */
  private async autoLog(
    chat: DueChatRow,
    saved: { id: string; action: ExtractedAction; status: string; cancelled: boolean }[],
  ): Promise<void> {
    for (const s of saved) {
      if (!autoLogDecision({ mode: chat.mode, type: s.action.type, status: s.status })) continue;
      try {
        const a = await this.repo.oneForSystem(chat.tenant_id, s.id);
        if (!a) continue;
        await this.logDecision(chat.tenant_id, a, null);
        s.status = 'auto_created';
      } catch (e) {
        this.log.warn(`решение ${s.id} в журнал: ${(e as Error).message}`);
      }
    }
  }

  /**
   * Ответ постановщика на вопрос об изменении.
   *
   * «Да» — меняем его руками и с его правами (не сумели — говорим, почему, и изменение
   * остаётся в разборе). «Оставить» — закрываем наблюдение: это тоже промах агента, и
   * счётчики его видят. Непонятный ответ — не ответ.
   */
  private async answerChange(row: AwaitingRow, text: string): Promise<boolean> {
    const verdict = parseYesNo(text);
    if (!verdict) return false;
    const a = await this.repo.oneForSystem(row.tenant_id, row.id);
    if (!a) return false;
    if (verdict === 'no') {
      await this.repo.markAction(row.tenant_id, row.id, { status: 'rejected' });
      await this.say(row.tenant_id, row.chat_id, 'Понял, оставляю задачу как есть.');
      return true;
    }
    try {
      const role = await this.repo.roleOf(row.tenant_id, String(row.assigner_id));
      await this.applyChange(row.tenant_id, a, { userId: String(row.assigner_id), role });
    } catch (e) {
      await this.say(row.tenant_id, row.chat_id,
        `Не получилось: ${(e as Error).message}. Изменение осталось в «Разборе переписки» — его можно применить оттуда.`);
      // Второй раз не пробуем: вопрос снят, решать дальше — руками из разбора.
      await this.repo.markAction(row.tenant_id, row.id, { status: 'detected' });
    }
    return true;
  }

  /**
   * Время встречи из ответа организатора.
   *
   * Дата уже известна из разговора, время — из ответа, пояс — организации. Время в
   * прошлом (ответили поздно) не принимаем: встреча остаётся ждать, её поставят руками.
   */
  private async fillMeetingTime(row: AwaitingRow, text: string, now: Date): Promise<boolean> {
    const time = parseTimeAnswer(text);
    if (!time || !row.meeting_date) return false;
    const [y, m, d] = row.meeting_date.split('-').map(Number);
    const at = zonedToUtc(y, m, d, time, row.timezone || 'Europe/Moscow');
    const status = meetingReadiness({
      intent: Number(row.intent_confidence), meetingAt: at, meetingDate: row.meeting_date,
      participants: row.participant_ids ?? [], cancelled: false, now,
    });
    if (status !== 'ready') return false;
    await this.repo.fillMeeting(row.tenant_id, row.id, { meetingAt: at, status });
    await this.say(row.tenant_id, row.chat_id,
      `Принял: ${dayLabel(row.meeting_date)}, ${time}. Встреча «${row.title}» готова — осталось поставить её в календарь.`);
    return true;
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

        // Изменение ждёт «да» или «оставить» постановщика.
        if (row.action_type === 'change') {
          if (await this.answerChange(row, text)) filled++;
          continue;
        }

        // Встреча ждёт времени: берём его из ответа организатора и складываем с датой.
        if (row.action_type === 'meeting') {
          if (await this.fillMeetingTime(row, text, now)) filled++;
          continue;
        }

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

      /*
        Справочник задач — только для статуса и блокера, и узкий: открытые задачи тех, кто
        в этом разговоре писал. Выбор модели из него ещё не привязка — её решает
        `resolveTask` по основаниям.
      */
      const authorIds = [...new Set(messages.map((m) => m.author_id).filter((x): x is string => !!x))];
      /*
        Плюс задачи, РОДИВШИЕСЯ в этом чате (этап 7): «не делай, клиент передумал» в том
        же разговоре относится к ним. Только такие модель вправе выбрать для изменения.
      */
      const bornRows = await this.repo.bornHereTasks(chat.tenant_id, chat.chat_id);
      const bornHere = new Set(bornRows.map((t) => String(t.id)));
      const ownRows = await this.repo.candidateTasks(chat.tenant_id, authorIds, chat.project_id);
      const candidates = [...bornRows, ...ownRows.filter((t) => !bornHere.has(String(t.id)))];
      catalog.tasks = new Map(candidates.map((t, i) => [`t${i + 1}`, String(t.id)]));
      const owners = new Map(ownRows.map((t) => [String(t.id), { assigneeId: t.assignee_id, creatorId: t.created_by }]));
      const named = [...new Set(messages.flatMap((m) => [
        ...taskNumbersIn(String(m.body ?? '')), ...(m.task_id ? [String(m.task_id)] : []),
      ]))];
      const alive = await this.repo.aliveTasks(chat.tenant_id, named);
      const messageById = new Map(messages.map((m) => [String(m.id), m]));
      // Как задачи выглядят сейчас: изменение «на то же самое» — не изменение.
      const states = await this.repo.taskStates(chat.tenant_id, [...bornHere, ...alive]);

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
        tasks: candidates.map((t, i) => ({
          ref: `t${i + 1}`, number: `#${t.id}`, title: t.title,
          assignee_ref: t.assignee_id ? userRef.get(String(t.assignee_id)) ?? null : null,
          from_this_chat: bornHere.has(String(t.id)),
        })),
        messages: messages.map((m) => ({
          id: String(m.id),
          at: m.created_at,
          author_ref: m.author_id ? userRef.get(String(m.author_id)) ?? null : null,
          author: m.is_ai ? 'бот' : (m.author_name ?? 'неизвестно'),
          is_bot: m.is_ai,
          reply_to: m.reply_to_id,
          thread_root: m.thread_root_id,
          text: String(m.body ?? '').slice(0, 2000),
          // Пересланная карточка задачи: о ней, скорее всего, и речь.
          task: m.task_id ? `#${m.task_id}` : null,
        })),
      };

      const prompt = await this.prompts.resolve(chat.tenant_id, 'chat.analysis', {}, chat.chat_id);
      // Модель — та, что ответила: по ней сравнивают качество версий (ТЗ разд. 60).
      const { text: raw, model: usedModel } = await this.ai.generateWithModel(
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
      // Все названные — для «Юра, сделай — нет, пусть Глеб» (ТЗ разд. 31), где имён два.
      const peopleNamed = people.map((p) => ({ id: String(p.id), name: p.name }));
      const namedIds = usersNamedInText(said, peopleNamed);
      const textOf = (ids: string[]) => ids.map((id) => String(messageById.get(id)?.body ?? '')).join('\n');

      // Кто что написал: по авторству определяются постановщик и исполнитель.
      const authorOf = new Map(messages.map((m) => [String(m.id), m.author_id ? String(m.author_id) : null]));

      /*
        Сообщения бота источником не бывают. Живая проверка 30.09: бот написал «Поставил
        встречу … на 1 октября в 15:00», и модель завела из этого вторую встречу — а от
        повтора ключ по источникам не спас, потому что источник был другой. Наблюдение,
        у которого не осталось ни одного сообщения человека, выбрасываем целиком.
      */
      const human = parseAnalysis(raw, catalog)
        .map((a) => ({ ...a, sources: a.sources.filter((x) => !messageById.get(x.messageId)?.is_ai) }))
        .filter((a) => a.sources.length > 0);
      /*
        Страховка: отмену, названную прямым текстом с номером задачи, берём правилом, если
        модель о ней промолчала (живая проверка 30.09). Дальше она идёт тем же путём, что
        и найденная моделью: цель по номеру, вопрос постановщику, решает он.
      */
      for (const c of ruleCancellations(
        messages.map((m) => ({ id: String(m.id), body: String(m.body ?? ''), isAi: m.is_ai })), alive, taskNumbersIn,
      )) {
        const seen = human.some((a) => a.type === 'change' && a.changeKind === 'cancel'
          && (a.taskId === c.taskId || a.sources.some((x) => x.messageId === c.messageId)));
        if (seen) continue;
        const rule: ExtractedAction = {
          type: 'change', title: `Отмена задачи #${c.taskId}`, description: '',
          projectId: null, assignerId: null, assigneeId: null, taskId: c.taskId,
          deadlineAt: null, meetingAt: null, meetingDate: null, durationMinutes: null, participantIds: [],
          changeKind: 'cancel',
          // Номер и слово отмены названы прямо — это не догадка.
          confidence: { intent: 0.95, project: 0, assigner: 0, assignee: 0, task: 0 },
          sources: [{ messageId: c.messageId, role: 'cancellation' }],
          dedupKey: '',
        };
        rule.dedupKey = dedupKeyOf(rule);
        human.push(rule);
      }
      const actions = human.map((a) => {
        const p = resolveProject({ chatProjectId: chat.project_id, spokenId: spoken });
        /*
          Роли — по самой переписке, а не по ответу модели (ТЗ разд. 10). Модель
          отвечает на вопрос «где здесь поручение», а «чьё оно» видно по тому, кто
          написал это сообщение. Неверный постановщик — худшая из ошибок функции.
        */
        /*
          Последняя правка с одним названным человеком — финальный исполнитель: «нет,
          пусть Глеб возьмёт». Автора правки не считаем: он говорит о другом, не о себе.
        */
        const lastFix = [...a.sources].reverse().find((x) => x.role === 'correction');
        const fixNamed = lastFix
          ? usersNamedInText(textOf([lastFix.messageId]), peopleNamed)
            .filter((id) => id !== (authorOf.get(lastFix.messageId) ?? ''))
          : [];
        const roles = resolveRoles({
          sources: a.sources.map((s) => ({ ...s, authorId: authorOf.get(s.messageId) ?? null })),
          modelAssigneeId: a.assigneeId,
          namedInText,
          namedIds,
          correction: lastFix && fixNamed.length === 1 ? { messageId: lastFix.messageId, assigneeId: fixNamed[0] } : null,
        });

        /*
          Задача статуса и блокера — по основаниям (journal-rules): пересланная карточка
          или названный номер, иначе выбор модели, но только если это задача автора.
        */
        const onTask = a.type === 'status' || a.type === 'blocker';
        const taskSources = a.sources.map((x) => {
          const m = messageById.get(x.messageId);
          return {
            messageId: x.messageId, authorId: m?.author_id ? String(m.author_id) : null,
            sharedTaskId: m?.task_id ? String(m.task_id) : null, text: String(m?.body ?? ''),
          };
        });
        const isChange = a.type === 'change';
        const t = onTask
          ? resolveTask({ sources: taskSources, alive, modelTaskId: a.taskId, owners })
          : isChange
            // Изменение — только к задаче, родившейся здесь, или к названной номером.
            ? resolveChangeTarget({ sources: taskSources, alive, modelTaskId: a.taskId, bornHere })
            : { taskId: null, confidence: 0 };
        const current = isChange && t.taskId ? states.get(String(t.taskId)) ?? null : null;
        const changeAssignee = isChange && a.changeKind === 'reassign'
          ? newAssigneeOf({
            modelAssigneeId: a.assigneeId,
            named: usersNamedInText(textOf(a.sources.map((x) => x.messageId)), peopleNamed),
            authors: taskSources.map((x) => x.authorId),
          })
          : null;

        /*
          Встреча: организатор — автор первого сообщения договорённости (предложил он),
          участники — договаривавшиеся и названные по имени в этих сообщениях. Модель
          участников не называет вовсе: звать людей по её догадке нельзя.
        */
        const isMeeting = a.type === 'meeting';
        const meetingAuthors = isMeeting
          ? a.sources.map((x) => messageById.get(x.messageId))
            .filter((m): m is MessageRow => !!m && !m.is_ai)
            .sort((x, y) => Number(x.id) - Number(y.id))
            .map((m) => (m.author_id ? String(m.author_id) : null))
          : [];
        const organizerId = meetingAuthors.find((id) => !!id) ?? null;
        const participantIds = isMeeting
          ? meetingParticipants({
            organizerId,
            named: usersNamedInText(
              a.sources.map((x) => String(messageById.get(x.messageId)?.body ?? '')).join('\n'),
              people.map((pp) => ({ id: String(pp.id), name: pp.name })),
            ),
            authors: meetingAuthors,
          })
          : [];

        const fixed: ExtractedAction = {
          ...a,
          projectId: p.projectId,
          /*
            У изменения «постановщик» — постановщик самой задачи: спрашивать будем его,
            и только он (или владелец) вправе задачу поменять.
          */
          assignerId: isMeeting ? organizerId : isChange ? (current?.created_by ?? null) : roles.assignerId,
          assigneeId: isMeeting ? null : isChange ? changeAssignee : roles.assigneeId,
          deadlineAt: isChange && a.changeKind !== 'deadline' ? null : a.deadlineAt,
          participantIds,
          taskId: t.taskId,
          confidence: {
            ...a.confidence,
            project: p.confidence,
            assigner: roles.assignerConfidence,
            assignee: roles.assigneeConfidence,
            task: t.confidence,
          },
        };
        // Ключ от повторов считается в том числе по проекту и исполнителю — пересобираем.
        fixed.dedupKey = dedupKeyOf(fixed);

        /*
          Состояние наблюдения: «готово» — человеку остаётся нажать одну кнопку. Решению
          для этого хватает уверенности, статусу и блокеру нужна ещё задача.
        */
        const status = fixed.type === 'task'
          ? taskReadiness({
            projectId: fixed.projectId, assigneeId: fixed.assigneeId, assignerId: fixed.assignerId,
            cancelled: roles.cancelled, confidence: fixed.confidence,
          })
          : fixed.type === 'change'
            ? changeReadiness({
              kind: fixed.changeKind, intent: fixed.confidence.intent, taskId: fixed.taskId,
              newAssigneeId: fixed.assigneeId, newDeadline: fixed.deadlineAt,
              current: current ? { assigneeId: current.assignee_id, deadline: current.deadline_at ? new Date(current.deadline_at) : null } : null,
            })
          : fixed.type === 'meeting'
            ? meetingReadiness({
              intent: fixed.confidence.intent, meetingAt: fixed.meetingAt, meetingDate: fixed.meetingDate,
              participants: fixed.participantIds, cancelled: roles.cancelled, now: new Date(),
            })
            : noteReadiness({
              type: fixed.type, intent: fixed.confidence.intent, taskId: fixed.taskId, cancelled: roles.cancelled,
            });
        return { action: fixed, status, cancelled: roles.cancelled };
      });

      let stored = 0;
      /** Что записали в этот проход: из этого выбираем, о чём спросить. */
      const saved: { id: string; action: ExtractedAction; status: string; cancelled: boolean }[] = [];
      /*
        Уже разобранное (ТЗ разд. 29): суточная сверка видит те же сообщения, что и
        разбор по затиханию, а модель на второй раз сформулирует то же иначе — ключ по
        тексту тут не спасёт. Узнаём по ключевым сообщениям-источникам.
      */
      const covered = await this.repo.coveredBy(chat.tenant_id, messages.map((m) => String(m.id)));
      for (const { action: a, status, cancelled } of actions) {
        // Изменение «на то же самое» не записываем: спрашивать о нём не о чем.
        if (status === 'noop') continue;
        const keys = keyMessages(a.sources);
        if (alreadyCovered({ type: a.type, keys }, covered)) continue;
        covered.push({ type: a.type, messageIds: keys });
        const id = await this.repo.addAction(chat.tenant_id, runId, chat.chat_id, a, status);
        if (!id) continue;
        stored++;
        saved.push({ id, action: a, status, cancelled });
      }
      await this.autoCreate(chat, saved);
      await this.autoLog(chat, saved);
      await this.askAbout(chat, saved);

      await this.repo.finishRun(runId, {
        status: 'done', model: usedModel ?? prompt?.model ?? null,
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

/** «5 октября, 18:00» — срок словами, в поясе организации. */
function deadlineLabel(d: Date, tz: string): string {
  return d.toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', timeZone: tz || 'Europe/Moscow' });
}

function toSegmentMessage(m: MessageRow): SegmentMessage {
  return { id: String(m.id), createdAt: new Date(m.created_at), authorId: m.author_id, isAi: m.is_ai };
}

export type { ExtractedAction };
