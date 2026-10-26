import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AddressInfo } from 'net';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { AllExceptionsFilter } from '../src/common/http/all-exceptions.filter';
import { ResponseInterceptor } from '../src/common/http/response.interceptor';
import { DbService } from '../src/database/db.service';
import { signWebAppInitData } from '../src/modules/auth/telegram-webapp-verify';
import { TelegramSender } from '../src/modules/telegram/telegram.sender';

/**
 * Вход в Telegram Mini App (#4619, этап 5): initData с подписью токена бота →
 * привязанный Telegram ID получает сессию, непривязанный — {linked:false},
 * подделка и просрочка — 401.
 */
describe('Telegram Mini App: вход по initData (e2e)', () => {
  const TOKEN = '424242:e2e-webapp-token';
  let app: INestApplication;
  let http$: any;
  let db: DbService;
  let prevToken: string | undefined;
  const fakeTg = {
    enabled: true,
    username: async () => 'qevo_test_bot',
    deliver: async () => 'ok' as const,
    sendMessage: async () => undefined,
    sendVoice: async () => true,
    fileUrl: async () => null,
  };
  const uniq = () => Math.random().toString(36).slice(2) + Date.now().toString(36);
  const tgId = () => String(5_000_000_000 + Math.floor(Math.random() * 1_000_000_000));
  const initData = (id: string, authDate = Math.floor(Date.now() / 1000), token = TOKEN) =>
    signWebAppInitData({
      auth_date: String(authDate),
      query_id: 'AAE' + uniq(),
      user: JSON.stringify({ id: Number(id), first_name: 'Дмитрий' }),
    }, token);

  beforeAll(async () => {
    prevToken = process.env.TELEGRAM_BOT_TOKEN;
    process.env.TELEGRAM_BOT_TOKEN = TOKEN;
    const mod = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(TelegramSender).useValue(fakeTg)
      .compile();
    app = mod.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    app.useGlobalFilters(new AllExceptionsFilter());
    app.useGlobalInterceptors(new ResponseInterceptor());
    await app.listen(0, '0.0.0.0');
    http$ = request(`http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`);
    db = app.get(DbService);
  });
  afterAll(async () => {
    await app?.close();
    if (prevToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
    else process.env.TELEGRAM_BOT_TOKEN = prevToken;
  });

  it('привязанный Telegram ID → сессия того человека, источник помечен', async () => {
    const owner = (await http$.post('/api/auth/register')
      .send({ acceptPrivacy: true, tenantName: 'Маркетинг', email: `twa_${uniq()}@t.test`, password: 'password123', fullName: 'Дмитрий Орлов' })
      .expect(201)).body.data;
    const id = tgId();
    await db.query(`INSERT INTO telegram_accounts (tenant_id, user_id, telegram_user_id) VALUES ($1, $2, $3)`,
      [owner.user.tenantId, owner.user.id, id]);

    const res = (await http$.post('/api/auth/telegram-webapp').send({ initData: initData(id) }).expect(200)).body.data;
    expect(res.linked).toBe(true);
    expect(res.accessToken).toBeTruthy();
    expect(res.refreshToken).toBeTruthy();
    expect(String(res.user.id)).toBe(String(owner.user.id));

    // токен рабочий
    await http$.get('/api/auth/organizations').set({ Authorization: `Bearer ${res.accessToken}` }).expect(200);
    const sess = await db.one<{ user_agent: string }>(
      `SELECT user_agent FROM refresh_tokens WHERE user_id = $1 ORDER BY id DESC LIMIT 1`, [owner.user.id]);
    expect(sess!.user_agent).toMatch(/^telegram-webapp/);
  });

  it('непривязанный Telegram ID → linked:false без токенов', async () => {
    const res = (await http$.post('/api/auth/telegram-webapp').send({ initData: initData(tgId()) }).expect(200)).body.data;
    expect(res).toEqual({ linked: false });
  });

  it('подделка: чужой токен или подмена поля → 401', async () => {
    await http$.post('/api/auth/telegram-webapp').send({ initData: initData(tgId(), undefined, '1:wrong') }).expect(401);
    const p = new URLSearchParams(initData(tgId()));
    p.set('user', JSON.stringify({ id: 1, first_name: 'X' }));
    await http$.post('/api/auth/telegram-webapp').send({ initData: p.toString() }).expect(401);
    const noHash = new URLSearchParams(initData(tgId()));
    noHash.delete('hash');
    await http$.post('/api/auth/telegram-webapp').send({ initData: noHash.toString() }).expect(401);
  });

  it('просрочка: auth_date старше часа → 401', async () => {
    const old = Math.floor(Date.now() / 1000) - 2 * 3600;
    await http$.post('/api/auth/telegram-webapp').send({ initData: initData(tgId(), old) }).expect(401);
  });
});
