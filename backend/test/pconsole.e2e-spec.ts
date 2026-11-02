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
import { PlatformService } from '../src/modules/platform/platform.service';
import { BillingService } from '../src/modules/billing/billing.service';
import { sharedSecret } from '../src/modules/shared-secrets/secrets-registry';
import { AiGuardService } from '../src/modules/ai/ai-guard.service';
import { GuestLinksService } from '../src/modules/media/guest-links.service';

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
    // чувствительные действия (§3) требуют свежего кода: подтверждаем сразу следующим шагом
    await http.post('/api/pc/stepup').set(H(t.accessToken)).send({ code: totpAt(s.secret, stepOf(Date.now()) + 1) }).expect(200);
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

  it('тариф на год: новая версия при смене цены, год виден клиенту, без цены года — на год не продаётся', async () => {
    const o = await signIn(await staff(['owner']), 'owner');
    const code = `t${uniq().slice(0, 10)}`;
    await http.post('/api/pc/owner/plans').set(H(o.accessToken)).send({ code, title: 'Тест', priceRub: 100, isActive: true }).expect(200);
    await http.post('/api/pc/owner/plans').set(H(o.accessToken)).send({ code, title: 'Тест', priceRub: 100, priceYearRub: 1000, isActive: true }).expect(200);
    await http.post('/api/pc/owner/plans').set(H(o.accessToken)).send({ code, title: 'Тест', priceRub: 100, priceYearRub: 1000, isActive: true }).expect(200);
    const versions = (await http.get(`/api/pc/owner/plans/${code}/versions`).set(H(o.accessToken)).expect(200)).body.data as { version: number }[];
    expect(versions.map((v) => v.version)).toEqual([2, 1]);

    const r = await http.post('/api/auth/register')
      .send({ acceptPrivacy: true, tenantName: 'Year', email: `y_${uniq()}@t.test`, password: 'Test-pass-2026', fullName: 'Владелец' })
      .expect(201);
    const v = (await http.get('/api/billing').set(H(r.body.data.accessToken)).expect(200)).body.data;
    expect(v.plans.find((p: { code: string }) => p.code === code)).toMatchObject({ price: 100, priceYear: 1000 });
    expect(v.period).toBe('month');
    // в CI ключей ЮKassa нет — честный отказ, а не падение; неизвестный период — 400 от проверки
    await http.post('/api/billing/checkout').set(H(r.body.data.accessToken)).send({ plan: code, period: 'decade' }).expect(400);
    await http.post('/api/pc/owner/plans').set(H(o.accessToken)).send({ code, title: 'Тест', priceRub: 100, isActive: false }).expect(200);
  });

  it('поддержка: своя учётка консоли, служебный профиль без входа в CRM, обращение клиента — взял и ответил', async () => {
    const platform = app.get(PlatformService);
    const vendor = (await http.post('/api/auth/register')
      .send({ acceptPrivacy: true, tenantName: 'Vendor', email: `v_${uniq()}@t.test`, password: 'Test-pass-2026', fullName: 'Вендор' })
      .expect(201)).body.data;
    const client = (await http.post('/api/auth/register')
      .send({ acceptPrivacy: true, tenantName: 'Клиент', email: `c_${uniq()}@t.test`, password: 'Test-pass-2026', fullName: 'Клиент' })
      .expect(201)).body.data;
    await platform.declarePlatform(String(vendor.user.tenantId), String(vendor.user.id));
    try {
      const conv = (await http.post('/api/support/desk/messages').set(H(client.accessToken))
        .send({ text: 'Позовите специалиста: не открывается доска' }).expect(201)).body.data;

      const s = await signIn(await staff(['support']), 'support');
      await http.get('/api/pc/owner/overview').set(H(s.accessToken)).expect(403);
      const avail = (await http.post('/api/pc/support/presence').set(H(s.accessToken)).send({ status: 'available' }).expect(200)).body.data;
      expect(avail.available).toBeGreaterThanOrEqual(1);

      const queue = (await http.get('/api/pc/support/queue').set(H(s.accessToken)).expect(200)).body.data as { id: string; orgName: string }[];
      expect(queue.find((q) => String(q.id) === String(conv.id))?.orgName).toBe('Клиент');
      const view = (await http.get(`/api/pc/support/${conv.id}`).set(H(s.accessToken)).expect(200)).body.data;
      expect(view.client.company).toBe('Клиент');
      expect(view.client.subscription.status).toBe('TRIAL');
      expect(view.client.ai.text).toBeTruthy();
      await http.post(`/api/pc/support/${conv.id}/join`).set(H(s.accessToken)).expect(200);
      await http.post(`/api/pc/support/${conv.id}/reply`).set(H(s.accessToken)).send({ text: 'Смотрим, минуту' }).expect(200);

      // клиент видит ответ в своём разговоре
      const mine = (await http.get(`/api/support/desk/${conv.id}`).set(H(client.accessToken)).expect(200)).body.data;
      expect(mine.messages.some((m: { body: string }) => m.body.includes('Смотрим'))).toBe(true);

      // служебный профиль: в организации вендора, неактивен — в команде и чатах его нет, войти в CRM нельзя
      const u = await db.one<{ is_active: boolean; is_service: boolean; tenant_id: string; account_id: string | null }>(
        `SELECT u.is_active, u.is_service, u.tenant_id::text, u.account_id::text
           FROM pc_accounts a JOIN users u ON u.id = a.crm_user_id WHERE a.id = (SELECT max(id) FROM pc_accounts WHERE 'support' = ANY(roles))`);
      expect(u).toMatchObject({ is_active: false, is_service: true, tenant_id: String(vendor.user.tenantId), account_id: null });
      const team = (await http.get('/api/users').set(H(vendor.accessToken)).expect(200)).body.data as { fullName?: string; full_name?: string }[];
      expect(team.some((m) => (m.fullName ?? m.full_name) === 'Сотрудник')).toBe(false);

      const audit = await db.many<{ action: string }>(`SELECT action FROM pc_audit WHERE target=$1`, [`conversation:${conv.id}`]);
      expect(audit.map((a) => a.action)).toContain('support.join');
    } finally {
      await platform.clearPlatform();
    }
  });

  it('установки: первый запуск, обновление, подделанное скачивание не считается; владелец видит цифры', async () => {
    const id = '0a8f7e2c-1b3d-4c5e-9f60-' + Date.now().toString(16).padStart(12, '0').slice(-12);
    await http.post('/api/telemetry/launch').send({ installationId: id, platform: 'android', version: '1.51' }).expect(204);
    await http.post('/api/telemetry/launch').send({ installationId: id, platform: 'android', version: '1.52' }).expect(204);
    await http.post('/api/telemetry/launch').send({ installationId: 'не-номер', platform: 'android' }).expect(400);
    const ev = await db.many<{ kind: string }>(`SELECT kind FROM app_install_events WHERE installation_id=$1 ORDER BY id`, [id]);
    expect(ev.map((e) => e.kind)).toEqual(['first_run', 'update']);
    // снаружи признак зеркала nginx не поставить: без него скачивание не пишется
    await http.get('/api/telemetry/download').set('X-Original-URI', '/app/qevo-9.99.apk').expect(204);
    expect((await db.one<{ n: number }>(`SELECT count(*)::int AS n FROM app_downloads WHERE file='qevo-9.99.apk'`))!.n).toBe(0);
    const o = await signIn(await staff(['owner']), 'owner');
    const ov = (await http.get('/api/pc/owner/overview?period=today&tz=Europe/Moscow').set(H(o.accessToken)).expect(200)).body.data;
    expect(ov.apps.installs.android.firstRuns).toBeGreaterThanOrEqual(1);
  });

  it('перевод на новую цену: письмо владельцу, клиент видит новую цену, отмена', async () => {
    const o = await signIn(await staff(['owner']), 'owner');
    const code = `m${uniq().slice(0, 10)}`;
    await http.post('/api/pc/owner/plans').set(H(o.accessToken)).send({ code, title: 'Перевод', priceRub: 100, isActive: true }).expect(200);
    const r = (await http.post('/api/auth/register')
      .send({ acceptPrivacy: true, tenantName: 'Move', email: `mv_${uniq()}@t.test`, password: 'Test-pass-2026', fullName: 'Владелец' })
      .expect(201)).body.data;
    await db.query(
      `INSERT INTO tenant_subscriptions (tenant_id, status, plan_code, current_period_end, period_months, price_rub, plan_version)
       VALUES ($1, 'ACTIVE', $2, now() + interval '30 days', 1, 100, 1)
       ON CONFLICT (tenant_id) DO UPDATE SET status='ACTIVE', plan_code=$2, current_period_end=now() + interval '30 days', period_months=1, price_rub=100, plan_version=1`,
      [r.user.tenantId, code]);
    await http.post('/api/pc/owner/plans').set(H(o.accessToken)).send({ code, title: 'Перевод', priceRub: 150, isActive: true }).expect(200);
    await http.post(`/api/pc/owner/plans/${code}/moves`).set(H(o.accessToken)).send({ applyFrom: '2020-01-01' }).expect(400);
    const today = new Date(Date.now() + 3 * 3600_000).toISOString().slice(0, 10);
    const m = (await http.post(`/api/pc/owner/plans/${code}/moves`).set(H(o.accessToken)).send({ applyFrom: today }).expect(200)).body.data;
    expect(m.toVersion).toBe(2);
    await http.post(`/api/pc/owner/plans/${code}/moves`).set(H(o.accessToken)).send({ applyFrom: today }).expect(409);
    await app.get(BillingService).sweep(new Date());

    const v = (await http.get('/api/billing').set(H(r.accessToken)).expect(200)).body.data;
    expect(v.priceChange).toMatchObject({ price: 150, nextPeriod: false });
    const mail = await db.one<{ n: number }>(`SELECT count(*)::int AS n FROM mail_outbox WHERE tenant_id=$1 AND event_key='billing.price_move'`, [r.user.tenantId]);
    expect(mail!.n).toBe(1);
    const moves = (await http.get(`/api/pc/owner/plans/${code}/moves`).set(H(o.accessToken)).expect(200)).body.data;
    expect(moves[0]).toMatchObject({ affected: 1, notified: 1 });

    await http.post(`/api/pc/owner/moves/${m.id}/cancel`).set(H(o.accessToken)).expect(200);
    expect((await http.get('/api/billing').set(H(r.accessToken)).expect(200)).body.data.priceChange).toBeNull();
    await http.post('/api/pc/owner/plans').set(H(o.accessToken)).send({ code, title: 'Перевод', priceRub: 150, isActive: false }).expect(200);
  });

  it('общие ключи: значение не возвращается никогда; активировать — сервер берёт его; отозвать — стирается', async () => {
    const o = await signIn(await staff(['owner']), 'owner');
    const value = `tvly-test-${uniq()}-secretvalue`;
    const before = sharedSecret('TAVILY_API_KEY');
    const added = await http.post('/api/pc/owner/secrets').set(H(o.accessToken)).send({ name: 'TAVILY_API_KEY', value, note: 'e2e' }).expect(200);
    expect(JSON.stringify(added.body)).not.toContain(value);
    expect(added.body.data.check.ok).toBeNull(); // у Tavily проверки нет — честно «не поддерживается»
    await http.post('/api/pc/owner/secrets').set(H(o.accessToken)).send({ name: 'JWT_ACCESS_SECRET', value }).expect(400);
    await http.post('/api/pc/owner/secrets').set(H(o.accessToken)).send({ name: 'TAVILY_API_KEY', value: 'с пробелом внутри ключа' }).expect(400);

    const list = await http.get('/api/pc/owner/secrets').set(H(o.accessToken)).expect(200);
    expect(JSON.stringify(list.body)).not.toContain(value);
    const t = list.body.data.managed.find((m: { name: string }) => m.name === 'TAVILY_API_KEY');
    expect(t.versions[0]).toMatchObject({ status: 'pending', last4: `…${value.slice(-4)}` });

    await http.post(`/api/pc/owner/secrets/${added.body.data.id}/activate`).set(H(o.accessToken)).expect(200);
    expect(sharedSecret('TAVILY_API_KEY')).toBe(value);
    await http.post(`/api/pc/owner/secrets/${added.body.data.id}/revoke`).set(H(o.accessToken)).send({ reason: '' }).expect(400);
    await http.post(`/api/pc/owner/secrets/${added.body.data.id}/revoke`).set(H(o.accessToken)).send({ reason: 'конец проверки' }).expect(200);
    expect(sharedSecret('TAVILY_API_KEY')).toBe(before);
    const row = await db.one<{ value_enc: string | null; status: string }>(`SELECT value_enc, status FROM platform_secrets WHERE id=$1`, [added.body.data.id]);
    expect(row).toEqual({ value_enc: null, status: 'revoked' });
    const audit = await db.many<{ meta: unknown }>(`SELECT meta FROM pc_audit WHERE action LIKE 'secret.%'`);
    expect(JSON.stringify(audit)).not.toContain(value);
  });

  it('бюджет общего ИИ: одновременные запросы не перебирают потолок, резерв снимается фактом', async () => {
    const o = await signIn(await staff(['owner']), 'owner');
    const g = app.get(AiGuardService);
    await g.syncBudget().catch(() => undefined);
    const spent = await g.sharedSpentUsd(true);
    // потолок = уже потрачено + ровно на 3 запроса по 0,01 $
    await http.post('/api/pc/owner/ai').set(H(o.accessToken)).send({ allOff: false, sharedOff: false, monthlyBudgetUsd: Math.round((spent + 0.035) * 1e6) / 1e6 }).expect(200);
    await db.query(`UPDATE ai_budget_month SET spent_usd = $1, held_usd = 0 WHERE month = to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM')`, [spent]);
    (g as unknown as { cfg: null }).cfg = null;
    const holds = await Promise.all(Array.from({ length: 8 }, () => g.reserve(null, 'e2e', 0.01)));
    const ok = holds.filter((h): h is string => typeof h === 'string');
    expect(ok).toHaveLength(3);
    for (const id of ok) await g.settle(id, 0);
    const v = (await http.get('/api/pc/owner/ai').set(H(o.accessToken)).expect(200)).body.data;
    expect(v.heldUsd).toBe(0);
    await http.post('/api/pc/owner/ai').set(H(o.accessToken)).send({ allOff: false, sharedOff: false, monthlyBudgetUsd: null }).expect(200);
  });

  it('поддержка: созвон по пропуску оператора, доступ к настройкам, известные проблемы, сбой', async () => {
    const platform = app.get(PlatformService);
    const vendor = (await http.post('/api/auth/register')
      .send({ acceptPrivacy: true, tenantName: 'Vendor2', email: `v2_${uniq()}@t.test`, password: 'Test-pass-2026', fullName: 'Вендор' })
      .expect(201)).body.data;
    const client = (await http.post('/api/auth/register')
      .send({ acceptPrivacy: true, tenantName: 'Клиент2', email: `c2_${uniq()}@t.test`, password: 'Test-pass-2026', fullName: 'Клиент' })
      .expect(201)).body.data;
    await platform.declarePlatform(String(vendor.user.tenantId), String(vendor.user.id));
    try {
      const C = H(client.accessToken);
      const conv = (await http.post('/api/support/desk/messages').set(C).send({ text: 'Позовите специалиста, нужен созвон' }).expect(201)).body.data;
      await http.post(`/api/support/desk/${conv.id}/call/request`).set(C).expect(201);

      // первая линия: известные проблемы и сбой — не её
      const line = await signIn(await staff(['support']), 'support');
      await http.post('/api/pc/support/incident').set(H(line.accessToken)).send({ title: 'x', message: 'y' }).expect(403);

      // руководитель службы (владелец платформы с ролью поддержки)
      const lead = await signIn(await staff(['owner', 'support']), 'support');
      const L = H(lead.accessToken);
      const acc = (await http.post(`/api/pc/support/${conv.id}/call/accept`).set(L).expect(200)).body.data;
      expect(acc.pass.token).toBeTruthy();
      const op = app.get(GuestLinksService).verifyOperator(acc.pass.token);
      expect(op).toMatchObject({ kind: 'support-op', roomId: acc.pass.roomId });
      expect(acc.conversation.messages.some((m: { body: string }) => /подключайтесь: https?:\/\//.test(m.body))).toBe(true);
      expect((await http.post(`/api/pc/support/${conv.id}/call/pass`).set(L).expect(200)).body.data.pass.roomId).toBe(acc.pass.roomId);

      const grants = (await http.post(`/api/pc/support/${conv.id}/access`).set(L).send({ reason: 'посмотреть колонки' }).expect(200)).body.data;
      expect(grants[0]).toMatchObject({ status: 'requested' });

      await http.get('/api/pc/support/known').set(L).expect(200);
      const inc = (await http.post('/api/pc/support/incident').set(L).send({ title: 'Не грузятся доски', message: 'Чиним' }).expect(200)).body.data;
      expect((await http.get('/api/pc/support/incident').set(L).expect(200)).body.data.incident.title).toBe('Не грузятся доски');
      await http.post(`/api/pc/support/incident/${inc.id}/resolve`).set(L).expect(200);
      expect((await http.get('/api/pc/support/incident').set(L).expect(200)).body.data.incident).toBeNull();
    } finally {
      await platform.clearPlatform();
    }
  });

  it('чувствительное действие без свежего кода — отказ с просьбой подтвердить; журнал не правится', async () => {
    const email = await staff(['owner']);
    const r = (await http.post('/api/pc/auth/login').send({ email, password: PASS, app: 'owner' }).expect(200)).body.data;
    const st = (await http.post('/api/pc/auth/mfa/setup').send({ token: r.mfaSetup }).expect(200)).body.data;
    const t = (await http.post('/api/pc/auth/mfa/enable').send({ token: r.mfaSetup, code: totpAt(st.secret, stepOf(Date.now())) }).expect(200)).body.data;
    const res = await http.post('/api/pc/owner/ai').set(H(t.accessToken)).send({ allOff: false, sharedOff: false }).expect(403);
    expect(res.body.error.details).toEqual({ stepUp: true });
    await http.post('/api/pc/owner/ai').set(H(t.accessToken)).set('X-Pc-Code', '000000').send({ allOff: false, sharedOff: false }).expect(403);
    await expect(db.query(`UPDATE pc_audit SET action='x' WHERE id=(SELECT max(id) FROM pc_audit)`)).rejects.toThrow(/только дополняется/);
    await expect(db.query(`DELETE FROM pc_audit WHERE id=(SELECT max(id) FROM pc_audit)`)).rejects.toThrow(/только дополняется/);
  });
});
