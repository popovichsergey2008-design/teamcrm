import { Injectable } from '@nestjs/common';
import { AppException } from '../../common/http/app-exception';
import { NlService } from '../nl/nl.service';
import { ChatsAiService } from './chats-ai.service';
import { DiagService } from '../diagnostics/diag.service';
import { FilesService } from '../files/files.service';
import { RealtimeService } from '../realtime/realtime.service';
import { ChatRow, ChatsRepository } from './chats.repository';

const PAGE = 50;

/**
 * Мессенджер команды: личные диалоги, группы и чаты проектов.
 *
 * Доступ: у dm и group — по членству; у чата проекта — у всей команды, потому что
 * доступ к проектам в CRM и так общий. Заказчик (client) в командные чаты не входит:
 * у него отдельный портал, и переписка команды не для его глаз.
 */
@Injectable()
export class ChatsService {
  constructor(
    private readonly repo: ChatsRepository,
    private readonly files: FilesService,
    private readonly realtime: RealtimeService,
    private readonly diag: DiagService,
    /** Разбор фразы в задачу — тот же, что у голосовой постановки: два механизма
        для одного и того же разошлись бы на первой правке. */
    private readonly nl: NlService,
    private readonly chatAi: ChatsAiService,
  ) {}

  /** Список чатов + кто сейчас в сети (точка рядом с именем). */
  async list(tenantId: string, userId: string) {
    const chats = await this.repo.listForUser(tenantId, userId);
    const online = new Set(this.realtime.onlineUsers(tenantId));
    return chats.map((c) => ({
      id: c.id,
      kind: c.kind,
      title: c.kind === 'dm' ? c.peer_name : c.kind === 'project' ? c.project_name : c.title,
      peerId: c.peer_id,
      peerOnline: c.peer_id ? online.has(String(c.peer_id)) : false,
      avatarUrl: c.peer_avatar ? `/api/files/${c.peer_avatar}` : null,
      projectId: c.project_id,
      unread: Number(c.unread ?? 0),
      lastBody: c.last_body,
      lastAuthor: c.last_author,
      lastAt: c.last_at,
      // избранное личное: у каждого свои четыре закреплённых чата
      favorite: c.favorite === true,
      isPrivate: c.is_private !== false,
      description: c.description ?? null,
      // Список собирается явным объектом: новое поле репозитория само сюда не доедет —
      // на этом мы уже обожглись со звездой «в избранном».
      isExternal: c.is_external === true,
    }));
  }

  /** Доступ к чату + сам чат. Единая точка проверки для всех операций. */
  private async access(tenantId: string, chatId: string, user: { userId: string; role: string }): Promise<ChatRow> {
    if (user.role === 'client') throw AppException.forbidden('Чаты команды недоступны');
    const chat = await this.repo.get(tenantId, chatId);
    if (!chat) throw AppException.notFound('Чат не найден');
    if (chat.kind !== 'project' && !(await this.repo.isMember(chatId, user.userId))) {
      throw AppException.forbidden('Вы не участник этого чата');
    }
    return chat;
  }

  /** Кому слать событие: участникам чата, а для чата проекта — всей команде. */
  private recipients(chat: ChatRow, tenantId: string): Promise<string[]> {
    return chat.kind === 'project' ? this.repo.teamIds(tenantId) : this.repo.memberIds(chat.id);
  }

  async openDm(tenantId: string, userId: string, peerId: string) {
    if (String(peerId) === String(userId)) throw AppException.validation('Нельзя написать самому себе');
    const key = ChatsRepository.dmKey(userId, peerId);
    const existing = await this.repo.findDm(tenantId, key);
    const chat = existing ?? (await this.repo.createDm(tenantId, userId, peerId));
    return { id: chat.id, kind: chat.kind };
  }

  async createGroup(tenantId: string, userId: string, title: string, userIds: string[]) {
    const name = title.trim();
    if (!name) throw AppException.validation('Назовите группу');
    const chat = await this.repo.createGroup(tenantId, userId, name.slice(0, 160), userIds.map(String));
    this.realtime.emitToUsers(tenantId, [userId, ...userIds], 'chat.created', { chatId: chat.id, title: name });
    return { id: chat.id, kind: chat.kind, title: name };
  }

  /**
   * Канал — общая тема, а не переписка нескольких человек.
   *
   * Публичный виден всей компании и вступают в него сами; приватный — как группа,
   * только с названием темы. Разница не косметическая: в публичном канале копится
   * общее знание, и запирать его на приглашения значит потерять смысл затеи.
   */
  async createChannel(
    tenantId: string, user: { userId: string; role: string },
    dto: { title: string; description?: string; isPrivate?: boolean; userIds?: string[] },
  ) {
    if (user.role === 'client') throw AppException.forbidden('Чаты команды недоступны');
    const title = (dto.title ?? '').trim();
    if (!title) throw AppException.validation('Назовите канал');
    const chat = await this.repo.createChannel({
      tenantId, userId: user.userId,
      title: title.slice(0, 160),
      description: (dto.description ?? '').trim().slice(0, 300) || null,
      isPrivate: dto.isPrivate !== false, // умолчание — приватный: раскрыть проще, чем спрятать
      userIds: (dto.userIds ?? []).map(String),
    });
    this.realtime.emitToUsers(tenantId, [user.userId, ...(dto.userIds ?? []).map(String)], 'chat.created', {
      chatId: chat.id, title,
    });
    return { id: chat.id, kind: chat.kind, title };
  }

