/**
 * Минимальные структурные типы mediasoup.
 *
 * Штатные типы не импортируем сознательно: mediasoup лежит в optionalDependencies,
 * потому что официально не ставится под Windows (только через WSL). Импорт его типов
 * ломал бы компиляцию на машине разработчика, где пакета нет. Здесь описано ровно то,
 * чем мы пользуемся.
 */

export interface MsTransport {
  id: string;
  iceParameters: unknown;
  iceCandidates: unknown;
  dtlsParameters: unknown;
  connect(o: { dtlsParameters: unknown }): Promise<void>;
  produce(o: { kind: string; rtpParameters: unknown; appData?: unknown }): Promise<MsProducer>;
  consume(o: { producerId: string; rtpCapabilities: unknown; paused?: boolean; appData?: unknown }): Promise<MsConsumer>;
  setMaxIncomingBitrate(bps: number): Promise<void>;
  restartIce(): Promise<unknown>;
  close(): void;
  on(event: string, cb: (...args: any[]) => void): void;
  observer: { on(event: string, cb: (...args: any[]) => void): void };
}

export interface MsProducer {
  id: string;
  kind: string;
  appData: Record<string, unknown>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  close(): void;
}

export interface MsConsumer {
  id: string;
  kind: string;
  producerId: string;
  rtpParameters: unknown;
  resume(): Promise<void>;
  setPreferredLayers(l: { spatialLayer: number; temporalLayer: number }): Promise<void>;
  close(): void;
  on(event: string, cb: (...args: any[]) => void): void;
}

/** Транспорт для записи: RTP уходит на локальный порт, где слушает ffmpeg. */
export interface MsPlainTransport {
  id: string;
  tuple: { localPort?: number };
  connect(o: { ip: string; port: number }): Promise<void>;
  consume(o: { producerId: string; rtpCapabilities: unknown; paused?: boolean }): Promise<MsConsumer>;
  close(): void;
}

export interface MsRouter {
  rtpCapabilities: unknown;
  createWebRtcTransport(options: unknown): Promise<MsTransport>;
  createPlainTransport(options: unknown): Promise<MsPlainTransport>;
  canConsume(o: { producerId: string; rtpCapabilities: unknown }): boolean;
  close(): void;
}

export interface MsWorker {
  pid: number;
  createRouter(o: { mediaCodecs: unknown }): Promise<MsRouter>;
  close(): void;
  on(event: string, cb: (...args: any[]) => void): void;
}

/** Участник комнаты: свои транспорты и потоки. */
export interface Participant {
  userId: string;
  displayName: string;
  sendTransport: MsTransport | null;
  recvTransport: MsTransport | null;
  producers: Map<string, MsProducer>;
  consumers: Map<string, MsConsumer>;
  handRaised: boolean;
}

export interface MeetingRoom {
  id: string;
  tenantId: string;
  projectId: string | null;
  router: MsRouter;
  participants: Map<string, Participant>;
  startedAt: number;
  /** ИИ позвали при старте: запись включится сама, как только пойдёт звук. */
  aiEnabled: boolean;
}

/** ИИ в списке участников — не человек, поэтому вынесен отдельным описанием. */
export const AI_PARTICIPANT = {
  userId: 'ai',
  displayName: 'ИИ-ассистент',
  handRaised: false,
  isAi: true,
  producers: [] as { id: string; kind: string; appData: unknown }[],
};
