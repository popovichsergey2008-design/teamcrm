import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AddressInfo } from 'net';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { AllExceptionsFilter } from '../src/common/http/all-exceptions.filter';
import { ResponseInterceptor } from '../src/common/http/response.interceptor';
import { RedisIoAdapter } from '../src/common/auth/redis-io.adapter';

/**
 * Что нового в задаче лично для меня.
 *
 * Проверяем не «ручка отвечает», а четыре правила, ради которых счётчик и заводился:
 * чужое изменение делает задачу новой, открытие карточки гасит отметку, СВОИ действия
 * новостью не считаются, и краснеют только МОИ задачи — иначе на большой доске горит
 * всё подряд и смотреть на это перестают.
 */
describe('непрочитанное в задачах (e2e)', () => {
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

  const team = async () => {
    const owner = (await http.post('/api/auth/register')
      .send({ tenantName: 'Unread', email: `un_${uniq()}@t.test`, password: 'password123', fullName: 'Ольга Владелец' })
      .expect(201)).body.data;
    const email = `un_m_${uniq()}@t.test`;
    const inv = (await http.post('/api/invites').set(H(owner.accessToken))
      .send({ email, role: 'member' }).expect(201)).body.data;
    await http.post('/api/invites/accept')
      .send({ token: inv.token, fullName: 'Пётр Сотрудник', password: 'memberpass1' }).expect(201);
    const member = (await http.post('/api/auth/login')
      .send({ email, password: 'memberpass1' }).expect(201)).body.data;
    return { owner, member };
  };

  /** Сколько нового видит человек на доске по конкретной задаче. */
  const unreadOf = async (token: string, projectId: string, taskId: string): Promise<number> => {
    const board = (await http.get(`/api/projects/${projectId}/board`).set(H(token)).expect(200)).body.data;
    const task = board.columns.flatMap((c: any) => c.tasks).find((t: any) => String(t.id) === String(taskId));
    return Number(task?.unread ?? -1);
  };

  it('чужое изменение делает задачу новой, открытие карточки гасит отметку', async () => {
    const { owner, member } = await team();
    const proj = (await http.post('/api/projects').set(H(owner.accessToken))
      .send({ name: 'Непрочитанное' }).expect(201)).body.data;

    // задачу ставит владелец сотруднику — для сотрудника это новость
    const task = (await http.post('/api/tasks').set(H(owner.accessToken))
      .send({ projectId: proj.id, title: 'Собрать смету', assigneeId: member.user.id }).expect(201)).body.data;

    expect(await unreadOf(member.accessToken, proj.id, task.id)).toBeGreaterThan(0);
    // постановщику своя же задача новостью не является
    expect(await unreadOf(owner.accessToken, proj.id, task.id)).toBe(0);

    // открыл карточку — отметка погасла
    await http.post(`/api/tasks/${task.id}/read`).set(H(member.accessToken)).expect(201);
    expect(await unreadOf(member.accessToken, proj.id, task.id)).toBe(0);

    // владелец написал в обсуждении — снова новое
    await http.post(`/api/tasks/${task.id}/comments`).set(H(owner.accessToken))
      .send({ body: 'Смету считаем без НДС' }).expect(201);
    expect(await unreadOf(member.accessToken, proj.id, task.id)).toBe(1);

    // свой ответ новостью для себя не становится
    await http.post(`/api/tasks/${task.id}/comments`).set(H(member.accessToken))
      .send({ body: 'Принял' }).expect(201);
    expect(await unreadOf(member.accessToken, proj.id, task.id)).toBe(1);

    // а постановщику ответ сотрудника — новость
    expect(await unreadOf(owner.accessToken, proj.id, task.id)).toBe(1);
  }, 40000);

  it('чужие задачи не краснеют, а счётчик проекта считает только мои', async () => {
    const { owner, member } = await team();
    const proj = (await http.post('/api/projects').set(H(owner.accessToken))
      .send({ name: 'Чужое' }).expect(201)).body.data;

    // задача владельца сама себе: сотрудник в ней никак не участвует
    const alien = (await http.post('/api/tasks').set(H(owner.accessToken))
      .send({ projectId: proj.id, title: 'Не моё дело', assigneeId: owner.user.id }).expect(201)).body.data;
    await http.post(`/api/tasks/${alien.id}/comments`).set(H(owner.accessToken))
      .send({ body: 'Обсуждаем без него' }).expect(201);

    expect(await unreadOf(member.accessToken, proj.id, alien.id)).toBe(0);

    const projects = (await http.get('/api/projects').set(H(member.accessToken)).expect(200)).body.data;
    const mine = projects.find((p: any) => String(p.id) === String(proj.id));
    expect(Number(mine.unread)).toBe(0);

    // а наблюдателем — уже моё: следить за задачей и значит хотеть знать об изменениях
    await http.post(`/api/tasks/${alien.id}/participants`).set(H(owner.accessToken))
      .send({ userId: member.user.id, role: 'watcher' }).expect(201);
    await http.post(`/api/tasks/${alien.id}/comments`).set(H(owner.accessToken))
      .send({ body: 'Теперь при нём' }).expect(201);

    expect(await unreadOf(member.accessToken, proj.id, alien.id)).toBeGreaterThan(0);
  }, 40000);
});