  /**
   * Внешний чат с человеком со стороны.
   *
   * Заводится явно и отдельно от внутренних: разговор при клиенте и разговор о клиенте —
   * не одно и то же, и путать их нельзя ни при каких настройках видимости.
   */
  async createExternal(
    tenantId: string, user: { userId: string; role: string },
    dto: { title: string; clientId?: string; userIds?: string[] },
  ) {
    if (user.role === 'client') throw AppException.forbidden('Чаты команды недоступны');
    const title = (dto.title ?? '').trim();
    if (!title) throw AppException.validation('Назовите разговор — например, «ООО Вектор»');
    const chat = await this.repo.createExternal({
      tenantId, userId: user.userId, title: title.slice(0, 160),
      clientId: dto.clientId ?? null, userIds: (dto.userIds ?? []).map(String),
    });
    this.realtime.emitToUsers(tenantId, [user.userId, ...(dto.userIds ?? []).map(String)], 'chat.created', {
      chatId: chat.id, title,
    });
    return { id: chat.id, kind: chat.kind, title };
  }

  /**
   * Переписка глазами внешнего участника.
   *
   * Он видит ТОЛЬКО этот чат и только если чат помечен внешним. Проверка не косметика:
   * гостевой токен выдаётся по ссылке, а ссылку пересылают — и она не должна открывать
   * ничего, кроме того разговора, ради которого её выдали.
   */
  async guestMessages(tenantId: string, chatId: string) {
    const chat = await this.repo.get(tenantId, chatId);
    if (!chat || !chat.is_external) throw AppException.forbidden('Этот разговор недоступен по ссылке');
    return this.repo.messages(tenantId, chatId, null, 50, '0');
  }

  /** Сообщение от внешнего участника: имя он назвал при входе по ссылке. */
  async guestSend(tenantId: string, chatId: string, guestName: string, body: string) {
    const chat = await this.repo.get(tenantId, chatId);
    if (!chat || !chat.is_external) throw AppException.forbidden('Этот разговор недоступен по ссылке');
    const text = (body ?? '').trim();
    if (!text) throw AppException.validation('Пустое сообщение');
    const message = await this.repo.addGuestMessage(tenantId, chatId, guestName, text.slice(0, 8000));
    // Сотрудникам это обычное новое сообщение — с пометкой, что писал человек со стороны.
    const to = await this.recipients(chat, tenantId);
    this.realtime.emitToUsers(tenantId, to, 'chat.message', { chatId, message });
    return message;
  }

  /** Витрина «Все каналы»: публичные каналы компании и кнопка «Вступить». */
  channels(tenantId: string, user: { userId: string; role: string }) {
    if (user.role === 'client') throw AppException.forbidden('Чаты команды недоступны');
    return this.repo.publicChannels(tenantId, user.userId);
  }

  /**
   * Вступить в канал.
   *
   * Только в публичный: в приватный входят по приглашению, иначе «приватный» —
   * это просто слово в интерфейсе.
   */
  async joinChannel(tenantId: string, chatId: string, user: { userId: string; role: string }) {
    if (user.role === 'client') throw AppException.forbidden('Чаты команды недоступны');
    const chat = await this.repo.get(tenantId, chatId);
    if (!chat || chat.kind !== 'channel') throw AppException.notFound('Канал не найден');
    if (chat.is_private) throw AppException.forbidden('Это закрытый канал — в него приглашают');
    await this.repo.join(tenantId, chatId, user.userId);
    return { id: chat.id, kind: chat.kind, title: chat.title };
  }

  /** Закрепить чат сверху списка или снять. Порядок личный. */
  async toggleFavorite(tenantId: string, chatId: string, user: { userId: string; role: string }) {
    await this.access(tenantId, chatId, user);
    const favorite = await this.repo.toggleFavorite(tenantId, chatId, user.userId);
    return { favorite };
  }

  /**
   * Чат с собой — «Заметки».
   *
   * Ссылки, куски кода, мысли на потом: их складывают в диалог с самим собой в любом
   * мессенджере, и без такого чата люди пишут это коллеге «чтобы не потерять».
   */
  async selfChat(tenantId: string, user: { userId: string; role: string }) {
    if (user.role === 'client') throw AppException.forbidden('Чаты команды недоступны');
    const chat = await this.repo.ensureSelfChat(tenantId, user.userId);
    return { id: chat.id, kind: chat.kind, title: chat.title };
  }

