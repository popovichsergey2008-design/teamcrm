import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AddressInfo } from 'net';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { AllExceptionsFilter } from '../src/common/http/all-exceptions.filter';
import { ResponseInterceptor } from '../src/common/http/response.interceptor';
import { RedisIoAdapter } from '../src/common/auth/redis-io.adapter';

/** enh-07 PromptOps (P1): версионирование промптов — создание/активация/откат, изоляция, метеринг по версии. */
describe('PromptOps (e2e)', () => {
  let app: INestApplication;
  let http: any;
  const uniq = () => Math.random().toString(36).slice(2) + Date.now().toString(36);
  const H = (t: string) => ({ Authorization: `Bearer ${t}` });
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  const register = async () => {
    const r = (await http.post('/api/auth/register')
      .send({ tenantName: `PO-${uniq()}`, email: `po_${uniq()}@t.test`, password: 'password123', fullName: 'Овнер' })
      .expect(201)).body.data;
    return r.accessToken as string;
  };

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

  it('список промптов содержит системные дефолты (не кастомизированы)', async () => {
    const tok = await register();
    const list = (await http.get('/api/prompts').set(H(tok)).expect(200)).body.data;
    const keys = list.map((t: any) => t.key);
    expect(keys).toContain('brain.system');
    expect(keys).toContain('standup.parse');
    const brain = list.find((t: any) => t.key === 'brain.system');
    expect(brain.customized).toBe(false);
    expect(brain.activeVersion).toBe(1);
  });

  it('создать версию (клон-он-райт) → активировать → откат меняют активную версию без релиза', async () => {
    const tok = await register();

    // изначально одна глобальная версия
    let v = (await http.get('/api/prompts/brain.system/versions').set(H(tok)).expect(200)).body.data;
    expect(v.customized).toBe(false);
    expect(v.versions.length).toBe(1);

    // новая версия → клон глобального в override арендатора: v1(active, из дефолта) + v2(draft)
    const created = (await http.post('/api/prompts/brain.system/versions').set(H(tok))
      .send({ body: 'НОВЫЙ системный промпт для теста', note: 'эксперимент' }).expect(201)).body.data;
    expect(created.version).toBe(2);
    expect(created.status).toBe('draft');

    v = (await http.get('/api/prompts/brain.system/versions').set(H(tok)).expect(200)).body.data;
    expect(v.customized).toBe(true);
    expect(v.versions.map((x: any) => x.version).sort()).toEqual([1, 2]);
    expect(v.versions.find((x: any) => x.version === 1).status).toBe('active');

    // активируем v2 → v2 active, v1 deprecated
    await http.post('/api/prompts/brain.system/versions/2/activate').set(H(tok)).expect(201);
    let list = (await http.get('/api/prompts').set(H(tok)).expect(200)).body.data;
    expect(list.find((t: any) => t.key === 'brain.system').activeVersion).toBe(2);

    // ОТКАТ: активируем старую v1 → снова active v1
    await http.post('/api/prompts/brain.system/versions/1/activate').set(H(tok)).expect(201);
    list = (await http.get('/api/prompts').set(H(tok)).expect(200)).body.data;
    expect(list.find((t: any) => t.key === 'brain.system').activeVersion).toBe(1);
    v = (await http.get('/api/prompts/brain.system/versions').set(H(tok)).expect(200)).body.data;
    expect(v.versions.find((x: any) => x.version === 2).status).toBe('deprecated');
  });

  it('изоляция: правки одного арендатора не видит другой (у него — системный дефолт)', async () => {
    const a = await register();
    await http.post('/api/prompts/brain.system/versions').set(H(a)).send({ body: 'секретный промпт A' }).expect(201);

    const b = await register();
    const vb = (await http.get('/api/prompts/brain.system/versions').set(H(b)).expect(200)).body.data;
    expect(vb.customized).toBe(false);
    expect(vb.versions.length).toBe(1);
    expect(vb.versions[0].body).not.toContain('секретный промпт A');
  });

  it('ответ Brain метерится по версии активного промпта (ai_usage.prompt_version_id)', async () => {
    const tok = await register();
    // активируем кастомную версию v2, чтобы метрики привязались к ней
    await http.post('/api/prompts/brain.system/versions').set(H(tok)).send({ body: 'Отвечай строго по контексту. [n]' }).expect(201);
    await http.post('/api/prompts/brain.system/versions/2/activate').set(H(tok)).expect(201);

    // источник знаний → чанки
    await http.post('/api/regulations').set(H(tok))
      .send({ title: 'Онбординг', body: 'Новичку выдают доступы, наставника и первую задачу в первый день.' }).expect(201);
    let ready = false;
    for (let i = 0; i < 40; i++) {
      const s = (await http.get('/api/knowledge/stats').set(H(tok)).expect(200)).body.data;
      if (Number(s.chunks) >= 1) { ready = true; break; }
      if (i === 10) await http.post('/api/knowledge/reindex').set(H(tok)).expect(201);
      await sleep(300);
    }
    expect(ready).toBe(true);

    const conv = (await http.post('/api/brain/conversations').set(H(tok)).expect(201)).body.data;
    await http.post(`/api/brain/conversations/${conv.id}/ask`).set(H(tok)).send({ question: 'как проходит онбординг новичка?' }).expect(201);

    const m = (await http.get('/api/prompts/brain.system/metrics').set(H(tok)).expect(200)).body.data;
    const v2 = m.byVersion.find((r: any) => r.version === 2);
    expect(v2).toBeDefined();
    expect(v2.calls).toBeGreaterThanOrEqual(1);
  });
});
