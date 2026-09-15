import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AddressInfo } from 'net';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { AllExceptionsFilter } from '../src/common/http/all-exceptions.filter';
import { ResponseInterceptor } from '../src/common/http/response.interceptor';
import { RedisIoAdapter } from '../src/common/auth/redis-io.adapter';

/**
 * «Просмотрено» в переписке задачи (ТЗ-7, разд. 17).
 *
 * Отправителю нужно знать не «доставлено», а «прочитано»: половина вопросов в
 * задачах — «ты видел?». Отметка одна на человека и задачу и только ползёт вверх —
 * прокрутка назад не должна снимать у автора уже показанное подтверждение.
 */
describe('ТЗ-7 — отметки о прочтении переписки задачи (e2e)', () => {
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

  it('коллега дочитал — автор видит его в «Просмотрено»; отметка не откатывается назад', async () => {
    const owner = (await http.post('/api/auth/register')
      .send({ tenantName: 'RD', email: `rd_${uniq()}@t.test`, password: 'password123', fullName: 'Ольга Владелец' })
      .expect(201)).body.data;
    const mateEmail = `rd_m_${uniq()}@t.test`;
    await http.post('/api/users').set(H(owner.accessToken))
      .send({ email: mateEmail, fullName: 'Пётр Коллега', password: 'password123', role: 'member' })
      .expect(201);
    const mate = (await http.post('/api/auth/login')
      .send({ email: mateEmail, password: 'password123' }).expect(201)).body.data;
    const O = H(owner.accessToken);
    const M = H(mate.accessToken);

    const proj = (await http.post('/api/projects').set(O).send({ name: 'П' }).expect(201)).body.data;
    const board = (await http.get(`/api/projects/${proj.id}/board`).set(O).expect(200)).body.data;
    const task = (await http.post('/api/tasks').set(O)
      .send({ projectId: proj.id, columnId: board.columns[0].id, title: 'Правки Барнаул' }).expect(201)).body.data;

    const first = (await http.post(`/api/tasks/${task.id}/comments`).set(O)
      .send({ body: 'Держи ссылку на ТЗ' }).expect(201)).body.data;
    const second = (await http.post(`/api/tasks/${task.id}/comments`).set(O)
      .send({ body: 'И ещё один документ' }).expect(201)).body.data;

    // пока никто не читал — показывать нечего
    expect((await http.get(`/api/tasks/${task.id}/comments/readers`).set(O).expect(200)).body.data).toEqual([]);

    // коллега открыл разговор и дочитал до последнего
    await http.post(`/api/tasks/${task.id}/comments/read`).set(M)
      .send({ lastReadId: String(second.id) }).expect(201);

    const readers = (await http.get(`/api/tasks/${task.id}/comments/readers`).set(O).expect(200)).body.data;
    expect(readers).toHaveLength(1);
    expect(readers[0].name).toBe('Пётр Коллега');
    expect(Number(readers[0].lastReadId)).toBe(Number(second.id));

    // прокрутил переписку назад и «прочитал» старое — подтверждение не снимается
    await http.post(`/api/tasks/${task.id}/comments/read`).set(M)
      .send({ lastReadId: String(first.id) }).expect(201);
    const after = (await http.get(`/api/tasks/${task.id}/comments/readers`).set(O).expect(200)).body.data;
    expect(Number(after[0].lastReadId)).toBe(Number(second.id));
  });
});
