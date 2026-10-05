import { Device, types } from 'mediasoup-client';
import { wsUrl } from './origin';
import { diag, flushDiag } from './diag';

export interface RemoteTrack {
  consumerId: string;
  userId: string;
  kind: 'audio' | 'video';
  screen: boolean;
  track: MediaStreamTrack;
}

export interface Peer {
  userId: string;
  displayName: string;
  handRaised: boolean;
  /** ИИ-ассистент: показывается в списке наравне с людьми, пока идёт запись. */
  isAi?: boolean;
  /** Гость по ссылке: в списке помечен, чтобы «свой человек» и «чужой» не путались. */
  isGuest?: boolean;
}

/** Гость, стоящий за дверью: показывается сотрудникам до впуска. */
export interface Knock {
  guestId: string;
  name: string;
  /** Просится коллега, а не внешний гость: его не звали в этот созвон. */
  employee?: boolean;
}

export interface MeetEvents {
  onPeers: (peers: Peer[]) => void;
  onTrack: (t: RemoteTrack) => void;
  onTrackGone: (consumerId: string) => void;
  onState: (state: 'connecting' | 'connected' | 'reconnecting' | 'closed') => void;
  onRecording: (active: boolean) => void;
  onAiInvited?: () => void;
  /** Гостю: стучимся, ждём впуска (hostPresent — есть ли кому впускать). */
  onGuestWaiting?: (hostPresent: boolean, hostCalled: boolean) => void;
  /** Гостю: встреча позже — стучаться можно с opensAt (ISO). */
  onGuestTooEarly?: (opensAt: string) => void;
  /** Гостю: впустили — дальше обычный созвон. */
  onGuestAdmitted?: () => void;
  /** Гостю: отказали или отозвали ссылку. */
  onGuestRejected?: (reason: string) => void;
  /** Кто я в этой комнате: может ли «Завершить для всех» / «Закрыть вход» (ТЗ-14). */
  onRole?: (r: { host: boolean; meeting: boolean; locked: boolean }) => void;
  /** Организатор завершил встречу для всех. */
  onEnded?: (by: string) => void;
  /** Вход закрыт или открыт снова. */
  onLocked?: (locked: boolean) => void;
  /** Ответ на «Сообщить организатору». */
  onHostNotified?: (ok: boolean) => void;
  /** Сотруднику: список стучащихся изменился. */
  onKnocks?: (knocks: Knock[]) => void;
  onError: (message: string) => void;
}

const RESPONSE_TIMEOUT = 10_000;
/** Как часто замерять связь: чаще — шумно в диагностике, реже — не поймать момент. */
const STATS_EVERY = 15_000;

/**
 * Клиент созвона: WebSocket-сигналинг + mediasoup-client.
 *
 * Протокол сохранён как в TeamConnect — он обкатан, а ошибки в нём проявляются
 * как «у половины не слышно». Отличие одно и важное: ICE-серверы приходят с нашего
 * сервера (временные учётные данные TURN), а не зашиты в код бандла.
 */
export class MeetClient {
  private ws: WebSocket | null = null;
  private device = new Device();
  private send: types.Transport | null = null;
  private recv: types.Transport | null = null;
  private readonly producers = new Map<string, types.Producer>();
  private readonly consumers = new Map<string, types.Consumer>();
  /** Чей поток и какого рода — нужно, чтобы вернуть дорожку после паузы. */
  private readonly consumerMeta = new Map<string, { userId: string; screen: boolean }>();
  private readonly peers = new Map<string, Peer>();
  /** Гости за дверью — только для сотрудников. */
  private readonly knocks = new Map<string, Knock>();
  /** Уже запрошенные потоки: защита от повторного приёма того же продюсера. */
  private readonly requested = new Set<string>();

  /** Ожидания ответов сервера: соединение транспорта и подтверждение produce. */
  private readonly connectAcks = new Map<string, () => void>();
  private readonly produceAcks = new Map<string, (id: string) => void>();
  private reqCounter = 0;
  private closed = false;

