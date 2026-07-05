import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import {
  OnGatewayConnection,
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

/**
 * WebSocket Gateway. Сокет авторизуется тем же access-JWT при handshake.
 * Комнаты — по проекту, с разделением internal/client (фича №9).
 * WebSocket — только транспорт уведомлений; запись идёт через REST.
 */
@WebSocketGateway({ transports: ['websocket', 'polling'] })
export class RealtimeGateway implements OnGatewayInit, OnGatewayConnection {
  private readonly logger = new Logger('Realtime');

  @WebSocketServer()
  server!: Server;

  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly db: DbService,
    private readonly realtime: RealtimeService,
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
    } catch {
      socket.emit('error', { code: 'UNAUTHORIZED', message: 'Socket auth failed' });
      socket.disconnect(true);
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
