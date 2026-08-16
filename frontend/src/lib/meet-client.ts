import { Device, types } from 'mediasoup-client';

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
}

export interface MeetEvents {
  onPeers: (peers: Peer[]) => void;
  onTrack: (t: RemoteTrack) => void;
  onTrackGone: (consumerId: string) => void;
  onState: (state: 'connecting' | 'connected' | 'reconnecting' | 'closed') => void;
  onRecording: (active: boolean) => void;
  onAiInvited?: () => void;
  onError: (message: string) => void;
}

const RESPONSE_TIMEOUT = 10_000;

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
  private readonly peers = new Map<string, Peer>();

  /** Ожидания ответов сервера: соединение транспорта и подтверждение produce. */
  private readonly connectAcks = new Map<string, () => void>();
  private readonly produceAcks = new Map<string, (id: string) => void>();
  private reqCounter = 0;
  private closed = false;

  constructor(
    private readonly meetingId: string,
    private readonly token: string,
    private readonly iceServers: RTCIceServer[],
    private readonly ev: MeetEvents,
  ) {}

  async join(): Promise<void> {
    this.ev.onState('connecting');
    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
    this.ws = new WebSocket(`${proto}://${window.location.host}/ws/meet?token=${encodeURIComponent(this.token)}`);

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

  private async onMessage(msg: { type: string; payload?: any }): Promise<void> {
    const p = msg.payload ?? {};
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
            handRaised: !!it.handRaised, isAi: !!it.isAi,
          });
        }
        this.ev.onPeers([...this.peers.values()]);
        // потоки тех, кто уже говорит, надо запросить самому — сервер о них не напомнит
        for (const it of p.participants ?? []) {
          for (const pr of it.producers ?? []) this.consume(pr.id);
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
        this.peers.set(p.user_id, { userId: p.user_id, displayName: p.display_name, handRaised: false });
        this.ev.onPeers([...this.peers.values()]);
        return;

      case 'meet.peer-left':
        this.peers.delete(p.user_id);
        this.ev.onPeers([...this.peers.values()]);
        return;

      case 'meet.new-producer':
        this.consume(p.producer_id);
        return;

      case 'meet.consumed': {
        const consumer = await this.recv!.consume({
          id: p.consumer_id, producerId: p.producer_id, kind: p.kind, rtpParameters: p.rtp_parameters,
        });
        this.consumers.set(consumer.id, consumer);
        this.emit('meet.resume-consumer', { consumer_id: consumer.id });
        this.ev.onTrack({
          consumerId: consumer.id, userId: p.producer_user_id, kind: p.kind,
          screen: p.app_data?.type === 'screen', track: consumer.track,
        });
        return;
      }

      case 'meet.producer-closed':
      case 'meet.producer-paused': {
        for (const [id, c] of this.consumers) {
          if (c.producerId === p.producer_id) {
            if (msg.type === 'meet.producer-closed') { c.close(); this.consumers.delete(id); }
            this.ev.onTrackGone(id);
          }
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

    transport.on('connectionstatechange', (state) => {
      if (state === 'connected') this.ev.onState('connected');
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

  private consume(producerId: string): void {
    if (!this.device.loaded) return;
    this.emit('meet.consume', { producer_id: producerId, rtp_capabilities: this.device.rtpCapabilities });
  }

  /** Публикация дорожки. Демонстрация экрана намеренно скромнее по битрейту и кадрам. */
  async publish(track: MediaStreamTrack, opts: { screen?: boolean } = {}): Promise<string | null> {
    if (!this.send) return null;
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
    return producer.id;
  }

  async setMuted(kind: 'audio' | 'video', muted: boolean): Promise<void> {
    for (const [id, producer] of this.producers) {
      if (producer.kind !== kind) continue;
      if (muted) { producer.pause(); this.emit('meet.producer-pause', { producer_id: id }); }
      else { producer.resume(); this.emit('meet.producer-resume', { producer_id: id }); }
    }
  }

  async unpublish(producerId: string): Promise<void> {
    const producer = this.producers.get(producerId);
    if (!producer) return;
    producer.close();
    this.producers.delete(producerId);
    this.emit('meet.producer-close', { producer_id: producerId });
  }

  raiseHand(up: boolean): void {
    this.emit(up ? 'meet.hand-raise' : 'meet.hand-lower', {});
  }

  /** Запись созвона: по остановке сервер сам сделает стенограмму и черновики задач. */
  setRecording(on: boolean): void {
    this.emit(on ? 'meet.record-start' : 'meet.record-stop', {});
  }

  invite(userIds: string[]): void {
    this.emit('meet.invite', { user_ids: userIds });
  }

  leave(): void {
    this.closed = true;
    this.emit('meet.leave', {});
    for (const p of this.producers.values()) p.close();
    for (const c of this.consumers.values()) c.close();
    this.send?.close();
    this.recv?.close();
    this.ws?.close();
    this.ev.onState('closed');
  }
}
