import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AddressInfo } from 'net';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { AllExceptionsFilter } from '../src/common/http/all-exceptions.filter';
import { ResponseInterceptor } from '../src/common/http/response.interceptor';
import { DbService } from '../src/database/db.service';
import { BillingService } from '../src/modules/billing/billing.service';

/** Оплата (мастер-план релиза, этап 4): пробный период, «только чтение», места, уведомления. */
describe('Оплата подписки (e2e)', () => {
  let app: INestApplication;
  let http: any;
  let db: DbService;
  const uniq = () => Math.random().toString(36).slice(2) + Date.now().toString(36);
  const H = (t: string) => ({ Authorization: `Bearer ${t}` });

  async function register() {
    const r = await http.post('/api/auth/register')
      .send({ acceptPrivacy: true, tenantName: 'Bill', email: `bill_${uniq()}@t.test`, password: 'Test-pass-2026', fullName: 'Владелец' })
      .expect(201);
    return { token: r.body.data.accessToken as string, tenantId: String(r.body.data.user.tenantId) };
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

  it('новая компания — пробный период, тарифы видны, оплата без ключей честно отказывает', async () => {
    const o = await register();
    const v = (await http.get('/api/billing').set(H(o.token)).expect(200)).body.data;
    expect(v.status).toBe('TRIAL');
    expect(v.writable).toBe(true);
    expect(v.plans.length).toBeGreaterThan(0);
    expect(v.members).toBe(1);
    // в CI ключей ЮKassa нет
    const r = await http.post('/api/billing/checkout').set(H(o.token)).send({ plan: v.plans[0].code });
    if (!v.configured) expect(r.status).toBe(400);
  });

  it('пробный кончился и льгота прошла — «только чтение»: читать можно, писать нельзя, оплатить можно', async () => {
    const o = await register();
    await db.query(`INSERT INTO tenant_subscriptions (tenant_id, status, trial_ends_at) VALUES ($1,'TRIAL', now() - interval '5 days')
                    ON CONFLICT (tenant_id) DO UPDATE SET trial_ends_at = now() - interval '5 days'`, [o.tenantId]);
    // кэш состояния — сбрасываем, как после оплаты
    (app.get(BillingService) as any).cache.clear();
    expect((await http.get('/api/billing').set(H(o.token)).expect(200)).body.data.status).toBe('READ_ONLY');
    await http.get('/api/projects').set(H(o.token)).expect(200);
    const denied = await http.post('/api/projects').set(H(o.token)).send({ name: 'Нельзя' }).expect(403);
    expect(denied.body.error.details?.billing).toBe('read_only');
    // вход и поддержка не блокируются
    await http.post('/api/auth/email/resend').set(H(o.token)).expect(200);
  });

  it('напоминание владельцу о конце пробного — одно письмо, без повторов', async () => {
    const o = await register();
    await db.query(`UPDATE tenants SET created_at = now() - interval '12 days' WHERE id = $1`, [o.tenantId]);
    const svc = app.get(BillingService);
    await svc.sweep(new Date());
    await svc.sweep(new Date());
    const mails = await db.many(`SELECT event_key FROM mail_outbox WHERE tenant_id=$1 AND event_key LIKE 'billing.%'`, [o.tenantId]);
    expect(mails.map((m: any) => m.event_key)).toEqual(['billing.trial_3d']);
  });

  it('уведомление ЮKassa о неизвестном платеже и повтор — 200, без последствий', async () => {
    const body = { type: 'notification', event: 'payment.succeeded', object: { id: `test-${uniq()}` } };
    await http.post('/api/billing/yookassa/webhook').send(body).expect(200);
    await http.post('/api/billing/yookassa/webhook').send(body).expect(200);
    const n = await db.one<{ n: number }>(`SELECT count(*)::int AS n FROM billing_webhook_events WHERE provider_event_id=$1`, [`payment.succeeded:${body.object.id}`]);
    expect(n!.n).toBe(1);
  });

  it('оплаченный тариф ограничивает число сотрудников', async () => {
    const o = await register();
    await db.query(`INSERT INTO tenant_subscriptions (tenant_id, status, plan_code, current_period_end) VALUES ($1,'ACTIVE','start', now() + interval '20 days')
                    ON CONFLICT (tenant_id) DO UPDATE SET plan_code='start', current_period_end = now() + interval '20 days'`, [o.tenantId]);
    (app.get(BillingService) as any).cache.clear();
    const emails = Array.from({ length: 5 }, () => `seat_${uniq()}@t.test`);
    const r = await http.post('/api/invites/batch').set(H(o.token)).send({ emails, role: 'member' }).expect(400);
    expect(r.body.error.message).toMatch(/до 5 сотрудников/);
  });
});
