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
  const restoreAi = () => { for (const k of ['canTranscribe', 'transcribe', 'transcribeTimed', 'tidyTranscript'] as const) (app.get(ChatsAiService)[k] as any).mockRestore?.(); };

  async function setup() {
    const owner = (await http$.post('/api/auth/register')
      .send({ acceptPrivacy: true, tenantName: 'Клипы', email: `c_${uniq()}@t.test`, password: 'Test-pass-2026', fullName: 'Сергей' }).expect(201)).body.data;
    const O = H(owner.accessToken);
    const gleb = (await http$.post('/api/users').set(O)
      .send({ email: `cg_${uniq()}@t.test`, fullName: 'Глеб Орлов', password: 'Test-pass-2026', role: 'member' }).expect(201)).body.data;
    const dm = (await http$.post('/api/chats/dm').set(O).send({ userId: gleb.id }).expect(201)).body.data;
    return { O, dm };
  }

  const waitFor = async (pred: () => any, ms = 5000) => {
    for (let i = 0; i < ms / 50; i++) { const v = pred(); if (v) return v; await sleep(50); }
    return pred();
  };

  it('#4902 п. 14: голосовое расшифровывается сразу и остаётся голосовым; кратко — событием; «Ответить голосом» — ответом', async () => {
    const { O, dm } = await setup();
    const ai = app.get(ChatsAiService);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => { release = r; });
    jest.spyOn(ai, 'canTranscribe').mockResolvedValue(true);
    const heard = jest.spyOn(ai, 'transcribeTimed').mockImplementation(async () => {
      await gate;
      return { text: 'глеб поправь форму к пятнице', segments: [{ start: 0, end: 3, text: 'глеб поправь форму к пятнице' }], durationSec: 3 };
    });
    jest.spyOn(ai, 'tidyTranscript').mockResolvedValue('Глеб, поправь форму к пятнице.');

    const res = (await http$.post(`/api/chats/${dm.id}/clip`).set(O)
      .field('kind', 'voice')
      .attach('file', Buffer.from('voice-bytes'), { filename: 'voice.webm', contentType: 'audio/webm' })
      .expect(201)).body.data;
    // сообщение — сразу, голосовое остаётся голосовым, расшифровка уже идёт сама
    expect(res.body).toBe('Голосовое сообщение');
    expect(res.transcript_status).toBe('running');
    expect(events.some((e) => e.event === 'chat.message' && String(e.payload.message.id) === String(res.id))).toBe(true);

    // «В текст», пока идёт, второй расшифровки не запускает
    const t = (await http$.post(`/api/chats/${dm.id}/messages/${res.id}/transcribe`).set(O).expect(201)).body.data;
    expect(t.status).toBe('running');
    release();
    const ev = await waitFor(() => events.find((e) => e.event === 'chat.message.transcript' && String(e.payload.messageId) === String(res.id) && e.payload.status === 'ready'));
    expect(ev.payload.transcript).toBe('Глеб, поправь форму к пятнице.');
    expect(heard).toHaveBeenCalledTimes(1);
    const after = (await http$.get(`/api/chats/${dm.id}/messages`).set(O).expect(200)).body.data;
    const list = Array.isArray(after) ? after : after.messages ?? after.items;
    const m = list.find((x: any) => String(x.id) === String(res.id));
    expect(m.body).toBe('Голосовое сообщение');
    expect(m.transcript).toBe('Глеб, поправь форму к пятнице.');
    expect(m.transcript_status).toBe('ready');

    // разбор клипа: реплики с метками, событие и выдача пачкой
    await waitFor(() => events.find((e) => e.event === 'chat.clip.insight' && String(e.payload.messageId) === String(res.id)));
    const ins = (await http$.get(`/api/clip-insight?ids=${res.id}`).set(O).expect(200)).body.data;
    expect(ins.items[0].kind).toBe('voice');
    expect(ins.items[0].segments.length).toBe(1);

    // «Ответить голосом»: голосовое ответом на это сообщение
    const answer = (await http$.post(`/api/chats/${dm.id}/clip`).set(O)
      .field('kind', 'voice').field('replyToId', String(res.id)).field('replyExcerpt', 'Голосовое сообщение')
      .attach('file', Buffer.from('voice-bytes'), { filename: 'voice.webm', contentType: 'audio/webm' })
      .expect(201)).body.data;
    expect(String(answer.reply_to_id)).toBe(String(res.id));
    restoreAi();
  });

  it('запись экрана расшифровывается сразу; не вышло — признак снимается, подпись остаётся; без ключа «В текст» отказывает', async () => {
    const { O, dm } = await setup();
    const ai = app.get(ChatsAiService);
    jest.spyOn(ai, 'canTranscribe').mockResolvedValue(true);
    jest.spyOn(ai, 'transcribeTimed').mockResolvedValue({ text: '', segments: [], durationSec: 0 });
    const res = (await http$.post(`/api/chats/${dm.id}/clip`).set(O)
      .field('kind', 'screen')
      .attach('file', Buffer.from('screen-bytes'), { filename: 'screen.webm', contentType: 'video/webm' })
      .expect(201)).body.data;
    expect(res.transcript_status).toBe('running');
    const ev = await waitFor(() => events.find((e) => e.event === 'chat.message.transcript' && String(e.payload.messageId) === String(res.id)));
    expect(ev.payload.status).toBe('failed');
    expect(ev.payload.body).toBe('Запись экрана');

    jest.spyOn(ai, 'canTranscribe').mockResolvedValue(false);
    const plain = (await http$.post(`/api/chats/${dm.id}/clip`).set(O)
      .attach('file', Buffer.from('voice-bytes'), { filename: 'voice.webm', contentType: 'audio/webm' })
      .expect(201)).body.data;
    expect(plain.transcript_status).toBeNull();
    await http$.post(`/api/chats/${dm.id}/messages/${plain.id}/transcribe`).set(O).expect(400);
    restoreAi();
  });
});
