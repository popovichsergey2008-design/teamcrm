import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import { MeetingRoom, MsRouter, MsTransport, MsWorker, Participant } from './media.types';

/** Кодеки: Opus для звука, три видеокодека — браузеры договорятся сами. */
const MEDIA_CODECS = [
  {
    kind: 'audio', mimeType: 'audio/opus', clockRate: 48000, channels: 2,
    parameters: { useinbandfec: 1, usedtx: 0, maxaveragebitrate: 128000, stereo: 0, 'sprop-stereo': 0 },
  },
  { kind: 'video', mimeType: 'video/VP8', clockRate: 90000, parameters: {} },
  { kind: 'video', mimeType: 'video/VP9', clockRate: 90000, parameters: { 'profile-id': 2 } },
  {
    kind: 'video', mimeType: 'video/H264', clockRate: 90000,
    parameters: { 'packetization-mode': 1, 'profile-level-id': '42e01f', 'level-asymmetry-allowed': 1 },
  },
];

/** Чем больше людей — тем скромнее битрейт: канал делится на всех. */
function bitrateCap(count: number): number {
  if (count <= 2) return 2_500_000;
  if (count <= 4) return 1_500_000;
  if (count <= 8) return 1_000_000;
  return 800_000;
}

/** Аналогично со слоями simulcast: на многолюдной встрече качество снижаем осознанно. */
export function optimalLayers(count: number): { spatialLayer: number; temporalLayer: number } {
  if (count <= 2) return { spatialLayer: 2, temporalLayer: 2 };
  if (count <= 3) return { spatialLayer: 1, temporalLayer: 2 };
  if (count <= 4) return { spatialLayer: 1, temporalLayer: 1 };
  return { spatialLayer: 0, temporalLayer: 1 };
}

/**
 * SFU-слой созвонов (перенос из TeamConnect, адаптированный под CRM).
 *
 * Два принципиальных отличия от оригинала:
 * 1) mediasoup грузится ЛЕНИВО и лежит в optionalDependencies. Нет бинарника (Windows,
 *    сборка без сети) — звонки недоступны, а доски, задачи и финансы работают как обычно.
 * 2) Смерть воркера НЕ убивает процесс. В TeamConnect стоял process.exit(1) — там процесс
 *    и есть мессенджер. У нас этот же процесс обслуживает всю компанию, поэтому воркер
 *    пересоздаётся, а его комнаты закрываются с уведомлением.
 */
