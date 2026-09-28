import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AddressInfo } from 'net';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { AllExceptionsFilter } from '../src/common/http/all-exceptions.filter';
import { ResponseInterceptor } from '../src/common/http/response.interceptor';
import { RedisIoAdapter } from '../src/common/auth/redis-io.adapter';

/**
 * Вход через Google и Telegram (ТЗ-11, разд. 11-12).
 *
 * Ключей на этом сервере ещё нет, и главное обещание проверки именно такое: пока их нет,
 * ничего не меняется — кнопкам не за что зацепиться, а ручки не пускают. И ни при каких
 * входных данных подделанный вход не должен закончиться сессией.
 */
describe('вход через провайдеров (e2e)', () => {
  let app: INestApplication;
  let http: any;

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
  afterAll(async () => { await app?.close(); });

  const providers = async () => (await http.get('/api/auth/providers').expect(200)).body.data;

  it('список входов открыт без токена: по нему экран входа решает, что рисовать', async () => {
    const p = await providers();
    expect(typeof p.google).toBe('boolean');
    expect(typeof p.telegram).toBe('boolean');
    // Имя бота либо есть, либо кнопки Telegram не будет: виджет без него не собрать.
    if (p.telegram) expect(p.telegramBot).toBeTruthy();
    if (p.google) expect(p.googleClientId).toBeTruthy();
  });

  it('невыключённый вход не пускает по мусорным данным', async () => {
    const p = await providers();

    const g = await http.post('/api/auth/google').send({ idToken: 'ни на что не похожий токен' });
    expect([400, 401]).toContain(g.status);
    expect(g.body?.data?.accessToken).toBeUndefined();
    if (!p.google) expect(JSON.stringify(g.body)).toMatch(/не настроен/);

    const t = await http.post('/api/auth/telegram').send({ data: { id: '1', hash: 'нетакой', auth_date: '1' } });
    expect([400, 401]).toContain(t.status);
    expect(t.body?.data?.accessToken).toBeUndefined();
    if (!p.telegram) expect(JSON.stringify(t.body)).toMatch(/не настроен/);
  });

  it('привязка входа к аккаунту — только своему: без токена не отвечает', async () => {
    await http.post('/api/auth/google/link').send({ idToken: 'что угодно' }).expect(401);
    await http.post('/api/auth/telegram/link').send({ data: { id: '1' } }).expect(401);
  });

  it('обычный вход по паролю не задет: он и остаётся основным', async () => {
    const email = `social_${Math.random().toString(36).slice(2)}@t.test`;
    const reg = await http.post('/api/auth/register')
      .send({ tenantName: 'Проверка входов', email, password: 'password123', fullName: 'Ольга Владелец' })
      .expect(201);
    expect(reg.body.data.accessToken).toBeTruthy();
    const login = await http.post('/api/auth/login').send({ email, password: 'password123' }).expect(201);
    expect(login.body.data.accessToken).toBeTruthy();
  });
});
