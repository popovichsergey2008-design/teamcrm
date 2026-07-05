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

/**
 * Верификационный гейт Этапа 1. Требует живые PostgreSQL/Redis/RabbitMQ
 * (docker-окружение из Этапа 0) и применённые миграции.
 */
describe('TEAMCRM Этап 1 (e2e)', () => {
  let app: INestApplication;
  let http: any;
  let baseUrl: string;
  let jwt: JwtService;
  let accessSecret: string;

  const uniq = () => Math.floor(Math.random() * 1e9).toString(36) + Date.now().toString(36);
  let ownerAToken: string;
  let tenantA: string;
  let projectId: string;
  let taskId: string;

  function syntheticToken(tenantId: string, role: RoleCode): string {
    const payload: AccessTokenPayload = {
      sub: '0',
      tenantId,
      role,
      email: `${role}@synthetic.local`,
    };
    return jwt.sign(payload, { secret: accessSecret, expiresIn: 300 });
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    app.useGlobalFilters(new AllExceptionsFilter());
    app.useGlobalInterceptors(new ResponseInterceptor());
    app.useWebSocketAdapter(new RedisIoAdapter(app));

    const config = app.get(ConfigService);
    accessSecret = config.getOrThrow('JWT_ACCESS_SECRET');
    jwt = app.get(JwtService);

    await app.listen(0, '0.0.0.0');
    const addr = app.getHttpServer().address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
    http = request(baseUrl) as any;
  });

  afterAll(async () => {
    await app?.close();
  });

  it('health is reachable and reports schema version', async () => {
    const res = await http.get('/api/health').expect(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.checks.postgres).toBe('ok');
    expect(res.body.data.schemaVersion).toBeTruthy();
  });

  it('register creates tenant + owner and returns tokens', async () => {
    const email = `owner_${uniq()}@a.test`;
    const res = await http
      .post('/api/auth/register')
      .send({ tenantName: 'Tenant A', email, password: 'password123', fullName: 'Owner A' })
      .expect(201);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.user.role).toBe('owner');
    expect(res.body.data.user.email).toBe(email);
    expect(res.body.data.accessToken).toBeTruthy();
    expect((res.body.data.user as any).password_hash).toBeUndefined();
    ownerAToken = res.body.data.accessToken;
    tenantA = res.body.data.user.tenantId;
  });

  it('rejects unauthenticated access to /api/me', async () => {
    const res = await http.get('/api/me').expect(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('/api/me returns the profile for a valid token', async () => {
    const res = await http
      .get('/api/me')
      .set('Authorization', `Bearer ${ownerAToken}`)
      .expect(200);
    expect(res.body.data.tenantId).toBe(tenantA);
    expect(res.body.data.role).toBe('owner');
  });

  it('refresh rotates tokens and logout revokes them', async () => {
    const email = `rot_${uniq()}@a.test`;
    const reg = await http
      .post('/api/auth/register')
      .send({ tenantName: 'RotTenant', email, password: 'password123', fullName: 'Rot' })
      .expect(201);
    const refreshToken = reg.body.data.refreshToken;

    const refreshed = await http
      .post('/api/auth/refresh')
      .send({ refreshToken })
      .expect(201);
    expect(refreshed.body.data.accessToken).toBeTruthy();

    // старый refresh уже отозван ротацией
    await http.post('/api/auth/refresh').send({ refreshToken }).expect(401);

    // новый refresh работает, затем logout его отзывает
    const newRefresh = refreshed.body.data.refreshToken;
    await http.post('/api/auth/logout').send({ refreshToken: newRefresh }).expect(201);
    await http.post('/api/auth/refresh').send({ refreshToken: newRefresh }).expect(401);
  });

  it('creates a project (owner) and seeds default board columns', async () => {
    const res = await http
      .post('/api/projects')
      .set('Authorization', `Bearer ${ownerAToken}`)
      .send({ name: 'Project P', budget: 100000 })
      .expect(201);
    projectId = res.body.data.id;
    expect(projectId).toBeTruthy();

    const board = await http
      .get(`/api/projects/${projectId}/board`)
      .set('Authorization', `Bearer ${ownerAToken}`)
      .expect(200);
    expect(board.body.data.columns.length).toBe(3);
  });

  it('creates and moves a task; board reflects new column', async () => {
    const created = await http
      .post('/api/tasks')
      .set('Authorization', `Bearer ${ownerAToken}`)
      .send({ projectId, title: 'Build API' })
      .expect(201);
    taskId = created.body.data.id;

    const board = await http
      .get(`/api/projects/${projectId}/board`)
      .set('Authorization', `Bearer ${ownerAToken}`)
      .expect(200);
    const cols = board.body.data.columns;
    const targetCol = cols[1].id;

    const moved = await http
      .post(`/api/tasks/${taskId}/move`)
      .set('Authorization', `Bearer ${ownerAToken}`)
      .send({ columnId: targetCol, position: 0 })
      .expect(201);
    expect(moved.body.data.column_id).toBe(targetCol);
    expect(moved.body.data.status).toBe(cols[1].name);
  });

  it('tenant isolation: tenant B cannot read tenant A board', async () => {
    const email = `owner_${uniq()}@b.test`;
    const reg = await http
      .post('/api/auth/register')
      .send({ tenantName: 'Tenant B', email, password: 'password123', fullName: 'Owner B' })
      .expect(201);
    const ownerBToken = reg.body.data.accessToken;

    const res = await http
      .get(`/api/projects/${projectId}/board`)
      .set('Authorization', `Bearer ${ownerBToken}`)
      .expect(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('RBAC: member cannot create a deal (403)', async () => {
    const memberToken = syntheticToken(tenantA, 'member');
    const res = await http
      .post('/api/deals')
      .set('Authorization', `Bearer ${memberToken}`)
      .send({ title: 'X' })
      .expect(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('client REST isolation: client не имеет доступа к внутренним доскам (только портал)', async () => {
    // Этап 5: client ходит только через /api/portal (жёсткий whitelist без финансов, см. portal.e2e).
    // Внутренние эндпоинты досок/проектов для роли client закрыты.
    const clientToken = syntheticToken(tenantA, 'client');
    await http.get(`/api/projects/${projectId}/board`).set('Authorization', `Bearer ${clientToken}`).expect(403);
    await http.get('/api/projects').set('Authorization', `Bearer ${clientToken}`).expect(403);
  });

  it('deal → project conversion creates a linked project (фича №5)', async () => {
    const deal = await http
      .post('/api/deals')
      .set('Authorization', `Bearer ${ownerAToken}`)
      .send({ title: 'Big Deal', amount: 50000, plannedMargin: 30 })
      .expect(201);
    const dealId = deal.body.data.id;

    const conv = await http
      .post(`/api/deals/${dealId}/convert`)
      .set('Authorization', `Bearer ${ownerAToken}`)
      .expect(201);
    expect(conv.body.data.project.deal_id).toBe(dealId);
    expect(conv.body.data.deal.project_id).toBe(conv.body.data.project.id);
  });

  it('realtime: task.moved reaches internal room; client room gets no financials', async () => {
    const clientToken = syntheticToken(tenantA, 'client');

    const internalSock: Socket = io(baseUrl, {
      transports: ['websocket'],
      auth: { token: ownerAToken },
    });
    const clientSock: Socket = io(baseUrl, {
      transports: ['websocket'],
      auth: { token: clientToken },
    });

    await Promise.all([
      new Promise<void>((r) => internalSock.on('connect', () => r())),
      new Promise<void>((r) => clientSock.on('connect', () => r())),
    ]);
    await internalSock.emitWithAck('project.subscribe', { projectId });
    await clientSock.emitWithAck('project.subscribe', { projectId });

    const internalEvent = new Promise<any>((resolve) =>
      internalSock.once('task.moved', resolve),
    );
    const clientEvent = new Promise<any>((resolve) =>
      clientSock.once('task.moved', resolve),
    );

    // триггерим перенос через REST
    const board = await http
      .get(`/api/projects/${projectId}/board`)
      .set('Authorization', `Bearer ${ownerAToken}`)
      .expect(200);
    const cols = board.body.data.columns;
    await http
      .post(`/api/tasks/${taskId}/move`)
      .set('Authorization', `Bearer ${ownerAToken}`)
      .send({ columnId: cols[2].id, position: 0 })
      .expect(201);

    const [internalPayload, clientPayload] = await Promise.all([internalEvent, clientEvent]);
    expect(internalPayload.id).toBe(taskId);
    expect(internalPayload.cost_current).toBeDefined();
    expect(clientPayload.id).toBe(taskId);
    expect(clientPayload.cost_current).toBeUndefined();

    internalSock.close();
    clientSock.close();
  });
});
