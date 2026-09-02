import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AddressInfo } from 'net';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { AllExceptionsFilter } from '../src/common/http/all-exceptions.filter';
import { ResponseInterceptor } from '../src/common/http/response.interceptor';
import { RedisIoAdapter } from '../src/common/auth/redis-io.adapter';

/** Удаление проектов: каскад по задачам/колонкам, права, изоляция организаций. */
describe('Enhancements v1 — Project delete (e2e)', () => {
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

  it('owner удаляет проект с задачами (каскад) — он исчезает из списка', async () => {
    const reg = (await http.post('/api/auth/register').send({ tenantName: 'Del', email: `d_${uniq()}@t.test`, password: 'password123', fullName: 'Оля' }).expect(201)).body.data;
    const tok = reg.accessToken;

    const proj = (await http.post('/api/projects').set(H(tok)).send({ name: 'На удаление' }).expect(201)).body.data;
    const board = (await http.get(`/api/projects/${proj.id}/board`).set(H(tok)).expect(200)).body.data;
    const col = board.columns[0].id;
    // задача + дочерние данные (комментарий, чеклист) — проверяем, что каскад не падает на FK
    const task = (await http.post('/api/tasks').set(H(tok)).send({ projectId: proj.id, columnId: col, title: 'T1' }).expect(201)).body.data;
    await http.post(`/api/tasks/${task.id}/comments`).set(H(tok)).send({ body: 'коммент' }).expect(201);
    await http.post(`/api/tasks/${task.id}/checklist`).set(H(tok)).send({ text: 'пункт' }).expect(201);

    await http.delete(`/api/projects/${proj.id}`).set(H(tok)).expect(200);

    const list = (await http.get('/api/projects').set(H(tok)).expect(200)).body.data;
    expect(list.find((p: any) => String(p.id) === String(proj.id))).toBeUndefined();
    // доска удалённого проекта больше недоступна
    await http.get(`/api/projects/${proj.id}/board`).set(H(tok)).expect(404);
  });

  it('проект удаляет и сотрудник; чужой/несуществующий — 404', async () => {
    const reg = (await http.post('/api/auth/register').send({ tenantName: 'Del2', email: `d_${uniq()}@t.test`, password: 'password123', fullName: 'Босс' }).expect(201)).body.data;
    const tok = reg.accessToken;
    const proj = (await http.post('/api/projects').set(H(tok)).send({ name: 'Защищённый' }).expect(201)).body.data;

    // приглашаем рядового участника
    const memberEmail = `m_${uniq()}@t.test`;
    const inv = (await http.post('/api/invites').set(H(tok)).send({ email: memberEmail, role: 'member' }).expect(201)).body.data;
    await http.post('/api/invites/accept').send({ token: inv.token, fullName: 'Петя', password: 'memberpass1' }).expect(201);
    const mLogin = (await http.post('/api/auth/login').send({ email: memberEmail, password: 'memberpass1' }).expect(201)).body.data;

    // другая организация не видит проект → 404, и это важнее любых ролей внутри своей
    const other = (await http.post('/api/auth/register').send({ tenantName: 'Other', email: `o_${uniq()}@t.test`, password: 'password123', fullName: 'Чужой' }).expect(201)).body.data;
    await http.delete(`/api/projects/${proj.id}`).set(H(other.accessToken)).expect(404);

    // Удаление проекта открыто сотрудникам — решение заказчика. От случайности
    // удерживает подтверждение в интерфейсе, а не роль.
    await http.delete(`/api/projects/${proj.id}`).set(H(mLogin.accessToken)).expect(200);
    const list = (await http.get('/api/projects').set(H(tok)).expect(200)).body.data;
    expect(list.find((p: any) => String(p.id) === String(proj.id))).toBeUndefined();
  });
});