  async openProjectChat(tenantId: string, userId: string, role: string, projectId: string) {
    if (role === 'client') throw AppException.forbidden('Чаты команды недоступны');
    void userId;
    const chat = await this.repo.ensureProjectChat(tenantId, projectId);
    return { id: chat.id, kind: chat.kind };
  }

  async messages(tenantId: string, chatId: string, user: { userId: string; role: string }, beforeId?: string) {
    await this.access(tenantId, chatId, user);
    const rows = await this.repo.messages(tenantId, chatId, beforeId ?? null, PAGE, user.userId);
    await this.repo.markRead(tenantId, chatId, user.userId);
    return rows;
  }

  /**
   * Отправка сообщения — в чат или в ветку.
   *
   * `threadRootId` делает сообщение ответом в ветке: в общей ленте его не будет, ради
   * этого треды и заводились. `alsoInChannel` — исключение по просьбе автора: ответ,
   * который важен всем, показывается и в ленте. Копию при этом НЕ создаём: две записи
   * об одном сообщении разъезжаются при первой же правке.
   */
  async send(
    tenantId: string, chatId: string, user: { userId: string; role: string },
    body: string, fileId: string | null,
    thread?: { rootId?: string | null; alsoInChannel?: boolean },
    mentionIds?: string[],
  ) {
    const chat = await this.access(tenantId, chatId, user);
    const text = (body ?? '').trim();
    if (!text && !fileId) throw AppException.validation('Пустое сообщение');

    const rootId = await this.threadRoot(tenantId, chatId, thread?.rootId ?? null);
    const message = await this.repo.addMessage({
      tenantId, chatId, authorId: user.userId, body: text.slice(0, 8000), fileId,
      threadRootId: rootId, alsoInChannel: thread?.alsoInChannel === true,
    });
    // Ответив, человек ветку прочитал: иначе собственная реплика тут же
    // возвращалась бы к нему непрочитанной в разделе «Треды».
    if (rootId) await this.repo.markThreadRead(tenantId, rootId, user.userId);
    await this.repo.markRead(tenantId, chatId, user.userId); // своё сообщение прочитанным считаем сразу

    await this.mention(tenantId, String(message.id), mentionIds, user.userId, text);

    const to = await this.recipients(chat, tenantId);
    this.realtime.emitToUsers(tenantId, to, 'chat.message', { chatId, message });
    // В журнал — только факт и адресаты: по нему видно, ушло ли сообщение и кому,
    // когда человек говорит «мне не пришло». Текста сообщения здесь нет.
    this.diag.write({
      tenantId, scope: 'chat', refId: String(chatId), userId: user.userId, side: 'server',
      event: 'message.sent', data: { messageId: String(message.id), recipients: to.length, hasFile: !!fileId, length: text.length },
    });
    return message;
  }

  /**
   * Позвали по имени.
   *
   * Список приходит от подсказки по «@», поэтому проверяем, что это вообще сотрудники
   * этой компании. Себя из рассылки выбрасываем: звать себя оповещением незачем.
   *
   * Храним id, а не имя из текста: после переименования сотрудника имя в сообщении
   * указывало бы в никуда.
   */
  private async mention(
    tenantId: string, messageId: string, ids: string[] | undefined, actorId: string, body: string,
  ): Promise<void> {
    const wanted = (ids ?? []).map(String).filter((id) => id !== String(actorId)).slice(0, 30);
    if (!wanted.length) return;
    const users = await this.repo.tenantUserIds(tenantId, wanted);
    if (!users.length) return;
    await this.repo.addMentions(tenantId, messageId, users.map((u) => String(u.id)));
    this.realtime.emitToUsers(tenantId, users.map((u) => String(u.id)), 'chat.mention', {
      messageId: String(messageId), body: body.slice(0, 160),
    });
  }

  /**
   * Вопрос помощнику прямо в чате.
   *
   * Ответ ложится в тот же чат, что и сообщения людей: спросили при всех — ответ видят
   * все и он остаётся в истории разговора. Отдельная панель «спросить ИИ» рядом с чатом
   * сделала бы из помощника инструмент в стороне, хотя он участник разговора.
   */
  async askAi(tenantId: string, chatId: string, user: { userId: string; role: string }, question: string) {
    const chat = await this.access(tenantId, chatId, user);
    const answer = await this.chatAi.answer(tenantId, chatId, user.userId, question);
    const message = await this.repo.addMessage({
      tenantId, chatId, authorId: user.userId, body: answer, fileId: null, isAi: true,
    });
    const to = await this.recipients(chat, tenantId);
    this.realtime.emitToUsers(tenantId, to, 'chat.message', { chatId, message });
    return message;
  }

