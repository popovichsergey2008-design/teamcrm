import { Injectable } from '@nestjs/common';
import { AppException } from '../../common/http/app-exception';
import { NlService } from '../nl/nl.service';
import { ChatsAiService } from './chats-ai.service';
import { ChatTaskDraftService } from './chat-task-draft.service';
import { CustomResponsesService } from './custom-responses.service';
import { DiagService } from '../diagnostics/diag.service';
import { FilesService } from '../files/files.service';
import { RealtimeService } from '../realtime/realtime.service';
import { PushService } from '../notifications/push.service';
import { TelegramMirror } from '../notifications/telegram-mirror.service';
import { ChatRow, ChatsRepository, MessageRow } from './chats.repository';
import { ScheduledRepository, ScheduledRow } from './scheduled.repository';

const PAGE = 50;

/**
 * Мессенджер команды: личные диалоги, группы и чаты проектов.
 *
 * Доступ: у dm и group — по членству; у чата проекта — у всей команды, потому что
 * доступ к проектам в CRM и так общий. Заказчик (client) в командные чаты не входит:
 * у него отдельный портал, и переписка команды не для его глаз.
 */
/**
 * Адреса из текста сообщения — для вкладки «Ссылки». Хвостовую пунктуацию
 * отрезаем: точка в конце предложения не часть адреса.
 */
