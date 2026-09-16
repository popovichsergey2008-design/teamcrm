import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AddressInfo } from 'net';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { AllExceptionsFilter } from '../src/common/http/all-exceptions.filter';
import { ResponseInterceptor } from '../src/common/http/response.interceptor';
import { RedisIoAdapter } from '../src/common/auth/redis-io.adapter';

/**
 * Правка проекта, видимость «только для своих» и перенос задачи между проектами.
 *
 * Главное, что проверяем: закрытый проект не виден НИ в списке, НИ по прямой ссылке
 * на доску. Скрыть строку в списке несложно; ценность проверки в том, что адрес
 * доски знают все, кому его хоть раз присылали.
 */
describe('доступ к проектам и перенос задач (e2e)', () => {
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

  /** Владелец, сотрудник и проект с доской — всё, с чего начинается каждый случай. */
  const setup = async (tag: string) => {
    const owner = (await http.post('/api/auth/register')
      .send({ tenantName: tag, email: `${tag}_${uniq()}@t.test`, password: 'password123', fullName: 'Ольга Владелец' })
      .expect(201)).body.data;
    const mateEmail = `${tag}_m_${uniq()}@t.test`;
    const mate = (await http.post('/api/users').set(H(owner.accessToken))
      .send({ email: mateEmail, fullName: 'Пётр Коллега', password: 'password123', role: 'member' })
      .expect(201)).body.data;
    const mateLogin = (await http.post('/api/auth/login')
      .send({ email: mateEmail, password: 'password123' }).expect(201)).body.data;
    return { O: H(owner.accessToken), M: H(mateLogin.accessToken), mate };
  };

  it('проект переименовывается, а закрытый — не виден ни списком, ни ссылкой', async () => {
    const { O, M, mate } = await setup('PA');
    const proj = (await http.post('/api/projects').set(O).send({ name: 'Бухгалтерия' }).expect(201)).body.data;

    // переименование
    const renamed = (await http.patch(`/api/projects/${proj.id}`).set(O)
      .send({ name: 'Финансы' }).expect(200)).body.data;
    expect(renamed.name).toBe('Финансы');

    // пока проект открыт — сотрудник видит и список, и доску
    let seen = (await http.get('/api/projects').set(M).expect(200)).body.data;
    expect(seen.some((p: any) => String(p.id) === String(proj.id))).toBe(true);
    await http.get(`/api/projects/${proj.id}/board`).set(M).expect(200);

    // закрываем «для своих»
    await http.patch(`/api/projects/${proj.id}`).set(O).send({ visibility: 'members' }).expect(200);

    seen = (await http.get('/api/projects').set(M).expect(200)).body.data;
    expect(seen.some((p: any) => String(p.id) === String(proj.id))).toBe(false);
    // и по прямой ссылке тоже нет
    await http.get(`/api/projects/${proj.id}/board`).set(M).expect(403);

    // допустили — снова видно
    await http.post(`/api/projects/${proj.id}/members`).set(O).send({ userIds: [String(mate.id)] }).expect(201);
    await http.get(`/api/projects/${proj.id}/board`).set(M).expect(200);
    seen = (await http.get('/api/projects').set(M).expect(200)).body.data;
    expect(seen.some((p: any) => String(p.id) === String(proj.id))).toBe(true);

    // убрали — и снова нет
    await http.delete(`/api/projects/${proj.id}/members/${mate.id}`).set(O).expect(200);
    await http.get(`/api/projects/${proj.id}/board`).set(M).expect(403);

    // видимость меняет руководство, а не любой сотрудник
    await http.patch(`/api/projects/${proj.id}`).set(M).send({ visibility: 'all' }).expect(403);
  });

  it('закрывая проект, не отбираем его у тех, кто в нём работает', async () => {
    const { O, M, mate } = await setup('PA2');
    const proj = (await http.post('/api/projects').set(O).send({ name: 'Наём' }).expect(201)).body.data;
    const board = (await http.get(`/api/projects/${proj.id}/board`).set(O).expect(200)).body.data;
    const task = (await http.post('/api/tasks').set(O)
      .send({ projectId: proj.id, columnId: board.columns[0].id, title: 'Собеседование' }).expect(201)).body.data;
    await http.post(`/api/tasks/${task.id}/assign`).set(O)
      .send({ assigneeId: String(mate.id), confirmOverload: true }).expect(201);

    await http.patch(`/api/projects/${proj.id}`).set(O).send({ visibility: 'members' }).expect(200);
    // исполнитель задачи остаётся внутри: иначе «закрыть» означало бы «сломать работу»
    await http.get(`/api/projects/${proj.id}/board`).set(M).expect(200);
  });

  it('задача переезжает в другой проект, сохраняя переписку и попадая в такую же колонку', async () => {
    const { O } = await setup('PA3');
    const from = (await http.post('/api/projects').set(O).send({ name: 'Откуда' }).expect(201)).body.data;
    const to = (await http.post('/api/projects').set(O).send({ name: 'Куда' }).expect(201)).body.data;
    const fromBoard = (await http.get(`/api/projects/${from.id}/board`).set(O).expect(200)).body.data;
    const work = fromBoard.columns.find((c: any) => c.name === 'В работе') ?? fromBoard.columns[1];

    const task = (await http.post('/api/tasks').set(O)
      .send({ projectId: from.id, columnId: fromBoard.columns[0].id, title: 'Не туда положили' }).expect(201)).body.data;
    await http.post(`/api/tasks/${task.id}/comments`).set(O).send({ body: 'обсуждение по делу' }).expect(201);
    await http.post(`/api/tasks/${task.id}/move`).set(O)
      .send({ columnId: String(work.id), position: 0 }).expect(201);

    const moved = (await http.post(`/api/tasks/${task.id}/project`).set(O)
      .send({ projectId: String(to.id) }).expect(201)).body.data;
    expect(String(moved.project_id)).toBe(String(to.id));

    // попала в колонку с тем же названием, а не в «Новые»
    const toBoard = (await http.get(`/api/projects/${to.id}/board`).set(O).expect(200)).body.data;
    const col = toBoard.columns.find((c: any) => c.tasks.some((t: any) => String(t.id) === String(task.id)));
    expect(col.name).toBe(work.name);

    // переписка уехала вместе с задачей — ради этого перенос и делался
    const comments = (await http.get(`/api/tasks/${task.id}/comments`).set(O).expect(200)).body.data;
    expect(comments.some((c: any) => c.body === 'обсуждение по делу')).toBe(true);

    // и в старом проекте её больше нет
    const back = (await http.get(`/api/projects/${from.id}/board`).set(O).expect(200)).body.data;
    expect(back.columns.flatMap((c: any) => c.tasks).some((t: any) => String(t.id) === String(task.id))).toBe(false);
  });
});