  /**
   * Готовность исходящего транспорта.
   *
   * join() возвращается, как только открылся WebSocket, а транспорт создаётся
   * позже — после обмена возможностями с сервером. Микрофон же берётся сразу и,
   * если разрешение уже выдано, оказывается готов раньше транспорта. Тогда
   * publish() уходил в никуда: собеседник слышал тишину, при том что его самого
   * было слышно прекрасно. Теперь публикация ждёт транспорт.
   */
  /**
   * Стоим за дверью: гость по ссылке или коллега, которого не звали.
   *
   * Пока не впустили, сервер каналов не открывает — и ждать их по обычному таймауту
   * нельзя: впускают не за десять секунд. Раньше микрофон отваливался с «Сервер
   * созвонов не открыл исходящий канал», и впущенного гостя никто не слышал.
   * Обещание живёт, пока человек за дверью; впустили или отказали — разрешается.
   */
  private lobby: Promise<void> | null = null;
  private leaveLobby: (() => void) | null = null;
  /** Отказали во входе — публиковать нечего и ругаться не о чем. */
  private refused = false;

  private enterLobby(): void {
    if (this.lobby) return;
    this.lobby = new Promise<void>((r) => { this.leaveLobby = r; });
  }

  private exitLobby(): void {
    this.leaveLobby?.();
    this.lobby = null;
    this.leaveLobby = null;
  }

  private resolveSendReady!: () => void;
  private readonly sendReady = new Promise<void>((r) => { this.resolveSendReady = r; });

  /**
   * Готовность входящего транспорта.
   *
   * Та же беда с другой стороны и куда злее. Сервер присылает состав созвона
   * сразу после входа — вместе с потоками тех, кто уже говорит. Но входящий
   * транспорт к этому моменту ещё не создан: он появляется после загрузки
   * возможностей устройства. Запрос на приём приходил на сервер раньше времени,
   * тот молча его отбрасывал, а повторять было некому — поток помечался
   * запрошенным навсегда. Итог: вошедший вторым не слышал того, кто уже был
   * в комнате, хотя его самого слышали прекрасно.
   */
  private resolveRecvReady!: () => void;
  private readonly recvReady = new Promise<void>((r) => { this.resolveRecvReady = r; });

  constructor(
    private readonly meetingId: string,
    private readonly token: string,
    private readonly iceServers: RTCIceServer[],
    private readonly ev: MeetEvents,
    /** Свой id: по нему отсеиваем собственные потоки, чтобы не слышать себя. */
    private readonly myUserId: string,
  ) {}

  async join(): Promise<void> {
    this.ev.onState('connecting');
    this.ws = new WebSocket(`${wsUrl('/ws/meet')}?token=${encodeURIComponent(this.token)}`);

    this.ws.onmessage = (e) => {
      let msg: any;
      try { msg = JSON.parse(e.data); } catch { return; }
      this.onMessage(msg).catch((err) => this.ev.onError(String(err?.message ?? err)));
    };
    this.ws.onclose = () => { if (!this.closed) this.ev.onState('reconnecting'); };
    this.ws.onerror = () => this.ev.onError('Соединение с сервером созвонов потеряно');
    await new Promise<void>((resolve, reject) => {
      this.ws!.onopen = () => resolve();
      setTimeout(() => reject(new Error('Сервер созвонов не отвечает')), RESPONSE_TIMEOUT);
    });
    this.emit('meet.join', {});
  }