export function extractLinks(body: string): string[] {
  const out: string[] = [];
  for (const m of String(body ?? '').matchAll(/(?:https?:\/\/|www\.)[^\s<>"']+/gi)) {
    const url = m[0].replace(/[).,;:!?»"']+$/, '');
    if (url && !out.includes(url)) out.push(url);
  }
  return out;
}

@Injectable()
export class ChatsService {
  constructor(
    private readonly repo: ChatsRepository,
    private readonly files: FilesService,
    private readonly realtime: RealtimeService,
    private readonly diag: DiagService,
    private readonly scheduled: ScheduledRepository,
    /** Разбор фразы в задачу — тот же, что у голосовой постановки: два механизма
        для одного и того же разошлись бы на первой правке. */
    private readonly nl: NlService,
    private readonly chatAi: ChatsAiService,
    private readonly responses: CustomResponsesService,
    private readonly push: PushService,
    private readonly mirror: TelegramMirror,
    /** Черновики задач из сообщений: сюда уходит ответ автора о проекте. */
    private readonly drafts: ChatTaskDraftService,
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
      peerLastSeen: c.peer_last_seen ?? null,
      peerStatus: c.peer_status ?? null,
      avatarUrl: c.peer_avatar ? `/api/files/${c.peer_avatar}` : null,
      projectId: c.project_id,
      unread: Number(c.unread ?? 0),
      // ручная пометка «непрочитанное»: в списке — точка, в счётчике — единица
      markedUnread: c.marked_unread === true,
      // уведомления по чату: панель не звучит и не считает тихие чаты
      notify: c.notify ?? 'all',
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
    await this.repo.audit({ tenantId, chatId: String(chat.id), actorId: userId, action: 'created', detail: { kind: 'group', title: name } });
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
      description: (dto.description ?? '').trim().slice(0, 2000) || null,
      isPrivate: dto.isPrivate !== false, // умолчание — приватный: раскрыть проще, чем спрятать
      userIds: (dto.userIds ?? []).map(String),
    });
    await this.repo.audit({ tenantId, chatId: String(chat.id), actorId: user.userId, action: 'created', detail: { kind: 'channel', title } });
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

  async messages(
    tenantId: string, chatId: string, user: { userId: string; role: string },
    beforeId?: string, afterId?: string,
  ) {
    const chat = await this.access(tenantId, chatId, user);
    const rows = await this.repo.messages(tenantId, chatId, beforeId ?? null, PAGE, user.userId, afterId ?? null);
    /*
      Прочитанным считаем ТОЛЬКО открытие чата, а не подгрузку старого.

      Человек тянет ленту вверх, чтобы перечитать позавчерашнее, — и в этот момент
      гасились счётчики новых сообщений, до которых он ещё не дошёл. То же самое
      делает и переход к сообщению из поиска.
    */
    if (!beforeId && !afterId) await this.repo.markRead(tenantId, chatId, user.userId);
    /*
      Открыли чат — значит прочитали, и собеседник должен увидеть вторую галочку СЕЙЧАС.

      Раньше отметка здесь ставилась молча, а событие уходило только из отдельной
      ручки «пометить прочитанным». Из-за этого галочки у отправителя появлялись
      лишь после перезагрузки переписки — ровно на это и жаловались.

      Только при первой странице: подгрузка старого вверх чтением не является.
    */
    if (!beforeId && !afterId) await this.announceRead(tenantId, chat, user.userId);
    return rows;
  }

  /** Кому сказать «я прочитал»: всем участникам, кроме себя. */
  private async announceRead(tenantId: string, chat: ChatRow, userId: string): Promise<void> {
    const to = (await this.recipients(chat, tenantId)).filter((id) => String(id) !== String(userId));
    if (!to.length) return;
    this.realtime.emitToUsers(tenantId, to, 'chat.read', {
      chatId: String(chat.id), userId: String(userId), at: new Date().toISOString(),
    });
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
    /** Все вложения сообщения; `fileId` — первое из них. */
    fileIds?: string[],
    /**
     * Ответ на сообщение В ЛЕНТЕ.
     *
     * От ветки отличается тем, что реплика остаётся в общем разговоре: видно, кому
     * отвечают, но обсуждение никуда не уводится. Одно с другим не спорит — человек
     * сам выбирает, ответить здесь или увести в ветку.
     */
    reply?: { toId?: string | null; excerpt?: string | null },
  ) {
    const chat = await this.access(tenantId, chatId, user);
    const text = (body ?? '').trim();
    if (!text && !fileId) throw AppException.validation('Пустое сообщение');

    const rootId = await this.threadRoot(tenantId, chatId, thread?.rootId ?? null);
    /*
      На что отвечаем — проверяем, а не верим клиенту.

      Сообщение должно существовать и лежать в ЭТОМ чате: иначе в цитату можно было бы
      подтянуть чужую переписку, к которой у человека нет доступа.
    */
    let replyToId: string | null = null;
    if (reply?.toId) {
      const src = await this.repo.findMessage(tenantId, String(reply.toId));
      if (src && String(src.chat_id) === String(chatId)) replyToId = String(src.id);
    }
    const message = await this.repo.addMessage({
      tenantId, chatId, authorId: user.userId, body: text.slice(0, 8000), fileId,
      fileIds,
      threadRootId: rootId, alsoInChannel: thread?.alsoInChannel === true,
      replyToId, replyExcerpt: replyToId ? reply?.excerpt ?? null : null,
    });
    // Ответив, человек ветку прочитал: иначе собственная реплика тут же
    // возвращалась бы к нему непрочитанной в разделе «Треды».
    if (rootId) await this.repo.markThreadRead(tenantId, rootId, user.userId);
    await this.repo.markRead(tenantId, chatId, user.userId); // своё сообщение прочитанным считаем сразу

    const mentioned = await this.mention(tenantId, String(message.id), mentionIds, user.userId, text);

    const to = await this.recipients(chat, tenantId);
    // Кого позвали — вместе с сообщением: у получателя может стоять «только
    // упоминания», и решать, звучать ли, он должен сразу, без второго запроса.
    this.realtime.emitToUsers(tenantId, to, 'chat.message', { chatId, message, mentionIds: mentioned });
    // Тем, кого нет в сети, — push и запись в ящик (ТЗ-9): не ждём и не роняем отправку.
    void this.repo.notifyModes(chatId).then((modes) => this.push.chatMessage({
      tenantId, chatId, chatKind: chat.kind, chatTitle: chat.title,
      authorId: user.userId, authorName: message.author_name ?? null, text,
      recipients: to, mentioned, modes, threadRootId: rootId,
    })).catch(() => undefined);
    /*
      Личное сообщение и упоминание — ещё и в Telegram (просьба заказчика).

      Писем о переписке нет и не будет: это спам на каждое «ок». Но личное обращение
      и «@имя» пропускать нельзя — человек ждёт ответа. Групповую болтовню сюда не
      тащим: туда пишут весь день.
    */
    const tgPath = rootId ? `/chat/${chatId}/thread/${rootId}` : `/chat/${chatId}`;
    for (const rid of to) {
      if (String(rid) === String(user.userId)) continue;
      const isMention = mentioned.map(String).includes(String(rid));
      if (chat.kind !== 'dm' && !isMention) continue;
      void this.mirror.chatMessage({
        tenantId, userId: String(rid), authorName: message.author_name ?? null,
        chatTitle: chat.kind === 'dm' ? null : chat.title, text, mention: isMention, path: tgPath,
      }).catch(() => undefined);
    }
    // В журнал — только факт и адресаты: по нему видно, ушло ли сообщение и кому,
    // когда человек говорит «мне не пришло». Текста сообщения здесь нет.
    this.diag.write({
      tenantId, scope: 'chat', refId: String(chatId), userId: user.userId, side: 'server',
      event: 'message.sent', data: { messageId: String(message.id), recipients: to.length, hasFile: !!fileId, length: text.length },
    });
    // Заготовленный ответ без обращения к боту — только у тех ответов, где это
    // включено отдельно (ТЗ-6, разд. 38). В стороне от отправки: сообщение человека
    // не должно ждать бота и не должно упасть из-за него.
    if (text) void this.autoRespond(tenantId, chat, text, to, user.userId).catch(() => undefined);
    /*
      Не ответ ли это на вопрос бота о проекте.

      Когда в поручении не назван проект, бот спрашивает о нём прямо в чате и ждёт
      обычной реплики — кнопок в переписке у нас нет. Проверка идёт в стороне от
      отправки: сообщение человека не должно ни ждать разбора, ни падать из-за него.
    */
    if (text) void this.drafts.noticeAnswer(tenantId, chatId, user.userId, text).catch(() => undefined);
    return message;
  }

  /**
   * «Слово VPN → вот инструкция», без упоминания бота.
   *
   * Ответ приходит отдельным сообщением от помощника, а не правкой чужого: в
   * переписке видно, кто что сказал, и заготовку легко отличить от человека.
   */
  private async autoRespond(tenantId: string, chat: { id: string; kind: string }, text: string, to: string[], askedBy: string): Promise<void> {
    const canned = await this.responses.match(tenantId, text, String(chat.kind), false);
    if (!canned) return;
    const message = await this.repo.addMessage({
      tenantId, chatId: String(chat.id), authorId: askedBy, body: canned.answer, fileId: null, isAi: true,
    });
    this.realtime.emitToUsers(tenantId, to, 'chat.message', { chatId: String(chat.id), message });
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
  ): Promise<string[]> {
    const wanted = (ids ?? []).map(String).filter((id) => id !== String(actorId)).slice(0, 30);
    if (!wanted.length) return [];
    const users = await this.repo.tenantUserIds(tenantId, wanted);
    if (!users.length) return [];
    const userIds = users.map((u) => String(u.id));
    await this.repo.addMentions(tenantId, messageId, userIds);
    this.realtime.emitToUsers(tenantId, userIds, 'chat.mention', {
      messageId: String(messageId), body: body.slice(0, 160),
    });
    return userIds;
  }

  /** Уведомления по чату — личная настройка: all | mentions | none. */
  async setNotify(tenantId: string, chatId: string, user: { userId: string; role: string }, mode: string) {
    await this.access(tenantId, chatId, user);
    if (!['all', 'mentions', 'none'].includes(mode)) throw AppException.validation('Режим: все, только упоминания или выключено');
    await this.repo.setNotify(tenantId, chatId, user.userId, mode);
    return { notify: mode };
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
    // Сначала — заготовленный ответ (ТЗ-6, разд. 38): на «где инструкция по VPN»
    // компания отвечает одинаково каждому, и модель для этого не нужна.
    const canned = await this.responses.match(tenantId, question, String(chat.kind), true);
    const answer = canned
      ? canned.answer
      : await this.chatAi.answer(tenantId, chatId, user.userId, question, await this.aiContext(tenantId, chat));
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

  /**
   * Поиск по всем чатам — как в мессенджерах.
   *
   * Отличается от `aiSearch` тем, что ничего не понимает: ищет ровно введённые
   * буквы. Это и нужно чаще всего — человек помнит обрывок фразы («пиликалка»,
   * «смет») и хочет найти само сообщение, а не пересказ.
   *
   * Подпись чата собираем здесь: «Юрий Про» для личного, название группы, имя
   * проекта. В списке результатов без неё непонятно, где вообще это сказали.
   */
  async searchMessages(tenantId: string, user: { userId: string; role: string }, query: string) {
    if (user.role === 'client') throw AppException.forbidden('Чаты команды недоступны');
    const q = String(query ?? '').trim();
    // Одна буква находит всё и ничего не сообщает — не ищем.
    if (q.length < 2) return { items: [] };
    const rows = await this.repo.searchMessages(tenantId, user.userId, q);
    return {
      items: rows.map((r) => ({
        messageId: String(r.id),
        chatId: String(r.chat_id),
        chatTitle: r.chat_kind === 'dm' ? (r.peer_name ?? 'Личный чат')
          : r.chat_kind === 'project' ? (r.project_name ?? 'Проект')
            : (r.chat_title ?? 'Группа'),
        chatKind: r.chat_kind,
        authorName: r.author_name,
        body: r.body,
        createdAt: r.created_at,
        // Ответ из ветки открывается веткой, иначе его в ленте не найти.
        threadRootId: r.thread_root_id ? String(r.thread_root_id) : null,
      })),
    };
  }

  /**
   * Окно сообщений вокруг найденного — переход из поиска.
   *
   * Отдаём тем же путём, что и обычную ленту, поэтому клиент показывает их своим
   * же кодом. Отметку «прочитано» здесь НЕ ставим: человек пришёл посмотреть одно
   * старое сообщение, а не прочитал весь чат.
   */
  async messagesAround(tenantId: string, chatId: string, user: { userId: string; role: string }, messageId: string) {
    await this.access(tenantId, chatId, user);
    return this.repo.messagesAround(tenantId, chatId, messageId, user.userId);
  }

  /**
   * Отложить сообщение.
   *
   * Проверяем доступ и время: отправка в прошлое — почти всегда опечатка в дате,
   * а «через год» чаще ошибка, чем замысел. Текст держим у себя до срока: положить
   * его сразу в чат нельзя — он тут же уедет собеседнику.
   */
  async schedule(
    tenantId: string, chatId: string, user: { userId: string; role: string },
    body: string, sendAt: string,
    opts?: { rootId?: string | null; alsoInChannel?: boolean; mentionIds?: string[]; repeat?: string },
  ) {
    await this.access(tenantId, chatId, user);
    const text = String(body ?? '').trim();
    if (!text) throw AppException.validation('Пустое сообщение отложить нельзя');
    const at = new Date(sendAt);
    if (Number.isNaN(at.getTime())) throw AppException.validation('Непонятное время отправки');
    if (at.getTime() < Date.now() + 30_000) throw AppException.validation('Выберите время в будущем');
    if (at.getTime() > Date.now() + 365 * 86_400_000) throw AppException.validation('Слишком далеко — не больше года');

    const row = await this.scheduled.create({
      tenantId, chatId, authorId: user.userId, body: text.slice(0, 8000),
      threadRootId: opts?.rootId ? String(opts.rootId) : null,
      alsoInChannel: opts?.alsoInChannel === true,
      mentionIds: (opts?.mentionIds ?? []).map(String),
      sendAt: at,
      repeatKind: opts?.repeat === 'daily' ? 'daily' : 'none',
    });
    return this.scheduledView(row);
  }

  listScheduled(tenantId: string, chatId: string, user: { userId: string; role: string }) {
    return this.access(tenantId, chatId, user)
      .then(() => this.scheduled.listMine(tenantId, chatId, user.userId))
      .then((rows) => ({ items: rows.map((r: ScheduledRow) => this.scheduledView(r)) }));
  }

  /** Отмена и перенос — только своего: чужое отложенное не трогает никто. */
  async cancelScheduled(tenantId: string, id: string, user: { userId: string }) {
    const row = await this.scheduled.byId(tenantId, id);
    if (!row) throw AppException.notFound('Отложенное сообщение не найдено');
    if (String(row.author_id) !== String(user.userId)) throw AppException.forbidden('Это не ваше сообщение');
    await this.scheduled.cancel(tenantId, id);
    return { cancelled: true };
  }

  /**
   * «Отправить сейчас» — как в Telegram: передумал ждать.
   *
   * Отправляем тем же путём, что и планировщик, и сразу помечаем строку
   * отправленной: иначе через полминуты он отправит её второй раз.
   */
  async sendScheduledNow(tenantId: string, id: string, user: { userId: string; role: string }) {
    const row = await this.scheduled.byId(tenantId, id);
    if (!row) throw AppException.notFound('Отложенное сообщение не найдено');
    if (String(row.author_id) !== String(user.userId)) throw AppException.forbidden('Это не ваше сообщение');
    if (row.status !== 'pending') throw AppException.conflict('Это сообщение уже отправлено или отменено');
    const message = await this.send(
      tenantId, String(row.chat_id), user, row.body, null,
      { rootId: row.thread_root_id ? String(row.thread_root_id) : null, alsoInChannel: row.also_in_channel },
      (row.mention_ids ?? []).map(String),
    );
    await this.scheduled.markSent(
      String(row.id), String((message as { id?: string })?.id ?? ''), row.repeat_kind === 'daily',
    );
    return { sent: true };
  }

  /** Правка текста отложенного: до отправки это ещё черновик. */
  async editScheduled(tenantId: string, id: string, user: { userId: string }, body: string) {
    const row = await this.scheduled.byId(tenantId, id);
    if (!row) throw AppException.notFound('Отложенное сообщение не найдено');
    if (String(row.author_id) !== String(user.userId)) throw AppException.forbidden('Это не ваше сообщение');
    const text = String(body ?? '').trim();
    if (!text) throw AppException.validation('Пустое сообщение — отмените его целиком');
    await this.scheduled.editBody(tenantId, id, text.slice(0, 8000));
    return { body: text.slice(0, 8000) };
  }

  async rescheduleMessage(tenantId: string, id: string, user: { userId: string }, sendAt: string) {
    const row = await this.scheduled.byId(tenantId, id);
    if (!row) throw AppException.notFound('Отложенное сообщение не найдено');
    if (String(row.author_id) !== String(user.userId)) throw AppException.forbidden('Это не ваше сообщение');
    const at = new Date(sendAt);
    if (Number.isNaN(at.getTime()) || at.getTime() < Date.now() + 30_000) {
      throw AppException.validation('Выберите время в будущем');
    }
    await this.scheduled.reschedule(tenantId, id, at);
    return { sendAt: at.toISOString() };
  }

  private scheduledView(row: ScheduledRow | null) {
    if (!row) throw AppException.conflict('Не удалось отложить сообщение');
    return {
      id: String(row.id),
      chatId: String(row.chat_id),
      body: row.body,
      sendAt: row.send_at,
      /** Повтор показываем отдельно: «каждый день в 09:00» — это не дата, а правило. */
      repeat: row.repeat_kind === 'daily' ? 'daily' : 'none',
      sentCount: Number(row.sent_count ?? 0),
    };
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
    await this.repo.link({ tenantId, chatId, entityType: 'task', entityId: String(created.id), relation: 'created_from', actorId: user.userId });
    await this.repo.audit({ tenantId, chatId, actorId: user.userId, action: 'task_created', detail: { messageId, taskId: String(created.id), title: created.title } });
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
    const [mentions, threads, chats, replies] = await Promise.all([
      this.repo.mentionsList(tenantId, user.userId, 20),
      this.repo.myThreads(tenantId, user.userId, 20),
      this.repo.listForUser(tenantId, user.userId),
      this.repo.repliesToMe(tenantId, user.userId, 20),
    ]);
    /*
      Открыли «Входящие» — упоминания показаны, значит увидены.

      Раньше счётчик гасила только отдельная ручка «упоминания», в которую этот
      экран не ходит: цифра висела вечно. А считались упоминания по сырым строкам —
      включая те, чьё сообщение давно удалили: в списке пусто, а единица горит.
      Теперь и список, и счётчик берутся из одного места, а увиденное гасится здесь же.
    */
    await this.repo.markMentionsSeen(tenantId, user.userId);
    /*
      «Входящие» — только то, что адресовано ЛИЧНО мне.

      Заказчик сказал прямо: сюда не должно попадать обычное сообщение в общий чат.
      Личное обращение — это четыре случая: меня позвали по имени, написали в личку,
      ответили на мою реплику, ответили в моей ветке. Всё остальное — обычная
      переписка, у неё свой счётчик на самом чате, и разбирать её приходят сами.
    */
    const dms = chats.filter((c: any) => c.kind === 'dm' && Number(c.unread) > 0);
    return {
      mentions,
      threads: threads.filter((t) => Number(t.unread) > 0),
      dms,
      replies,
      counts: {
        mentions: 0,
        threads: threads.reduce((n: number, t) => n + Number(t.unread || 0), 0),
        dms: dms.reduce((n: number, c: any) => n + Number(c.unread || 0), 0),
        replies: replies.length,
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
    await this.repo.audit({ tenantId, chatId, actorId: user.userId, action: pinned ? 'pinned' : 'unpinned', detail: { messageId } });
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
  /**
   * Файлы сообщением — сколько угодно за раз.
   *
   * Три вставленных из буфера снимка это ОДНО сообщение с тремя картинками, а не
   * три сообщения подряд: иначе разговор превращается в ленту обрывков. Первый файл
   * дублируется в `file_id` — на него завязаны лента, поиск и задачи из сообщений.
   */
  async sendFiles(
    tenantId: string, chatId: string, user: { userId: string; role: string },
    files: { buffer: Buffer; originalname: string; mimetype: string }[], body: string,
    thread?: { rootId?: string | null; alsoInChannel?: boolean },
    /** Снимок тоже бывает ответом: «вот о чём я» — и цитата исходной реплики. */
    reply?: { toId?: string | null; excerpt?: string | null },
  ) {
    await this.access(tenantId, chatId, user);
    if (!files.length) throw AppException.validation('Файл не приложен');
    const stored = [];
    for (const f of files) {
      stored.push(await this.files.upload({
        tenantId, userId: user.userId, buffer: f.buffer, fileName: f.originalname,
        contentType: f.mimetype, ownerKind: 'chat_message', ownerId: chatId,
      }));
    }
    return this.send(
      tenantId, chatId, user, body, String(stored[0].id), thread, undefined,
      stored.map((x) => String(x.id)), reply,
    );
  }

  async sendFile(
    tenantId: string, chatId: string, user: { userId: string; role: string },
    file: { buffer: Buffer; originalname: string; mimetype: string }, body: string,
  ) {
    return this.sendFiles(tenantId, chatId, user, [file], body);
  }

  // ───── управление группой ─────

  /** Операции состава есть только у групп: у диалога участники неизменны, у проекта — вся команда. */
  private async group(tenantId: string, chatId: string, user: { userId: string; role: string }): Promise<ChatRow> {
    const chat = await this.access(tenantId, chatId, user);
    // Каналы — тоже: у них есть владелец и администраторы, и порядок наводят так же.
    if (chat.kind !== 'group' && chat.kind !== 'channel') throw AppException.validation('Состав меняется только у групп и каналов');
    return chat;
  }

  /**
   * Кто вправе менять чат: владелец и администраторы чата, а также руководство
   * компании — иначе любой мог бы выкинуть любого. Роль в чате — из chat_members,
   * должность — из компании; создатель остаётся в силе и без записи о роли.
   */
  private async canManageChat(chat: ChatRow, user: { userId: string; role: string }): Promise<boolean> {
    if (String(chat.created_by) === String(user.userId) || user.role === 'owner' || user.role === 'manager') return true;
    const m = await this.repo.memberRole(String(chat.id), user.userId);
    return m?.role === 'owner' || m?.role === 'admin';
  }

  private memberOut(r: { user_id: string; full_name: string; avatar_file_id: string | null; role: string; last_seen_at: Date | null; presence_status: string | null }) {
    return {
      userId: r.user_id,
      fullName: r.full_name,
      avatarUrl: r.avatar_file_id ? `/api/files/${r.avatar_file_id}` : null,
      role: r.role,
      lastSeenAt: r.last_seen_at,
      status: r.presence_status,
    };
  }

  async members(tenantId: string, chatId: string, user: { userId: string; role: string }) {
    const chat = await this.access(tenantId, chatId, user);
    const rows = await this.repo.members(tenantId, chatId);
    const online = new Set(this.realtime.onlineUsers(tenantId));
    return {
      canManage: (chat.kind === 'group' || chat.kind === 'channel') && await this.canManageChat(chat, user),
      createdBy: chat.created_by,
      members: rows.map((r) => ({ ...this.memberOut(r), online: online.has(String(r.user_id)) })),
    };
  }

  /**
   * Сведения для сайдбара чата (ТЗ-5, этап 2): что это за чат, кто в нём и по каким
   * ролям, сколько в нём материалов. Одним запросом с фронта — сайдбар открывают
   * ради одного взгляда, и три отдельных загрузки читались бы как «медленно».
   */
  async info(tenantId: string, chatId: string, user: { userId: string; role: string }) {
    await this.access(tenantId, chatId, user);
    const chat = await this.repo.info(tenantId, chatId);
    if (!chat) throw AppException.notFound('Чат не найден');
    const rows = await this.repo.members(tenantId, chatId);
    const online = new Set(this.realtime.onlineUsers(tenantId));
    const counts = await this.repo.materialCounts(tenantId, chatId);
    const my = rows.find((r) => String(r.user_id) === String(user.userId));
    return {
      chat: {
        id: String(chat.id), kind: chat.kind, title: chat.title, description: chat.description ?? null,
        isPrivate: chat.is_private !== false, isExternal: chat.is_external === true,
        projectId: chat.project_id ? String(chat.project_id) : null, projectName: chat.project_name,
        clientId: chat.client_id ? String(chat.client_id) : null, clientName: chat.client_name,
        createdAt: chat.created_at, createdBy: chat.created_by ? String(chat.created_by) : null, createdByName: chat.created_by_name,
      },
      members: rows.map((r) => ({ ...this.memberOut(r), online: online.has(String(r.user_id)) })),
      // Внешние — по ссылке, без учётки: в списке участников они отдельной группой,
      // чтобы было видно, кто из говорящих здесь не сотрудник.
      guests: chat.is_external ? (await this.repo.guestNames(tenantId, chatId)).map((g) => g.guest_name) : [],
      me: {
        role: my?.role ?? (chat.kind === 'project' ? 'member' : null),
        notify: my?.notify ?? 'all',
        canManage: (chat.kind === 'group' || chat.kind === 'channel') && await this.canManageChat(chat, user),
      },
      counts: {
        media: Number(counts?.media ?? 0), voice: Number(counts?.voice ?? 0), docs: Number(counts?.docs ?? 0),
        files: Number(counts?.files ?? 0), links: Number(counts?.links ?? 0), pinned: Number(counts?.pinned ?? 0),
      },
    };
  }

  /** Материалы чата по вкладке; ссылки вынимаются из текста сообщений. */
  async materials(tenantId: string, chatId: string, user: { userId: string; role: string }, kind: string, before?: string) {
    await this.access(tenantId, chatId, user);
    if (kind === 'links') {
      const rows = await this.repo.linkMessages(tenantId, chatId);
      const items: { messageId: string; url: string; authorName: string | null; createdAt: Date }[] = [];
      for (const m of rows) {
        for (const url of extractLinks(m.body)) {
          items.push({ messageId: String(m.id), url, authorName: m.author_name, createdAt: m.created_at });
        }
      }
      return { items };
    }
    if (kind !== 'media' && kind !== 'voice' && kind !== 'docs' && kind !== 'files') {
      throw AppException.validation('Неизвестный вид материалов');
    }
    const rows = await this.repo.materials(tenantId, chatId, kind, 60, before);
    return {
      items: rows.map((r) => ({
        messageId: String(r.message_id), fileId: String(r.file_id), name: r.file_name, mime: r.content_type,
        size: Number(r.size_bytes), authorName: r.author_name, createdAt: r.created_at,
      })),
    };
  }

  async savedInChat(tenantId: string, chatId: string, user: { userId: string; role: string }) {
    await this.access(tenantId, chatId, user);
    return this.repo.savedInChat(tenantId, chatId, user.userId);
  }

  async auditList(tenantId: string, chatId: string, user: { userId: string; role: string }) {
    await this.access(tenantId, chatId, user);
    return this.repo.auditList(tenantId, chatId);
  }

  /** Назначить администратора или снять: владелец, администраторы, руководство. */
  async setMemberRole(tenantId: string, chatId: string, user: { userId: string; role: string }, targetId: string, role: 'admin' | 'member') {
    const chat = await this.group(tenantId, chatId, user);
    if (!(await this.canManageChat(chat, user))) throw AppException.forbidden('Назначать администраторов может владелец или администратор чата');
    if (!(await this.repo.setMemberRole(chatId, targetId, role))) throw AppException.notFound('Участник не найден или это владелец');
    const name = (await this.repo.members(tenantId, chatId)).find((m) => String(m.user_id) === String(targetId))?.full_name ?? 'Участник';
    await this.repo.audit({ tenantId, chatId, actorId: user.userId, action: role === 'admin' ? 'admin_granted' : 'admin_revoked', detail: { userId: targetId, name } });
    await this.announce(tenantId, chat, role === 'admin' ? `${name} — теперь администратор` : `${name} больше не администратор`);
    this.emitChatUpdated(tenantId, chat);
    return { role };
  }

  async setDescription(tenantId: string, chatId: string, user: { userId: string; role: string }, description: string) {
    const chat = await this.group(tenantId, chatId, user);
    if (!(await this.canManageChat(chat, user))) throw AppException.forbidden('Описание меняет владелец или администратор чата');
    const text = description.trim().slice(0, 2000) || null;
    await this.repo.setDescription(tenantId, chatId, text);
    await this.repo.audit({ tenantId, chatId, actorId: user.userId, action: 'description_changed', detail: {} });
    this.emitChatUpdated(tenantId, chat);
    return { description: text };
  }

  /**
   * Задачи чата — блок в сайдбаре (ТЗ-5, этап 3): выросшие из сообщений и
   * отправленные карточкой. У чата проекта — ещё и сколько всего задач на доске.
   */
  async chatTasks(tenantId: string, chatId: string, user: { userId: string; role: string }) {
    const chat = await this.access(tenantId, chatId, user);
    const rows = await this.repo.chatTasks(tenantId, chatId);
    const total = Number((await this.repo.countChatTasks(tenantId, chatId))?.n ?? 0);
    return {
      total,
      projectId: chat.project_id ? String(chat.project_id) : null,
      items: rows.map((t) => ({
        id: String(t.id), title: t.title, status: t.status, closed: !!t.closed_at,
        deadlineAt: t.deadline_at, projectId: String(t.project_id), assigneeName: t.assignee_name, relation: t.relation,
      })),
    };
  }

  /**
   * «+ Отправить текущую задачу / проект» (ТЗ-5, раздел 30).
   *
   * В ленту уходит обычное сообщение с карточкой: задача — с номером и ссылкой на
   * неё (как у задачи, созданной из сообщения), проект — с названием и адресом
   * доски. Связь записывается в conversation_links: сайдбар покажет задачу в
   * блоке «Задачи», даже если сообщение потом уедет вверх.
   */
  async share(tenantId: string, chatId: string, user: { userId: string; role: string }, entityType: string, entityId: string) {
    const chat = await this.access(tenantId, chatId, user);
    const base = (process.env.APP_BASE_URL || 'https://anthill.team').replace(/\/+$/, '');
    let message: MessageRow;
    if (entityType === 'task') {
      const task = await this.repo.taskCard(tenantId, entityId);
      if (!task) throw AppException.notFound('Задача не найдена');
      const bits = [task.status, task.assignee_name ? `исполнитель: ${task.assignee_name}` : null,
        task.deadline_at ? `срок: ${new Date(task.deadline_at).toLocaleDateString('ru-RU')}` : null].filter(Boolean);
      message = await this.repo.addTaskMessage(
        tenantId, chatId, user.userId,
        `Задача #${task.id} «${task.title}»${bits.length ? `\n${bits.join(' · ')}` : ''}\n${base}/projects/${task.project_id}/task/${task.id}`,
        String(task.id),
      );
      await this.repo.link({ tenantId, chatId, entityType: 'task', entityId: String(task.id), relation: 'shared', actorId: user.userId });
    } else if (entityType === 'project') {
      const project = await this.repo.projectCard(tenantId, entityId);
      if (!project) throw AppException.notFound('Проект не найден');
      message = await this.repo.addMessage({
        tenantId, chatId, authorId: user.userId, fileId: null,
        body: `Проект «${project.name}» · задач в работе: ${project.open_tasks}\n${base}/projects/${project.id}`,
      });
      await this.repo.link({ tenantId, chatId, entityType: 'project', entityId: String(project.id), relation: 'shared', actorId: user.userId });
    } else {
      throw AppException.validation('Отправить можно задачу или проект');
    }
    await this.repo.markRead(tenantId, chatId, user.userId);
    const to = await this.recipients(chat, tenantId);
    this.realtime.emitToUsers(tenantId, to, 'chat.message', { chatId, message });
    this.realtime.emitToUsers(tenantId, to, 'chat.updated', { chatId: String(chat.id) });
    return message;
  }

  /** Миты чата — блок в сайдбаре. */
  async chatMeetings(tenantId: string, chatId: string, user: { userId: string; role: string }) {
    await this.access(tenantId, chatId, user);
    const rows = await this.repo.chatMeetings(tenantId, chatId);
    return rows.map((m) => ({
      id: String(m.id), title: m.title, at: m.happened_at ?? m.created_at, durationSec: m.duration_sec,
      status: m.status, summary: m.summary, tasksCreated: Number(m.tasks_created ?? 0),
      participants: m.participants ?? [], projectId: m.project_id ? String(m.project_id) : null,
    }));
  }

  /**
   * Контекст CRM для помощника (ТЗ-5, разделы 28 и 43): проект чата с живыми
   * задачами, задачи, связанные с чатом, итог последнего мита. Ровно то, что
   * человек и так видит в сайдбаре этого чата, — доступ уже проверен `access`.
   * Отдаётся коротко: модели нужен контекст, а не выгрузка базы.
   */
  private async aiContext(tenantId: string, chat: ChatRow) {
    const ctx: Record<string, unknown> = { chat: { kind: chat.kind, title: chat.title, description: chat.description ?? null } };
    if (chat.project_id) {
      const project = await this.repo.projectCard(tenantId, String(chat.project_id));
      if (project) {
        ctx.project = {
          name: project.name, status: project.status, openTasks: project.open_tasks,
          tasks: (await this.repo.projectTasksBrief(tenantId, String(chat.project_id))).map((t) => ({
            id: String(t.id), title: t.title, status: t.status, assignee: t.assignee_name,
            deadline: t.deadline_at ? new Date(t.deadline_at).toLocaleDateString('ru-RU') : null,
          })),
        };
      }
    }
    const linked = await this.repo.chatTasks(tenantId, String(chat.id), 20);
    if (linked.length) {
      ctx.linkedTasks = linked.map((t) => ({
        id: String(t.id), title: t.title, status: t.closed_at ? 'завершена' : t.status, assignee: t.assignee_name,
        deadline: t.deadline_at ? new Date(t.deadline_at).toLocaleDateString('ru-RU') : null,
      }));
    }
    const meetings = await this.repo.chatMeetings(tenantId, String(chat.id), 3);
    const last = meetings.find((m) => m.summary);
    if (last) ctx.lastMeeting = { title: last.title, at: new Date(last.happened_at ?? last.created_at).toLocaleString('ru-RU'), summary: String(last.summary).slice(0, 1500) };
    return ctx;
  }

  /** Сайдбар у всех участников должен перечитаться: название, описание, состав, роли. */
  private emitChatUpdated(tenantId: string, chat: ChatRow) {
    void this.recipients(chat, tenantId).then((to) => {
      this.realtime.emitToUsers(tenantId, to, 'chat.updated', { chatId: String(chat.id) });
    });
  }

  /** Добавлять может любой участник: звать коллегу в обсуждение — обычное дело. */
  async addMembers(tenantId: string, chatId: string, user: { userId: string; role: string }, userIds: string[]) {
    const chat = await this.group(tenantId, chatId, user);
    const added = await this.repo.addMembers(tenantId, chatId, userIds);
    if (!added.length) return { added: 0 };

    const names = (await this.repo.members(tenantId, chatId))
      .filter((m) => added.includes(String(m.user_id))).map((m) => m.full_name);
    await this.announce(tenantId, chat, `${names.join(', ')} ${names.length > 1 ? 'добавлены' : 'добавлен(а)'} в группу`);
    await this.repo.audit({ tenantId, chatId, actorId: user.userId, action: 'members_added', detail: { userIds: added, names } });
    // новичкам чат должен появиться в списке сразу
    this.realtime.emitToUsers(tenantId, added, 'chat.created', { chatId, title: chat.title });
    this.emitChatUpdated(tenantId, chat);
    return { added: added.length };
  }

  async removeMember(tenantId: string, chatId: string, user: { userId: string; role: string }, targetId: string) {
    const chat = await this.group(tenantId, chatId, user);
    if (String(targetId) === String(user.userId)) throw AppException.validation('Чтобы выйти самому, используйте «Выйти из группы»');
    if (!(await this.canManageChat(chat, user))) throw AppException.forbidden('Убирать участников может владелец или администратор чата');
    if (String(chat.created_by) === String(targetId)) throw AppException.validation('Владельца чата убрать нельзя');

    const name = (await this.repo.members(tenantId, chatId)).find((m) => String(m.user_id) === String(targetId))?.full_name;
    if (!(await this.repo.removeMember(chatId, targetId))) throw AppException.notFound('Участник не найден');
    await this.announce(tenantId, chat, `${name ?? 'Участник'} удалён(а) из группы`);
    await this.repo.audit({ tenantId, chatId, actorId: user.userId, action: 'member_removed', detail: { userId: targetId, name } });
    // исключённому чат исчезает из списка
    this.realtime.emitToUsers(tenantId, [targetId], 'chat.removed', { chatId });
    this.emitChatUpdated(tenantId, chat);
    return { removed: true };
  }

  async rename(tenantId: string, chatId: string, user: { userId: string; role: string }, title: string) {
    const chat = await this.group(tenantId, chatId, user);
    if (!(await this.canManageChat(chat, user))) throw AppException.forbidden('Переименовать может владелец или администратор чата');
    const name = title.trim();
    if (!name) throw AppException.validation('Название не может быть пустым');
    await this.repo.rename(tenantId, chatId, name.slice(0, 160));
    await this.announce(tenantId, chat, `Группа переименована в «${name.slice(0, 160)}»`);
    await this.repo.audit({ tenantId, chatId, actorId: user.userId, action: 'renamed', detail: { from: chat.title, to: name.slice(0, 160) } });
    this.emitChatUpdated(tenantId, chat);
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

  /**
   * «Пометить как непрочитанное» — как в Telegram.
   *
   * Личная пометка: собеседник о ней не узнаёт, его галочки не меняются, поэтому
   * никому ничего не рассылаем. Свои же устройства узнают из списка чатов.
   */
  async markUnread(tenantId: string, chatId: string, user: { userId: string; role: string }) {
    await this.access(tenantId, chatId, user);
    await this.repo.markUnread(tenantId, chatId, user.userId);
    return { unread: true };
  }

  /**
   * Непрочитанное С ЭТОГО сообщения.
   *
   * Только чужое: своё сообщение «не дочитать» нельзя. Собеседник узнаёт, что
   * дочитано не всё, — обычной отметкой чтения, когда чат откроют снова.
   */
  async markUnreadFrom(tenantId: string, chatId: string, user: { userId: string; role: string }, messageId: string) {
    await this.access(tenantId, chatId, user);
    const msg = await this.repo.findMessage(tenantId, messageId);
    if (!msg || String(msg.chat_id) !== String(chatId)) throw AppException.notFound('Сообщение не найдено');
    if (String(msg.author_id) === String(user.userId)) {
      throw AppException.validation('Своё сообщение непрочитанным не пометить');
    }
    const ok = await this.repo.markUnreadFrom(tenantId, chatId, user.userId, messageId);
    if (!ok) throw AppException.notFound('Сообщение не найдено');
    return { unread: true };
  }

  async markRead(tenantId: string, chatId: string, user: { userId: string; role: string }) {
    const chat = await this.access(tenantId, chatId, user);
    await this.repo.markRead(tenantId, chatId, user.userId);
    /*
      Собеседник должен увидеть вторую галочку СРАЗУ, а не после перезагрузки чата.
      Отметку о прочтении шлём остальным участникам: у отправителя галочки на всех
      его сообщениях до этого момента становятся прочитанными.
    */
    await this.announceRead(tenantId, chat, user.userId);
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
    // Обрезаем по тому же пределу, что и при отправке: правка не должна укорачивать текст.
    const next = text.slice(0, 8000);
    await this.repo.editMessage(tenantId, messageId, next);
    const to = await this.recipients(chat, tenantId);
    this.realtime.emitToUsers(tenantId, to, 'chat.message_edited', { chatId, messageId, body: next });
    return { edited: true, body: next };
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