@Injectable()
export class MediaService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('Media');
  private readonly workers: MsWorker[] = [];
  private readonly rooms = new Map<string, MeetingRoom>();
  private mediasoup: any = null;
  private nextWorker = 0;
  private initError: string | null = null;

  constructor(private readonly config: ConfigService) {}

  get available(): boolean {
    return this.workers.length > 0;
  }

  /** Состояние медиа-слоя для диагностики: почему звонки недоступны — видно сразу. */
  health() {
    return {
      available: this.available,
      workers: this.workers.length,
      rooms: this.rooms.size,
      participants: [...this.rooms.values()].reduce((s, r) => s + r.participants.size, 0),
      announcedIp: this.config.get<string>('MEDIASOUP_ANNOUNCED_IP') ?? null,
      error: this.initError,
    };
  }

  async onModuleInit(): Promise<void> {
    if (this.config.get<string>('MEDIASOUP_DISABLED') === '1') {
      this.initError = 'выключено через MEDIASOUP_DISABLED';
      return;
    }
    try {
      // require, а не import: пакета может не быть, и это не должно ронять сборку
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      this.mediasoup = require('mediasoup');
    } catch {
      this.initError = 'пакет mediasoup не установлен — созвоны недоступны, остальная CRM работает';
      this.log.warn(this.initError);
      return;
    }
    const count = Math.max(1, Number(this.config.get('MEDIASOUP_NUM_WORKERS') ?? 2));
    try {
      for (let i = 0; i < count; i++) await this.spawnWorker();
      this.log.log(`mediasoup: воркеров ${this.workers.length}, порты ${this.minPort()}–${this.maxPort()}`);
    } catch (e) {
      this.initError = `не удалось запустить mediasoup: ${(e as Error).message}`;
      this.log.error(this.initError);
    }
  }

  onModuleDestroy(): void {
    for (const r of this.rooms.values()) this.closeRoomInternal(r);
    for (const w of this.workers) { try { w.close(); } catch { /* уже мёртв */ } }
    this.workers.length = 0;
  }

  private minPort() { return Number(this.config.get('MEDIASOUP_MIN_PORT') ?? 40000); }
  private maxPort() { return Number(this.config.get('MEDIASOUP_MAX_PORT') ?? 40100); }

  private async spawnWorker(): Promise<void> {
    const worker: MsWorker = await this.mediasoup.createWorker({
      rtcMinPort: this.minPort(), rtcMaxPort: this.maxPort(), logLevel: 'warn',
    });
    worker.on('died', () => {
      this.log.error(`mediasoup worker ${worker.pid} умер — закрываю его комнаты и поднимаю замену`);
      // комнаты этого воркера больше не обслуживаются: честно закрываем, чтобы клиенты переподключились
      for (const [id, room] of [...this.rooms]) {
        if (!this.workers.includes(worker)) continue;
        this.closeRoomInternal(room);
        this.rooms.delete(id);
      }
      const idx = this.workers.indexOf(worker);
      if (idx >= 0) this.workers.splice(idx, 1);
      this.spawnWorker().catch((e) => this.log.error(`замена воркера не поднялась: ${(e as Error).message}`));
    });
    this.workers.push(worker);
  }

  private pickWorker(): MsWorker {
    const w = this.workers[this.nextWorker % this.workers.length];
    this.nextWorker++;
    return w;
  }

  private transportOptions() {
    const listenIp = this.config.get<string>('MEDIASOUP_LISTEN_IP') ?? '0.0.0.0';
    // за NAT SFU обязан объявлять ВНЕШНИЙ адрес, иначе кандидаты ICE указывают в пустоту
    const announced = this.config.get<string>('MEDIASOUP_ANNOUNCED_IP') || undefined;
    return {
      listenInfos: [
        { protocol: 'udp', ip: listenIp, announcedAddress: announced },
        { protocol: 'tcp', ip: listenIp, announcedAddress: announced },
      ],
      preferUdp: true,
      enableTcp: true, // TCP-запасной путь для сетей, где UDP режут
      initialAvailableOutgoingBitrate: 1_500_000,
    };
  }

  // ───── комнаты ─────

  async createRoom(tenantId: string, projectId: string | null): Promise<MeetingRoom> {
    if (!this.available) throw new Error('Медиа-сервер недоступен');
    const router: MsRouter = await this.pickWorker().createRouter({ mediaCodecs: MEDIA_CODECS });
    const room: MeetingRoom = {
      id: randomUUID(), tenantId, projectId, router, participants: new Map(), startedAt: Date.now(),
    };
    this.rooms.set(room.id, room);
    return room;
  }

  getRoom(id: string): MeetingRoom | undefined {
    return this.rooms.get(id);
  }

  /** Комнаты организации — чтобы показать «идёт созвон» и дать присоединиться. */
  activeRooms(tenantId: string) {
    return [...this.rooms.values()]
      .filter((r) => r.tenantId === tenantId)
      .map((r) => ({
        id: r.id, projectId: r.projectId, startedAt: r.startedAt,
        participants: [...r.participants.values()].map((p) => ({ userId: p.userId, displayName: p.displayName })),
      }));
  }

  closeRoom(id: string): void {
    const room = this.rooms.get(id);
    if (!room) return;
    this.closeRoomInternal(room);
    this.rooms.delete(id);
  }

  private closeRoomInternal(room: MeetingRoom): void {
    for (const p of room.participants.values()) {
      p.sendTransport?.close();
      p.recvTransport?.close();
    }
    try { room.router.close(); } catch { /* воркер мог умереть */ }
  }

  addParticipant(room: MeetingRoom, userId: string, displayName: string): Participant {
    const existing = room.participants.get(userId);
    if (existing) this.removeParticipant(room, userId); // вход со второго устройства вытесняет первый
    const p: Participant = {
      userId, displayName, sendTransport: null, recvTransport: null,
      producers: new Map(), consumers: new Map(), handRaised: false,
    };
    room.participants.set(userId, p);
    return p;
  }

  removeParticipant(room: MeetingRoom, userId: string): boolean {
    const p = room.participants.get(userId);
    if (!p) return false;
    for (const c of p.consumers.values()) { try { c.close(); } catch { /* */ } }
    for (const pr of p.producers.values()) { try { pr.close(); } catch { /* */ } }
    p.sendTransport?.close();
    p.recvTransport?.close();
    room.participants.delete(userId);
    return true;
  }

  // ───── транспорты и качество ─────

  async createTransport(room: MeetingRoom): Promise<MsTransport> {
    const transport = await room.router.createWebRtcTransport(this.transportOptions());
    await transport.setMaxIncomingBitrate(bitrateCap(room.participants.size)).catch(() => undefined);
    transport.on('dtlsstatechange', (state: string) => {
      if (state === 'failed' || state === 'closed') transport.close();
    });
    return transport;
  }

  /** После входа/выхода пересчитываем качество: людей стало больше — картинку ужимаем. */
  async recalcQuality(room: MeetingRoom): Promise<void> {
    const cap = bitrateCap(room.participants.size);
    const layers = optimalLayers(room.participants.size);
    for (const p of room.participants.values()) {
      await p.sendTransport?.setMaxIncomingBitrate(cap).catch(() => undefined);
      await p.recvTransport?.setMaxIncomingBitrate(cap).catch(() => undefined);
      for (const c of p.consumers.values()) {
        if (c.kind === 'video') await c.setPreferredLayers(layers).catch(() => undefined);
      }
    }
  }

  participantList(room: MeetingRoom) {
    return [...room.participants.values()].map((p) => ({
      userId: p.userId,
      displayName: p.displayName,
      handRaised: p.handRaised,
      producers: [...p.producers.values()].map((pr) => ({ id: pr.id, kind: pr.kind, appData: pr.appData })),
    }));
  }
}