  /**
   * Сводка непрочитанного: по одному чату или по всем сразу («что я пропустил»).
   *
   * Ничего не сохраняет и ничего не помечает прочитанным: сводка — это взгляд на
   * переписку, а не её чтение.
   */
  async aiDigest(tenantId: string, user: { userId: string; role: string }, chatId?: string) {
    if (user.role === 'client') throw AppException.forbidden('Чаты команды недоступны');
    if (chatId) await this.access(tenantId, chatId, user);
    return this.chatAi.digest(tenantId, user.userId, chatId ?? null);
  }

  /** Поиск по переписке словами — только по тому, что доступно спрашивающему. */
  aiSearch(tenantId: string, user: { userId: string; role: string }, query: string) {
    if (user.role === 'client') throw AppException.forbidden('Чаты команды недоступны');
    return this.chatAi.search(tenantId, user.userId, query);
  }

  /**
   * Черновик задачи из сообщения.
   *
   * Ничего не создаёт: человек правит формулировку и только потом нажимает «Создать».
   * Разбор идёт тем же путём, что и голосовая постановка, — второй механизм для того
   * же самого разошёлся бы с первым на первой правке.
   *
   * Проект чата подсказывается разбору: сообщение в чате проекта почти всегда о нём.
   */
  async taskDraft(tenantId: string, chatId: string, user: { userId: string; role: string }, messageId: string) {
    const chat = await this.access(tenantId, chatId, user);
    const msg = await this.repo.messageBody(tenantId, messageId);
    if (!msg || String(msg.chat_id) !== String(chatId)) throw AppException.notFound('Сообщение не найдено');
    const text = String(msg.body ?? '').trim();
    // Скриншот без единого слова — обычное дело: «вот что сломалось». Раньше такое
    // сообщение в задачу не превращалось вовсе. Теперь берём имя файла заголовком,
    // а картинка всё равно уедет в задачу вложением.
    if (text.length < 3 && !msg.file_id) {
      throw AppException.validation('В сообщении нет ни текста, ни файла, из которых получится задача');
    }
    const draft = text.length >= 3
      ? await this.nl.parse(tenantId, user.userId, text, chat.project_id ?? null)
      : await this.nl.parse(tenantId, user.userId, String(msg.file_name ?? 'Разобраться со скриншотом'), chat.project_id ?? null);
    /*
      Кого предложить исполнителем.

      Автор фразы им НЕ становится: в переписке задачу описывает тот, кто её просит,
      то есть постановщик. Угадывать здесь нельзя — назначенная не тому задача
      выглядит как поручение, которого человек не получал.

      Поэтому исполнитель подставляется только там, где он назван однозначно:
      — позвали одного человека через @ — он и делает («@Пётр, поправь блок»);
      — личная переписка: собеседников двое, и сообщение адресовано второму.
      Во всех прочих случаях поле остаётся пустым и заполняется руками.
    */
    const mentioned = await this.repo.messageMentions(tenantId, messageId);
    let assigneeId: string | null = null;
    let assigneeReason: string | null = null;
    if (mentioned.length === 1) {
      assigneeId = String(mentioned[0].user_id);
      assigneeReason = 'назван в сообщении через @';
    } else if (!mentioned.length && chat.kind === 'dm' && msg.author_id) {
      // Двое в переписке: адресат — тот, кто не писал. Названных по имени тут нет,
      // иначе разговор шёл бы о ком-то третьем и выбирать пришлось бы человеку.
      const peer = await this.repo.dmPeer(tenantId, chatId, String(msg.author_id));
      if (peer) {
        assigneeId = String(peer.user_id);
        assigneeReason = 'личная переписка — адресат сообщения';
      }
    }

    return {
      task: draft.task ?? null,
      context: draft.context,
      note: draft.note,
      /*
        Откуда взялась задача: автор фразы, приложенный файл и предложенный
        исполнитель. Файл — чтобы окно сразу показало, что скриншот поедет в задачу.
      */
      source: {
        authorId: msg.author_id ? String(msg.author_id) : null,
        authorName: msg.author_name ?? null,
        fileId: msg.file_id ? String(msg.file_id) : null,
        fileName: msg.file_name ?? null,
        assigneeId,
        assigneeReason,
      },
    };
  }

