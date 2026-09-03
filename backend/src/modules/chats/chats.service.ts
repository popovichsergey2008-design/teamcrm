import { Injectable } from '@nestjs/common';
import { AppException } from '../../common/http/app-exception';
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
    await this.access(tenantId, chatId, user);
    await this.repo.markRead(tenantId, chatId, user.userId);
    return { read: true };
  }

  /** Удалять можно только своё: правки чужих сообщений в переписке недопустимы. */
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
