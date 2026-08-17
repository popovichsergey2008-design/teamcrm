import { Injectable, Logger } from '@nestjs/common';
import { ChildProcess, spawn } from 'child_process';
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { MeetingRoom, MsConsumer, MsPlainTransport, Participant } from './media.types';
import { DiagService } from '../diagnostics/diag.service';

/** Локальные порты для RTP «mediasoup → ffmpeg». Наружу не выходят, в ufw не нужны. */
const PORT_FROM = 42000;
const PORT_TO = 42200;

interface TrackRecorder {
  userId: string;
  displayName: string;
  transport: MsPlainTransport;
  consumer: MsConsumer;
  proc: ChildProcess;
  file: string;
  port: number;
  /** Смещение от начала записи: участник мог войти в середине разговора. */
  offsetSec: number;
}

interface Session {
  meetingId: string;
  tenantId: string;
  startedBy: string;
  startedAt: number;
  dir: string;
  tracks: Map<string, TrackRecorder>;
}

export interface RecordedTrack {
  userId: string;
  displayName: string;
  buffer: Buffer;
  fileName: string;
  offsetSec: number;
}

/**
 * Запись созвона — дорожка на каждого говорящего.
 *
 * Это то, чего в TeamConnect не было вовсе: mediasoup сам файлы не пишет. Схема штатная —
 * PlainTransport отдаёт RTP на локальный порт, ffmpeg пишет оттуда Opus в ogg.
 *
 * Дорожка на участника нужна не ради качества, а ради имён: из смешанного звука
 * восстановить, кто говорил, невозможно, а стенограмма без имён почти бесполезна —
 * непонятно, кому ставить задачу.
 */
@Injectable()
export class RecordingService {
  private readonly log = new Logger('Recording');
  private readonly sessions = new Map<string, Session>();
  private readonly usedPorts = new Set<number>();

  constructor(private readonly diag: DiagService) {}

  isRecording(meetingId: string): boolean {
    return this.sessions.has(meetingId);
  }

  recordingInfo(meetingId: string) {
    const s = this.sessions.get(meetingId);
    return s ? { active: true, startedBy: s.startedBy, startedAt: s.startedAt } : { active: false };
  }

  /**
   * Порт под дорожку — только чётный, с шагом 2.
   *
   * rtcpMux избавляет от второго порта нас, но не ffmpeg: получив SDP со строкой
   * «m=audio N», он всё равно занимает N под звук и N+1 под служебный канал.
   * При шаге 1 второму участнику доставался порт, уже занятый первым, ffmpeg
   * падал с «Address already in use», и человек просто отсутствовал в записи —
   * молча, потому что сама дорожка создавалась успешно.
   */
  private allocPort(): number {
    for (let p = PORT_FROM; p <= PORT_TO; p += 2) {
      if (!this.usedPorts.has(p)) { this.usedPorts.add(p); return p; }
    }
    throw new Error('нет свободных портов для записи');
  }

  /** Начать запись: подхватываем все звуковые потоки, что уже идут в комнате. */
  async start(room: MeetingRoom, startedBy: string): Promise<void> {
    if (this.sessions.has(room.id)) return;
    const dir = await mkdtemp(join(tmpdir(), `rec-${room.id.slice(0, 8)}-`));
    const session: Session = {
      meetingId: room.id, tenantId: room.tenantId, startedBy,
      startedAt: Date.now(), dir, tracks: new Map(),
    };
    this.sessions.set(room.id, session);
    for (const participant of room.participants.values()) await this.attach(room, session, participant);
    this.log.log(`запись начата: ${room.id}, дорожек ${session.tracks.size}`);
  }

  /** Кто-то включил микрофон уже во время записи — добавляем его дорожку на ходу. */
  async attachLate(room: MeetingRoom, participant: Participant): Promise<void> {
    const session = this.sessions.get(room.id);
    if (!session || session.tracks.has(participant.userId)) return;
    await this.attach(room, session, participant).catch((e) =>
      this.log.warn(`дорожка ${participant.userId}: ${(e as Error).message}`));
  }

