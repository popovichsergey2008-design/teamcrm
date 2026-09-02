import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AddressInfo } from 'net';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { AllExceptionsFilter } from '../src/common/http/all-exceptions.filter';
import { ResponseInterceptor } from '../src/common/http/response.interceptor';
import { RedisIoAdapter } from '../src/common/auth/redis-io.adapter';

/**
 * Что на доске может сотрудник.
 *
 * Живой случай: у сотрудника не было ни стрелок переноса колонок, ни архивации
 * проекта — кнопки просто не рисовались, и понять, почему у коллеги они есть, а у
 * тебя нет, было невозможно.
 *
 * Решение заказчика: доской управляют все, кто по ней работает, — вплоть до удаления.
 * От случайного нажатия удерживает подтверждение в интерфейсе, а не роль. Проверка
 * закрепляет именно это: пройден весь путь сотрудника от переноса колонки до удаления
 * задачи и проекта. Снаружи организации по-прежнему не видно ничего — это не про
 * роли, а про изоляцию, и её проверяем отдельно (projects.e2e-spec).
 */
describe('права сотрудника на доске (e2e)', () => {
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

  it('сотрудник ведёт доску целиком: колонки, проект, удаление задачи', async () => {
    const owner = (await http.post('/api/auth/register')
      .send({ tenantName: 'Board', email: `bp_${uniq()}@t.test`, password: 'password123', fullName: 'Ольга Владелец' })
      .expect(201)).body.data;
    const email = `bp_m_${uniq()}@t.test`;
    const inv = (await http.post('/api/invites').set(H(owner.accessToken))
      .send({ email, role: 'member' }).expect(201)).body.data;
    await http.post('/api/invites/accept')
      .send({ token: inv.token, fullName: 'Пётр Сотрудник', password: 'memberpass1' }).expect(201);
    const member = (await http.post('/api/auth/login')
      .send({ email, password: 'memberpass1' }).expect(201)).body.data;
    const M = H(member.accessToken);

    const proj = (await http.post('/api/projects').set(H(owner.accessToken))
      .send({ name: 'Доска' }).expect(201)).body.data;
    const board = (await http.get(`/api/projects/${proj.id}/board`).set(M).expect(200)).body.data;
    const first = board.columns[0];

    // порядок колонок
    await http.post(`/api/projects/${proj.id}/columns/${first.id}/move`).set(M)
      .send({ direction: 'right' }).expect(201);
    const moved = (await http.get(`/api/projects/${proj.id}/board`).set(M).expect(200)).body.data;
    expect(String(moved.columns[0].id)).not.toBe(String(first.id));

    // добавление, переименование и удаление колонки
    const added = (await http.post(`/api/projects/${proj.id}/columns`).set(M)
      .send({ name: 'Проверка' }).expect(201)).body.data;
    await http.patch(`/api/projects/${proj.id}/columns/${added.id}`).set(M)
      .send({ name: 'На проверке' }).expect(200);
    await http.delete(`/api/projects/${proj.id}/columns/${added.id}`).set(M).expect(200);

    // задача: завёл и удалил
    const task = (await http.post('/api/tasks').set(M)
      .send({ projectId: proj.id, title: 'Разовая' }).expect(201)).body.data;
    await http.delete(`/api/tasks/${task.id}`).set(M).expect(200);

    // свой проект: архив, возврат и удаление
    const own = (await http.post('/api/projects').set(M).send({ name: 'Мой проект' }).expect(201)).body.data;
    await http.post(`/api/projects/${own.id}/archive`).set(M).expect(201);
    await http.post(`/api/projects/${own.id}/unarchive`).set(M).expect(201);
    await http.delete(`/api/projects/${own.id}`).set(M).expect(200);

    const left = (await http.get('/api/projects').set(M).expect(200)).body.data;
    expect(left.find((p: any) => String(p.id) === String(own.id))).toBeUndefined();
  }, 40000);
});
