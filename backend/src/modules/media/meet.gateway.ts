import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpAdapterHost } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { IncomingMessage } from 'http';
import { Duplex } from 'stream';
import { WebSocket, WebSocketServer } from 'ws';
import { AccessTokenPayload } from '../../common/auth/jwt.types';
import { DbService } from '../../database/db.service';
import { MeetingsService } from '../meetings/meetings.service';
import { MediaService, optimalLayers } from './media.service';
import { RecordingService } from './recording.service';
import { AI_PARTICIPANT, MeetingRoom } from './media.types';

const PATH = '/ws/meet';

interface Client {
  ws: WebSocket;
  userId: string;
  tenantId: string;
  displayName: string;
  meetingId: string | null;
}

/**
 * Сигналинг созвонов — перенос протокола TeamConnect (17 сообщений).
 *
 * Почему отдельный WebSocket, а не наш socket.io: протокол mediasoup обкатан именно
 * в таком виде, а ошибки в нём проявляются как «у половины не слышно» и ловятся неделями.
 * Переписывание транспорта ради единообразия — не та экономия. Оба сервера живут на одном
 * HTTP-порту: socket.io обслуживает свой путь, мы — только /ws/meet и ничей больше.
 */
@Injectable()
export class MeetGateway implements OnModuleInit {
  private readonly log = new Logger('Meet');
  private wss: WebSocketServer | null = null;
  private readonly clients = new Map<WebSocket, Client>();
  /** tenantId:userId → сокеты (человек может сидеть с двух устройств) */
  private readonly byUser = new Map<string, Set<WebSocket>>();

  constructor(
    private readonly adapterHost: HttpAdapterHost,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly media: MediaService,
    private readonly db: DbService,
    private readonly recording: RecordingService,
    private readonly meetings: MeetingsService,
  ) {}

