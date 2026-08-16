import { Injectable } from '@nestjs/common';
import { AppException } from '../../common/http/app-exception';
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
    const rows = await this.repo.messages(tenantId, chatId, beforeId ?? null, PAGE);
    await this.repo.markRead(tenantId, chatId, user.userId);
    return rows;
  }

  async send(tenantId: string, chatId: string, user: { userId: string; role: string }, body: string, fileId: string | null) {
    const chat = await this.access(tenantId, chatId, user);
    const text = (body ?? '').trim();
    if (!text && !fileId) throw AppException.validation('Пустое сообщение');

    const message = await this.repo.addMessage({
      tenantId, chatId, authorId: user.userId, body: text.slice(0, 8000), fileId,
    });
    await this.repo.markRead(tenantId, chatId, user.userId); // своё сообщение прочитанным считаем сразу

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
