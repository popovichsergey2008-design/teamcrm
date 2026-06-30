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
});