  onModuleInit(): void {
    const server = this.adapterHost.httpAdapter?.getHttpServer();
    if (!server) return;
    this.wss = new WebSocketServer({ noServer: true });

    server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      // Трогаем ТОЛЬКО свой путь: socket.io апгрейдит свои соединения сам,
      // и перехват чужого upgrade сломал бы realtime досок.
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (url.pathname !== PATH) return;

      const user = this.authenticate(url.searchParams.get('token'));
      // заказчику (роль client) командные созвоны недоступны — у него свой портал
      if (!user || user.role === 'client') {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
      this.wss!.handleUpgrade(req, socket, head, (ws) => void this.onConnect(ws, user));
    });
    this.log.log(`сигналинг созвонов слушает ${PATH}`);
  }

  /** Токен приходит query-параметром: браузер не умеет слать заголовки при WS-рукопожатии. */
  private authenticate(token: string | null): AccessTokenPayload | null {
    if (!token) return null;
    try {
      return this.jwt.verify<AccessTokenPayload>(token, {
        secret: this.config.getOrThrow<string>('JWT_ACCESS_SECRET'),
      });
    } catch {
      return null;
    }
  }

  private async onConnect(ws: WebSocket, user: AccessTokenPayload): Promise<void> {
    // имени в токене нет — берём из базы, оно показывается всем участникам созвона
    const row = await this.db
      .one<{ full_name: string }>(`SELECT full_name FROM users WHERE tenant_id=$1 AND id=$2`, [user.tenantId, user.sub])
      .catch(() => null);
    const client: Client = {
      ws,
      userId: String(user.sub),
      tenantId: String(user.tenantId),
      displayName: row?.full_name || user.email || 'Участник',
      meetingId: null,
    };
    this.clients.set(ws, client);
    this.track(client, ws);

    ws.on('message', (raw) => {
      let msg: any;
      try { msg = JSON.parse(String(raw)); } catch { return; }
      this.handle(client, msg).catch((e) =>
        this.log.warn(`${msg?.type}: ${(e as Error).message}`));
    });
    ws.on('close', () => {
      if (client.meetingId) void this.leave(client);
      this.clients.delete(ws);
      this.untrack(client, ws);
    });
    ws.on('error', () => ws.close());
  }

  private key(tenantId: string, userId: string) { return `${tenantId}:${userId}`; }

  private track(c: Client, ws: WebSocket) {
    const k = this.key(c.tenantId, c.userId);
    const set = this.byUser.get(k) ?? new Set<WebSocket>();
    set.add(ws);
    this.byUser.set(k, set);
  }
  private untrack(c: Client, ws: WebSocket) {
    const k = this.key(c.tenantId, c.userId);
    const set = this.byUser.get(k);
    if (!set) return;
    set.delete(ws);
    if (!set.size) this.byUser.delete(k);
  }

  private send(ws: WebSocket, type: string, payload: Record<string, unknown>) {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type, payload }));
  }

  private toUser(tenantId: string, userId: string, type: string, payload: Record<string, unknown>) {
    for (const ws of this.byUser.get(this.key(tenantId, userId)) ?? []) this.send(ws, type, payload);
  }

  /** Рассылка всем в комнате, кроме отправителя. */
  private broadcast(room: MeetingRoom, type: string, payload: Record<string, unknown>, exceptUserId?: string) {
    for (const userId of room.participants.keys()) {
      if (userId === exceptUserId) continue;
      this.toUser(room.tenantId, userId, type, payload);
    }
  }

  /** Комната только своей организации: чужой созвон недоступен даже по угаданному id. */
  private roomFor(c: Client, meetingId: unknown): MeetingRoom | null {
    if (typeof meetingId !== 'string') return null;
    const room = this.media.getRoom(meetingId);
    return room && room.tenantId === c.tenantId ? room : null;
  }

  private async handle(c: Client, msg: { type: string; payload?: Record<string, any> }): Promise<void> {
    const p = msg.payload ?? {};
    const room = this.roomFor(c, p.meeting_id);

    switch (msg.type) {
      case 'meet.join': {
        if (!room) return this.send(c.ws, 'meet.error', { message: 'Созвон не найден' });
        // вход со второго устройства вытесняет первое — иначе в списке два одинаковых человека
        if (room.participants.has(c.userId)) {
          this.media.removeParticipant(room, c.userId);
          this.broadcast(room, 'meet.peer-left', { meeting_id: room.id, user_id: c.userId });
        }
        this.media.addParticipant(room, c.userId, c.displayName);
        c.meetingId = room.id;

        this.send(c.ws, 'meet.router-capabilities', { meeting_id: room.id, rtp_capabilities: room.router.rtpCapabilities });
        this.send(c.ws, 'meet.participants', { meeting_id: room.id, participants: this.participants(room) });
        this.broadcast(room, 'meet.peer-joined', { meeting_id: room.id, user_id: c.userId, display_name: c.displayName }, c.userId);
        // ИИ позвали при создании — вошедший должен видеть это сразу, ещё до первой реплики
        if (room.aiEnabled && !this.recording.isRecording(room.id)) {
          this.send(c.ws, 'meet.ai-invited', { meeting_id: room.id });
        }

        // другие устройства этого же человека гасят входящий звонок
        for (const ws of this.byUser.get(this.key(c.tenantId, c.userId)) ?? []) {
          if (ws !== c.ws) this.send(ws, 'meet.call-answered-elsewhere', { meeting_id: room.id });
        }
        // вошедший обязан сразу узнать, что идёт запись, — это не мелочь интерфейса
        this.send(c.ws, 'meet.recording', { meeting_id: room.id, ...this.recording.recordingInfo(room.id) });
        await this.media.recalcQuality(room);
        return;
      }

      case 'meet.create-transport': {
        const participant = room?.participants.get(c.userId);
        if (!room || !participant) return;
        const direction = p.direction === 'send' ? 'send' : 'recv';
        const transport = await this.media.createTransport(room);
        if (direction === 'send') participant.sendTransport = transport;
        else participant.recvTransport = transport;

        return this.send(c.ws, 'meet.transport-created', {
          meeting_id: room.id, direction, transport_id: transport.id,
          ice_parameters: transport.iceParameters,
          ice_candidates: transport.iceCandidates,
          dtls_parameters: transport.dtlsParameters,
        });
      }

      case 'meet.connect-transport': {
        const transport = this.transportOf(room, c.userId, p.transport_id);
        if (!transport || !p.dtls_parameters) return;
        try {
          await transport.connect({ dtlsParameters: p.dtls_parameters });
          return this.send(c.ws, 'meet.transport-connected', { meeting_id: p.meeting_id, transport_id: p.transport_id });
        } catch (e) {
          this.log.warn(`connect-transport: ${(e as Error).message}`);
          return this.send(c.ws, 'meet.error', { message: 'Не удалось установить соединение' });
        }
      }

      case 'meet.produce': {
        const participant = room?.participants.get(c.userId);
        if (!room || !participant?.sendTransport || !p.kind || !p.rtp_parameters) return;
        try {
          const producer = await participant.sendTransport.produce({
            kind: p.kind, rtpParameters: p.rtp_parameters, appData: p.app_data ?? {},
          });
          participant.producers.set(producer.id, producer);
          // _req_id возвращаем обязательно: клиент по нему сопоставляет ответ со своим вызовом
          this.send(c.ws, 'meet.produced', { meeting_id: room.id, producer_id: producer.id, _req_id: p._req_id });
          this.broadcast(room, 'meet.new-producer', {
            meeting_id: room.id, user_id: c.userId, producer_id: producer.id,
            kind: producer.kind, app_data: producer.appData,
          }, c.userId);
          if (producer.kind === 'audio') {
            if (this.recording.isRecording(room.id)) {
              // включил микрофон при уже идущей записи — подхватываем дорожку на ходу
              void this.recording.attachLate(room, participant);
            } else if (room.aiEnabled) {
              // ИИ позвали при старте: запись стартует с первым же звуком, а не по кнопке.
              // Раньше делать нечего — записывать было бы нечего.
              void this.startRecording(room, c.userId);
            }
          }
        } catch (e) {
          this.log.warn(`produce: ${(e as Error).message}`);
          this.send(c.ws, 'meet.error', { message: 'Не удалось начать передачу', _req_id: p._req_id });
        }
        return;
      }

      case 'meet.consume': {
        const participant = room?.participants.get(c.userId);
        if (!room || !participant?.recvTransport || !p.producer_id || !p.rtp_capabilities) return;
        if (!room.router.canConsume({ producerId: p.producer_id, rtpCapabilities: p.rtp_capabilities })) {
          return this.send(c.ws, 'meet.error', { message: 'Поток недоступен для приёма' });
        }
        const owner = this.producerOwner(room, p.producer_id);
        try {
          const consumer = await participant.recvTransport.consume({
            producerId: p.producer_id,
            rtpCapabilities: p.rtp_capabilities,
            // звук стартует сразу: лишний round-trip слышен как задержка голоса.
            // видео — на паузе, клиент включит его, когда подготовит элемент
            paused: owner?.kind === 'video',
          });
          participant.consumers.set(consumer.id, consumer);
          if (consumer.kind === 'video') {
            await consumer.setPreferredLayers(optimalLayers(room.participants.size)).catch(() => undefined);
          }
          return this.send(c.ws, 'meet.consumed', {
            meeting_id: room.id, consumer_id: consumer.id, producer_id: p.producer_id,
            producer_user_id: owner?.userId ?? '', kind: consumer.kind,
            rtp_parameters: consumer.rtpParameters,
            // именно appData ПРОДЮСЕРА: у консьюмера оно пустое, а клиенту нужно знать,
            // камера это или демонстрация экрана
            app_data: owner?.appData ?? {},
          });
        } catch (e) {
          this.log.warn(`consume: ${(e as Error).message}`);
          return this.send(c.ws, 'meet.error', { message: 'Не удалось принять поток' });
        }
      }

      case 'meet.resume-consumer': {
        const consumer = room?.participants.get(c.userId)?.consumers.get(p.consumer_id);
        await consumer?.resume().catch(() => undefined);
        return;
      }

      case 'meet.producer-pause':
      case 'meet.producer-resume': {
        const producer = room?.participants.get(c.userId)?.producers.get(p.producer_id);
        if (!room || !producer) return;
        const pausing = msg.type === 'meet.producer-pause';
        await (pausing ? producer.pause() : producer.resume()).catch(() => undefined);
        this.broadcast(room, pausing ? 'meet.producer-paused' : 'meet.producer-resumed', {
          meeting_id: room.id, user_id: c.userId, producer_id: producer.id, kind: producer.kind,
        }, c.userId);
        return;
      }

      case 'meet.producer-close': {
        const participant = room?.participants.get(c.userId);
        const producer = participant?.producers.get(p.producer_id);
        if (!room || !participant || !producer) return;
        producer.close();
        participant.producers.delete(producer.id);
        this.broadcast(room, 'meet.producer-closed', { meeting_id: room.id, user_id: c.userId, producer_id: producer.id }, c.userId);
        return;
      }

      case 'meet.hand-raise':
      case 'meet.hand-lower': {
        const participant = room?.participants.get(c.userId);
        if (!room || !participant) return;
        participant.handRaised = msg.type === 'meet.hand-raise';
        this.broadcast(room, participant.handRaised ? 'meet.hand-raised' : 'meet.hand-lowered',
          { meeting_id: room.id, user_id: c.userId }, c.userId);
        return;
      }

      case 'meet.reaction': {
        if (!room || !room.participants.has(c.userId) || typeof p.emoji !== 'string') return;
        this.broadcast(room, 'meet.reaction', { meeting_id: room.id, user_id: c.userId, emoji: p.emoji.slice(0, 8) }, c.userId);
        return;
      }

      case 'meet.restart-ice': {
        const transport = this.transportOf(room, c.userId, p.transport_id);
        if (!transport) return;
        try {
          const iceParameters = await transport.restartIce();
          return this.send(c.ws, 'meet.ice-restarted', {
            meeting_id: p.meeting_id, transport_id: p.transport_id, ice_parameters: iceParameters,
          });
        } catch {
          return this.send(c.ws, 'meet.error', { message: 'Не удалось переустановить соединение' });
        }
      }

      case 'meet.set-consumer-layers': {
        const consumer = room?.participants.get(c.userId)?.consumers.get(p.consumer_id);
        if (!consumer || typeof p.spatial_layer !== 'number' || typeof p.temporal_layer !== 'number') return;
        await consumer.setPreferredLayers({ spatialLayer: p.spatial_layer, temporalLayer: p.temporal_layer }).catch(() => undefined);
        return;
      }

      case 'meet.get-participants': {
        if (!room) return;
        return this.send(c.ws, 'meet.participants', { meeting_id: room.id, participants: this.media.participantList(room) });
      }

      /** Приглашение: адресатам прилетает входящий звонок на все их устройства. */
      case 'meet.invite': {
        if (!room || !room.participants.has(c.userId) || !Array.isArray(p.user_ids)) return;
        for (const target of p.user_ids.slice(0, 50)) {
          if (String(target) === c.userId) continue;
          this.toUser(c.tenantId, String(target), 'meet.incoming-call', {
            meeting_id: room.id, project_id: room.projectId,
            caller_id: c.userId, caller_name: c.displayName,
          });
        }
        return;
      }

      case 'meet.decline': {
        if (!room || typeof p.caller_id !== 'string') return;
        this.toUser(c.tenantId, p.caller_id, 'meet.declined', { meeting_id: room.id, user_id: c.userId });
        return;
      }

      /** Запись включается по кнопке и видна всем — тихой записи в продукте нет. */
      case 'meet.record-start': {
        if (!room || !room.participants.has(c.userId)) return;
        await this.startRecording(room, c.userId);
        return;
      }

      case 'meet.record-stop': {
        if (!room || !room.participants.has(c.userId)) return;
        room.aiEnabled = false; // остановили вручную — не поднимаем запись заново на следующем звуке
        await this.finishRecording(room, c.userId);
        for (const userId of room.participants.keys()) {
          this.toUser(room.tenantId, userId, 'meet.recording', { meeting_id: room.id, active: false });
        }
        this.syncParticipants(room); // ИИ уходит из списка
        return;
      }

      case 'meet.leave':
        return this.leave(c);
    }
  }

  /** Запуск записи + оповещение: плашка у всех и ИИ в списке участников. */
  private async startRecording(room: MeetingRoom, actorId: string): Promise<void> {
    if (this.recording.isRecording(room.id)) return;
    try {
      await this.recording.start(room, actorId);
    } catch (e) {
      this.log.warn(`не удалось начать запись ${room.id}: ${(e as Error).message}`);
      this.toUser(room.tenantId, actorId, 'meet.error', { message: 'Не удалось начать запись' });
      return;
    }
    const info = this.recording.recordingInfo(room.id);
    for (const userId of room.participants.keys()) {
      this.toUser(room.tenantId, userId, 'meet.recording', { meeting_id: room.id, ...info });
    }
    this.syncParticipants(room); // ИИ появляется в списке
  }

  /**
   * Останавливает запись и отдаёт дорожки в конвейер встреч: стенограмма с именами,
   * сводка, черновики задач. Ошибка обработки не должна ронять созвон.
   */
  private async finishRecording(room: MeetingRoom, actorId: string | null): Promise<void> {
    if (!this.recording.isRecording(room.id)) return;
    try {
      const tracks = await this.recording.stop(room.id);
      if (!tracks.length) return;
      const when = new Date().toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
      await this.meetings.ingestCallRecording({
        tenantId: room.tenantId, actorId, projectId: room.projectId,
        title: `Созвон ${when}`, tracks,
      });
    } catch (e) {
      this.log.warn(`обработка записи ${room.id}: ${(e as Error).message}`);
    }
  }

  /**
   * Список участников: пока идёт запись, ИИ показывается наравне с людьми.
   * Он именно в списке, а не только плашкой — так его невозможно не заметить.
   */
  private participants(room: MeetingRoom) {
    const list: unknown[] = this.media.participantList(room);
    if (this.recording.isRecording(room.id)) list.unshift(AI_PARTICIPANT);
    return list;
  }

  /** Разослать всем актуальный состав — после входа, выхода и смены состояния записи. */
  private syncParticipants(room: MeetingRoom) {
    const participants = this.participants(room);
    for (const userId of room.participants.keys()) {
      this.toUser(room.tenantId, userId, 'meet.participants', { meeting_id: room.id, participants });
    }
  }

  private transportOf(room: MeetingRoom | null, userId: string, transportId: unknown) {
    const participant = room?.participants.get(userId);
    if (!participant || typeof transportId !== 'string') return null;
    if (participant.sendTransport?.id === transportId) return participant.sendTransport;
    if (participant.recvTransport?.id === transportId) return participant.recvTransport;
    return null;
  }

  private producerOwner(room: MeetingRoom, producerId: string) {
    for (const [userId, participant] of room.participants) {
      const producer = participant.producers.get(producerId);
      if (producer) return { userId, kind: producer.kind, appData: producer.appData };
    }
    return null;
  }

  /** Выход: последний участник закрывает комнату, иначе роутеры копились бы вечно. */
  private async leave(c: Client): Promise<void> {
    const room = c.meetingId ? this.media.getRoom(c.meetingId) : null;
    c.meetingId = null;
    if (!room) return;
    if (!this.media.removeParticipant(room, c.userId)) return;

    this.broadcast(room, 'meet.peer-left', { meeting_id: room.id, user_id: c.userId });
    if (room.participants.size === 0) {
      // все разошлись, кнопку «стоп» никто не нажал — дописываем сами,
      // иначе ffmpeg остался бы висеть, а запись пропала
      await this.finishRecording(room, c.userId);
      this.media.closeRoom(room.id);
    } else {
      await this.media.recalcQuality(room);
    }
  }
}
