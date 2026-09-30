import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AddressInfo } from 'net';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { AllExceptionsFilter } from '../src/common/http/all-exceptions.filter';
import { ResponseInterceptor } from '../src/common/http/response.interceptor';
import { RedisIoAdapter } from '../src/common/auth/redis-io.adapter';

/**
 * Направления задачи и автоподбор исполнителя (задачи #1295, #1363).
 *
 * Проверяем обещания: направления задаются несколькими отметками и хранятся у задачи;
 * автоподбор без модели понимает направление по словам и отдаёт задачу человеку этого
 * направления, а не первому попавшемуся; менять направления может тот, кто в задаче.
 */
describe('Направления задачи (e2e)', () => {
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

  it('направления хранятся у задачи, автоподбор отдаёт задачу человеку нужного направления', async () => {
    const owner = (await http.post('/api/auth/register')
      .send({ tenantName: 'Dir', email: `d_${uniq()}@t.test`, password: 'password123', fullName: 'Ольга Владелец' })
      .expect(201)).body.data;
    const O = H(owner.accessToken);

    const person = async (fullName: string, skills: string[]) => {
      const u = (await http.post('/api/users').set(O)
        .send({ email: `d_${uniq()}@t.test`, password: 'password123', fullName, role: 'member' }).expect(201)).body.data;
      await http.patch(`/api/users/${u.id}`).set(O).send({ skills }).expect(200);
      return String(u.id);
    };
    const back = await person('Денис Бэкендов', ['backend']);
    const front = await person('Марина Фронтова', ['frontend']);

    // Автоподбор без модели: «API» — это бэкенд, и задача уходит бэкендеру.
    const pick = (await http.post('/api/nl/auto-assign').set(O)
      .send({ title: 'Сделать API авторизации для складов' }).expect(201)).body.data;
    expect(pick.directions[0]).toBe('backend');
    expect(pick.assigneeId).toBe(back);

    const pickFront = (await http.post('/api/nl/auto-assign').set(O)
      .send({ title: 'Поправить кнопку на странице заказа' }).expect(201)).body.data;
    expect(pickFront.assigneeId).toBe(front);

    // Слов нет — никого не ставим наугад.
    const none = (await http.post('/api/nl/auto-assign').set(O)
      .send({ title: 'Позвонить клиенту по договору' }).expect(201)).body.data;
    expect(none.directions).toEqual([]);
    expect(none.assigneeId).toBeNull();

    // ТЗ из пунктов — видно, что его можно разложить.
    const tz = (await http.post('/api/nl/auto-assign').set(O)
      .send({ title: 'ТЗ по складу', description: '1. Сделать API\n2. Сверстать форму\n3. Написать текст' }).expect(201)).body.data;
    expect(tz.items).toBe(3);

    // Несколько направлений у одной задачи — при создании и отметкой в карточке.
    const project = (await http.post('/api/projects').set(O).send({ name: 'Склад' }).expect(201)).body.data;
    const task = (await http.post('/api/tasks').set(O)
      .send({ projectId: String(project.id), title: 'API и форма заказа', assigneeId: back, directions: ['backend', 'frontend'] })
      .expect(201)).body.data;
    expect(task.directions).toEqual(['backend', 'frontend']);

    const changed = (await http.patch(`/api/tasks/${task.id}/directions`).set(O)
      .send({ directions: ['backend'] }).expect(200)).body.data;
    expect(changed.directions).toEqual(['backend']);

    // Чужое направление не принимается: только коды из справочника.
    await http.patch(`/api/tasks/${task.id}/directions`).set(O).send({ directions: ['космос'] }).expect(400);
  }, 90000);
});
