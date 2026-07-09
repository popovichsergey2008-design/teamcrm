import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AddressInfo } from 'net';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { AllExceptionsFilter } from '../src/common/http/all-exceptions.filter';
import { ResponseInterceptor } from '../src/common/http/response.interceptor';
import { RedisIoAdapter } from '../src/common/auth/redis-io.adapter';

/** Этап 5 K1 — RAG-база знаний: индексация + поиск + изоляция по tenant. */
describe('Knowledge base (e2e)', () => {
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

  /** ждём пока в индексе появятся чанки (воркер очереди embeddings асинхронный). */
  const waitChunks = async (tok: string, min: number, reindex = false) => {
    for (let i = 0; i < 40; i++) {
      const s = (await http.get('/api/knowledge/stats').set(H(tok)).expect(200)).body.data;
      if (Number(s.chunks) >= min) return Number(s.chunks);
      if (reindex && i === 10) await http.post('/api/knowledge/reindex').set(H(tok)).expect(201);
      await sleep(300);
    }
    return 0;
  };

  it('регламент индексируется и находится семантическим поиском; изоляция по tenant', async () => {
    const a = (await http.post('/api/auth/register').send({ tenantName: 'KB-A', email: `a_${uniq()}@t.test`, password: 'password123', fullName: 'Анна' }).expect(201)).body.data;
    const tok = a.accessToken;

    await http.post('/api/regulations').set(H(tok)).send({
      title: 'Пагинация на проектах недвижимости',
      body: 'Чтобы решить проблему пагинации, используйте rel=next/prev и canonical, закрывайте GET-параметры от индексации.',
    }).expect(201);

    const chunks = await waitChunks(tok, 1, true);
    expect(chunks).toBeGreaterThanOrEqual(1);

    const hits = (await http.get('/api/knowledge/search').query({ q: 'как решали пагинацию на недвижимости' }).set(H(tok)).expect(200)).body.data;
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits.some((h: any) => h.sourceType === 'regulation' && /Пагинация/.test(h.title))).toBe(true);

    // другой арендатор НЕ видит чужие знания
    const b = (await http.post('/api/auth/register').send({ tenantName: 'KB-B', email: `b_${uniq()}@t.test`, password: 'password123', fullName: 'Борис' }).expect(201)).body.data;
    const hitsB = (await http.get('/api/knowledge/search').query({ q: 'как решали пагинацию на недвижимости' }).set(H(b.accessToken)).expect(200)).body.data;
    expect(hitsB.length).toBe(0);
  });

  it('разрез по проекту: поиск в рамках проекта не выдаёт задачи другого проекта', async () => {
    const reg = (await http.post('/api/auth/register').send({ tenantName: 'KB-Scope', email: `s_${uniq()}@t.test`, password: 'password123', fullName: 'С' }).expect(201)).body.data;
    const tok = reg.accessToken;
    const pa = (await http.post('/api/projects').set(H(tok)).send({ name: 'Проект Альфа' }).expect(201)).body.data;
    const pb = (await http.post('/api/projects').set(H(tok)).send({ name: 'Проект Бета' }).expect(201)).body.data;
    const colA = (await http.get(`/api/projects/${pa.id}/board`).set(H(tok)).expect(200)).body.data.columns[0].id;
    const colB = (await http.get(`/api/projects/${pb.id}/board`).set(H(tok)).expect(200)).body.data.columns[0].id;
    // открытые задачи (индексируются при создании)
    await http.post('/api/tasks').set(H(tok)).send({ projectId: pa.id, columnId: colA, title: 'альфа секрет пагинация' }).expect(201);
    await http.post('/api/tasks').set(H(tok)).send({ projectId: pb.id, columnId: colB, title: 'бета секрет редиректы' }).expect(201);
    expect(await waitChunks(tok, 2, true)).toBeGreaterThanOrEqual(2);

    // поиск в рамках проекта Альфа — не должно быть задач проекта Бета
    const hits = (await http.get('/api/knowledge/search').query({ q: 'секрет', k: 20, projectId: pa.id }).set(H(tok)).expect(200)).body.data;
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits.some((h: any) => /альфа/.test(h.title))).toBe(true);
    expect(hits.some((h: any) => /бета/.test(h.title))).toBe(false);
    // у результатов есть подпись проекта
    expect(hits.find((h: any) => /альфа/.test(h.title)).projectName).toBe('Проект Альфа');
  });

  it('закрытая задача попадает в базу знаний (триггер закрытия)', async () => {
    const reg = (await http.post('/api/auth/register').send({ tenantName: 'KB-T', email: `t_${uniq()}@t.test`, password: 'password123', fullName: 'Т' }).expect(201)).body.data;
    const tok = reg.accessToken;
    const proj = (await http.post('/api/projects').set(H(tok)).send({ name: 'П' }).expect(201)).body.data;
    const board = (await http.get(`/api/projects/${proj.id}/board`).set(H(tok)).expect(200)).body.data;
    const done = board.columns.find((c: any) => c.name === 'Done');
    const first = board.columns[0].id;

    const task = (await http.post('/api/tasks').set(H(tok)).send({ projectId: proj.id, columnId: first, title: 'Оптимизация редиректов и robots' }).expect(201)).body.data;
    // перенос в Done → закрытие → индексация
    await http.post(`/api/tasks/${task.id}/move`).set(H(tok)).send({ columnId: done.id, position: 0 }).expect(201);

    const chunks = await waitChunks(tok, 1, true);
    expect(chunks).toBeGreaterThanOrEqual(1);
    const hits = (await http.get('/api/knowledge/search').query({ q: 'редиректы robots оптимизация' }).set(H(tok)).expect(200)).body.data;
    expect(hits.some((h: any) => h.sourceType === 'task')).toBe(true);
  });
});
