import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AddressInfo } from 'net';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { AllExceptionsFilter } from '../src/common/http/all-exceptions.filter';
import { ResponseInterceptor } from '../src/common/http/response.interceptor';
import { RedisIoAdapter } from '../src/common/auth/redis-io.adapter';

/**
 * План на день (ТЗ-2, этап 3, Ш1).
 *
 * Главное, что проверяем: план — личный. Его ставит исполнитель, а не тот, кто задачу
 * поручил, иначе «фокус дня» превращается в ещё один канал раздачи указаний. И план —
 * не срок: сдвиг плана не трогает обязательство перед другими.
 */
describe('ТЗ-2 — план на день (e2e)', () => {
  let app: INestApplication;
  let http: any;
  const uniq = () => Math.random().toString(36).slice(2) + Date.now().toString(36);
  const H = (t: string) => ({ Authorization: `Bearer ${t}` });
  const day = (shift = 0) => {
    const d = new Date();
    d.setDate(d.getDate() + shift);
    return d.toISOString().slice(0, 10);
  };

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

  it('план ставит исполнитель, срок при этом не меняется', async () => {
    const owner = (await http.post('/api/auth/register')
      .send({ tenantName: 'Plan', email: `p_${uniq()}@t.test`, password: 'password123', fullName: 'Ольга' })
      .expect(201)).body.data;
    const tok = owner.accessToken;

    const memEmail = `p_m_${uniq()}@t.test`;
    const inv = (await http.post('/api/invites').set(H(tok)).send({ email: memEmail, role: 'member' }).expect(201)).body.data;
    await http.post('/api/invites/accept').send({ token: inv.token, fullName: 'Пётр', password: 'memberpass1' }).expect(201);
    const mem = (await http.post('/api/auth/login').send({ email: memEmail, password: 'memberpass1' }).expect(201)).body.data;

    const proj = (await http.post('/api/projects').set(H(tok)).send({ name: 'План' }).expect(201)).body.data;
    const deadline = new Date(Date.now() + 7 * 864e5).toISOString();
    const task = (await http.post('/api/tasks').set(H(tok)).send({
      projectId: proj.id, title: 'Задача со сроком через неделю',
      assigneeId: mem.user.id, deadlineAt: deadline,
    }).expect(201)).body.data;

    // 1. Постановщик планировать чужой день не может — это не поручение
    await http.patch(`/api/tasks/${task.id}/focus-date`).set(H(tok)).send({ date: day() }).expect(403);

    // 2. Исполнитель берёт задачу в сегодняшний день
    const planned = (await http.patch(`/api/tasks/${task.id}/focus-date`).set(H(mem.accessToken))
      .send({ date: day() }).expect(200)).body.data;
    expect(planned.focus_date).toBeTruthy();
    expect(String(planned.focus_date).slice(0, 10)).toBe(day());
    // срок — обязательство перед другими — остался прежним
    expect(new Date(planned.deadline_at).toISOString().slice(0, 10)).toBe(deadline.slice(0, 10));

    // 3. Задача видна в своей выборке вместе с планом
    const mine = (await http.get('/api/tasks/my?scope=mine').set(H(mem.accessToken)).expect(200)).body.data;
    expect(mine.find((t: any) => String(t.id) === String(task.id))?.focus_date).toBeTruthy();

    // 4. План можно снять, не трогая срок
    const cleared = (await http.patch(`/api/tasks/${task.id}/focus-date`).set(H(mem.accessToken))
      .send({ date: null }).expect(200)).body.data;
    expect(cleared.focus_date).toBeNull();
    expect(cleared.deadline_at).toBeTruthy();

    // 5. Кривая дата отклоняется, а не записывается молча
    await http.patch(`/api/tasks/${task.id}/focus-date`).set(H(mem.accessToken))
      .send({ date: 'завтра' }).expect(400);
  });

  it('вчерашнее незакрытое попадает в хвосты, сегодняшнее — нет', async () => {
    const a = (await http.post('/api/auth/register')
      .send({ tenantName: 'Tails', email: `t_${uniq()}@t.test`, password: 'password123', fullName: 'Анна' })
      .expect(201)).body.data;
    const tok = a.accessToken;
    const proj = (await http.post('/api/projects').set(H(tok)).send({ name: 'Хвосты' }).expect(201)).body.data;

    const stale = (await http.post('/api/tasks').set(H(tok))
      .send({ projectId: proj.id, title: 'Вчерашняя', assigneeId: a.user.id }).expect(201)).body.data;
    const fresh = (await http.post('/api/tasks').set(H(tok))
      .send({ projectId: proj.id, title: 'Сегодняшняя', assigneeId: a.user.id }).expect(201)).body.data;

    await http.patch(`/api/tasks/${stale.id}/focus-date`).set(H(tok)).send({ date: day(-1) }).expect(200);
    await http.patch(`/api/tasks/${fresh.id}/focus-date`).set(H(tok)).send({ date: day() }).expect(200);

    const tails = (await http.get(`/api/tasks/my/leftovers?today=${day()}`).set(H(tok)).expect(200)).body.data;
    const ids = tails.map((t: any) => String(t.id));
    expect(ids).toContain(String(stale.id));
    expect(ids).not.toContain(String(fresh.id));
  });
});
