import { EventEmitter } from 'events';

/*
  26.11.2026, созвон Tokenalphabet: запись включили, когда у троих микрофон был на паузе.
  ffmpeg без единого пакета вышел через ~20 с, и их речь после включения микрофона не
  писалась до конца созвона. Здесь — тот же сценарий на подделках mediasoup и ffmpeg.
*/
const procs: (EventEmitter & { exitCode: number | null; signalCode: string | null; kill: jest.Mock; stderr: EventEmitter })[] = [];
jest.mock('child_process', () => ({
  spawn: jest.fn(() => {
    const p = Object.assign(new EventEmitter(), { exitCode: null, signalCode: null, kill: jest.fn(), stderr: new EventEmitter() });
    procs.push(p as never);
    return p;
  }),
}));

import { RecordingService } from './recording.service';

function room(paused: boolean) {
  const producer = { id: 'prod-1', kind: 'audio', appData: {}, paused, closed: false };
  const participant = { userId: '884', displayName: 'Никита', producers: new Map([[producer.id, producer]]) };
  const router = {
    rtpCapabilities: {},
    createPlainTransport: jest.fn(async () => ({
      connect: jest.fn(async () => undefined),
      close: jest.fn(),
      consume: jest.fn(async (o: { producerId: string }) => ({
        producerId: o.producerId, rtpParameters: { codecs: [{ payloadType: 100, clockRate: 48000, channels: 2 }] },
        resume: jest.fn(async () => undefined), close: jest.fn(),
      })),
    })),
  };
  return { producer, participant, room: { id: 'room-1', tenantId: '137', router, participants: new Map([[participant.userId, participant]]) } };
}

describe('Запись: микрофон на паузе при старте записи', () => {
  beforeEach(() => { procs.length = 0; });

  it('на паузе дорожку не заводим; сняли с паузы — заводим', async () => {
    const svc = new RecordingService({ write: jest.fn() } as never);
    const r = room(true);
    await svc.start(r.room as never, '882');
    expect(svc.liveTracks('room-1')).toHaveLength(0);
    expect(procs).toHaveLength(0);

    r.producer.paused = false;
    await svc.attachLate(r.room as never, r.participant as never);
    expect(svc.liveTracks('room-1')).toHaveLength(1);
    // повторное включение микрофона живую дорожку не дублирует
    await svc.attachLate(r.room as never, r.participant as never);
    expect(procs).toHaveLength(1);
  });

  it('ffmpeg вышел посреди записи — при включении микрофона новая дорожка, старая остаётся', async () => {
    const diag = { write: jest.fn() };
    const svc = new RecordingService(diag as never);
    const r = room(false);
    await svc.start(r.room as never, '882');
    expect(procs).toHaveLength(1);

    procs[0].exitCode = 1;
    procs[0].emit('exit', 1);
    expect(diag.write).toHaveBeenCalledWith(expect.objectContaining({ event: 'recording.track-died' }));

    await svc.attachLate(r.room as never, r.participant as never);
    expect(procs).toHaveLength(2);
    const tracks = svc.liveTracks('room-1')!;
    expect(tracks).toHaveLength(2);
    expect(tracks.every((t) => t.userId === '884')).toBe(true);
    expect(new Set(tracks.map((t) => t.file)).size).toBe(2);
  });

  it('два события подряд (поток появился и сразу снят с паузы) — одна дорожка', async () => {
    const svc = new RecordingService({ write: jest.fn() } as never);
    const r = room(false);
    await svc.start(r.room as never, '882');
    procs.length = 0;
    r.participant.producers.set('prod-2', { id: 'prod-2', kind: 'audio', appData: {}, paused: false, closed: false });
    r.participant.producers.delete('prod-1');
    await Promise.all([
      svc.attachLate(r.room as never, r.participant as never),
      svc.attachLate(r.room as never, r.participant as never),
    ]);
    expect(procs).toHaveLength(1);
  });
});