  /**
   * Создать задачу по сообщению и связать их.
   *
   * Создание идёт общим путём (`nl.apply`) — тем же, каким задача появляется из
   * голоса и из командной строки. Дальше остаётся связь: под сообщением видно, что
   * задача уже заведена (иначе заведут вторую), а в задаче — откуда она взялась.
   */
  async createTask(
    tenantId: string, chatId: string, user: { userId: string; role: string },
    messageId: string, task: Record<string, unknown>,
  ) {
    await this.access(tenantId, chatId, user);
    const msg = await this.repo.messageBody(tenantId, messageId);
    if (!msg || String(msg.chat_id) !== String(chatId)) throw AppException.notFound('Сообщение не найдено');
    if (msg.task_id) throw AppException.conflict('По этому сообщению задача уже заведена');

    const res: any = await this.nl.apply(tenantId, user.userId, { intent: 'create_task', task });
    const created = res?.task;
    if (!created?.id) throw AppException.conflict('Задача не создалась');
    await this.repo.linkTask(tenantId, messageId, String(created.id));
    /*
      Скриншот из сообщения — во вложения задачи.

      Он и был половиной постановки: «вот тут съезжает» плюс картинка. Оставлять его
      в переписке значит заставлять исполнителя искать исходное сообщение, а через
      неделю — вспоминать, в каком чате оно было.

      Файл не копируем, а привязываем второй раз: это та же самая картинка, и две её
      копии в хранилище ничего не улучшат. Сообщения удаляются мягко, файл под ними
      остаётся.
    */
    if (msg.file_id) {
      await this.repo.attachFileToTask(tenantId, String(created.id), String(msg.file_id));
    }
    const projectId = created.project_id ? String(created.project_id) : String((task as any)?.projectId ?? '');
    // Автор сообщения и участники чата должны увидеть отметку сразу: иначе второй
    // человек заводит по той же фразе вторую задачу.
    const chat = await this.repo.get(tenantId, chatId);
    if (chat) {
      const to = await this.recipients(chat, tenantId);
      this.realtime.emitToUsers(tenantId, to, 'chat.task_linked', {
        chatId, messageId, taskId: String(created.id), title: created.title, projectId,
      });
    }
    return { taskId: String(created.id), title: created.title, projectId };
  }

  /** Откуда взялась задача: чат, автор и сама фраза. */
  sourceMessage(tenantId: string, taskId: string) {
    return this.repo.sourceMessage(tenantId, taskId);
  }

  /** Что за сущность стоит за чатом — для шапки. Не проектный чат контекста не имеет. */
  async context(tenantId: string, chatId: string, user: { userId: string; role: string }) {
    await this.access(tenantId, chatId, user);
    return this.repo.chatContext(tenantId, chatId);
  }

  /** Сохранить сообщение себе или снять сохранение. */
  async toggleSaved(tenantId: string, chatId: string, user: { userId: string; role: string }, messageId: string) {
    await this.access(tenantId, chatId, user);
    const msg = await this.repo.findMessage(tenantId, messageId);
    if (!msg || String(msg.chat_id) !== String(chatId)) throw AppException.notFound('Сообщение не найдено');
    const saved = await this.repo.toggleSaved(tenantId, messageId, user.userId);
    return { saved };
  }

  /** Раздел «Сохранённое»: важное, из которого задача не получается. */
  saved(tenantId: string, user: { userId: string; role: string }) {
    if (user.role === 'client') throw AppException.forbidden('Чаты команды недоступны');
    return this.repo.savedList(tenantId, user.userId);
  }

  /**
   * «Напомнить мне»: сообщение вернётся в нужный момент.
   *
   * Время считает клиент — он знает часовой пояс человека и его «сегодня вечером».
   * Сервер проверяет только, что момент в будущем и не дальше года: напоминание на
   * прошедшее время сработало бы мгновенно и выглядело поломкой.
   */
  async remind(
    tenantId: string, chatId: string, user: { userId: string; role: string },
    messageId: string, remindAt: string,
  ) {
    await this.access(tenantId, chatId, user);
    const msg = await this.repo.findMessage(tenantId, messageId);
    if (!msg || String(msg.chat_id) !== String(chatId)) throw AppException.notFound('Сообщение не найдено');
    const at = new Date(remindAt);
    if (Number.isNaN(at.getTime())) throw AppException.validation('Непонятное время напоминания');
    if (at.getTime() < Date.now() + 30_000) throw AppException.validation('Напоминание можно поставить только на будущее');
    if (at.getTime() > Date.now() + 365 * 86_400_000) throw AppException.validation('Слишком далеко — не больше года');
    await this.repo.setReminder(tenantId, user.userId, messageId, at);
    return { remindAt: at.toISOString() };
  }

  /** Где меня звали по имени. Открыли раздел — упоминания прочитаны. */
  async mentions(tenantId: string, user: { userId: string; role: string }) {
    if (user.role === 'client') throw AppException.forbidden('Чаты команды недоступны');
    const rows = await this.repo.mentionsList(tenantId, user.userId);
    await this.repo.markMentionsSeen(tenantId, user.userId);
    return rows;
  }

