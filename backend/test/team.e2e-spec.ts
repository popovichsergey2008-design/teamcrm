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

describe('Enhancements v1 — Team (e2e)', () => {
  let app: INestApplication;
  let http: any;
  let jwt: JwtService;
  let secret: string;
  let token: string;
  let tenantId: string;
  let ownerId: string;
  const uniq = () => Math.random().toString(36).slice(2) + Date.now().toString(36);
  const A = () => ({ Authorization: `Bearer ${token}` });
  const synth = (role: RoleCode) =>
    jwt.sign({ sub: '0', tenantId, role, email: `${role}@x.io` } as AccessTokenPayload, { secret, expiresIn: 300 });

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    app.useGlobalFilters(new AllExceptionsFilter());
    app.useGlobalInterceptors(new ResponseInterceptor());
    app.useWebSocketAdapter(new RedisIoAdapter(app));
    secret = app.get(ConfigService).getOrThrow('JWT_ACCESS_SECRET');
    jwt = app.get(JwtService);
    await app.listen(0, '0.0.0.0');
    http = request(`http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`);
    const reg = await http
      .post('/api/auth/register')
      .send({ tenantName: 'Team', email: `o_${uniq()}@t.test`, password: 'password123', fullName: 'Owner' })
      .expect(201);
    token = reg.body.data.accessToken;
    tenantId = reg.body.data.user.tenantId;
    ownerId = reg.body.data.user.id;
  });
  afterAll(async () => app?.close());

  let posId: string;
  let groupId: string;

  it('должности: CRUD + уникальность', async () => {
    posId = (await http.post('/api/positions').set(A()).send({ name: 'Разработчик' }).expect(201)).body.data.id;
    await http.post('/api/positions').set(A()).send({ name: 'Разработчик' }).expect(409);
    const list = (await http.get('/api/positions').set(A()).expect(200)).body.data;
    expect(list.some((p: any) => p.id === posId)).toBe(true);
  });

  it('группы: создание + участники', async () => {
    groupId = (await http.post('/api/groups').set(A()).send({ name: 'Бэкенд', kind: 'department' }).expect(201)).body.data.id;
    await http.post(`/api/groups/${groupId}/members`).set(A()).send({ userId: ownerId }).expect(201);
    const members = (await http.get(`/api/groups/${groupId}/members`).set(A()).expect(200)).body.data;
    expect(members.some((m: any) => m.id === ownerId)).toBe(true);
  });

  it('создание сотрудника с должностью и группой; список обогащён', async () => {
    const email = `u2_${uniq()}@t.test`;
    const u2 = (await http
      .post('/api/users')
      .set(A())
      .send({ email, password: 'password123', fullName: 'U2', role: 'member', positionId: posId, groupIds: [groupId] })
      .expect(201)).body.data;
    const list = (await http.get('/api/users').set(A()).expect(200)).body.data;
    const row = list.find((u: any) => u.id === u2.id);
    expect(row.positionName).toBe('Разработчик');
    expect(row.groups.some((g: any) => g.id === groupId)).toBe(true);
    expect(row.role).toBe('member');
  });

  it('инвариант: нельзя понизить/деактивировать последнего owner', async () => {
    await http.patch(`/api/users/${ownerId}`).set(A()).send({ role: 'member' }).expect(409);
    await http.patch(`/api/users/${ownerId}`).set(A()).send({ isActive: false }).expect(409);
  });

  it('при двух owner понижение исходного разрешено', async () => {
    const email = `co_${uniq()}@t.test`;
    const co = (await http.post('/api/users').set(A()).send({ email, password: 'password123', fullName: 'Co', role: 'manager' }).expect(201)).body.data;
    await http.patch(`/api/users/${co.id}`).set(A()).send({ role: 'owner' }).expect(200); // теперь 2 owner
    await http.patch(`/api/users/${ownerId}`).set(A()).send({ role: 'manager' }).expect(200); // исходного можно понизить
    // вернём владельца, чтобы не мешать (не обязательно)
  });

  it('приглашение: accept создаёт пользователя, токен одноразовый; деактивация блокирует логин', async () => {
    const email = `inv_${uniq()}@t.test`;
    const inv = (await http.post('/api/invites').set(A()).send({ email, role: 'member', positionId: posId }).expect(201)).body.data;
    expect(inv.token).toBeTruthy();
    await http.post('/api/invites/accept').send({ token: inv.token, fullName: 'Invited', password: 'password123' }).expect(201);
    // приглашённый может войти
    await http.post('/api/auth/login').send({ email, password: 'password123' }).expect(201);
    // токен одноразовый
    await http.post('/api/invites/accept').send({ token: inv.token, fullName: 'X', password: 'password123' }).expect(401);
  });

  it('деактивированный сотрудник не логинится', async () => {
    const email = `de_${uniq()}@t.test`;
    const u = (await http.post('/api/users').set(A()).send({ email, password: 'password123', fullName: 'De', role: 'member' }).expect(201)).body.data;
    await http.post('/api/auth/login').send({ email, password: 'password123' }).expect(201);
    await http.patch(`/api/users/${u.id}`).set(A()).send({ isActive: false }).expect(200);
    await http.post('/api/auth/login').send({ email, password: 'password123' }).expect(401);
  });

  it('RBAC: member не управляет командой; client не видит список', async () => {
    const m = synth('member');
    expect((await http.post('/api/positions').set({ Authorization: `Bearer ${m}` }).send({ name: 'X' })).status).toBe(403);
    expect((await http.post('/api/users').set({ Authorization: `Bearer ${m}` }).send({ email: 'a@a.io', password: 'password123', fullName: 'A' })).status).toBe(403);
    const c = synth('client');
    expect((await http.get('/api/users').set({ Authorization: `Bearer ${c}` })).status).toBe(403);
  });

  it('tenant-изоляция справочников', async () => {
    const reg = await http
      .post('/api/auth/register')
      .send({ tenantName: 'OtherT', email: `o2_${uniq()}@t.test`, password: 'password123', fullName: 'O2' })
      .expect(201);
    const list = (await http.get('/api/positions').set({ Authorization: `Bearer ${reg.body.data.accessToken}` }).expect(200)).body.data;
    expect(list.some((p: any) => p.id === posId)).toBe(false);
  });
});