  private emit(type: string, payload: Record<string, unknown>) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type, payload: { meeting_id: this.meetingId, ...payload } }));
    }
  }

  private log(event: string, data?: unknown): void {
    diag('meet', event, this.meetingId, data);
  }

  /**
   * Замер связи раз в STATS_EVERY — в диагностику.
   *
   * Жалоба «звук с задержкой» без цифр не разбирается: задержку дают и путь (напрямую,
   * через TCP или через ретранслятор TURN), и потери с джиттером, из-за которых
   * браузер раздувает буфер воспроизведения. Здесь — всё это одной строкой:
   *  - path — какой путь выбран (host/srflx/relay, udp/tcp) и rtt до сервера;
   *  - in — приём звука: джиттер, потери за интервал, средний буфер, доля «досочинённого»;
   *  - out — отправка: rtt и потери глазами сервера.
   */
  private statsTimer: ReturnType<typeof setInterval> | null = null;
  private statsPrev = new Map<string, { lost: number; recv: number; concealed: number; samples: number; jbDelay: number; jbCount: number }>();

  private startStats(): void {
    if (this.statsTimer) return;
    this.statsTimer = setInterval(() => { void this.sampleStats(); }, STATS_EVERY);
  }

  private stopStats(): void {
    if (this.statsTimer) clearInterval(this.statsTimer);
    this.statsTimer = null;
  }

  private async sampleStats(): Promise<void> {
    if (this.closed) return this.stopStats();
    try {
      const out: Record<string, unknown> = {};
      for (const [dir, t] of [['send', this.send], ['recv', this.recv]] as const) {
        if (!t) continue;
        const report = await t.getStats();
        const all = new Map<string, any>();
        report.forEach((s: any) => all.set(s.id, s));
        // выбранная пара кандидатов — тот путь, по которому реально идёт звук
        let pair: any = null;
        for (const s of all.values()) {
          if (s.type === 'transport' && s.selectedCandidatePairId) pair = all.get(s.selectedCandidatePairId);
        }
        if (!pair) for (const s of all.values()) if (s.type === 'candidate-pair' && s.nominated && s.state === 'succeeded') pair = s;
        const local = pair ? all.get(pair.localCandidateId) : null;
        out[`${dir}Path`] = local
          ? `${local.candidateType}/${local.protocol}${local.relayProtocol ? `>${local.relayProtocol}` : ''}`
          : 'none';
        if (pair?.currentRoundTripTime != null) out[`${dir}Rtt`] = Math.round(pair.currentRoundTripTime * 1000);

        for (const s of all.values()) {
          if (s.type === 'inbound-rtp' && s.kind === 'audio') {
            const prev = this.statsPrev.get(s.id) ?? { lost: 0, recv: 0, concealed: 0, samples: 0, jbDelay: 0, jbCount: 0 };
            const now = {
              lost: s.packetsLost ?? 0, recv: s.packetsReceived ?? 0,
              concealed: s.concealedSamples ?? 0, samples: s.totalSamplesReceived ?? 0,
              jbDelay: s.jitterBufferDelay ?? 0, jbCount: s.jitterBufferEmittedCount ?? 0,
            };
            this.statsPrev.set(s.id, now);
            const got = now.recv - prev.recv;
            const lost = now.lost - prev.lost;
            const emitted = now.jbCount - prev.jbCount;
            const list = (out.in as unknown[] | undefined) ?? [];
            list.push({
              jitter: Math.round((s.jitter ?? 0) * 1000),
              lostPct: got + lost > 0 ? Math.round((lost / (got + lost)) * 1000) / 10 : 0,
              // средняя задержка в буфере воспроизведения за интервал — главный виновник «эха через секунду»
              bufferMs: emitted > 0 ? Math.round(((now.jbDelay - prev.jbDelay) / emitted) * 1000) : null,
              concealPct: now.samples - prev.samples > 0
                ? Math.round(((now.concealed - prev.concealed) / (now.samples - prev.samples)) * 1000) / 10 : 0,
              silent: got === 0,
            });
            out.in = list;
          }
          if (s.type === 'remote-inbound-rtp' && s.kind === 'audio') {
            out.out = {
              rtt: s.roundTripTime != null ? Math.round(s.roundTripTime * 1000) : null,
              lostPct: s.fractionLost != null ? Math.round(s.fractionLost * 1000) / 10 : null,
            };
          }
        }
      }
      this.log('stats', out);
    } catch { /* замер — не повод ронять созвон */ }
  }

  private async onMessage(msg: { type: string; payload?: any }): Promise<void> {
    const p = msg.payload ?? {};
    // Порядок сообщений — половина диагноза: именно он ломал приём звука.
    this.log(`in:${msg.type.replace('meet.', '')}`, {
      producerId: p.producer_id ?? undefined,
      direction: p.direction ?? undefined,
      people: Array.isArray(p.participants) ? p.participants.length : undefined,
      producers: Array.isArray(p.participants)
        ? p.participants.reduce((n: number, it: any) => n + (it.producers?.length ?? 0), 0)
        : undefined,
      deviceLoaded: this.device.loaded,
      hasRecv: !!this.recv,
      hasSend: !!this.send,
    });
    switch (msg.type) {
      case 'meet.router-capabilities':
        if (!this.device.loaded) await this.device.load({ routerRtpCapabilities: p.rtp_capabilities });
        this.emit('meet.create-transport', { direction: 'send' });
        this.emit('meet.create-transport', { direction: 'recv' });
        return;

      case 'meet.participants':
        this.peers.clear();
        for (const it of p.participants ?? []) {
          this.peers.set(it.userId, {
            userId: it.userId, displayName: it.displayName,
            handRaised: !!it.handRaised, isAi: !!it.isAi, isGuest: !!it.isGuest,
          });
        }
        this.ev.onPeers([...this.peers.values()]);
        // Потоки тех, кто уже говорит, запрашиваем сами — сервер о них не напомнит.
        // СВОИ пропускаем: иначе слышишь себя из динамиков. Список рассылается заново
        // (например, при старте записи), когда свой поток уже существует.
        for (const it of p.participants ?? []) {
          if (String(it.userId) === String(this.myUserId)) continue;
          for (const pr of it.producers ?? []) void this.consume(pr.id);
        }
        return;

      case 'meet.transport-created':
        this.createTransport(p);
        return;

      case 'meet.transport-connected':
        this.connectAcks.get(p.transport_id)?.();
        this.connectAcks.delete(p.transport_id);
        return;

      case 'meet.produced':
        this.produceAcks.get(String(p._req_id))?.(p.producer_id);
        this.produceAcks.delete(String(p._req_id));
        return;

      case 'meet.peer-joined':
        this.peers.set(p.user_id, {
          userId: p.user_id, displayName: p.display_name, handRaised: false, isGuest: !!p.is_guest,
        });
        this.ev.onPeers([...this.peers.values()]);
        return;

      case 'meet.peer-left':
        this.peers.delete(p.user_id);
        this.ev.onPeers([...this.peers.values()]);
        return;

      case 'meet.new-producer':
        void this.consume(p.producer_id);
        return;

      case 'meet.consumed': {
        const consumer = await this.recv!.consume({
          id: p.consumer_id, producerId: p.producer_id, kind: p.kind, rtpParameters: p.rtp_parameters,
        });
        this.consumers.set(consumer.id, consumer);
        this.consumerMeta.set(consumer.id, { userId: p.producer_user_id, screen: p.app_data?.type === 'screen' });
        this.log('track.received', { kind: p.kind, from: p.producer_user_id, muted: consumer.track.muted, live: consumer.track.readyState });
        this.emit('meet.resume-consumer', { consumer_id: consumer.id });
        this.ev.onTrack({
          consumerId: consumer.id, userId: p.producer_user_id, kind: p.kind,
          screen: p.app_data?.type === 'screen', track: consumer.track,
        });
        return;
      }

      case 'meet.producer-closed': {
        for (const [id, c] of this.consumers) {
          if (c.producerId !== p.producer_id) continue;
          c.close();
          this.consumers.delete(id);
          this.consumerMeta.delete(id);
          this.ev.onTrackGone(id);
        }
        // поток закрыт — разрешаем запросить его заново, если человек снова включит камеру
        this.requested.delete(p.producer_id);
        return;
      }

      /**
       * Пауза — это не конец потока.
       *
       * Раньше пауза убирала дорожку наравне с закрытием, а сообщения о снятии
       * паузы клиент вовсе не знал — возвращать было нечему. Достаточно было
       * собеседнику выключить и включить микрофон, чтобы его больше никто
       * не услышал до конца созвона.
       *
       * Звук на паузе не трогаем совсем: дорожка жива и просто молчит. Видео
       * убираем с плитки — иначе висит застывший кадр, будто человек замер.
       */
      case 'meet.producer-paused': {
        for (const [id, c] of this.consumers) {
          if (c.producerId === p.producer_id && c.kind === 'video') this.ev.onTrackGone(id);
        }
        return;
      }

      case 'meet.producer-resumed': {
        for (const [id, c] of this.consumers) {
          if (c.producerId !== p.producer_id || c.kind !== 'video') continue;
          const meta = this.consumerMeta.get(id);
          this.ev.onTrack({
            consumerId: id, userId: meta?.userId ?? '', kind: 'video',
            screen: !!meta?.screen, track: c.track,
          });
        }
        return;
      }

      case 'meet.hand-raised':
      case 'meet.hand-lowered': {
        const peer = this.peers.get(p.user_id);
        if (peer) { peer.handRaised = msg.type === 'meet.hand-raised'; this.ev.onPeers([...this.peers.values()]); }
        return;
      }

      case 'meet.ice-restarted':
        (this.send?.id === p.transport_id ? this.send : this.recv)?.restartIce({ iceParameters: p.ice_parameters });
        return;

      case 'meet.recording':
        this.ev.onRecording(!!p.active);
        return;

      case 'meet.ai-invited':
        // ИИ позвали при старте: запись включится с первым звуком, но сказать надо сразу
        this.ev.onAiInvited?.();
        return;

      case 'meet.peer-busy':
        // не молчим: иначе непонятно, почему человек «не берёт трубку»
        this.ev.onError('Собеседник сейчас в другом созвоне — вызов ему не ушёл');
        return;

      case 'meet.guest-waiting':
        this.enterLobby();
        this.ev.onGuestWaiting?.(!!p.host_present, !!p.host_called);
        return;

      case 'meet.guest-too-early':
        this.enterLobby();
        this.ev.onGuestTooEarly?.(String(p.opens_at ?? ''));
        return;

      case 'meet.guest-admitted':
        this.exitLobby();
        this.ev.onGuestAdmitted?.();
        return;

      case 'meet.guest-rejected':
        this.refused = true;
        this.exitLobby();
        this.ev.onGuestRejected?.(String(p.reason ?? 'declined'));
        return;

      case 'meet.role':
        this.ev.onRole?.({ host: !!p.host, meeting: !!p.meeting, locked: !!p.locked });
        return;

      case 'meet.ended':
        this.refused = true;
        this.exitLobby();
        this.ev.onEnded?.(String(p.by ?? ''));
        return;

      case 'meet.locked':
        this.ev.onLocked?.(!!p.locked);
        return;

      case 'meet.host-notified':
        this.ev.onHostNotified?.(!!p.ok);
        return;

      case 'meet.guest-knocking':
        this.knocks.set(p.guest_id, { guestId: p.guest_id, name: p.name, employee: !!p.employee });
        this.ev.onKnocks?.([...this.knocks.values()]);
        return;

      case 'meet.guest-gone':
        this.knocks.delete(p.guest_id);
        this.ev.onKnocks?.([...this.knocks.values()]);
        return;

      case 'meet.error':
        this.ev.onError(p.message ?? 'Ошибка созвона');
        return;
    }
  }

  private createTransport(p: any): void {
    const options: types.TransportOptions = {
      id: p.transport_id,
      iceParameters: p.ice_parameters,
      iceCandidates: p.ice_candidates,
      dtlsParameters: p.dtls_parameters,
      iceServers: this.iceServers,
    };
    const transport = p.direction === 'send'
      ? (this.send = this.device.createSendTransport(options))
      : (this.recv = this.device.createRecvTransport(options));
    this.log('transport.created', { direction: p.direction, iceServers: this.iceServers.length });
    if (p.direction === 'send') this.resolveSendReady();
    else this.resolveRecvReady();

    transport.on('connect', ({ dtlsParameters }, ok, fail) => {
      const timer = setTimeout(() => fail(new Error('Сервер не подтвердил соединение')), RESPONSE_TIMEOUT);
      this.connectAcks.set(transport.id, () => { clearTimeout(timer); ok(); });
      this.emit('meet.connect-transport', { transport_id: transport.id, dtls_parameters: dtlsParameters });
    });

    if (p.direction === 'send') {
      transport.on('produce', ({ kind, rtpParameters, appData }, ok, fail) => {
        const reqId = String(++this.reqCounter);
        const timer = setTimeout(() => fail(new Error('Сервер не принял поток')), RESPONSE_TIMEOUT);
        this.produceAcks.set(reqId, (id) => { clearTimeout(timer); ok({ id }); });
        this.emit('meet.produce', { kind, rtp_parameters: rtpParameters, app_data: appData, _req_id: reqId });
      });
    }

    // Оба канала готовы — просим состав заново. Первый список приходит до создания
    // каналов, и всё, что в нём было, надо перечитать: и участников, и их потоки.
    if (this.send && this.recv) this.emit('meet.get-participants', {});

    transport.on('connectionstatechange', (state) => {
      // Здесь видно, дошла ли связь вообще: «failed» почти всегда значит TURN.
      this.log('transport.state', { direction: p.direction, state });
      if (state === 'connected') { this.ev.onState('connected'); this.startStats(); }
      // разрыв лечится перезапуском ICE: сеть моргнула — звонок не должен разваливаться
      if (state === 'failed') this.emit('meet.restart-ice', { transport_id: transport.id });
      if (state === 'disconnected') {
        this.ev.onState('reconnecting');
        setTimeout(() => {
          if (transport.connectionState === 'disconnected') this.emit('meet.restart-ice', { transport_id: transport.id });
        }, 2000);
      }
    });
  }

  /**
   * Запрос потока на приём.
   *
   * Ждём входящий транспорт: без него сервер отбрасывает запрос молча.
   * Отметку «запрошен» ставим только перед самой отправкой — иначе неудачная
   * ранняя попытка навсегда закрывала бы дорогу повторной.
   */
  private async consume(producerId: string): Promise<void> {
    if (this.requested.has(producerId)) return; // повтор дал бы вторую дорожку и двойной звук
    try {
      await Promise.race([
        this.recvReady,
        new Promise((_, reject) => setTimeout(() => reject(new Error('нет входящего канала')), RESPONSE_TIMEOUT)),
      ]);
    } catch {
      this.log('consume.no-recv-transport', { producerId });
      return; // канал так и не появился — приём невозможен, дальше молчать бессмысленно
    }
    if (this.closed || !this.device.loaded || this.requested.has(producerId)) return;
    this.requested.add(producerId);
    this.log('consume.request', { producerId });
    this.emit('meet.consume', { producer_id: producerId, rtp_capabilities: this.device.rtpCapabilities });
  }

  /** Публикация дорожки. Демонстрация экрана намеренно скромнее по битрейту и кадрам. */
  async publish(track: MediaStreamTrack, opts: { screen?: boolean } = {}): Promise<string | null> {
    if (!this.send) {
      // ждём транспорт, но не бесконечно: молчаливое зависание хуже честной ошибки.
      // Исключение — время за дверью: пока не впустили, канала и не может быть.
      const waitSend = () => Promise.race([
        this.sendReady.then(() => true),
        new Promise<boolean>((r) => setTimeout(() => r(false), RESPONSE_TIMEOUT)),
      ]);
      let ready = await waitSend();
      while (!ready && this.lobby && !this.closed) {
        await this.lobby;
        ready = this.refused ? false : await waitSend();
      }
      if (!ready && !this.refused && !this.closed) throw new Error('Сервер созвонов не открыл исходящий канал');
    }
    if (this.refused) return null;
    if (!this.send || this.closed) {
      this.log('publish.failed', { kind: track.kind, reason: this.closed ? 'closed' : 'no-send-transport' });
      return null;
    }
    const isVideo = track.kind === 'video';
    const producer = await this.send.produce({
      track,
      appData: { type: opts.screen ? 'screen' : track.kind },
      ...(isVideo && opts.screen
        ? { encodings: [{ maxBitrate: 300_000, maxFramerate: 3 }], codecOptions: { videoGoogleStartBitrate: 200 } }
        : isVideo
          ? {
            // три слоя simulcast: сервер сам выберет подходящий по числу участников
            encodings: [
              { rid: 'r0', maxBitrate: 100_000, scaleResolutionDownBy: 4 },
              { rid: 'r1', maxBitrate: 300_000, scaleResolutionDownBy: 2 },
              { rid: 'r2', maxBitrate: 900_000 },
            ],
            codecOptions: { videoGoogleStartBitrate: 300 },
          }
          : {}),
    });
    this.producers.set(producer.id, producer);
    this.log('publish', { kind: track.kind, screen: !!opts.screen, producerId: producer.id, track: track.readyState });
    return producer.id;
  }

  async setMuted(kind: 'audio' | 'video', muted: boolean): Promise<void> {
    for (const [id, producer] of this.producers) {
      if (producer.kind !== kind) continue;
      if (muted) { producer.pause(); this.emit('meet.producer-pause', { producer_id: id }); }
      else { producer.resume(); this.emit('meet.producer-resume', { producer_id: id }); }
    }
  }

  /**
   * Снять свой поток.
   *
   * Серверу сообщаем ВСЕГДА, даже если у себя продюсера уже нет: дорожка могла
   * кончиться сама (человек остановил показ экрана полосой браузера), и тогда на
   * сервере поток остаётся живым, а собеседники смотрят в застывший чёрный кадр.
   * Лишнее сообщение сервер просто не найдёт у себя и промолчит — это дешевле,
   * чем брошенный поток.
   */
  async unpublish(producerId: string): Promise<void> {
    const producer = this.producers.get(producerId);
    producer?.close();
    this.producers.delete(producerId);
    this.log('unpublish', { producerId, known: !!producer });
    this.emit('meet.producer-close', { producer_id: producerId });
  }

  raiseHand(up: boolean): void {
    this.emit(up ? 'meet.hand-raise' : 'meet.hand-lower', {});
  }

  /** Запись созвона: по остановке сервер сам сделает стенограмму и черновики задач. */
  setRecording(on: boolean): void {
    this.emit(on ? 'meet.record-start' : 'meet.record-stop', {});
  }

  /** Впустить или выставить стучащегося гостя. Доступно только сотруднику. */
  answerKnock(guestId: string, admit: boolean): void {
    this.knocks.delete(guestId);
    this.ev.onKnocks?.([...this.knocks.values()]);
    this.emit(admit ? 'meet.guest-admit' : 'meet.guest-reject', { guest_id: guestId });
  }

  /** «Завершить для всех» — организатор встречи или тот, кто начал созвон. */
  endForAll(): void { this.emit('meet.end-all', {}); }

  /** «Закрыть вход» / «Открыть вход». */
  setLocked(locked: boolean): void { this.emit('meet.lock', { locked }); }

  /** Из зала ожидания: «Сообщить организатору, что я жду». */
  notifyHost(): void { this.emit('meet.notify-host', {}); }

  invite(userIds: string[]): void {
    this.emit('meet.invite', { user_ids: userIds });
  }

  leave(): void {
    this.log('leave', { producers: this.producers.size, consumers: this.consumers.size, peers: this.peers.size });
    flushDiag();
    this.closed = true;
    this.exitLobby(); // ждущая за дверью публикация должна закончиться, а не висеть
    void this.sampleStats(); // последний замер — каким созвон был под конец
    this.stopStats();
    this.emit('meet.leave', {});
    for (const p of this.producers.values()) p.close();
    for (const c of this.consumers.values()) c.close();
    this.consumerMeta.clear();
    this.send?.close();
    this.recv?.close();
    this.ws?.close();
    this.ev.onState('closed');
  }
}
