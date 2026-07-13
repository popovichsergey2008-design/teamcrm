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

  it('обратная связь 👍/👎 пишется, агрегируется в метриках, валидируется и изолируется по tenant', async () => {
    const tok = await register();
    // кастомная версия v2 активна
    await http.post('/api/prompts/brain.system/versions').set(H(tok)).send({ body: 'версия для оценок' }).expect(201);
    await http.post('/api/prompts/brain.system/versions/2/activate').set(H(tok)).expect(201);
    const versions = (await http.get('/api/prompts/brain.system/versions').set(H(tok)).expect(200)).body.data;
    const activeId = versions.versions.find((v: any) => v.status === 'active').id;

    // 👍 и 👎+переделка
    await http.post('/api/prompt-feedback').set(H(tok)).send({ promptVersionId: activeId, rating: 1 }).expect(201);
    await http.post('/api/prompt-feedback').set(H(tok)).send({ promptVersionId: activeId, rating: -1, reworked: true }).expect(201);

    // метрики отражают оценки
    const m = (await http.get('/api/prompts/brain.system/metrics').set(H(tok)).expect(200)).body.data;
    const v2 = m.byVersion.find((r: any) => r.version === 2);
    expect(v2.up).toBeGreaterThanOrEqual(1);
    expect(v2.down).toBeGreaterThanOrEqual(1);
    expect(v2.reworked).toBeGreaterThanOrEqual(1);

    // валидация: rating вне {1,-1} → 400
    await http.post('/api/prompt-feedback').set(H(tok)).send({ promptVersionId: activeId, rating: 5 }).expect(400);

    // изоляция: чужой арендатор не может оценить приватную версию → 404
    const other = await register();
    await http.post('/api/prompt-feedback').set(H(other)).send({ promptVersionId: activeId, rating: 1 }).expect(404);
  });

  it('A/B: назначение B-варианта со сплитом, валидация, промоут очищает сплит', async () => {
    const tok = await register();
    // клон-он-райт + черновик v2 (v1 — активный контроль)
    await http.post('/api/prompts/brain.system/versions').set(H(tok)).send({ body: 'B-вариант для A/B' }).expect(201);

    // нельзя A/B на активной (v1)
    await http.post('/api/prompts/brain.system/versions/1/ab').set(H(tok)).send({ split: 50 }).expect(400);
    // сплит вне диапазона
    await http.post('/api/prompts/brain.system/versions/2/ab').set(H(tok)).send({ split: 150 }).expect(400);
    await http.post('/api/prompts/brain.system/versions/2/ab').set(H(tok)).send({ split: 0 }).expect(400);

    // корректный A/B: v2 → testing 30%
    await http.post('/api/prompts/brain.system/versions/2/ab').set(H(tok)).send({ split: 30 }).expect(201);
    let v = (await http.get('/api/prompts/brain.system/versions').set(H(tok)).expect(200)).body.data;
    const v2 = v.versions.find((x: any) => x.version === 2);
    expect(v2.status).toBe('testing');
    expect(v2.abSplit).toBe(30);
    expect(v.versions.find((x: any) => x.version === 1).status).toBe('active');

    // промоут B (activate v2) → active + сплит очищен, v1 deprecated
    await http.post('/api/prompts/brain.system/versions/2/activate').set(H(tok)).expect(201);
    v = (await http.get('/api/prompts/brain.system/versions').set(H(tok)).expect(200)).body.data;
    const v2b = v.versions.find((x: any) => x.version === 2);
    expect(v2b.status).toBe('active');
    expect(v2b.abSplit).toBeNull();
    expect(v.versions.find((x: any) => x.version === 1).status).toBe('deprecated');
  });

  it('P4: авто-оптимизация возвращает текущий промпт+метрики и метерит мета-промпт (деградирует без LLM)', async () => {
    const tok = await register();
    const r = (await http.post('/api/prompts/brain.system/optimize').set(H(tok)).expect(201)).body.data;
    expect(r.currentVersion).toBe(1);
    expect(typeof r.current).toBe('string');
    expect(r.current.length).toBeGreaterThan(0);
    expect(typeof r.metrics).toBe('string');
    // mock-провайдер (без ключа) → предложение не парсится в JSON → suggestion null + пояснение
    expect(r.suggestion === null || typeof r.suggestion === 'string').toBe(true);
    if (!r.suggestion) expect(typeof r.rationale).toBe('string');

    // мета-промпт оптимизатора сам метерится под promptops.optimize (догфудинг)
    const m = (await http.get('/api/prompts/promptops.optimize/metrics').set(H(tok)).expect(200)).body.data;
    const v1 = m.byVersion.find((x: any) => x.version === 1);
    expect(v1).toBeDefined();
    expect(v1.calls).toBeGreaterThanOrEqual(1);
  });
});
