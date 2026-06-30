import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AddressInfo } from 'net';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { AllExceptionsFilter } from '../src/common/http/all-exceptions.filter';
import { ResponseInterceptor } from '../src/common/http/response.interceptor';
import { RedisIoAdapter } from '../src/common/auth/redis-io.adapter';

/** Мультиорганизации: глобальный аккаунт + членство в нескольких организациях. */
describe('Enhancements v1 — Multi-org (e2e)', () => {
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

  it('регистрация даёт одну организацию; глобальная уникальность e-mail', async () => {
    const email = `o_${uniq()}@t.test`;
    const reg = (await http.post('/api/auth/register').send({ tenantName: 'Орг 1', email, password: 'password123', fullName: 'Влад' }).expect(201)).body.data;
    expect(reg.organizations.length).toBe(1);
    expect(reg.organizations[0].role).toBe('owner');
    // повторная регистрация тем же e-mail → конфликт (глобально уникален)
    await http.post('/api/auth/register').send({ tenantName: 'Орг X', email, password: 'password123', fullName: 'Влад' }).expect(409);
  });

  it('создание второй организации из кабинета + переключение', async () => {
    const email = `o_${uniq()}@t.test`;
    const reg = (await http.post('/api/auth/register').send({ tenantName: 'Орг A', email, password: 'password123', fullName: 'A' }).expect(201)).body.data;
    const t1 = reg.organizations[0].tenantId;

    const created = (await http.post('/api/auth/organizations').set(H(reg.accessToken)).send({ name: 'Орг B' }).expect(201)).body.data;
    const t2 = created.user.tenantId;
    expect(t2).not.toBe(t1);

    // список организаций аккаунта = 2
    const orgs = (await http.get('/api/auth/organizations').set(H(created.accessToken)).expect(200)).body.data;
    expect(orgs.length).toBe(2);

    // переключение обратно на первую
    const sw = (await http.post('/api/auth/switch-org').set(H(created.accessToken)).send({ tenantId: t1 }).expect(201)).body.data;
    expect(sw.user.tenantId).toBe(t1);
    // токен новой активной организации работает
    const me = (await http.get('/api/me').set(H(sw.accessToken)).expect(200)).body.data;
    expect(me.tenantId).toBe(t1);
  });

  it('приглашение уже-зарегистрированного человека в свою организацию', async () => {
    // B сам зарегистрировал свою организацию
    const bEmail = `b_${uniq()}@t.test`;
    const b = (await http.post('/api/auth/register').send({ tenantName: 'Орг B-own', email: bEmail, password: 'bpass1234', fullName: 'Борис' }).expect(201)).body.data;
    const bOwnTenant = b.organizations[0].tenantId;

    // A приглашает B по e-mail в свою организацию
    const a = (await http.post('/api/auth/register').send({ tenantName: 'Орг A2', email: `a_${uniq()}@t.test`, password: 'password123', fullName: 'Анна' }).expect(201)).body.data;
    const aTenant = a.organizations[0].tenantId;
    const inv = (await http.post('/api/invites').set(H(a.accessToken)).send({ email: bEmail, role: 'member' }).expect(201)).body.data;
    await http.post('/api/invites/accept').send({ token: inv.token, fullName: 'Борис', password: 'ignored123' }).expect(201);

    // B входит СВОИМ паролем и видит ОБЕ организации
    const login = (await http.post('/api/auth/login').send({ email: bEmail, password: 'bpass1234' }).expect(201)).body.data;
    const tenantIds = login.organizations.map((o: any) => String(o.tenantId));
    expect(tenantIds).toContain(String(bOwnTenant));
    expect(tenantIds).toContain(String(aTenant));

    // и может переключиться в организацию A (роль member)
    const sw = (await http.post('/api/auth/switch-org').set(H(login.accessToken)).send({ tenantId: aTenant }).expect(201)).body.data;
    expect(sw.user.role).toBe('member');
    expect(sw.user.tenantId).toBe(String(aTenant));
  });

  it('нельзя переключиться в чужую организацию', async () => {
    const a = (await http.post('/api/auth/register').send({ tenantName: 'A3', email: `a3_${uniq()}@t.test`, password: 'password123', fullName: 'A' }).expect(201)).body.data;
    const b = (await http.post('/api/auth/register').send({ tenantName: 'B3', email: `b3_${uniq()}@t.test`, password: 'password123', fullName: 'B' }).expect(201)).body.data;
    await http.post('/api/auth/switch-org').set(H(a.accessToken)).send({ tenantId: b.organizations[0].tenantId }).expect(403);
  });
});
