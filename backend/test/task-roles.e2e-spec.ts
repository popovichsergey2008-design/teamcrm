import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AddressInfo } from 'net';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { AllExceptionsFilter } from '../src/common/http/all-exceptions.filter';
import { ResponseInterceptor } from '../src/common/http/response.interceptor';
import { RedisIoAdapter } from '../src/common/auth/redis-io.adapter';

/** Роли задачи: руководитель (создатель) и исполнитель (assignee) — видны на доске. */
describe('Enhancements v1 — Task roles (e2e)', () => {
  let app: INestApplication;
  let http: any;
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
    http = request(`http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`);
  });
  afterAll(async () => app?.close());

  const findTask = (board: any, id: string) =>
    board.columns.flatMap((c: any) => c.tasks).find((t: any) => String(t.id) === String(id));

  it('создатель становится руководителем; назначение исполнителя видно на доске', async () => {
    const reg = (await http.post('/api/auth/register').send({ tenantName: 'Roles', email: `r_${uniq()}@t.test`, password: 'password123', fullName: 'Анна Босс' }).expect(201)).body.data;
    const tok = reg.accessToken;
    const proj = (await http.post('/api/projects').set(H(tok)).send({ name: 'П' }).expect(201)).body.data;
    const board0 = (await http.get(`/api/projects/${proj.id}/board`).set(H(tok)).expect(200)).body.data;
    const col = board0.columns[0].id;

    const task = (await http.post('/api/tasks').set(H(tok)).send({ projectId: proj.id, columnId: col, title: 'Задача' }).expect(201)).body.data;
    expect(String(task.created_by)).toBeTruthy(); // постановщик проставлен

    let board = (await http.get(`/api/projects/${proj.id}/board`).set(H(tok)).expect(200)).body.data;
    let card = findTask(board, task.id);
    expect(card.manager_name).toBe('Анна Босс'); // руководитель = создатель
    expect(card.assignee_name).toBeNull();

    // назначаем исполнителя (на себя) → имя видно на карточке
    await http.post(`/api/tasks/${task.id}/assign`).set(H(tok)).send({ assigneeId: task.created_by, confirmOverload: true }).expect(201);
    board = (await http.get(`/api/projects/${proj.id}/board`).set(H(tok)).expect(200)).body.data;
    card = findTask(board, task.id);
    expect(card.assignee_name).toBe('Анна Босс');

    // смена руководителя через PATCH managerId
    await http.patch(`/api/tasks/${task.id}`).set(H(tok)).send({ managerId: null }).expect(200);
    board = (await http.get(`/api/projects/${proj.id}/board`).set(H(tok)).expect(200)).body.data;
    expect(findTask(board, task.id).manager_name).toBeNull();
  });

  it('создание задачи с явными исполнителем и руководителем (форма)', async () => {
    const owner = (await http.post('/api/auth/register').send({ tenantName: 'Form', email: `f_${uniq()}@t.test`, password: 'password123', fullName: 'Руководитель Р' }).expect(201)).body.data;
    const tok = owner.accessToken;
    // приглашаем исполнителя
    const exec = `e_${uniq()}@t.test`;
    const inv = (await http.post('/api/invites').set(H(tok)).send({ email: exec, role: 'member' }).expect(201)).body.data;
    await http.post('/api/invites/accept').send({ token: inv.token, fullName: 'Исполнитель И', password: 'execpass12' }).expect(201);
    const users = (await http.get('/api/users').set(H(tok)).expect(200)).body.data;
    const execId = users.find((u: any) => u.email === exec).id;
    const ownerId = users.find((u: any) => u.email !== exec).id;

    const proj = (await http.post('/api/projects').set(H(tok)).send({ name: 'П' }).expect(201)).body.data;
    const board0 = (await http.get(`/api/projects/${proj.id}/board`).set(H(tok)).expect(200)).body.data;

    const task = (await http.post('/api/tasks').set(H(tok)).send({
      projectId: proj.id, columnId: board0.columns[0].id, title: 'С формы', assigneeId: execId, managerId: ownerId, description: 'детали',
    }).expect(201)).body.data;

    const board = (await http.get(`/api/projects/${proj.id}/board`).set(H(tok)).expect(200)).body.data;
    const card = findTask(board, task.id);
    expect(card.assignee_name).toBe('Исполнитель И');
    expect(card.manager_name).toBe('Руководитель Р');
  });

  it('форма создания задаёт приоритет, срок, оценку и метки одним запросом', async () => {
    const reg = (await http.post('/api/auth/register').send({ tenantName: 'Full', email: `u_${uniq()}@t.test`, password: 'password123', fullName: 'Полная Форма' }).expect(201)).body.data;
    const tok = reg.accessToken;
    const proj = (await http.post('/api/projects').set(H(tok)).send({ name: 'П' }).expect(201)).body.data;
    const board0 = (await http.get(`/api/projects/${proj.id}/board`).set(H(tok)).expect(200)).body.data;

    const label = (await http.post('/api/labels').set(H(tok)).send({ name: `срочно_${uniq()}` }).expect(201)).body.data;
    const deadline = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();

    const task = (await http.post('/api/tasks').set(H(tok)).send({
      projectId: proj.id,
      columnId: board0.columns[0].id,
      title: 'Со всеми полями',
      priority: 'high',
      deadlineAt: deadline,
      estimateHours: 6.5,
      labelIds: [String(label.id)],
    }).expect(201)).body.data;

    expect(task.priority).toBe('high');
    expect(Number(task.estimate_hours)).toBe(6.5);
    expect(new Date(task.deadline_at).toISOString()).toBe(deadline);

    // метка должна быть привязана в той же транзакции, что и сама задача
    const labels = (await http.get(`/api/tasks/${task.id}/labels`).set(H(tok)).expect(200)).body.data;
    expect(labels.map((l: any) => String(l.id))).toContain(String(label.id));

    // без указанных полей поведение прежнее: приоритет по умолчанию, срок пуст
    const plain = (await http.post('/api/tasks').set(H(tok)).send({
      projectId: proj.id, columnId: board0.columns[0].id, title: 'Без полей',
    }).expect(201)).body.data;
    expect(plain.priority).toBe('normal');
    expect(plain.deadline_at).toBeNull();
    expect(plain.estimate_hours).toBeNull();
  });
});