  /**
   * «Входящие»: всё, что ждёт человека, одной лентой.
   *
   * Иначе он обходит тридцать чатов и три раздела, чтобы понять, где его ждут.
   * Здесь ровно три источника: позвали по имени, ответили в ветке, написали в чат.
   */
  async inbox(tenantId: string, user: { userId: string; role: string }) {
    if (user.role === 'client') throw AppException.forbidden('Чаты команды недоступны');
    const [mentions, threads, chats, unseen] = await Promise.all([
      this.repo.mentionsList(tenantId, user.userId, 20),
      this.repo.myThreads(tenantId, user.userId, 20),
      this.repo.listForUser(tenantId, user.userId),
      this.repo.unseenMentions(tenantId, user.userId),
    ]);
    return {
      mentions,
      threads: threads.filter((t) => Number(t.unread) > 0),
      chats: chats.filter((c) => Number(c.unread) > 0),
      counts: {
        mentions: unseen,
        threads: threads.reduce((n: number, t) => n + Number(t.unread || 0), 0),
        chats: chats.reduce((n: number, c) => n + Number(c.unread || 0), 0),
      },
    };
  }

  /**
   * Корень ветки: отвечать можно только на сообщение ЭТОГО чата.
   *
   * И только на корневое: ветки в ветках превращают разговор в дерево, по которому
   * никто не ходит. Ответ на ответ уходит в ту же ветку — так же, как в Slack.
   */
  private async threadRoot(tenantId: string, chatId: string, rootId: string | null): Promise<string | null> {
    if (!rootId) return null;
    const msg = await this.repo.findMessage(tenantId, rootId);
    if (!msg || String(msg.chat_id) !== String(chatId)) {
      throw AppException.notFound('Сообщение не найдено в этом чате');
    }
    return String(msg.thread_root_id ?? msg.id);
  }

  /** Ветка целиком: корень и ответы. Открыли — значит прочитали. */
  async thread(tenantId: string, chatId: string, user: { userId: string; role: string }, rootId: string) {
    await this.access(tenantId, chatId, user);
    const root = await this.repo.findMessage(tenantId, rootId);
    if (!root || String(root.chat_id) !== String(chatId)) throw AppException.notFound('Ветка не найдена');
    const messages = await this.repo.thread(tenantId, String(root.thread_root_id ?? root.id), user.userId);
    await this.repo.markThreadRead(tenantId, String(root.thread_root_id ?? root.id), user.userId);
    return messages;
  }

  /**
   * Мои ветки — раздел «Треды».
   *
   * Только те, где человек начал разговор или отвечал: список всех веток компании
   * не нужен никому. Непрочитанное считается по чужим ответам после последнего
   * открытия ветки.
   */
  myThreads(tenantId: string, user: { userId: string; role: string }) {
    if (user.role === 'client') throw AppException.forbidden('Чаты команды недоступны');
    return this.repo.myThreads(tenantId, user.userId);
  }

  /**
   * Реакция на сообщение: ни истории, ни уведомлений — это знак, а не событие.
   *
   * Ради «ок» и «спасибо» будить уведомлением всех участников чата незачем: половина
   * шума в рабочих чатах — именно такие сообщения.
   */
  async react(tenantId: string, chatId: string, user: { userId: string; role: string }, messageId: string, emoji: string) {
    await this.access(tenantId, chatId, user);
    const msg = await this.repo.findMessage(tenantId, messageId);
    if (!msg || String(msg.chat_id) !== String(chatId)) throw AppException.notFound('Сообщение не найдено');
    await this.repo.toggleReaction(tenantId, messageId, user.userId, emoji.slice(0, 16));
    return { ok: true };
  }

  /**
   * Закрепить сообщение или снять закрепление.
   *
   * Право у всех участников чата: закрепление обратимо, а спрашивать руководителя,
   * чтобы повесить ссылку на макет, — не работа, а бюрократия.
   */
  async pin(tenantId: string, chatId: string, user: { userId: string; role: string }, messageId: string, pinned: boolean) {
    const chat = await this.access(tenantId, chatId, user);
    const msg = await this.repo.findMessage(tenantId, messageId);
    if (!msg || String(msg.chat_id) !== String(chatId)) throw AppException.notFound('Сообщение не найдено');
    await this.repo.setPinned(tenantId, messageId, user.userId, pinned);
    // Закрепление видят все: у собеседника шапка чата должна измениться сразу,
    // иначе он узнает о важном сообщении, только перезагрузив страницу.
    const to = await this.recipients(chat, tenantId);
    this.realtime.emitToUsers(tenantId, to, 'chat.pinned', { chatId, messageId, pinned });
    return { pinned };
  }

  /** Закреплённое чата: то, что нужно всем и всегда под рукой. */
  async pinnedList(tenantId: string, chatId: string, user: { userId: string; role: string }) {
    await this.access(tenantId, chatId, user);
    return this.repo.pinned(tenantId, chatId);
  }

