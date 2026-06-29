import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { AddressInfo } from 'net';
import { io, Socket } from 'socket.io-client';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { AllExceptionsFilter } from '../src/common/http/all-exceptions.filter';
import { ResponseInterceptor } from '../src/common/http/response.interceptor';
import { RedisIoAdapter } from '../src/common/auth/redis-io.adapter';
import { AccessTokenPayload, RoleCode } from '../src/common/auth/jwt.types';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Верификационный гейт Этапа 2. Требует живые PG/Redis/RabbitMQ + миграции. */
describe('TEAMCRM Этап 2 — Unit-Economics (e2e)', () => {
  let app: INestApplication;
  let http: any;
  let baseUrl: string;
  let jwt: JwtService;
  let accessSecret: string;

  let token: string;
  let tenantId: string;
  let userId: string;

  const uniq = () => Math.random().toString(36).slice(2) + Date.now().toString(36);
  const auth = () => ({ Authorization: `Bearer ${token}` });

  function syntheticToken(role: RoleCode): string {
    const payload: AccessTokenPayload = { sub: '0', tenantId, role, email: `${role}@syn.local` };
    return jwt.sign(payload, { secret: accessSecret, expiresIn: 300 });
  }

  async function pollCost(taskId: string, timeoutMs = 15000): Promise<number> {
    const stop = Date.now() + timeoutMs;
    let last = 0;
    while (Date.now() < stop) {
      const r = await http.get(`/api/tasks/${taskId}/cost`).set(auth());
      last = Number(r.body?.data?.costCurrent ?? 0);
      if (last > 0) return last;
      await sleep(500);
    }
    return last;
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    app.useGlobalFilters(new AllExceptionsFilter());
    app.useGlobalInterceptors(new ResponseInterceptor());
    app.useWebSocketAdapter(new RedisIoAdapter(app));
    const config = app.get(ConfigService);
    accessSecret = config.getOrThrow('JWT_ACCESS_SECRET');
    jwt = app.get(JwtService);
    await app.listen(0, '0.0.0.0');
    baseUrl = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
    http = request(baseUrl);

    const reg = await http
      .post('/api/auth/register')
      .send({ tenantName: 'Econ', email: `o_${uniq()}@e.test`, password: 'password123', fullName: 'Owner' })
      .expect(201);
    token = reg.body.data.accessToken;
    tenantId = reg.body.data.user.tenantId;
    userId = reg.body.data.user.id;

    // ставка: 360000/час → 1 сек трекинга = 100 (быстрый измеримый сигнал в e2e)
    await http.post('/api/rates').set(auth()).send({ userId, hourlyRate: 360000 }).expect(201);
  });

  afterAll(async () => {
    await app?.close();
  });

  it('один активный таймер: старт на новой задаче закрывает предыдущий', async () => {
    const p = (await http.post('/api/projects').set(auth()).send({ name: 'P1', budget: 1000000 }).expect(201)).body.data;
    const t1 = (await http.post('/api/tasks').set(auth()).send({ projectId: p.id, title: 'A' }).expect(201)).body.data;
    const t2 = (await http.post('/api/tasks').set(auth()).send({ projectId: p.id, title: 'B' }).expect(201)).body.data;

    await http.post(`/api/tasks/${t1.id}/timer/start`).set(auth()).expect(201);
    let active = (await http.get('/api/me/timer').set(auth()).expect(200)).body.data;
    expect(active.taskId).toBe(t1.id);

    // старт второго закрывает первый
    await http.post(`/api/tasks/${t2.id}/timer/start`).set(auth()).expect(201);
    active = (await http.get('/api/me/timer').set(auth()).expect(200)).body.data;
    expect(active.taskId).toBe(t2.id);

    await http.post(`/api/tasks/${t2.id}/timer/stop`).set(auth()).expect(201);
    active = (await http.get('/api/me/timer').set(auth()).expect(200)).body.data;
    expect(active).toBeNull();
  });

  it('закрытие таймера триггерит пересчёт себестоимости (>0) и P&L', async () => {
    const p = (await http.post('/api/projects').set(auth()).send({ name: 'P2', budget: 1000000 }).expect(201)).body.data;
    const t = (await http.post('/api/tasks').set(auth()).send({ projectId: p.id, title: 'work' }).expect(201)).body.data;

    await http.post(`/api/tasks/${t.id}/timer/start`).set(auth()).expect(201);
    await sleep(1500); // ~1.5 сек работы
    await http.post(`/api/tasks/${t.id}/timer/stop`).set(auth()).expect(201);

    const cost = await pollCost(t.id);
    expect(cost).toBeGreaterThan(0);

    const pnl = (await http.get(`/api/projects/${p.id}/pnl`).set(auth()).expect(200)).body.data;
    expect(Number(pnl.costActual)).toBeGreaterThan(0);
    expect(pnl.marginActual).not.toBeNull();
  }, 30000);

  it('алерт маржи: при cost > budget маржа падает ниже порога → alert.raised', async () => {
    const p = (await http.post('/api/projects').set(auth()).send({ name: 'tiny', budget: 10 }).expect(201)).body.data;
    const t = (await http.post('/api/tasks').set(auth()).send({ projectId: p.id, title: 'burn' }).expect(201)).body.data;

    await http.post(`/api/tasks/${t.id}/timer/start`).set(auth()).expect(201);
    await sleep(1500);
    await http.post(`/api/tasks/${t.id}/timer/stop`).set(auth()).expect(201);
    await pollCost(t.id);

    // ждём появления активного алерта по проекту
    let raised = false;
    const stop = Date.now() + 10000;
    while (Date.now() < stop) {
      const alerts = (await http.get('/api/alerts').set(auth()).expect(200)).body.data;
      if (alerts.some((a: any) => String(a.project_id) === String(p.id) && a.type === 'margin_below_threshold')) {
        raised = true;
        break;
      }
      await sleep(500);
    }
    expect(raised).toBe(true);
  }, 30000);

  it('client-изоляция: роль client не получает cost/pnl/alerts (REST 403)', async () => {
    const clientTok = syntheticToken('client');
    const ch = (path: string) => http.get(path).set({ Authorization: `Bearer ${clientTok}` });
    const p = (await http.post('/api/projects').set(auth()).send({ name: 'P3', budget: 100 }).expect(201)).body.data;
    const t = (await http.post('/api/tasks').set(auth()).send({ projectId: p.id, title: 'x' }).expect(201)).body.data;

    expect((await ch(`/api/tasks/${t.id}/cost`)).status).toBe(403);
    expect((await ch(`/api/projects/${p.id}/pnl`)).status).toBe(403);
    expect((await ch('/api/alerts')).status).toBe(403);
  });

  it('realtime: task.cost_changed доходит в internal-комнату, НЕ в клиентскую', async () => {
    const p = (await http.post('/api/projects').set(auth()).send({ name: 'RT', budget: 1000000 }).expect(201)).body.data;
    const t = (await http.post('/api/tasks').set(auth()).send({ projectId: p.id, title: 'rt' }).expect(201)).body.data;
    const clientTok = syntheticToken('client');

    const internal: Socket = io(baseUrl, { transports: ['websocket'], auth: { token } });
    const client: Socket = io(baseUrl, { transports: ['websocket'], auth: { token: clientTok } });
    await Promise.all([
      new Promise<void>((r) => internal.on('connect', () => r())),
      new Promise<void>((r) => client.on('connect', () => r())),
    ]);
    await internal.emitWithAck('project.subscribe', { projectId: p.id });
    await client.emitWithAck('project.subscribe', { projectId: p.id });

    let internalGotCost = false;
    let clientGotCost = false;
    let clientGotTimeStopped = false;
    internal.on('task.cost_changed', () => (internalGotCost = true));
    client.on('task.cost_changed', () => (clientGotCost = true));
    client.on('time.stopped', () => (clientGotTimeStopped = true));

    await http.post(`/api/tasks/${t.id}/timer/start`).set(auth()).expect(201);
    await sleep(1200);
    await http.post(`/api/tasks/${t.id}/timer/stop`).set(auth()).expect(201);
    await pollCost(t.id);
    await sleep(1500); // дать событиям долететь

    expect(internalGotCost).toBe(true);
    expect(clientGotCost).toBe(false); // финансовое событие не доходит клиенту
    expect(clientGotTimeStopped).toBe(true); // нефинансовое — доходит

    internal.close();
    client.close();
  }, 30000);
});
