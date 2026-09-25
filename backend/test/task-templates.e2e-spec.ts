import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AddressInfo } from 'net';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { AllExceptionsFilter } from '../src/common/http/all-exceptions.filter';
import { ResponseInterceptor } from '../src/common/http/response.interceptor';
import { RedisIoAdapter } from '../src/common/auth/redis-io.adapter';

/**
 * Шаблоны задач (просьба заказчика: «кнопка сохранить как шаблон»).
 *
 * Проверяем не хранение как таковое, а обещания, которые шаблон даёт человеку:
 * он забирает из задачи чек-лист и теги, переводит срок в «через N дней», не даёт
 * завести два одинаковых имени и не исчезает по нажатию постороннего.
 */
describe('шаблоны задач (e2e)', () => {
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

  it('шаблон забирает из задачи содержимое, а срок — относительным', async () => {
    const owner = (await http.post('/api/auth/register')
      .send({ tenantName: 'TPL', email: `tpl_${uniq()}@t.test`, password: 'password123', fullName: 'Ольга Владелец' })
      .expect(201)).body.data;
    const O = H(owner.accessToken);

    const proj = (await http.post('/api/projects').set(O).send({ name: 'П' }).expect(201)).body.data;
    const board = (await http.get(`/api/projects/${proj.id}/board`).set(O).expect(200)).body.data;

    // задача со сроком через неделю, чек-листом и тегом
    const inWeek = new Date(Date.now() + 7 * 86_400_000).toISOString();
    const task = (await http.post('/api/tasks').set(O).send({
      projectId: proj.id, columnId: board.columns[0].id,
      title: 'Подключить домен клиенту', description: 'по инструкции', priority: 'high',
      deadlineAt: inWeek, estimateHours: 3,
    }).expect(201)).body.data;
    await http.post(`/api/tasks/${task.id}/checklist`).set(O).send({ text: 'Проверить NS' }).expect(201);
    await http.post(`/api/tasks/${task.id}/checklist`).set(O).send({ text: 'Выпустить сертификат' }).expect(201);
    const tag = (await http.post('/api/tags').set(O).send({ name: 'инфраструктура' }).expect(201)).body.data;
    await http.post(`/api/tasks/${task.id}/tags`).set(O).send({ tagIds: [String(tag.id)] }).expect(201);

    const tpl = (await http.post(`/api/task-templates/from-task/${task.id}`).set(O)
      .send({ name: 'Домен под клиента' }).expect(201)).body.data;

    expect(tpl.name).toBe('Домен под клиента');
    expect(tpl.title).toBe('Подключить домен клиенту');
    expect(tpl.priority).toBe('high');
    expect(Number(tpl.estimate_hours)).toBe(3);
    // чек-лист уехал целиком и по порядку
    expect(tpl.checklist).toEqual(['Проверить NS', 'Выпустить сертификат']);
    expect(tpl.label_ids.map(String)).toEqual([String(tag.id)]);
    // срок стал относительным: «через неделю», а не 15 сентября
    expect(tpl.deadline_days).toBe(7);

    // шаблон виден в списке организации
    const list = (await http.get('/api/task-templates').set(O).expect(200)).body.data;
    expect(list.map((t: any) => t.name)).toContain('Домен под клиента');
  });

  it('второй шаблон с тем же именем не заводится — человек не поймёт, какой из них его', async () => {
    const owner = (await http.post('/api/auth/register')
      .send({ tenantName: 'TPL2', email: `tpl2_${uniq()}@t.test`, password: 'password123', fullName: 'Ольга' })
      .expect(201)).body.data;
    const O = H(owner.accessToken);
    const proj = (await http.post('/api/projects').set(O).send({ name: 'П' }).expect(201)).body.data;
    const board = (await http.get(`/api/projects/${proj.id}/board`).set(O).expect(200)).body.data;
    const task = (await http.post('/api/tasks').set(O)
      .send({ projectId: proj.id, columnId: board.columns[0].id, title: 'Отчёт' }).expect(201)).body.data;

    await http.post(`/api/task-templates/from-task/${task.id}`).set(O).send({ name: 'Недельный отчёт' }).expect(201);
    const again = await http.post(`/api/task-templates/from-task/${task.id}`).set(O)
      .send({ name: 'недельный ОТЧЁТ' }).expect(409);
    expect(again.body.error.message).toContain('уже есть');
  });

  it('чужой шаблон не удалить, свой — да; прошедший срок относительным не становится', async () => {
    const owner = (await http.post('/api/auth/register')
      .send({ tenantName: 'TPL3', email: `tpl3_${uniq()}@t.test`, password: 'password123', fullName: 'Ольга Владелец' })
      .expect(201)).body.data;
    const O = H(owner.accessToken);
    const mateEmail = `tpl3_m_${uniq()}@t.test`;
    await http.post('/api/users').set(O)
      .send({ email: mateEmail, fullName: 'Пётр Коллега', password: 'password123', role: 'member' }).expect(201);
    const M = H((await http.post('/api/auth/login')
      .send({ email: mateEmail, password: 'password123' }).expect(201)).body.data.accessToken);

    const proj = (await http.post('/api/projects').set(O).send({ name: 'П' }).expect(201)).body.data;
    const board = (await http.get(`/api/projects/${proj.id}/board`).set(O).expect(200)).body.data;
    // срок В ПРОШЛОМ: подставлять вчерашний день в новую задачу хуже, чем не подставлять
    const task = (await http.post('/api/tasks').set(O).send({
      projectId: proj.id, columnId: board.columns[0].id, title: 'Просроченная',
      deadlineAt: '2020-01-01T10:00:00.000Z',
    }).expect(201)).body.data;

    const mine = (await http.post(`/api/task-templates/from-task/${task.id}`).set(M)
      .send({ name: 'Пётров шаблон' }).expect(201)).body.data;
    expect(mine.deadline_days).toBeNull();

    // владелец удалить может (он последняя инстанция), а посторонний — нет:
    // проверяем обратным порядком, заведя шаблон от владельца
    const his = (await http.post(`/api/task-templates/from-task/${task.id}`).set(O)
      .send({ name: 'Ольгин шаблон' }).expect(201)).body.data;
    await http.delete(`/api/task-templates/${his.id}`).set(M).expect(403);
    await http.delete(`/api/task-templates/${mine.id}`).set(M).expect(200);

    const left = (await http.get('/api/task-templates').set(O).expect(200)).body.data;
    expect(left.map((t: any) => t.name)).toEqual(['Ольгин шаблон']);
  });

  it('счётчик использований поднимает частые шаблоны наверх списка', async () => {
    const owner = (await http.post('/api/auth/register')
      .send({ tenantName: 'TPL4', email: `tpl4_${uniq()}@t.test`, password: 'password123', fullName: 'Ольга' })
      .expect(201)).body.data;
    const O = H(owner.accessToken);
    const proj = (await http.post('/api/projects').set(O).send({ name: 'П' }).expect(201)).body.data;
    const board = (await http.get(`/api/projects/${proj.id}/board`).set(O).expect(200)).body.data;
    const task = (await http.post('/api/tasks').set(O)
      .send({ projectId: proj.id, columnId: board.columns[0].id, title: 'Т' }).expect(201)).body.data;

    // «Альфа» по алфавиту первая, но пользуются «Омегой»
    await http.post(`/api/task-templates/from-task/${task.id}`).set(O).send({ name: 'Альфа' }).expect(201);
    const omega = (await http.post(`/api/task-templates/from-task/${task.id}`).set(O)
      .send({ name: 'Омега' }).expect(201)).body.data;

    await http.post(`/api/task-templates/${omega.id}/used`).set(O).expect(201);
    const list = (await http.get('/api/task-templates').set(O).expect(200)).body.data;
    expect(list[0].name).toBe('Омега');
  });
});
