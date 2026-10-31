import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AddressInfo } from 'net';
import request from 'supertest';
import * as argon2 from 'argon2';

import { AppModule } from '../src/app.module';
import { AllExceptionsFilter } from '../src/common/http/all-exceptions.filter';
import { ResponseInterceptor } from '../src/common/http/response.interceptor';
import { DbService } from '../src/database/db.service';
import { stepOf, totpAt } from '../src/common/auth/totp';

/**
 * Консоли платформы: отдельные учётные записи, обязательный второй фактор, роль = одна
 * консоль, токен CRM консоль не открывает, отзыв роли закрывает сессию сразу.
 */
describe('Консоли платформы (e2e)', () => {
  let app: INestApplication;
  let http: any;
  let db: DbService;
  const uniq = () => Math.random().toString(36).slice(2) + Date.now().toString(36);
  const H = (t: string) => ({ Authorization: `Bearer ${t}` });
  const PASS = 'Console-pass-2026';

  async function staff(roles: string[]) {
    const email = `pc_${uniq()}@t.test`;
    await db.query(`INSERT INTO pc_accounts (email, full_name, password_hash, status, roles) VALUES ($1, 'Сотрудник', $2, 'active', $3::text[])`,
      [email, await argon2.hash(PASS), roles]);
    return email;
  }

  /** Вход с первой настройкой кода: пароль → секрет → код → сессия. */
  async function signIn(email: string, app: string) {
    const r = (await http.post('/api/pc/auth/login').send({ email, password: PASS, app }).expect(200)).body.data;
    expect(r.mfaSetup).toBeTruthy();
    const s = (await http.post('/api/pc/auth/mfa/setup').send({ token: r.mfaSetup }).expect(200)).body.data;
    const code = totpAt(s.secret, stepOf(Date.now()));
    const t = (await http.post('/api/pc/auth/mfa/enable').send({ token: r.mfaSetup, code }).expect(200)).body.data;
    return { ...t, secret: s.secret } as { accessToken: string; refreshToken: string; secret: string };
  }

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    app.useGlobalFilters(new AllExceptionsFilter());
    app.useGlobalInterceptors(new ResponseInterceptor());
    await app.listen(0, '0.0.0.0');
    http = request(`http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`);
    db = app.get(DbService);
  });
  afterAll(async () => app?.close());

  it('заявка ждёт одобрения и не входит; повторная заявка на ту же почту не выдаёт, что она занята', async () => {
    const email = `pc_${uniq()}@t.test`;
    const a = await http.post('/api/pc/auth/register').send({ email, name: 'Разработчик', password: PASS, role: 'developer' }).expect(200);
    expect(a.body.data.status).toBe('pending');
    const b = await http.post('/api/pc/auth/register').send({ email, name: 'Другой', password: PASS, role: 'owner' }).expect(200);
    expect(b.body.data.status).toBe('pending');
    await http.post('/api/pc/auth/login').send({ email, password: PASS, app: 'developer' }).expect(403);
  });

  it('токен CRM консоль не открывает, без токена — 401', async () => {
    const r = await http.post('/api/auth/register')
      .send({ acceptPrivacy: true, tenantName: 'PC', email: `crm_${uniq()}@t.test`, password: 'Test-pass-2026', fullName: 'Владелец' })
      .expect(201);
    await http.get('/api/pc/me').expect(401);
    await http.get('/api/pc/me').set(H(r.body.data.accessToken)).expect(401);
    await http.get('/api/pc/owner/overview').set(H(r.body.data.accessToken)).expect(401);
  });

  it('второй фактор обязателен, роль открывает только свою консоль, токен консоли не открывает CRM', async () => {
    const email = await staff(['developer']);
    await http.post('/api/pc/auth/login').send({ email, password: PASS, app: 'owner' }).expect(403);
    const t = await signIn(email, 'developer');
    const me = (await http.get('/api/pc/me').set(H(t.accessToken)).expect(200)).body.data;
    expect(me.perms).toEqual(['dev.view', 'dev.triage']);
    await http.get('/api/pc/dev/status').set(H(t.accessToken)).expect(200);
    await http.get('/api/pc/owner/overview').set(H(t.accessToken)).expect(403);
    await http.get('/api/me').set(H(t.accessToken)).expect(401);
    // повторный вход — уже с кодом
    const again = (await http.post('/api/pc/auth/login').send({ email, password: PASS, app: 'developer' }).expect(200)).body.data;
    expect(again.needCode).toBe(true);
  });

  it('владелец видит статистику и одобряет; блокировка закрывает сессию сразу', async () => {
    const ownerEmail = await staff(['owner']);
    const o = await signIn(ownerEmail, 'owner');
    const ov = (await http.get('/api/pc/owner/overview?period=7d&tz=Europe/Moscow').set(H(o.accessToken)).expect(200)).body.data;
    expect(ov.period.days).toBe(7);
    expect(ov.metrics.usersNew).toHaveProperty('value');
    await http.get('/api/pc/owner/overview?period=custom&from=2026-10-10&to=2026-10-01').set(H(o.accessToken)).expect(400);

    const devEmail = await staff(['developer']);
    const d = await signIn(devEmail, 'developer');
    const list = (await http.get('/api/pc/owner/staff').set(H(o.accessToken)).expect(200)).body.data as { id: string; email: string }[];
    const dev = list.find((s) => s.email === devEmail)!;
    await http.post(`/api/pc/owner/staff/${dev.id}`).set(H(o.accessToken)).send({ status: 'blocked', roles: ['developer'] }).expect(200);
    await http.get('/api/pc/dev/status').set(H(d.accessToken)).expect(401);
    await http.post('/api/pc/auth/refresh').send({ refreshToken: d.refreshToken, app: 'developer' }).expect(401);

    const audit = (await http.get('/api/pc/owner/audit').set(H(o.accessToken)).expect(200)).body.data as { action: string }[];
    expect(audit.some((a) => a.action === 'staff.update')).toBe(true);
  });

  it('ошибки сайта: принимаются без входа, очищаются, группируются, разбираются разработчиком', async () => {
    const tag = uniq();
    const body = { source: 'web', kind: 'TypeError', message: `boom ${tag} у boris@mail.ru в задаче 4705`, stack: ['TypeError', '    at f (https://app.qevo.one/assets/A-1234abcd.js:1:2)'].join(String.fromCharCode(10)), route: '/projects/7?x=1', version: 'v1', clientId: 'c1' };
    await http.post('/api/telemetry/error').send(body).expect(204);
    await http.post('/api/telemetry/error').send({ ...body, message: `boom ${tag} у boris@mail.ru в задаче 4706`, clientId: 'c2' }).expect(204);
    const t = await signIn(await staff(['developer']), 'developer');
    let list: { id: string; message: string; hits: string; route: string }[] = [];
    for (let i = 0; i < 20 && !list.length; i++) {
      list = (await http.get(`/api/pc/dev/errors?q=${tag}`).set(H(t.accessToken)).expect(200)).body.data;
      if (!list.length) await new Promise((r) => setTimeout(r, 100));
    }
    expect(list).toHaveLength(1);
    expect(list[0].message).not.toContain('boris@');
    expect(list[0].route).toBe('/projects/:id');
    await http.post(`/api/pc/dev/errors/${list[0].id}`).set(H(t.accessToken)).send({ status: 'fixed', version: 'v2' }).expect(200);
    const one = (await http.get(`/api/pc/dev/errors/${list[0].id}`).set(H(t.accessToken)).expect(200)).body.data;
    expect(one.status).toBe('fixed');
  });

  it('выключатель ИИ: без причины нельзя, с причиной — в журнал', async () => {
    const o = await signIn(await staff(['owner']), 'owner');
    await http.post('/api/pc/owner/ai').set(H(o.accessToken)).send({ allOff: false, sharedOff: true }).expect(400);
    const r = (await http.post('/api/pc/owner/ai').set(H(o.accessToken)).send({ allOff: false, sharedOff: true, sharedReason: 'проверка', monthlyBudgetUsd: 10 }).expect(200)).body.data;
    expect(r).toMatchObject({ sharedOff: true, monthlyBudgetUsd: 10 });
    const v = (await http.get('/api/pc/owner/ai').set(H(o.accessToken)).expect(200)).body.data;
    expect(v.decision.shared).toBe(false);
    await http.post('/api/pc/owner/ai').set(H(o.accessToken)).send({ allOff: false, sharedOff: false, monthlyBudgetUsd: null }).expect(200);
  });
});
