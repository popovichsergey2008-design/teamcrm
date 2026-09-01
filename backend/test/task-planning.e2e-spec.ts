import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AddressInfo } from 'net';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { AllExceptionsFilter } from '../src/common/http/all-exceptions.filter';
import { ResponseInterceptor } from '../src/common/http/response.interceptor';
import { RedisIoAdapter } from '../src/common/auth/redis-io.adapter';

/**
 * Кто может назначать исполнителя и ставить срок.
 *
 * Живой случай: сотрудник заводил задачу, открывал её и на «Сохранить» получал
 * «Insufficient role». Причина была в расхождении прав: создать задачу С ИСПОЛНИТЕЛЕМ
 * И СРОКОМ роль member могла, а поправить их потом — нет, эти две ручки остались от
 * этапа, где планирование считалось делом руководителя.
 *
 * Проверяем обе стороны: сотрудник планирует и назначает, клиент — не может.
 */
describe('планирование задачи: назначение и срок (e2e)', () => {
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

  /** Владелец, сотрудник и клиент в одной организации. */
  const team = async () => {
    const owner = (await http.post('/api/auth/register')
      .send({ tenantName: 'Plan', email: `pl_${uniq()}@t.test`, password: 'password123', fullName: 'Ольга Владелец' })
      .expect(201)).body.data;

    const join = async (role: string, fullName: string, password: string) => {
      const email = `pl_${role}_${uniq()}@t.test`;
      const inv = (await http.post('/api/invites').set(H(owner.accessToken))
        .send({ email, role }).expect(201)).body.data;
      await http.post('/api/invites/accept').send({ token: inv.token, fullName, password }).expect(201);
      return (await http.post('/api/auth/login').send({ email, password }).expect(201)).body.data;
    };

    return {
      owner,
      member: await join('member', 'Пётр Сотрудник', 'memberpass1'),
      client: await join('client', 'Клиент Иванов', 'clientpass1'),
    };
  };

  it('сотрудник ставит срок и назначает исполнителя на своей задаче', async () => {
    const { owner, member } = await team();
    const proj = (await http.post('/api/projects').set(H(owner.accessToken))
      .send({ name: 'Планирование' }).expect(201)).body.data;

    // задача заводится сотрудником — так же, как в жизни: увидел работу и записал
    const task = (await http.post('/api/tasks').set(H(member.accessToken))
      .send({ projectId: proj.id, title: 'Собрать смету' }).expect(201)).body.data;

    const deadline = new Date(Date.now() + 5 * 864e5).toISOString();
    await http.post(`/api/tasks/${task.id}/plan`).set(H(member.accessToken))
      .send({ estimateHours: 4, deadlineAt: deadline }).expect(201);

    const assigned = (await http.post(`/api/tasks/${task.id}/assign`).set(H(member.accessToken))
      .send({ assigneeId: member.user.id }).expect(201)).body.data;
    expect(assigned.assigned).toBe(true);

    const board = (await http.get(`/api/projects/${proj.id}/board`).set(H(member.accessToken)).expect(200)).body.data;
    const saved = board.columns.flatMap((c: any) => c.tasks).find((t: any) => String(t.id) === String(task.id));
    expect(String(saved.assignee_id)).toBe(String(member.user.id));
    expect(saved.deadline_at).toBeTruthy();
  }, 30000);

  it('клиент не планирует и не назначает', async () => {
    const { owner, member, client } = await team();
    const proj = (await http.post('/api/projects').set(H(owner.accessToken))
      .send({ name: 'Клиентский' }).expect(201)).body.data;
    const task = (await http.post('/api/tasks').set(H(owner.accessToken))
      .send({ projectId: proj.id, title: 'Не для клиента' }).expect(201)).body.data;

    await http.post(`/api/tasks/${task.id}/plan`).set(H(client.accessToken))
      .send({ estimateHours: 1 }).expect(403);
    await http.post(`/api/tasks/${task.id}/assign`).set(H(client.accessToken))
      .send({ assigneeId: member.user.id }).expect(403);
  }, 30000);
});
