import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AddressInfo } from 'net';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { AllExceptionsFilter } from '../src/common/http/all-exceptions.filter';
import { ResponseInterceptor } from '../src/common/http/response.interceptor';
import { RedisIoAdapter } from '../src/common/auth/redis-io.adapter';

/** Управление колонками доски: add/rename/move/delete + перенос задач, инварианты. */
describe('Enhancements v1 — Board columns (e2e)', () => {
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

  const names = (board: any) => board.columns.map((c: any) => c.name);

  it('add / rename / move / delete колонок с переносом задач', async () => {
    const reg = (await http.post('/api/auth/register').send({ tenantName: 'Cols', email: `c_${uniq()}@t.test`, password: 'password123', fullName: 'К' }).expect(201)).body.data;
    const tok = reg.accessToken;
    const proj = (await http.post('/api/projects').set(H(tok)).send({ name: 'Доска' }).expect(201)).body.data;

    let board = (await http.get(`/api/projects/${proj.id}/board`).set(H(tok)).expect(200)).body.data;
    expect(names(board)).toEqual(['To Do', 'In Progress', 'Done']);

    // добавить колонку
    await http.post(`/api/projects/${proj.id}/columns`).set(H(tok)).send({ name: 'Ревью' }).expect(201);
    board = (await http.get(`/api/projects/${proj.id}/board`).set(H(tok)).expect(200)).body.data;
    expect(names(board)).toEqual(['To Do', 'In Progress', 'Done', 'Ревью']);

    // переименовать первую
    const first = board.columns[0].id;
    await http.patch(`/api/projects/${proj.id}/columns/${first}`).set(H(tok)).send({ name: 'Бэклог' }).expect(200);

    // переместить последнюю (Ревью) влево
    const revue = board.columns[3].id;
    await http.post(`/api/projects/${proj.id}/columns/${revue}/move`).set(H(tok)).send({ direction: 'left' }).expect(201);
    board = (await http.get(`/api/projects/${proj.id}/board`).set(H(tok)).expect(200)).body.data;
    expect(names(board)).toEqual(['Бэклог', 'In Progress', 'Ревью', 'Done']);

    // задача во второй колонке → удаляем эту колонку → задача переезжает (не теряется)
    const col2 = board.columns[1].id;
    const task = (await http.post('/api/tasks').set(H(tok)).send({ projectId: proj.id, columnId: col2, title: 'Перенос' }).expect(201)).body.data;
    await http.delete(`/api/projects/${proj.id}/columns/${col2}`).set(H(tok)).expect(200);
    board = (await http.get(`/api/projects/${proj.id}/board`).set(H(tok)).expect(200)).body.data;
    expect(names(board)).toEqual(['Бэклог', 'Ревью', 'Done']);
    const allTasks = board.columns.flatMap((c: any) => c.tasks.map((t: any) => String(t.id)));
    expect(allTasks).toContain(String(task.id)); // задача сохранилась
  });

  it('нельзя удалить последнюю колонку; member не управляет колонками', async () => {
    const reg = (await http.post('/api/auth/register').send({ tenantName: 'Cols2', email: `c_${uniq()}@t.test`, password: 'password123', fullName: 'Б' }).expect(201)).body.data;
    const tok = reg.accessToken;
    const proj = (await http.post('/api/projects').set(H(tok)).send({ name: 'Доска2' }).expect(201)).body.data;
    let board = (await http.get(`/api/projects/${proj.id}/board`).set(H(tok)).expect(200)).body.data;

    // удаляем до одной
    await http.delete(`/api/projects/${proj.id}/columns/${board.columns[2].id}`).set(H(tok)).expect(200);
    await http.delete(`/api/projects/${proj.id}/columns/${board.columns[1].id}`).set(H(tok)).expect(200);
    board = (await http.get(`/api/projects/${proj.id}/board`).set(H(tok)).expect(200)).body.data;
    expect(board.columns.length).toBe(1);
    // последняя — нельзя (409)
    await http.delete(`/api/projects/${proj.id}/columns/${board.columns[0].id}`).set(H(tok)).expect(409);

    // member не может добавить колонку (403)
    const mEmail = `m_${uniq()}@t.test`;
    const inv = (await http.post('/api/invites').set(H(tok)).send({ email: mEmail, role: 'member' }).expect(201)).body.data;
    await http.post('/api/invites/accept').send({ token: inv.token, fullName: 'Петя', password: 'memberpass1' }).expect(201);
    const mLogin = (await http.post('/api/auth/login').send({ email: mEmail, password: 'memberpass1' }).expect(201)).body.data;
    await http.post(`/api/projects/${proj.id}/columns`).set(H(mLogin.accessToken)).send({ name: 'X' }).expect(403);
  });
});
