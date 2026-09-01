import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { AddressInfo } from 'net';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { AllExceptionsFilter } from '../src/common/http/all-exceptions.filter';
import { ResponseInterceptor } from '../src/common/http/response.interceptor';
import { RedisIoAdapter } from '../src/common/auth/redis-io.adapter';
import { AccessTokenPayload, RoleCode } from '../src/common/auth/jwt.types';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const iso = (offsetDays: number) => new Date(Date.now() + offsetDays * 86400000).toISOString();

/** Верификационный гейт Этапа 4 (AI Load Balancer). Живые PG/Redis/RabbitMQ. */
describe('TEAMCRM Этап 4 — Load Balancer (e2e)', () => {
  let app: INestApplication;
  let http: any;
  let jwt: JwtService;
  let accessSecret: string;

  let token: string;
  let tenantId: string;
  let ownerId: string;
  let userB: string;
  let projectId: string;

  const auth = () => ({ Authorization: `Bearer ${token}` });
  const uniq = () => Math.random().toString(36).slice(2) + Date.now().toString(36);
  const clientToken = () =>
    jwt.sign({ sub: '0', tenantId, role: 'client' as RoleCode, email: 'c@x.io' } as AccessTokenPayload, {
      secret: accessSecret,
      expiresIn: 300,
    });

  async function newTask(title: string): Promise<string> {
    return (await http.post('/api/tasks').set(auth()).send({ projectId, title }).expect(201)).body.data.id;
  }
  async function doneColumnId(): Promise<string> {
    const b = (await http.get(`/api/projects/${projectId}/board`).set(auth()).expect(200)).body.data;
    return b.columns.find((c: any) => c.name === 'Готово').id;
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    app.useGlobalFilters(new AllExceptionsFilter());
    app.useGlobalInterceptors(new ResponseInterceptor());
    app.useWebSocketAdapter(new RedisIoAdapter(app));
    accessSecret = app.get(ConfigService).getOrThrow('JWT_ACCESS_SECRET');
    jwt = app.get(JwtService);
    await app.listen(0, '0.0.0.0');
    http = request(`http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`);

    const reg = await http
      .post('/api/auth/register')
      .send({ tenantName: 'LB', email: `o_${uniq()}@lb.test`, password: 'password123', fullName: 'Owner' })
      .expect(201);
    token = reg.body.data.accessToken;
    tenantId = reg.body.data.user.tenantId;
    ownerId = reg.body.data.user.id;
    userB = (
      await http
        .post('/api/users')
        .set(auth())
        .send({ email: `b_${uniq()}@lb.test`, password: 'password123', fullName: 'User B', role: 'member' })
        .expect(201)
    ).body.data.id;
    projectId = (await http.post('/api/projects').set(auth()).send({ name: 'LB P', budget: 1_000_000 }).expect(201)).body.data.id;
  });

  afterAll(async () => {
    await app?.close();
  });

  it('Velocity считается из time_logs за окно (закрытые задачи / время)', async () => {
    const t = await newTask('velocity task');
    await http.post(`/api/tasks/${t}/assign`).set(auth()).send({ assigneeId: ownerId, estimateHours: 4 }).expect(201);
    await http.post(`/api/tasks/${t}/timer/start`).set(auth()).expect(201);
    await sleep(1200);
    await http.post(`/api/tasks/${t}/timer/stop`).set(auth()).expect(201);
    // confirmGate: задача на себе, сдаём без отчёта — здесь считается Velocity, а не качество сдачи
    await http.post(`/api/tasks/${t}/move`).set(auth()).send({ columnId: await doneColumnId(), position: 0, confirmGate: true }).expect(201);

    const v = (await http.get(`/api/users/${ownerId}/velocity`).set(auth()).expect(200)).body.data;
    expect(v.closedTasks).toBeGreaterThanOrEqual(1);
    expect(Number(v.trackedHours)).toBeGreaterThan(0);
    expect(Number(v.velocity)).toBeGreaterThan(0);
  }, 30000);

  it('Светофор: зелёный при запасе, красный при нехватке', async () => {
    const green = await newTask('green');
    await http
      .post(`/api/tasks/${green}/assign`)
      .set(auth())
      .send({ assigneeId: ownerId, estimateHours: 1, deadlineAt: iso(30) })
      .expect(201);
    const gf = (await http.get(`/api/tasks/${green}/forecast`).set(auth()).expect(200)).body.data;
    expect(gf.risk_level).toBe('green');

    const red = await newTask('red');
    await http
      .post(`/api/tasks/${red}/assign`)
      .set(auth())
      .send({ assigneeId: ownerId, estimateHours: 1000, deadlineAt: iso(1), confirmOverload: true })
      .expect(201);
    const rf = (await http.get(`/api/tasks/${red}/forecast`).set(auth()).expect(200)).body.data;
    expect(rf.risk_level).toBe('red');
    expect(Number(rf.risk_pct)).toBeGreaterThanOrEqual(75);
  }, 30000);

  it('Guard перегруза: назначение сверх ёмкости → предупреждение, требует confirm_overload', async () => {
    const big = await newTask('big');
    const warn = (
      await http.post(`/api/tasks/${big}/assign`).set(auth()).send({ assigneeId: userB, estimateHours: 500 }).expect(201)
    ).body.data;
    expect(warn.assigned).toBe(false);
    expect(warn.warning).toBe(true);
    expect(warn.projectedHours).toBeGreaterThan(warn.capacityHours);

    const forced = (
      await http
        .post(`/api/tasks/${big}/assign`)
        .set(auth())
        .send({ assigneeId: userB, estimateHours: 500, confirmOverload: true })
        .expect(201)
    ).body.data;
    expect(forced.assigned).toBe(true);
    expect(forced.overloadConfirmed).toBe(true);
  }, 30000);

  it('Видимость: client не получает velocity/load; forecast — без risk_pct', async () => {
    const ct = clientToken();
    const ch = (p: string) => http.get(p).set({ Authorization: `Bearer ${ct}` });
    expect((await ch(`/api/users/${ownerId}/velocity`)).status).toBe(403);
    expect((await ch(`/api/users/${ownerId}/load`)).status).toBe(403);

    const green = (await http.get(`/api/projects/${projectId}/board`).set(auth())).body.data.columns
      .flatMap((c: any) => c.tasks)[0];
    const cf = await ch(`/api/tasks/${green.id}/forecast`);
    expect(cf.status).toBe(200);
    expect(cf.body.data.risk_level !== undefined).toBe(true);
    expect(cf.body.data.risk_pct).toBeUndefined(); // risk_pct — только internal
  }, 30000);

  it('Velocity идемпотентна: повторный расчёт даёт то же значение', async () => {
    const v1 = (await http.get(`/api/users/${ownerId}/velocity`).set(auth()).expect(200)).body.data;
    const v2 = (await http.get(`/api/users/${ownerId}/velocity`).set(auth()).expect(200)).body.data;
    expect(v1.velocity).toBe(v2.velocity);
  });
});