  private async attach(room: MeetingRoom, session: Session, participant: Participant): Promise<void> {
    const audio = [...participant.producers.values()].find((p) => p.kind === 'audio');
    if (!audio || session.tracks.has(participant.userId)) return;

    const port = this.allocPort();
    const transport = await room.router.createPlainTransport({
      listenInfo: { protocol: 'udp', ip: '127.0.0.1' },
      rtcpMux: true,
      comedia: false,
    });
    await transport.connect({ ip: '127.0.0.1', port });

    // consumer стартует на паузе: сначала поднимаем ffmpeg, иначе первые секунды уйдут в никуда
    const consumer = await transport.consume({
      producerId: audio.id,
      rtpCapabilities: room.router.rtpCapabilities,
      paused: true,
    });

    const rtp = consumer.rtpParameters as any;
    const codec = rtp?.codecs?.[0];
    if (!codec) throw new Error('нет кодека в потоке');

    const safe = participant.displayName.replace(/[^\p{L}\p{N}_-]+/gu, '_').slice(0, 40);
    const file = join(session.dir, `${participant.userId}-${safe}.ogg`);
    const sdpPath = join(session.dir, `${participant.userId}.sdp`);
    await writeFile(sdpPath, [
      'v=0',
      'o=- 0 0 IN IP4 127.0.0.1',
      's=teamcrm',
      'c=IN IP4 127.0.0.1',
      't=0 0',
      `m=audio ${port} RTP/AVP ${codec.payloadType}`,
      `a=rtpmap:${codec.payloadType} opus/${codec.clockRate}/${codec.channels ?? 2}`,
      'a=recvonly',
    ].join('\n'));

    // -acodec copy: перекодировать незачем, Opus и так родной формат для распознавания
    const proc = spawn('ffmpeg', [
      '-hide_banner', '-loglevel', 'error',
      '-protocol_whitelist', 'file,udp,rtp',
      '-use_wallclock_as_timestamps', '1',
      '-i', sdpPath,
      '-acodec', 'copy',
      '-f', 'ogg', file,
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    proc.stderr?.on('data', (d) => this.log.warn(`ffmpeg ${participant.userId}: ${String(d).slice(0, 200)}`));

    await consumer.resume();
    session.tracks.set(participant.userId, {
      userId: participant.userId, displayName: participant.displayName,
      transport, consumer, proc, file, port,
      offsetSec: Math.max(0, (Date.now() - session.startedAt) / 1000),
    });
  }

  /** Остановить запись и забрать дорожки. Возвращает пустой массив, если писать было нечего. */
  async stop(meetingId: string): Promise<RecordedTrack[]> {
    const session = this.sessions.get(meetingId);
    if (!session) return [];
    this.sessions.delete(meetingId);

    const out: RecordedTrack[] = [];
    for (const t of session.tracks.values()) {
      try { t.consumer.close(); t.transport.close(); } catch { /* уже закрыто */ }
      this.usedPorts.delete(t.port);
      // SIGINT, а не kill: ffmpeg должен корректно закрыть контейнер ogg, иначе файл битый
      await this.finish(t.proc);
      // Пустая дорожка — это либо человек промолчал, либо запись сорвалась.
      // Раньше разницы не было видно вовсе: участник просто исчезал из стенограммы.
      let bytes = 0;
      try {
        const buffer = await readFile(t.file);
        bytes = buffer.length;
        if (bytes > 1024) {
          out.push({
            userId: t.userId, displayName: t.displayName, buffer,
            fileName: `${t.displayName}.ogg`, offsetSec: t.offsetSec,
          });
        }
      } catch { /* файла может не быть вовсе */ }
      if (bytes <= 1024) {
        this.log.warn(`запись ${meetingId}: дорожка ${t.displayName} пуста (${bytes} байт)`);
        this.diag.write({
          tenantId: session.tenantId, scope: 'meet', refId: meetingId, userId: t.userId,
          side: 'server', event: 'recording.track-empty', data: { name: t.displayName, bytes, port: t.port },
        });
      }
    }
    await rm(session.dir, { recursive: true, force: true }).catch(() => undefined);
    this.log.log(`запись завершена: ${meetingId}, дорожек с речью ${out.length} из ${session.tracks.size}`);
    this.diag.write({
      tenantId: session.tenantId, scope: 'meet', refId: meetingId, side: 'server',
      event: 'recording.finished', data: { withSpeech: out.length, tracks: session.tracks.size },
    });
    return out;
  }

  private finish(proc: ChildProcess): Promise<void> {
    return new Promise((resolve) => {
      if (proc.exitCode !== null || proc.signalCode) return resolve();
      const timer = setTimeout(() => { proc.kill('SIGKILL'); resolve(); }, 8000);
      proc.once('close', () => { clearTimeout(timer); resolve(); });
      proc.kill('SIGINT');
    });
  }
}
