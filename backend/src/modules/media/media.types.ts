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
  /**
   * Соединение, которому принадлежит место в комнате. Человек может войти со второй
   * вкладки или устройства — тогда место переходит к новому соединению, и закрытие
   * старого больше не должно выкидывать человека из созвона.
   */
  conn?: unknown;
}

export interface MeetingRoom {
  id: string;
  tenantId: string;
  projectId: string | null;
  /**
   * Чат, из которого начали созвон.
   *
   * По нему итог вернётся туда же, где договаривались созвониться. Без этой связи
   * разбор оседает в разделе встреч, и половина договорённостей не доходит до тех,
   * кто в созвоне не был.
   */
  chatId?: string | null;
  /**
   * Задача, из которой начали созвон.
   *
   * Разговор по задаче и есть работа по ней: итог должен вернуться в её обсуждение,
   * а не только в раздел встреч. Иначе через неделю «мы же договорились на созвоне»
   * подтвердить нечем.
   */
  taskId?: string | null;
  /**
   * Сотрудник, с которого началась встреча.
   *
   * Нужен, потому что автором записи и владельцем файлов дорожек может быть только
   * пользователь: у гостя строки в users нет. Последним из комнаты вполне может выйти
   * именно гость — и тогда без этого поля запись оказалась бы без автора.
   */
  startedBy: string | null;
  router: MsRouter;
  participants: Map<string, Participant>;
  startedAt: number;
  /** ИИ позвали при старте: запись включится сама, как только пойдёт звук. */
  aiEnabled: boolean;
  /**
   * Кто входит без стука: начавший созвон, позванные в него и впущенные.
   *
   * Раньше в любую идущую комнату мог войти любой сотрудник организации — по кнопке
   * «Идёт созвон» в меню. Забыл выйти из созвона — и любой коллега слышит, что у тебя
   * происходит. Теперь остальные стучатся, как гость, и их впускает кто-то изнутри.
   */
  allowed: Set<string>;
  /**
   * Комната гостевой ссылки или события календаря (поднята по известному id).
   * Своих у неё узнают по базе: автор ссылки и участники события.
   */
  linked?: boolean;
  /** Организатор и соорганизаторы встречи, вошедшие в комнату (ТЗ-14). */
  hosts?: Set<string>;
  /** Кто уже бывал внутри: после «Закрыть вход» им можно вернуться, новым — нет. */
  joined?: Set<string>;
  /** «Закрыть вход»: новые люди не входят и не стучатся. */
  locked?: boolean;
}

/** ИИ в списке участников — не человек, поэтому вынесен отдельным описанием. */
export const AI_PARTICIPANT = {
  userId: 'ai',
  displayName: 'ИИ-ассистент',
  handRaised: false,
  isAi: true,
  producers: [] as { id: string; kind: string; appData: unknown }[],
};
