import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AddressInfo } from 'net';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { AllExceptionsFilter } from '../src/common/http/all-exceptions.filter';
import { ResponseInterceptor } from '../src/common/http/response.interceptor';
import { RedisIoAdapter } from '../src/common/auth/redis-io.adapter';
import { AnthillRepository } from '../src/modules/anthill/anthill.repository';

/**
 * AnthillBot (ТЗ-6, MVP 1): сессии, ответ потоком, действия с подтверждением и откатом.
 * Модель в CI — заглушка, поэтому проверяем конвейер, а не качество текста.
 */
describe('AnthillBot (e2e)', () => {
  let app: INestApplication;
  let http$: any;
  let repo: AnthillRepository;
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
    repo = app.get(AnthillRepository);
  });
  afterAll(async () => app?.close());

  it('сессия: вопрос потоком с контекстом задачи, история, оценка, чужая сессия закрыта', async () => {
    const owner = (await http$.post('/api/auth/register')
      .send({ tenantName: 'AB', email: `ab_${uniq()}@t.test`, password: 'password123', fullName: 'Сергей' }).expect(201)).body.data;
    const O = H(owner.accessToken);
    const project = (await http$.post('/api/projects').set(O).send({ name: 'Panorama' }).expect(201)).body.data;
    const board = (await http$.get(`/api/projects/${project.id}/board`).set(O).expect(200)).body.data;
    const task = (await http$.post('/api/tasks').set(O)
      .send({ projectId: project.id, columnId: board.columns[0].id, title: 'Исправить авторизацию API', description: 'Падает на refresh' }).expect(201)).body.data;

    // до первого вопроса разговоров нет
    expect((await http$.get('/api/anthill/sessions').set(O).expect(200)).body.data).toEqual([]);

    const session = (await http$.post('/api/anthill/sessions').set(O).send({ context: { type: 'task', id: String(task.id) } }).expect(201)).body.data;
    const res = await http$.post(`/api/anthill/sessions/${session.id}/ask`).set(O).send({ question: 'Что здесь нужно сделать?' }).expect(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    expect(res.text).toContain('event: status');
    expect(res.text).toContain('event: done');

    const msgs = (await http$.get(`/api/anthill/sessions/${session.id}/messages`).set(O).expect(200)).body.data;
    expect(msgs.map((m: any) => m.role)).toEqual(['user', 'assistant']);
    expect(msgs[0].content).toBe('Что здесь нужно сделать?');
    // контекст страницы стал источником: задача под рукой, без ссылки
    expect(msgs[1].citations.some((c: any) => c.kind === 'task' && String(c.id) === String(task.id))).toBe(true);

    // история: разговор назван первым вопросом
    const list = (await http$.get('/api/anthill/sessions').set(O).expect(200)).body.data;
    expect(list[0].title).toBe('Что здесь нужно сделать?');
    expect(list[0].context).toEqual({ type: 'task', id: String(task.id) });

    // оценка ответа — только своего
    await http$.post(`/api/anthill/messages/${msgs[1].id}/feedback`).set(O).send({ vote: -1, reason: 'not_found' }).expect(201);
    const mateEmail = `abm_${uniq()}@t.test`;
    await http$.post('/api/users').set(O).send({ email: mateEmail, fullName: 'Глеб', password: 'password123', role: 'member' }).expect(201);
    const M = H((await http$.post('/api/auth/login').send({ email: mateEmail, password: 'password123' }).expect(201)).body.data.accessToken);
    await http$.get(`/api/anthill/sessions/${session.id}/messages`).set(M).expect(404);
    await http$.post(`/api/anthill/messages/${msgs[1].id}/feedback`).set(M).send({ vote: 1 }).expect(404);

    await http$.delete(`/api/anthill/sessions/${session.id}`).set(O).expect(200);
    expect((await http$.get('/api/anthill/sessions').set(O).expect(200)).body.data).toEqual([]);
  });

  it('действие: напоминание ставится только после «Создать», отменяется и не выполняется дважды', async () => {
    const owner = (await http$.post('/api/auth/register')
      .send({ tenantName: 'AB2', email: `ab2_${uniq()}@t.test`, password: 'password123', fullName: 'Сергей' }).expect(201)).body.data;
    const O = H(owner.accessToken);
    const session = (await http$.post('/api/anthill/sessions').set(O).send({}).expect(201)).body.data;

    // Модель в CI — заглушка и действий не предлагает: карточку кладём так же, как
    // положил бы оркестратор, и проверяем путь подтверждения.
    const when = new Date(Date.now() + 3600_000).toISOString();
    const action = await repo.createAction({
      tenantId: String(owner.user.tenantId), sessionId: String(session.id), userId: String(owner.user.id),
      tool: 'create_reminder', input: { text: 'проверить задачу', when },
    });
    const pending = (await http$.get('/api/anthill/actions').set(O).expect(200)).body.data;
    expect(pending[0]).toMatchObject({ id: String(action.id), tool: 'create_reminder', status: 'pending' });

    // до подтверждения в «Заметках» ничего не запланировано
    const self = (await http$.post('/api/chats/self').set(O).expect(201)).body.data;
    expect((await http$.get(`/api/chats/${self.id}/scheduled`).set(O).expect(200)).body.data.items).toEqual([]);

    const done = (await http$.post(`/api/anthill/actions/${action.id}/confirm`).set(O).expect(201)).body.data;
    expect(done.status).toBe('done');
    expect(done.canUndo).toBe(true);
    expect((await http$.get(`/api/chats/${self.id}/scheduled`).set(O).expect(200)).body.data.items.length).toBe(1);

    // второй раз не выполнить; откат убирает напоминание
    await http$.post(`/api/anthill/actions/${action.id}/confirm`).set(O).expect(409);
    await http$.post(`/api/anthill/actions/${action.id}/undo`).set(O).expect(201);
    expect((await http$.get(`/api/chats/${self.id}/scheduled`).set(O).expect(200)).body.data.items).toEqual([]);
    expect((await http$.get('/api/anthill/actions').set(O).expect(200)).body.data[0].status).toBe('undone');

    // отклонённое — не выполнить
    const other = await repo.createAction({
      tenantId: String(owner.user.tenantId), sessionId: String(session.id), userId: String(owner.user.id),
      tool: 'create_reminder', input: { text: 'ещё', when },
    });
    await http$.post(`/api/anthill/actions/${other.id}/reject`).set(O).expect(201);
    await http$.post(`/api/anthill/actions/${other.id}/confirm`).set(O).expect(409);
  });
});