  /**
   * Клип: голосовое сообщение или запись экрана.
   *
   * Отличается от обычного вложения одним, но решающим: расшифровка кладётся в ТЕЛО
   * сообщения. Аудио и видео в переписке иначе становятся чёрной дырой — их не найдёт
   * поиск, не увидит сводка непрочитанного и не разберёт помощник, а слушать три минуты
   * ради одной фразы никто не станет. С расшифровкой клип остаётся обычным сообщением,
   * из которого можно и задачу сделать.
   *
   * Не распозналось (нет ключа, тишина, чужой язык) — отправляем как есть: запись
   * ценнее расшифровки, и терять её из-за отсутствия ключа нельзя.
   */
  async sendClip(
    tenantId: string, chatId: string, user: { userId: string; role: string },
    file: { buffer: Buffer; originalname: string; mimetype: string },
    kind: 'voice' | 'screen',
  ) {
    const chat = await this.access(tenantId, chatId, user);
    const stored = await this.files.upload({
      tenantId, userId: user.userId, buffer: file.buffer, fileName: file.originalname,
      contentType: file.mimetype, ownerKind: 'chat_message', ownerId: chatId,
    });

    // Расшифровка своих ошибок наружу не поднимает: клип уходит и без текста —
    // запись ценнее расшифровки, и терять её из-за отсутствия ключа нельзя.
    const text = (await this.chatAi.transcribe(tenantId, file.buffer, file.originalname)).trim();
    // Подпись нужна и без расшифровки: в ленте «вложение» без слова не отличить
    // от документа, а голосовое от записи экрана — тем более.
    const body = text || (kind === 'voice' ? 'Голосовое сообщение' : 'Запись экрана');

    const message = await this.repo.addMessage({
      tenantId, chatId, authorId: user.userId, body, fileId: String(stored.id),
    });
    await this.repo.markRead(tenantId, chatId, user.userId);
    const to = await this.recipients(chat, tenantId);
    this.realtime.emitToUsers(tenantId, to, 'chat.message', { chatId, message });
    return message;
  }

  /** Вложение: файл кладётся в MinIO тем же путём, что и вложения задач. */
  async sendFile(
    tenantId: string, chatId: string, user: { userId: string; role: string },
    file: { buffer: Buffer; originalname: string; mimetype: string }, body: string,
  ) {
    await this.access(tenantId, chatId, user);
    const stored = await this.files.upload({
      tenantId, userId: user.userId, buffer: file.buffer, fileName: file.originalname,
      contentType: file.mimetype, ownerKind: 'chat_message', ownerId: chatId,
    });
    return this.send(tenantId, chatId, user, body, stored.id);
  }

  // ───── управление группой ─────

  /** Операции состава есть только у групп: у диалога участники неизменны, у проекта — вся команда. */
  private async group(tenantId: string, chatId: string, user: { userId: string; role: string }): Promise<ChatRow> {
    const chat = await this.access(tenantId, chatId, user);
    if (chat.kind !== 'group') throw AppException.validation('Состав меняется только у групповых чатов');
    return chat;
  }

  /** Изменять группу вправе её создатель и руководство: иначе любой может выкинуть любого. */
  private canManage(chat: ChatRow, user: { userId: string; role: string }): boolean {
    return String(chat.created_by) === String(user.userId) || user.role === 'owner' || user.role === 'manager';
  }

  async members(tenantId: string, chatId: string, user: { userId: string; role: string }) {
    const chat = await this.access(tenantId, chatId, user);
    const rows = await this.repo.members(tenantId, chatId);
    return {
      canManage: chat.kind === 'group' && this.canManage(chat, user),
      createdBy: chat.created_by,
      members: rows.map((r) => ({
        userId: r.user_id,
        fullName: r.full_name,
        avatarUrl: r.avatar_file_id ? `/api/files/${r.avatar_file_id}` : null,
      })),
    };
  }

  /** Добавлять может любой участник: звать коллегу в обсуждение — обычное дело. */
  async addMembers(tenantId: string, chatId: string, user: { userId: string; role: string }, userIds: string[]) {
    const chat = await this.group(tenantId, chatId, user);
    const added = await this.repo.addMembers(tenantId, chatId, userIds);
    if (!added.length) return { added: 0 };

    const names = (await this.repo.members(tenantId, chatId))
      .filter((m) => added.includes(String(m.user_id))).map((m) => m.full_name);
    await this.announce(tenantId, chat, `${names.join(', ')} ${names.length > 1 ? 'добавлены' : 'добавлен(а)'} в группу`);
    // новичкам чат должен появиться в списке сразу
    this.realtime.emitToUsers(tenantId, added, 'chat.created', { chatId, title: chat.title });
    return { added: added.length };
  }

  async removeMember(tenantId: string, chatId: string, user: { userId: string; role: string }, targetId: string) {
    const chat = await this.group(tenantId, chatId, user);
    if (String(targetId) === String(user.userId)) throw AppException.validation('Чтобы выйти самому, используйте «Выйти из группы»');
    if (!this.canManage(chat, user)) throw AppException.forbidden('Убирать участников может создатель группы или руководитель');

    const name = (await this.repo.members(tenantId, chatId)).find((m) => String(m.user_id) === String(targetId))?.full_name;
    if (!(await this.repo.removeMember(chatId, targetId))) throw AppException.notFound('Участник не найден');
    await this.announce(tenantId, chat, `${name ?? 'Участник'} удалён(а) из группы`);
    // исключённому чат исчезает из списка
    this.realtime.emitToUsers(tenantId, [targetId], 'chat.removed', { chatId });
    return { removed: true };
  }

