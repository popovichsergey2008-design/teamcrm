import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AddressInfo } from 'net';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { AllExceptionsFilter } from '../src/common/http/all-exceptions.filter';
import { ResponseInterceptor } from '../src/common/http/response.interceptor';
import { RedisIoAdapter } from '../src/common/auth/redis-io.adapter';

/** NL-команда / Zero-UI. Под mock LLM интент может быть none, поэтому apply тестируем на явном черновике. */
describe('NL-команда (e2e)', () => {
  let app: INestApplication;
  let http$: any;
  const uniq = () => Math.random().toString(36).slice(2) + Date.now().toString(36);
  const H = (t: string) => ({ Authorization: `Bearer ${t}` });

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    app.useGlobalFilters(new AllExceptionsFilter());
    app.useGlobalInterceptors(new ResponseInterceptor());
    app.useWebSocketAdapter(new RedisIoAdapter(app));
    await app.listen(0, '0.0.0.0');
    http$ = request(`http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`);
  });

  afterAll(async () => { await app?.close(); });

  it('parse отдаёт контекст; apply создаёт задачу; без проекта — 400', async () => {
    const email = `nl_${uniq()}@t.test`;
    const reg = (await http$.post('/api/auth/register').send({ tenantName: 'NL', email, password: 'password123', fullName: 'Босс' }).expect(201)).body.data;
    const tok = reg.accessToken;
    const proj = (await http$.post('/api/projects').set(H(tok)).send({ name: 'Маркетинг' }).expect(201)).body.data;

    // parse: структура + контекст (интент под mock LLM не гарантирован)
    const parsed = (await http$.post('/api/nl/parse').set(H(tok)).send({ text: 'Создай задачу обновить баннер в проекте Маркетинг' }).expect(201)).body.data;
    expect(['create_task', 'create_deal', 'none']).toContain(parsed.intent);
    expect(parsed.context.projects.some((p: any) => p.name === 'Маркетинг')).toBe(true);
    expect(parsed.context.users.some((u: any) => u.name === 'Босс')).toBe(true);

    // apply: создать задачу из подтверждённого черновика (+ срок уходит в описание, приоритет применяется)
    const applied = (await http$.post('/api/nl/apply').set(H(tok))
      .send({ intent: 'create_task', task: { projectId: proj.id, title: 'Обновить баннер', description: 'детали', priority: 'high', deadline: '2026-08-01' } }).expect(201)).body.data;
    expect(applied.type).toBe('task');
    expect(applied.task.title).toBe('Обновить баннер');

    const board = (await http$.get(`/api/projects/${proj.id}/board`).set(H(tok)).expect(200)).body.data;
    const task = board.columns.flatMap((c: any) => c.tasks).find((x: any) => x.title === 'Обновить баннер');
    expect(task).toBeTruthy();
    expect(task.priority).toBe('high');

    // apply задачи без проекта → 400
    await http$.post('/api/nl/apply').set(H(tok)).send({ intent: 'create_task', task: { title: 'Без проекта' } }).expect(400);

    // apply сделки
    const deal = (await http$.post('/api/nl/apply').set(H(tok)).send({ intent: 'create_deal', deal: { title: 'Продажа Иванову', amount: 5000 } }).expect(201)).body.data;
    expect(deal.type).toBe('deal');
    expect(deal.deal.title).toBe('Продажа Иванову');
  });
});
