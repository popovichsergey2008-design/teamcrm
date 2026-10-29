import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AddressInfo } from 'net';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { AllExceptionsFilter } from '../src/common/http/all-exceptions.filter';
import { ResponseInterceptor } from '../src/common/http/response.interceptor';
import { DbService } from '../src/database/db.service';
import { stepOf, totpAt } from '../src/common/auth/totp';

/**
 * Мастер-план релиза, этап 3: подтверждение почты, «Забыли пароль?», пароль по правилам,
 * двухфакторный вход и журнал входов. Пределы попыток проверяет юнит-тест
 * (auth-throttle.service.spec.ts): в e2e они выключены — тесты регистрируют сотни людей.
 */
describe('Защита входа (e2e)', () => {
  let app: INestApplication;
  let http: any;
  let db: DbService;
  const uniq = () => Math.random().toString(36).slice(2) + Date.now().toString(36);
  const H = (t: string) => ({ Authorization: `Bearer ${t}` });
  const PASS = 'Test-pass-2026';

  async function register(email = `sec_${uniq()}@t.test`) {
    const r = await http.post('/api/auth/register')
      .send({ acceptPrivacy: true, tenantName: 'Sec', email, password: PASS, fullName: 'Тест Защиты' })
      .expect(201);
    return { email, token: r.body.data.accessToken as string, refresh: r.body.data.refreshToken as string, user: r.body.data.user };
  }

  /** Ссылку из письма читаем прямо из очереди почты: токен в базе лежит только хешем. */
  async function tokenFromMail(email: string, eventKey: string, param: string): Promise<string> {
    const row = await db.one<{ body_text: string }>(
      `SELECT body_text FROM mail_outbox WHERE to_email=$1 AND event_key=$2 ORDER BY id DESC LIMIT 1`, [email, eventKey]);
    const m = row?.body_text.match(new RegExp(`[?&]${param}=([a-f0-9]+)`));
    if (!m) throw new Error(`нет письма ${eventKey} для ${email}`);
    return m[1];
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
  afterAll(async () => {
    delete process.env.AUTH_REQUIRE_VERIFIED_EMAIL;
    await app?.close();
  });

  it('частый пароль и поле-ловушка отклоняются', async () => {
    const weak = await http.post('/api/auth/register')
      .send({ acceptPrivacy: true, tenantName: 'Sec', email: `w_${uniq()}@t.test`, password: 'password123', fullName: 'W' })
      .expect(400);
    expect(weak.body.error.message).toMatch(/распространён/);
    await http.post('/api/auth/register')
      .send({ acceptPrivacy: true, tenantName: 'Sec', email: `b_${uniq()}@t.test`, password: PASS, fullName: 'B', website: 'spam.example' })
      .expect(400);
  });

  it('новая почта не подтверждена; ссылка из письма подтверждает; повтор ссылки не проходит', async () => {
    const u = await register();
    expect((await http.get('/api/me').set(H(u.token)).expect(200)).body.data.emailVerified).toBe(false);

    const token = await tokenFromMail(u.email, 'auth.verify-email', 'verify');
    await http.post('/api/auth/email/verify').send({ token }).expect(200);
    expect((await http.get('/api/me').set(H(u.token)).expect(200)).body.data.emailVerified).toBe(true);
    await http.post('/api/auth/email/verify').send({ token }).expect(401);
    // уже подтверждена — повторное письмо не шлём
    expect((await http.post('/api/auth/email/resend').set(H(u.token)).expect(200)).body.data.verified).toBe(true);
  });

  it('без подтверждённой почты приглашать нельзя (когда правило включено)', async () => {
    process.env.AUTH_REQUIRE_VERIFIED_EMAIL = 'true';
    try {
      const u = await register();
      await http.post('/api/invites').set(H(u.token)).send({ email: `inv_${uniq()}@t.test`, role: 'member' }).expect(403);
      await http.post('/api/auth/email/verify').send({ token: await tokenFromMail(u.email, 'auth.verify-email', 'verify') }).expect(200);
      await http.post('/api/invites').set(H(u.token)).send({ email: `inv_${uniq()}@t.test`, role: 'member' }).expect(201);
    } finally {
      delete process.env.AUTH_REQUIRE_VERIFIED_EMAIL;
    }
  });

  it('«Забыли пароль?»: ответ одинаковый; по ссылке новый пароль, старые сессии гаснут', async () => {
    const u = await register();
    const unknown = await http.post('/api/auth/password/forgot').send({ email: `nobody_${uniq()}@t.test` }).expect(200);
    const known = await http.post('/api/auth/password/forgot').send({ email: u.email }).expect(200);
    expect(unknown.body.data).toEqual(known.body.data);

    const token = await tokenFromMail(u.email, 'auth.password-reset', 'reset');
    await http.post('/api/auth/password/reset').send({ token, password: '12345678' }).expect(400);
    await http.post('/api/auth/password/reset').send({ token, password: 'Новый-пароль-77' }).expect(201);
    await http.post('/api/auth/refresh').send({ refreshToken: u.refresh }).expect(401);
    await http.post('/api/auth/login').send({ email: u.email, password: PASS }).expect(401);
    await http.post('/api/auth/login').send({ email: u.email, password: 'Новый-пароль-77' }).expect(201);
    await http.post('/api/auth/password/reset').send({ token, password: 'Ещё-один-пароль-1' }).expect(401);
  });

  it('двухфакторный вход: настройка, вход кодом и резервным кодом, выключение', async () => {
    const u = await register();
    await http.post('/api/auth/mfa/setup').set(H(u.token)).send({ password: 'wrong-password' }).expect(400);
    const setup = (await http.post('/api/auth/mfa/setup').set(H(u.token)).send({ password: PASS }).expect(200)).body.data;
    expect(setup.otpauthUri).toMatch(/^otpauth:\/\/totp\//);
    await http.post('/api/auth/mfa/enable').set(H(u.token)).send({ code: '000000' }).expect(400);
    const now = stepOf(Date.now());
    const enabled = (await http.post('/api/auth/mfa/enable').set(H(u.token)).send({ code: totpAt(setup.secret, now) }).expect(200)).body.data;
    expect(enabled.recoveryCodes).toHaveLength(10);
    expect((await http.get('/api/me').set(H(u.token)).expect(200)).body.data.mfaEnabled).toBe(true);

    // пароль верный — но сессии ещё нет, только просьба ввести код
    const first = (await http.post('/api/auth/login').send({ email: u.email, password: PASS }).expect(201)).body.data;
    expect(first.mfaRequired).toBe(true);
    expect(first.accessToken).toBeUndefined();
    // токен второго шага не годится как пропуск в API
    await http.get('/api/me').set(H(first.mfaToken)).expect(401);
    await http.post('/api/auth/login/mfa').send({ mfaToken: first.mfaToken, code: '123456' }).expect(401);
    // тот же код, что при включении, второй раз не проходит
    await http.post('/api/auth/login/mfa').send({ mfaToken: first.mfaToken, code: totpAt(setup.secret, now) }).expect(401);
    const done = (await http.post('/api/auth/login/mfa').send({ mfaToken: first.mfaToken, code: totpAt(setup.secret, now + 1) }).expect(200)).body.data;
    expect(done.accessToken).toBeTruthy();
    // одним токеном второго шага — один вход
    await http.post('/api/auth/login/mfa').send({ mfaToken: first.mfaToken, code: enabled.recoveryCodes[1] }).expect(401);

    // резервный код срабатывает один раз
    const second = (await http.post('/api/auth/login').send({ email: u.email, password: PASS }).expect(201)).body.data;
    await http.post('/api/auth/login/mfa').send({ mfaToken: second.mfaToken, code: enabled.recoveryCodes[0].toUpperCase() }).expect(200);
    const third = (await http.post('/api/auth/login').send({ email: u.email, password: PASS }).expect(201)).body.data;
    await http.post('/api/auth/login/mfa').send({ mfaToken: third.mfaToken, code: enabled.recoveryCodes[0] }).expect(401);
    expect((await http.get('/api/auth/mfa').set(H(done.accessToken)).expect(200)).body.data.recoveryLeft).toBe(9);

    await http.post('/api/auth/mfa/disable').set(H(done.accessToken)).send({ password: PASS, code: '111111' }).expect(400);
    await http.post('/api/auth/mfa/disable').set(H(done.accessToken)).send({ password: PASS, code: enabled.recoveryCodes[2] }).expect(200);
    const plain = (await http.post('/api/auth/login').send({ email: u.email, password: PASS }).expect(201)).body.data;
    expect(plain.accessToken).toBeTruthy();

    // всё это видно владельцу в журнале безопасности
    const events = (await db.many<{ event_type: string }>(
      `SELECT event_type FROM security_audit WHERE tenant_id=$1 ORDER BY id`, [u.user.tenantId])).map((e) => e.event_type);
    expect(events).toEqual(expect.arrayContaining([
      'auth.registered', 'auth.mfa_enabled', 'auth.mfa_failed', 'auth.mfa_recovery_used', 'auth.mfa_disabled', 'auth.login',
    ]));
  });

  it('обязательный второй фактор: без него токен пускает только к настройке', async () => {
    const u = await register();
    await http.post('/api/security/policy').set(H(u.token)).send({ twoFactor: 'required_for_admins' }).expect(201);
    const s = (await http.post('/api/auth/login').send({ email: u.email, password: PASS }).expect(201)).body.data;
    const locked = await http.get('/api/projects').set(H(s.accessToken)).expect(403);
    expect(locked.body.error.details?.mfaSetupRequired).toBe(true);
    expect((await http.get('/api/me').set(H(s.accessToken)).expect(200)).body.data.mfaSetupRequired).toBe(true);

    const setup = (await http.post('/api/auth/mfa/setup').set(H(s.accessToken)).send({ password: PASS }).expect(200)).body.data;
    await http.post('/api/auth/mfa/enable').set(H(s.accessToken)).send({ code: totpAt(setup.secret, stepOf(Date.now())) }).expect(200);
    // новый токен — уже без ограничения
    const fresh = (await http.post('/api/auth/refresh').send({ refreshToken: s.refreshToken }).expect(201)).body.data;
    await http.get('/api/projects').set(H(fresh.accessToken)).expect(200);
    expect((await http.get('/api/me').set(H(fresh.accessToken)).expect(200)).body.data.mfaSetupRequired).toBe(false);
  });

  it('неудачный вход пишется в журнал, ответ не выдаёт, есть ли аккаунт', async () => {
    const u = await register();
    const bad = await http.post('/api/auth/login').send({ email: u.email, password: 'не-тот-пароль' }).expect(401);
    const none = await http.post('/api/auth/login').send({ email: `none_${uniq()}@t.test`, password: 'не-тот-пароль' }).expect(401);
    expect(bad.body.error.message).toBe(none.body.error.message);
    const row = await db.one(`SELECT 1 FROM security_audit WHERE tenant_id=$1 AND event_type='auth.login_failed'`, [u.user.tenantId]);
    expect(row).toBeTruthy();
  });
});
