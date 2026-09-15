import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AddressInfo } from 'net';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { AllExceptionsFilter } from '../src/common/http/all-exceptions.filter';
import { ResponseInterceptor } from '../src/common/http/response.interceptor';
import { RedisIoAdapter } from '../src/common/auth/redis-io.adapter';

/**
 * «Сделал» — перенос срока на следующую среду 17:00 с подтверждением постановщика.
 *
 * Главное здесь не арифметика дат (она проверена отдельно в deadline-shift.spec.ts),
 * а ПРАВО: пока постановщик не сказал «да», срок остаётся прежним. Иначе это кнопка
 * «продлить себе срок», и сроки перестают что-либо значить.
 */
describe('перенос срока «Сделал» (e2e)', () => {
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
  afterAll(async () => { await app?.close(); });

  it('исполнитель просит — срок не двигается; постановщик подтверждает — двигается', async () => {
    const owner = (await http.post('/api/auth/register')
      .send({ tenantName: 'DS', email: `ds_${uniq()}@t.test`, password: 'password123', fullName: 'Ольга Владелец' })
      .expect(201)).body.data;
    const mateEmail = `ds_m_${uniq()}@t.test`;
    const mate = (await http.post('/api/users').set(H(owner.accessToken))
      .send({ email: mateEmail, fullName: 'Пётр Коллега', password: 'password123', role: 'member' })
      .expect(201)).body.data;
    const mateLogin = (await http.post('/api/auth/login')
      .send({ email: mateEmail, password: 'password123' }).expect(201)).body.data;
    const O = H(owner.accessToken);
    const M = H(mateLogin.accessToken);

    const proj = (await http.post('/api/projects').set(O).send({ name: 'П' }).expect(201)).body.data;
    const board = (await http.get(`/api/projects/${proj.id}/board`).set(O).expect(200)).body.data;
    const was = '2026-09-16T14:00:00.000Z';
    const task = (await http.post('/api/tasks').set(O)
      .send({ projectId: proj.id, columnId: board.columns[0].id, title: 'Еженедельная сводка', deadlineAt: was })
      .expect(201)).body.data;
    await http.post(`/api/tasks/${task.id}/assign`).set(O)
      .send({ assigneeId: String(mate.id), confirmOverload: true }).expect(201);

    // исполнитель нажал «Сделал»
    const asked = (await http.post(`/api/tasks/${task.id}/deadline-shift`).set(M).expect(201)).body.data;
    expect(asked.deadline_shift_to).toBeTruthy();
    expect(String(asked.deadline_shift_by)).toBe(String(mate.id));
    // срок пока ПРЕЖНИЙ: просьба сама по себе ничего не двигает
    expect(new Date(asked.deadline_at).toISOString()).toBe(was);
    // и предложенный срок — среда 17:00
    const to = new Date(asked.deadline_shift_to);
    const msk = to.toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', weekday: 'long', hour: '2-digit', minute: '2-digit' });
    expect(msk).toContain('среда');
    expect(msk).toContain('17:00');

    // решает постановщик, а не тот, кто просил
    await http.post(`/api/tasks/${task.id}/deadline-shift/decide`).set(M).send({ approve: true }).expect(403);

    const done = (await http.post(`/api/tasks/${task.id}/deadline-shift/decide`).set(O)
      .send({ approve: true }).expect(201)).body.data;
    expect(new Date(done.deadline_at).toISOString()).toBe(to.toISOString());
    expect(done.deadline_shift_to).toBeNull();

    // второй раз подтверждать нечего
    await http.post(`/api/tasks/${task.id}/deadline-shift/decide`).set(O).send({ approve: true }).expect(409);
  });

  it('отказ оставляет прежний срок', async () => {
    const owner = (await http.post('/api/auth/register')
      .send({ tenantName: 'DS2', email: `ds2_${uniq()}@t.test`, password: 'password123', fullName: 'Ольга Владелец' })
      .expect(201)).body.data;
    const mateEmail = `ds2_m_${uniq()}@t.test`;
    const mate = (await http.post('/api/users').set(H(owner.accessToken))
      .send({ email: mateEmail, fullName: 'Пётр Коллега', password: 'password123', role: 'member' })
      .expect(201)).body.data;
    const mateLogin = (await http.post('/api/auth/login')
      .send({ email: mateEmail, password: 'password123' }).expect(201)).body.data;
    const O = H(owner.accessToken);
    const M = H(mateLogin.accessToken);

    const proj = (await http.post('/api/projects').set(O).send({ name: 'П' }).expect(201)).body.data;
    const board = (await http.get(`/api/projects/${proj.id}/board`).set(O).expect(200)).body.data;
    const was = '2026-09-16T14:00:00.000Z';
    const task = (await http.post('/api/tasks').set(O)
      .send({ projectId: proj.id, columnId: board.columns[0].id, title: 'Отчёт', deadlineAt: was }).expect(201)).body.data;
    await http.post(`/api/tasks/${task.id}/assign`).set(O)
      .send({ assigneeId: String(mate.id), confirmOverload: true }).expect(201);

    await http.post(`/api/tasks/${task.id}/deadline-shift`).set(M).expect(201);
    const no = (await http.post(`/api/tasks/${task.id}/deadline-shift/decide`).set(O)
      .send({ approve: false }).expect(201)).body.data;
    expect(new Date(no.deadline_at).toISOString()).toBe(was);
    expect(no.deadline_shift_to).toBeNull();
  });

  it('постановщик переносит сам — сразу, без обряда подтверждения себе', async () => {
    const owner = (await http.post('/api/auth/register')
      .send({ tenantName: 'DS3', email: `ds3_${uniq()}@t.test`, password: 'password123', fullName: 'Ольга Владелец' })
      .expect(201)).body.data;
    const O = H(owner.accessToken);
    const proj = (await http.post('/api/projects').set(O).send({ name: 'П' }).expect(201)).body.data;
    const board = (await http.get(`/api/projects/${proj.id}/board`).set(O).expect(200)).body.data;
    const task = (await http.post('/api/tasks').set(O)
      .send({ projectId: proj.id, columnId: board.columns[0].id, title: 'Своя задача', deadlineAt: '2026-09-16T14:00:00.000Z' })
      .expect(201)).body.data;

    const res = (await http.post(`/api/tasks/${task.id}/deadline-shift`).set(O).expect(201)).body.data;
    expect(res.deadline_shift_to).toBeNull();
    // новый срок всегда в будущем — на какой бы день ни пришёлся прогон тестов
    expect(new Date(res.deadline_at).getTime()).toBeGreaterThan(Date.now());
  });
});
