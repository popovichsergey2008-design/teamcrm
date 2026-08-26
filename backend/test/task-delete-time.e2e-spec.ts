import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AddressInfo } from 'net';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { AllExceptionsFilter } from '../src/common/http/all-exceptions.filter';
import { ResponseInterceptor } from '../src/common/http/response.interceptor';
import { RedisIoAdapter } from '../src/common/auth/redis-io.adapter';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Удаление задачи, по которой учтено рабочее время.
 *
 * Обещание, которое здесь проверяется, стоит денег: задача исчезает с доски,
 * а часы и их стоимость остаются в себестоимости проекта — и остаются даже после
 * следующего пересчёта экономики, когда по проекту снова поработают.
 *
 * Ставка задана огромной специально: секунда трекинга сразу даёт измеримые деньги,
 * иначе тест ждал бы часами.
 */
describe('Удаление задачи с учтённым временем (e2e)', () => {
  let app: INestApplication;
  let http: any;
  const uniq = () => Math.random().toString(36).slice(2) + Date.now().toString(36);
  const H = (t: string) => ({ Authorization: `Bearer ${t}` });

  let ownerToken: string;
  let bossToken: string;
  let projectId: string;

  const pollCost = async (taskId: string, timeoutMs = 15000): Promise<number> => {
    const stop = Date.now() + timeoutMs;
    let last = 0;
    while (Date.now() < stop) {
      const r = await http.get(`/api/tasks/${taskId}/cost`).set(H(ownerToken));
      last = Number(r.body?.data?.costCurrent ?? 0);
      if (last > 0) return last;
      await sleep(500);
    }
    return last;
  };

  const pollProjectCost = async (expected: number, timeoutMs = 15000): Promise<number> => {
    const stop = Date.now() + timeoutMs;
    let last = 0;
    while (Date.now() < stop) {
      const r = await http.get(`/api/projects/${projectId}/pnl`).set(H(ownerToken));
      last = Number(r.body?.data?.costActual ?? 0);
      if (last >= expected) return last;
      await sleep(500);
    }
    return last;
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

    const owner = (await http.post('/api/auth/register')
      .send({ tenantName: 'Удаление', email: `d_${uniq()}@t.test`, password: 'password123', fullName: 'Владелец' })
      .expect(201)).body.data;
    ownerToken = owner.accessToken;

    const bossEmail = `d_b_${uniq()}@t.test`;
    await http.post('/api/users').set(H(ownerToken))
      .send({ email: bossEmail, fullName: 'Руководитель', password: 'password123', role: 'manager' }).expect(201);
    bossToken = (await http.post('/api/auth/login')
      .send({ email: bossEmail, password: 'password123' }).expect(201)).body.data.accessToken;

    // 360000 в час → одна секунда работы = 100
    await http.post('/api/rates').set(H(ownerToken))
      .send({ userId: owner.user.id, hourlyRate: 360000 }).expect(201);

    projectId = (await http.post('/api/projects').set(H(ownerToken))
      .send({ name: 'Стройка', budget: 1000000 }).expect(201)).body.data.id;
  });
  afterAll(async () => { await app?.close(); });

  it('задачу без времени руководитель удаляет как раньше', async () => {
    const task = (await http.post('/api/tasks').set(H(ownerToken))
      .send({ projectId, title: 'Заведена по ошибке' }).expect(201)).body.data;
    await http.delete(`/api/tasks/${task.id}`).set(H(bossToken)).expect(200);
  });

  it('часы и деньги остаются в проекте, когда задачу удаляют', async () => {
    const task = (await http.post('/api/tasks').set(H(ownerToken))
      .send({ projectId, title: 'Поработали и передумали' }).expect(201)).body.data;

    await http.post(`/api/tasks/${task.id}/timer/start`).set(H(ownerToken)).expect(201);
    await sleep(1500);
    await http.post(`/api/tasks/${task.id}/timer/stop`).set(H(ownerToken)).expect(201);
    const taskCost = await pollCost(task.id);
    expect(taskCost).toBeGreaterThan(0);
    const costBefore = await pollProjectCost(taskCost);
    const hoursBefore = Number((await http.get(`/api/projects/${projectId}/cost-of-work`).set(H(ownerToken))
      .expect(200)).body.data.laborHours);
    expect(hoursBefore).toBeGreaterThan(0);

    // 1. Руководителю такое удаление недоступно — решение о себестоимости принимает владелец
    await http.delete(`/api/tasks/${task.id}`).set(H(bossToken)).expect(403);

    // 2. Владельцу сначала говорят, сколько по задаче учтено
    const asked = await http.delete(`/api/tasks/${task.id}`).set(H(ownerToken)).expect(409);
    expect(asked.body.error.details.timeLoss.hours).toBeGreaterThan(0);
    expect(asked.body.error.message).toContain('себестоимости проекта');

    // 3. С подтверждением задача уходит
    await http.delete(`/api/tasks/${task.id}?confirmTimeLoss=1`).set(H(ownerToken)).expect(200);
    const board = (await http.get(`/api/projects/${projectId}/board`).set(H(ownerToken)).expect(200)).body.data;
    expect(board.columns.flatMap((c: any) => c.tasks).some((t: any) => String(t.id) === String(task.id))).toBe(false);

    // 4. Главное: часы проекта на месте
    const hoursAfter = Number((await http.get(`/api/projects/${projectId}/cost-of-work`).set(H(ownerToken))
      .expect(200)).body.data.laborHours);
    expect(hoursAfter).toBeCloseTo(hoursBefore, 2);

    // 5. И себестоимость не падает при СЛЕДУЮЩЕМ пересчёте, когда по проекту снова поработают
    const next = (await http.post('/api/tasks').set(H(ownerToken))
      .send({ projectId, title: 'Работаем дальше' }).expect(201)).body.data;
    await http.post(`/api/tasks/${next.id}/timer/start`).set(H(ownerToken)).expect(201);
    await sleep(1500);
    await http.post(`/api/tasks/${next.id}/timer/stop`).set(H(ownerToken)).expect(201);
    const nextCost = await pollCost(next.id);
    expect(nextCost).toBeGreaterThan(0);

    const costAfter = await pollProjectCost(costBefore + nextCost);
    expect(costAfter).toBeGreaterThanOrEqual(costBefore);
  }, 60000);
});
