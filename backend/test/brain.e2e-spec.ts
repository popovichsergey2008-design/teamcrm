import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AddressInfo } from 'net';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { AllExceptionsFilter } from '../src/common/http/all-exceptions.filter';
import { ResponseInterceptor } from '../src/common/http/response.interceptor';
import { RedisIoAdapter } from '../src/common/auth/redis-io.adapter';

/** Этап 5 K2 — AI Brain: RAG-диалог с цитатами; изоляция по tenant/пользователю. */
describe('AI Brain (e2e)', () => {
  let app: INestApplication;
  let http: any;
  const uniq = () => Math.random().toString(36).slice(2) + Date.now().toString(36);
  const H = (t: string) => ({ Authorization: `Bearer ${t}` });
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    app.useGlobalFilters(new AllExceptionsFilter());
    app.useGlobalInterceptors(new ResponseInterceptor());
    app.useWebSocketAdapter(new RedisIoAdapter(app));
    await app.listen(0, '0.0.0.0');
    http = request(`http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`);
  });
  afterAll(async () => app?.close());

  const waitChunks = async (tok: string) => {
    for (let i = 0; i < 40; i++) {
      const s = (await http.get('/api/knowledge/stats').set(H(tok)).expect(200)).body.data;
      if (Number(s.chunks) >= 1) return true;
      if (i === 10) await http.post('/api/knowledge/reindex').set(H(tok)).expect(201);
      await sleep(300);
    }
    return false;
  };

  it('диалог возвращает ответ с цитатами на источники', async () => {
    const a = (await http.post('/api/auth/register').send({ tenantName: 'Brain-A', email: `a_${uniq()}@t.test`, password: 'password123', fullName: 'Анна' }).expect(201)).body.data;
    const tok = a.accessToken;
    await http.post('/api/regulations').set(H(tok)).send({
      title: 'Решение проблемы пагинации',
      body: 'На проектах недвижимости пагинацию решали через rel=next/prev, canonical и закрытие GET-параметров от индексации.',
    }).expect(201);
    expect(await waitChunks(tok)).toBe(true);

    const conv = (await http.post('/api/brain/conversations').set(H(tok)).expect(201)).body.data;
    const res = (await http.post(`/api/brain/conversations/${conv.id}/ask`).set(H(tok)).send({ question: 'как мы решали пагинацию на недвижимости?' }).expect(201)).body.data;
    expect(typeof res.answer).toBe('string');
    expect(res.answer.length).toBeGreaterThan(0);
    expect(res.citations.length).toBeGreaterThanOrEqual(1);
    expect(res.citations[0].sourceType).toBe('regulation');

    // история сохранена (вопрос + ответ)
    const msgs = (await http.get(`/api/brain/conversations/${conv.id}/messages`).set(H(tok)).expect(200)).body.data;
    expect(msgs.length).toBe(2);
    expect(msgs[0].role).toBe('user');
    expect(msgs[1].role).toBe('assistant');
  });

  it('чужой диалог недоступен (изоляция по пользователю/tenant)', async () => {
    const a = (await http.post('/api/auth/register').send({ tenantName: 'Brain-Own', email: `o_${uniq()}@t.test`, password: 'password123', fullName: 'A' }).expect(201)).body.data;
    const conv = (await http.post('/api/brain/conversations').set(H(a.accessToken)).expect(201)).body.data;
    const b = (await http.post('/api/auth/register').send({ tenantName: 'Brain-Other', email: `x_${uniq()}@t.test`, password: 'password123', fullName: 'B' }).expect(201)).body.data;
    await http.post(`/api/brain/conversations/${conv.id}/ask`).set(H(b.accessToken)).send({ question: 'дай секреты' }).expect(404);
    await http.get(`/api/brain/conversations/${conv.id}/messages`).set(H(b.accessToken)).expect(404);
  });
});
