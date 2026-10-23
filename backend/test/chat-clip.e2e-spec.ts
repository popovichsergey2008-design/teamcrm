import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AddressInfo } from 'net';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { AllExceptionsFilter } from '../src/common/http/all-exceptions.filter';
import { ResponseInterceptor } from '../src/common/http/response.interceptor';
import { ChatsAiService } from '../src/modules/chats/chats-ai.service';
import { RealtimeService } from '../src/modules/realtime/realtime.service';

/**
 * Голосовое в чат (#4643): сообщение приходит СРАЗУ с признаком «расшифровка идёт»,
 * текст встаёт на место подписи позже — событием. ИИ подменён: ключа в тестах нет.
 */
describe('Голосовое: расшифровка фоном (e2e)', () => {
  let app: INestApplication;
  let http$: any;
  const uniq = () => Math.random().toString(36).slice(2) + Date.now().toString(36);
  const H = (t: string) => ({ Authorization: `Bearer ${t}` });
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const events: { event: string; payload: any }[] = [];

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    app.useGlobalFilters(new AllExceptionsFilter());
    app.useGlobalInterceptors(new ResponseInterceptor());
    await app.listen(0, '0.0.0.0');
    http$ = request(`http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`);
    const rt = app.get(RealtimeService);
    const orig = rt.emitToUsers.bind(rt);
    jest.spyOn(rt, 'emitToUsers').mockImplementation(((t: string, to: string[], event: string, payload: any) => {
      events.push({ event, payload });
      return orig(t, to, event, payload);
    }) as any);
  });
  afterAll(async () => { await app?.close(); });
  /** Подмену ИИ снимаем, а перехват событий оставляем на весь набор. */
  const restoreAi = () => { for (const k of ['canTranscribe', 'transcribe', 'tidyTranscript'] as const) (app.get(ChatsAiService)[k] as any).mockRestore?.(); };

  async function setup() {
    const owner = (await http$.post('/api/auth/register')
      .send({ tenantName: 'Клипы', email: `c_${uniq()}@t.test`, password: 'password123', fullName: 'Сергей' }).expect(201)).body.data;
    const O = H(owner.accessToken);
    const gleb = (await http$.post('/api/users').set(O)
      .send({ email: `cg_${uniq()}@t.test`, fullName: 'Глеб Орлов', password: 'password123', role: 'member' }).expect(201)).body.data;
    const dm = (await http$.post('/api/chats/dm').set(O).send({ userId: gleb.id }).expect(201)).body.data;
    return { O, dm };
  }

  const waitFor = async (pred: () => any, ms = 5000) => {
    for (let i = 0; i < ms / 50; i++) { const v = pred(); if (v) return v; await sleep(50); }
    return pred();
  };

  it('ответ сразу с «расшифровка идёт», потом событие с текстом и текст в ленте', async () => {
    const { O, dm } = await setup();
    const ai = app.get(ChatsAiService);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => { release = r; });
    jest.spyOn(ai, 'canTranscribe').mockResolvedValue(true);
    jest.spyOn(ai, 'transcribe').mockImplementation(async () => { await gate; return 'глеб поправь форму к пятнице'; });
    jest.spyOn(ai, 'tidyTranscript').mockResolvedValue('Глеб, поправь форму к пятнице.');

    const res = (await http$.post(`/api/chats/${dm.id}/clip`).set(O)
      .field('kind', 'voice')
      .attach('file', Buffer.from('voice-bytes'), { filename: 'voice.webm', contentType: 'audio/webm' })
      .expect(201)).body.data;
    // Whisper ещё «думает», а сообщение уже есть
    expect(res.body).toBe('Голосовое сообщение');
    expect(res.transcript_status).toBe('running');
    expect(events.some((e) => e.event === 'chat.message' && String(e.payload.message.id) === String(res.id))).toBe(true);
    const before = (await http$.get(`/api/chats/${dm.id}/messages`).set(O).expect(200)).body.data;
    const list0 = Array.isArray(before) ? before : before.messages ?? before.items;
    expect(list0.find((m: any) => String(m.id) === String(res.id)).transcript_status).toBe('running');

    release();
    const ev = await waitFor(() => events.find((e) => e.event === 'chat.message.transcript' && String(e.payload.messageId) === String(res.id)));
    expect(ev.payload.status).toBe('ready');
    expect(ev.payload.body).toBe('Глеб, поправь форму к пятнице.');
    const after = (await http$.get(`/api/chats/${dm.id}/messages`).set(O).expect(200)).body.data;
    const list = Array.isArray(after) ? after : after.messages ?? after.items;
    const m = list.find((x: any) => String(x.id) === String(res.id));
    expect(m.body).toBe('Глеб, поправь форму к пятнице.');
    expect(m.transcript_status).toBe('ready');
    expect(m.edited_at).toBeFalsy();
    restoreAi();
  });

  it('расшифровка не вышла — признак снимается, подпись остаётся; без ключа признака нет', async () => {
    const { O, dm } = await setup();
    const ai = app.get(ChatsAiService);
    jest.spyOn(ai, 'canTranscribe').mockResolvedValue(true);
    jest.spyOn(ai, 'transcribe').mockResolvedValue('');
    const res = (await http$.post(`/api/chats/${dm.id}/clip`).set(O)
      .attach('file', Buffer.from('voice-bytes'), { filename: 'voice.webm', contentType: 'audio/webm' })
      .expect(201)).body.data;
    const ev = await waitFor(() => events.find((e) => e.event === 'chat.message.transcript' && String(e.payload.messageId) === String(res.id)));
    expect(ev.payload.status).toBe('failed');
    expect(ev.payload.body).toBe('Голосовое сообщение');

    jest.spyOn(ai, 'canTranscribe').mockResolvedValue(false);
    const plain = (await http$.post(`/api/chats/${dm.id}/clip`).set(O)
      .attach('file', Buffer.from('voice-bytes'), { filename: 'voice.webm', contentType: 'audio/webm' })
      .expect(201)).body.data;
    expect(plain.transcript_status).toBeNull();
    restoreAi();
  });
});
