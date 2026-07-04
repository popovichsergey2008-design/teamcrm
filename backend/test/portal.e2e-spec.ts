import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AddressInfo } from 'net';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { AllExceptionsFilter } from '../src/common/http/all-exceptions.filter';
import { ResponseInterceptor } from '../src/common/http/response.interceptor';
import { RedisIoAdapter } from '../src/common/auth/redis-io.adapter';

/** Клиентский портал «маржа-сейф» (фича №9): прогресс без финансов; изоляция по client_id. */
describe('Client portal (e2e)', () => {
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

  it('клиент видит прогресс своих проектов без финансов; изоляция по client_id', async () => {
    const owner = (await http.post('/api/auth/register').send({ tenantName: 'Портал', email: `o_${uniq()}@t.test`, password: 'password123', fullName: 'Владелец' }).expect(201)).body.data;
    const tok = owner.accessToken;
    const proj = (await http.post('/api/projects').set(H(tok)).send({ name: 'Сайт клиники', budget: 500000 }).expect(201)).body.data;
    const board0 = (await http.get(`/api/projects/${proj.id}/board`).set(H(tok)).expect(200)).body.data;
    const col = board0.columns[0].id;
    await http.post('/api/tasks').set(H(tok)).send({ projectId: proj.id, columnId: col, title: 'Дизайн главной' }).expect(201);

    // внутреннее представление содержит финансы
    const internal = (await http.get(`/api/projects/${proj.id}/board`).set(H(tok)).expect(200)).body.data;
    expect(internal.project.budget).toBeDefined();
    expect(internal.columns[0].tasks[0].cost_current).toBeDefined();

    // клиент-компания + назначение проекта + приглашение client-пользователя
    const client = (await http.post('/api/portal/clients').set(H(tok)).send({ name: 'Клиника Аника' }).expect(201)).body.data;
    await http.post(`/api/portal/projects/${proj.id}/assign`).set(H(tok)).send({ clientId: client.id }).expect(201);
    const cEmail = `c_${uniq()}@t.test`;
    const inv = (await http.post(`/api/portal/clients/${client.id}/invite`).set(H(tok)).send({ email: cEmail }).expect(201)).body.data;
    await http.post('/api/invites/accept').send({ token: inv.token, fullName: 'Клиент К', password: 'clientpass1' }).expect(201);
    const clogin = (await http.post('/api/auth/login').send({ email: cEmail, password: 'clientpass1' }).expect(201)).body.data;
    const ctok = clogin.accessToken;
    expect(clogin.user.role).toBe('client');

    // портал: видит проект
    const pProjects = (await http.get('/api/portal/projects').set(H(ctok)).expect(200)).body.data;
    expect(pProjects.some((p: any) => String(p.id) === String(proj.id))).toBe(true);

    // портал: доска БЕЗ финансов
    const pBoard = (await http.get(`/api/portal/projects/${proj.id}/board`).set(H(ctok)).expect(200)).body.data;
    expect(pBoard.project.name).toBe('Сайт клиники');
    expect(pBoard.project.budget).toBeUndefined();                 // нет бюджета
    const pt = pBoard.columns[0].tasks[0];
    expect(pt.title).toBe('Дизайн главной');
    expect(pt.status).toBeDefined();
    expect(pt.cost_current).toBeUndefined();                       // нет себестоимости
    expect(pt.risk_pct).toBeUndefined();                           // нет risk_pct
    expect(pt.assignee_name).toBeUndefined();                      // нет внутренних исполнителей

    // клиент НЕ имеет доступа к внутренним эндпоинтам
    await http.get('/api/projects').set(H(ctok)).expect(403);
    await http.get(`/api/projects/${proj.id}/board`).set(H(ctok)).expect(403);

    // изоляция: другой клиент не видит чужой проект
    const client2 = (await http.post('/api/portal/clients').set(H(tok)).send({ name: 'Другая клиника' }).expect(201)).body.data;
    const c2Email = `c2_${uniq()}@t.test`;
    const inv2 = (await http.post(`/api/portal/clients/${client2.id}/invite`).set(H(tok)).send({ email: c2Email }).expect(201)).body.data;
    await http.post('/api/invites/accept').send({ token: inv2.token, fullName: 'Клиент2', password: 'clientpass2' }).expect(201);
    const c2 = (await http.post('/api/auth/login').send({ email: c2Email, password: 'clientpass2' }).expect(201)).body.data;
    const p2 = (await http.get('/api/portal/projects').set(H(c2.accessToken)).expect(200)).body.data;
    expect(p2.length).toBe(0);
    await http.get(`/api/portal/projects/${proj.id}/board`).set(H(c2.accessToken)).expect(404);
  });
});
