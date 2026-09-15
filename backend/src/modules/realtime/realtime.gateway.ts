import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
  MessageBody,
  ConnectedSocket,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { DbService } from '../../database/db.service';
import { AccessTokenPayload, AuthUser } from '../../common/auth/jwt.types';
import { RealtimeService } from './realtime.service';
import { PresenceService } from '../presence/presence.service';

/**
 * WebSocket Gateway. Сокет авторизуется тем же access-JWT при handshake.
 * Комнаты — по проекту, с разделением internal/client (фича №9).
 * WebSocket — только транспорт уведомлений; запись идёт через REST.
 */
@WebSocketGateway({ transports: ['websocket', 'polling'] })
export class RealtimeGateway implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger('Realtime');

  @WebSocketServer()
  server!: Server;

  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly db: DbService,
    private readonly realtime: RealtimeService,
    private readonly presence: PresenceService,
  ) {}

  afterInit(server: Server) {
    this.realtime.setServer(server);
  }

  async handleConnection(socket: Socket) {
    try {
      const token =
        (socket.handshake.auth?.token as string) ||
        (socket.handshake.query?.token as string);
      if (!token) throw new Error('no token');
      const payload = await this.jwt.verifyAsync<AccessTokenPayload>(token, {
        secret: this.config.getOrThrow<string>('JWT_ACCESS_SECRET'),
      });
      const user: AuthUser = {
        userId: payload.sub,
        tenantId: payload.tenantId,
        role: payload.role,
        email: payload.email,
      };
      socket.data.user = user;
      // личная комната: сюда приходят сообщения мессенджера, адресованные этому человеку
      await socket.join(RealtimeService.userRoom(user.tenantId, user.userId));
      // комната компании: статусы коллег приходят всем, кто в сети
      await socket.join(RealtimeService.tenantRoom(user.tenantId));
      this.realtime.presenceConnect(user.tenantId, user.userId);
      void this.presence.touch(user.tenantId, user.userId);
      this.realtime.emitToTenant(user.tenantId, 'user.online', { userId: user.userId });
    } catch {
      socket.emit('error', { code: 'UNAUTHORIZED', message: 'Socket auth failed' });
      socket.disconnect(true);
    }
  }

  /** Ушёл со всех устройств — гаснет точка «в сети» в мессенджере. */
  handleDisconnect(socket: Socket) {
    const user: AuthUser | undefined = socket.data?.user;
    if (!user) return;
    this.realtime.presenceDisconnect(user.tenantId, user.userId);
    void this.presence.touch(user.tenantId, user.userId);
    // «не в сети» — только когда закрылось ПОСЛЕДНЕЕ соединение человека: у него
    // может быть открыта вторая вкладка или телефон
    if (!this.realtime.isOnline(user.tenantId, user.userId)) {
      this.realtime.emitToTenant(user.tenantId, 'user.offline', { userId: user.userId });
    }
  }

  @SubscribeMessage('project.subscribe')
  async subscribe(
    @ConnectedSocket() socket: Socket,
    @MessageBody() body: { projectId: string },
  ) {
    const user: AuthUser = socket.data.user;
    if (!user || !body?.projectId) return { ok: false };

    // tenant-изоляция: проект должен принадлежать tenant'у из токена.
    // Для client с привязкой к заказчику — дополнительно проект должен быть его client_id.
    let project;
    if (user.role === 'client') {
      const u = await this.db.one<{ client_id: string | null }>(
        'SELECT client_id FROM users WHERE id = $1 AND tenant_id = $2',
        [user.userId, user.tenantId],
      );
      project = u?.client_id
        ? await this.db.one('SELECT id FROM projects WHERE id = $1 AND tenant_id = $2 AND client_id = $3', [body.projectId, user.tenantId, u.client_id])
        : await this.db.one('SELECT id FROM projects WHERE id = $1 AND tenant_id = $2', [body.projectId, user.tenantId]);
    } else {
      project = await this.db.one('SELECT id FROM projects WHERE id = $1 AND tenant_id = $2', [body.projectId, user.tenantId]);
    }
    if (!project) return { ok: false, error: 'NOT_FOUND' };

    const room =
      user.role === 'client'
        ? RealtimeService.clientRoom(user.tenantId, body.projectId)
        : RealtimeService.internalRoom(user.tenantId, body.projectId);
    await socket.join(room);
    return { ok: true, room };
  }

  /**
   * «Печатает…» (ТЗ-5, раздел 40).
   *
   * Клиент шлёт не чаще раза в пару секунд, пока набирает; сервер проверяет, что
   * человек в этом чате, и передаёт остальным участникам — без записи в базу: это
   * состояние, а не событие. Имя отдаём сразу, чтобы получателю не ходить за ним.
   */
  @SubscribeMessage('chat.typing')
  async typing(@ConnectedSocket() socket: Socket, @MessageBody() body: { chatId: string }) {
    const user: AuthUser = socket.data.user;
    if (!user || !body?.chatId || user.role === 'client') return { ok: false };
    const chat = await this.db.one<{ kind: string; is_member: boolean; full_name: string }>(
      `SELECT c.kind,
              EXISTS (SELECT 1 FROM chat_members m WHERE m.chat_id = c.id AND m.user_id = $3) AS is_member,
              (SELECT u.full_name FROM users u WHERE u.id = $3) AS full_name
         FROM chats c WHERE c.id = $1 AND c.tenant_id = $2`,
      [body.chatId, user.tenantId, user.userId],
    );
    if (!chat || (chat.kind !== 'project' && !chat.is_member)) return { ok: false };
    const payload = { chatId: String(body.chatId), userId: user.userId, name: chat.full_name };
    if (chat.kind === 'project') {
      this.realtime.emitToTenant(user.tenantId, 'chat.typing', payload);
    } else {
      const members = await this.db.many<{ user_id: string }>(
        `SELECT user_id FROM chat_members WHERE chat_id = $1 AND user_id <> $2`, [body.chatId, user.userId],
      );
      this.realtime.emitToUsers(user.tenantId, members.map((m) => String(m.user_id)), 'chat.typing', payload);
    }
    return { ok: true };
  }

  /**
   * «Печатает…» в обсуждении задачи (ТЗ-7).
   *
   * Тот же приём, что и у чатов: состояние живёт секунды и в базу не ложится.
   * Рассылаем в комнату проекта — ровно туда же, куда уходят новые сообщения
   * задачи, поэтому и слышат его те же люди. Имя берём сразу: получателю не
   * придётся ходить за ним отдельным запросом ради строки «Глеб печатает…».
   */
  @SubscribeMessage('task.typing')
  async taskTyping(@ConnectedSocket() socket: Socket, @MessageBody() body: { taskId: string }) {
    const user: AuthUser = socket.data.user;
    if (!user || !body?.taskId || user.role === 'client') return { ok: false };
    const row = await this.db.one<{ project_id: string; full_name: string }>(
      `SELECT t.project_id, (SELECT u.full_name FROM users u WHERE u.id = $3) AS full_name
         FROM tasks t WHERE t.id = $1 AND t.tenant_id = $2`,
      [body.taskId, user.tenantId, user.userId],
    );
    if (!row) return { ok: false };
    this.realtime.emitScoped(user.tenantId, String(row.project_id), 'task.typing', {
      taskId: String(body.taskId), userId: String(user.userId), name: row.full_name,
    }, false);
    return { ok: true };
  }

  @SubscribeMessage('project.unsubscribe')
  async unsubscribe(
    @ConnectedSocket() socket: Socket,
    @MessageBody() body: { projectId: string },
  ) {
    const user: AuthUser = socket.data.user;
    if (!user || !body?.projectId) return { ok: false };
    await socket.leave(RealtimeService.internalRoom(user.tenantId, body.projectId));
    await socket.leave(RealtimeService.clientRoom(user.tenantId, body.projectId));
    return { ok: true };
  }
}