  async rename(tenantId: string, chatId: string, user: { userId: string; role: string }, title: string) {
    const chat = await this.group(tenantId, chatId, user);
    if (!this.canManage(chat, user)) throw AppException.forbidden('Переименовать может создатель группы или руководитель');
    const name = title.trim();
    if (!name) throw AppException.validation('Название не может быть пустым');
    await this.repo.rename(tenantId, chatId, name.slice(0, 160));
    await this.announce(tenantId, chat, `Группа переименована в «${name.slice(0, 160)}»`);
    return { title: name.slice(0, 160) };
  }

  /** Выйти может каждый. Историю не трогаем: переписка остаётся у оставшихся. */
  async leave(tenantId: string, chatId: string, user: { userId: string; role: string }) {
    const chat = await this.group(tenantId, chatId, user);
    const name = (await this.repo.members(tenantId, chatId)).find((m) => String(m.user_id) === String(user.userId))?.full_name;
    await this.repo.removeMember(chatId, user.userId);
    await this.announce(tenantId, chat, `${name ?? 'Участник'} вышел(ла) из группы`);
    this.realtime.emitToUsers(tenantId, [user.userId], 'chat.removed', { chatId });
    return { left: true };
  }

  /** Служебная строка в ленту + рассылка оставшимся. */
  private async announce(tenantId: string, chat: ChatRow, text: string): Promise<void> {
    const message = await this.repo.addSystemMessage(tenantId, chat.id, text);
    const to = await this.recipients(chat, tenantId);
    this.realtime.emitToUsers(tenantId, to, 'chat.message', { chatId: chat.id, message });
  }

  async markRead(tenantId: string, chatId: string, user: { userId: string; role: string }) {
    const chat = await this.access(tenantId, chatId, user);
    await this.repo.markRead(tenantId, chatId, user.userId);
    /*
      Собеседник должен увидеть вторую галочку СРАЗУ, а не после перезагрузки чата.
      Отметку о прочтении шлём остальным участникам: у отправителя галочки на всех
      его сообщениях до этого момента становятся прочитанными.
    */
    const to = (await this.recipients(chat, tenantId)).filter((id) => String(id) !== String(user.userId));
    if (to.length) {
      this.realtime.emitToUsers(tenantId, to, 'chat.read', {
        chatId: String(chatId),
        userId: String(user.userId),
        at: new Date().toISOString(),
      });
    }
    return { read: true };
  }

  /** Удалять можно только своё: правки чужих сообщений в переписке недопустимы. */
  /**
   * Правка своего сообщения.
   *
   * Только автор и только текст: чужие слова не правит никто, включая руководителя —
   * его дело удалить сообщение целиком, а не переписать за человека. Файл и вложение
   * остаются на месте, меняется подпись.
   */
  async editMessage(
    tenantId: string, chatId: string, messageId: string,
    user: { userId: string; role: string }, body: string,
  ) {
    const chat = await this.access(tenantId, chatId, user);
    const message = await this.repo.message(tenantId, messageId);
    if (!message || String(message.chat_id) !== String(chatId)) throw AppException.notFound('Сообщение не найдено');
    if (String(message.author_id) !== String(user.userId)) throw AppException.forbidden('Это не ваше сообщение');
    const text = String(body ?? '').trim();
    // Пустое сообщение — это удаление, и делается оно отдельной кнопкой: иначе
    // человек стирает текст, а в переписке остаётся пустой пузырь.
    if (!text && !message.file_id) throw AppException.validation('Пустое сообщение — удалите его целиком');
    await this.repo.editMessage(tenantId, messageId, text.slice(0, 4000));
    const to = await this.recipients(chat, tenantId);
    this.realtime.emitToUsers(tenantId, to, 'chat.message_edited', {
      chatId, messageId, body: text.slice(0, 4000),
    });
    return { edited: true, body: text.slice(0, 4000) };
  }

  async remove(tenantId: string, chatId: string, messageId: string, user: { userId: string; role: string }) {
    const chat = await this.access(tenantId, chatId, user);
    const message = await this.repo.message(tenantId, messageId);
    if (!message || String(message.chat_id) !== String(chatId)) throw AppException.notFound('Сообщение не найдено');
    if (String(message.author_id) !== String(user.userId)) throw AppException.forbidden('Это не ваше сообщение');
    await this.repo.softDelete(messageId);
    const to = await this.recipients(chat, tenantId);
    this.realtime.emitToUsers(tenantId, to, 'chat.message_deleted', { chatId, messageId });
    return { deleted: true };
  }
}
