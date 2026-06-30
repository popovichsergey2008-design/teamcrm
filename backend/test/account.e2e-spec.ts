import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AddressInfo } from 'net';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { AllExceptionsFilter } from '../src/common/http/all-exceptions.filter';
import { ResponseInterceptor } from '../src/common/http/response.interceptor';
import { RedisIoAdapter } from '../src/common/auth/redis-io.adapter';

describe('Enhancements v1 — Account (e2e)', () => {
  let app: INestApplication;
  let http: any;
  const uniq = () => Math.random().toString(36).slice(2) + Date.now().toString(36);
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9, 9, 9]);

  async function register() {
    const r = await http
      .post('/api/auth/register')
      .send({ tenantName: 'Acc', email: `a_${uniq()}@t.test`, password: 'password123', fullName: 'User' })
      .expect(201);
    return { token: r.body.data.accessToken, refresh: r.body.data.refreshToken, email: r.body.data.user.email };
  }
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

  it('GET /me обогащён; пароль не утекает', async () => {
    const { token } = await register();
    const me = (await http.get('/api/me').set(H(token)).expect(200)).body.data;
    expect(me.role).toBe('owner');
    expect(me.timezone).toBe('Europe/Moscow');
    expect(me.weeklyCapacityHours).toBe(40);
    expect(me.password_hash).toBeUndefined();
    expect('password_hash' in me).toBe(false);
  });

  it('PATCH /me меняет профиль', async () => {
    const { token } = await register();
    await http.patch('/api/me').set(H(token)).send({ fullName: 'Иван Петров', phone: '+70000000000', timezone: 'Asia/Yekaterinburg' }).expect(200);
    const me = (await http.get('/api/me').set(H(token)).expect(200)).body.data;
    expect(me.fullName).toBe('Иван Петров');
    expect(me.phone).toBe('+70000000000');
    expect(me.timezone).toBe('Asia/Yekaterinburg');
  });

  it('смена пароля: неверный текущий → 400; верный → 200 и отзыв прочих сессий', async () => {
    const { token, email } = await register();
    // второй вход = вторая сессия
    const login2 = (await http.post('/api/auth/login').send({ email, password: 'password123' }).expect(201)).body.data;

    await http.post('/api/me/password').set(H(token)).send({ currentPassword: 'wrong', newPassword: 'newpass123' }).expect(400);
    await http.post('/api/me/password').set(H(token)).send({ currentPassword: 'password123', newPassword: 'newpass123' }).expect(201);

    // сессия-2 (её refresh) отозвана сменой пароля
    await http.post('/api/auth/refresh').send({ refreshToken: login2.refreshToken }).expect(401);
    // текущая сессия (token) ещё жива
    await http.get('/api/me').set(H(token)).expect(200);
    // новый пароль работает
    await http.post('/api/auth/login').send({ email, password: 'newpass123' }).expect(201);
  });

  it('аватар: загрузка → avatarUrl в профиле', async () => {
    const { token } = await register();
    const up = (await http.post('/api/me/avatar').set(H(token)).attach('file', png, { filename: 'a.png', contentType: 'image/png' }).expect(201)).body.data;
    expect(up.avatarFileId).toBeTruthy();
    const me = (await http.get('/api/me').set(H(token)).expect(200)).body.data;
    expect(me.avatarUrl).toBe(`/api/files/${up.avatarFileId}`);
    // файл реально отдаётся
    await http.get(me.avatarUrl).set(H(token)).expect(200);
  });

  it('уведомления: PUT сохраняет prefs', async () => {
    const { token } = await register();
    await http.put('/api/me/notifications').set(H(token)).send({ prefs: { taskAssigned: true, dailyDigest: false } }).expect(200);
    const me = (await http.get('/api/me').set(H(token)).expect(200)).body.data;
    expect(me.notifyPrefs.taskAssigned).toBe(true);
    expect(me.notifyPrefs.dailyDigest).toBe(false);
  });

  it('доступность: добавить → список → удалить', async () => {
    const { token } = await register();
    const av = (await http.post('/api/me/availability').set(H(token)).send({ kind: 'vacation', fromDate: '2026-08-01', toDate: '2026-08-10' }).expect(201)).body.data;
    let list = (await http.get('/api/me/availability').set(H(token)).expect(200)).body.data;
    expect(list.length).toBe(1);
    await http.delete(`/api/me/availability/${av.id}`).set(H(token)).expect(200);
    list = (await http.get('/api/me/availability').set(H(token)).expect(200)).body.data;
    expect(list.length).toBe(0);
  });

  it('сессии: список с текущей; отзыв; revoke-all оставляет текущую', async () => {
    const { token, email } = await register();
    await http.post('/api/auth/login').send({ email, password: 'password123' }).expect(201); // 2-я сессия
    await http.post('/api/auth/login').send({ email, password: 'password123' }).expect(201); // 3-я

    let sessions = (await http.get('/api/me/sessions').set(H(token)).expect(200)).body.data;
    expect(sessions.length).toBeGreaterThanOrEqual(3);
    const current = sessions.filter((s: any) => s.current);
    expect(current.length).toBe(1);

    const other = sessions.find((s: any) => !s.current);
    await http.delete(`/api/me/sessions/${other.id}`).set(H(token)).expect(200);

    await http.post('/api/me/sessions/revoke-all').set(H(token)).expect(201);
    sessions = (await http.get('/api/me/sessions').set(H(token)).expect(200)).body.data;
    expect(sessions.length).toBe(1);
    expect(sessions[0].current).toBe(true);
  });
});
