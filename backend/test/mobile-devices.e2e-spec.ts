import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AddressInfo } from 'net';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { AllExceptionsFilter } from '../src/common/http/all-exceptions.filter';
import { ResponseInterceptor } from '../src/common/http/response.interceptor';
import { RedisIoAdapter } from '../src/common/auth/redis-io.adapter';

/**
 * ТЗ-9, волна 3: устройства, привязка сессии, отзыв руководством — сразу, а не через
 * четверть часа.
 */
describe('Mobile — устройства и отзыв сессий (e2e)', () => {
  let app: INestApplication;
  let http: any;
  const uniq = () => Math.random().toString(36).slice(2) + Date.now().toString(36);
  const H = (t: string) => ({ Authorization: `Bearer ${t}` });

  async function register() {
    const r = await http
      .post('/api/auth/register')
      .send({ tenantName: 'Mob', email: `m_${uniq()}@t.test`, password: 'password123', fullName: 'Owner' })
      .expect(201);
    return { token: r.body.data.accessToken as string, userId: String(r.body.data.user.id) };
  }
  async function login(email: string) {
    const r = await http.post('/api/auth/login').send({ email, password: 'password123' }).expect(201);
    return { token: r.body.data.accessToken as string, userId: String(r.body.data.user.id) };
  }

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

  it('устройство регистрируется, сессия привязывается, в списке сессий видно телефон', async () => {
    const { token } = await register();
    const uuid = `uuid-${uniq()}`;
    const dev = (await http.post('/api/mobile/devices').set(H(token)).send({
      deviceUuid: uuid, platform: 'android', model: 'Pixel 7', osVersion: '14',
      nativeVersion: '1.0 (1)', webBundleVersion: '2026.09.21-abc1234',
    }).expect(201)).body.data;
    expect(dev.id).toBeTruthy();

    const sessions = (await http.get('/api/me/sessions').set(H(token)).expect(200)).body.data;
    const current = sessions.find((s: any) => s.current);
    expect(current.device).toEqual(expect.objectContaining({ platform: 'android', model: 'Pixel 7' }));

    // повторная регистрация того же устройства — та же строка, обновлённые версии
    const again = (await http.post('/api/mobile/devices').set(H(token)).send({
      deviceUuid: uuid, platform: 'android', nativeVersion: '1.1 (2)',
    }).expect(201)).body.data;
    expect(again.id).toBe(dev.id);
    const mine = (await http.get('/api/mobile/devices').set(H(token)).expect(200)).body.data;
    expect(mine.length).toBe(1);
    expect(mine[0].nativeVersion).toBe('1.1 (2)');
    expect(mine[0].model).toBe('Pixel 7'); // не затёрлось пустым
  });

  it('выход с устройства отзывает его сессию: старый токен больше не работает', async () => {
    const { token } = await register();
    const dev = (await http.post('/api/mobile/devices').set(H(token)).send({
      deviceUuid: `uuid-${uniq()}`, platform: 'ios', model: 'iPhone 14',
    }).expect(201)).body.data;
    await http.delete(`/api/mobile/devices/${dev.id}`).set(H(token)).expect(200);
    const r = await http.get('/api/me').set(H(token)).expect(401);
    expect(r.body.error.code).toBe('SESSION_REVOKED');
  });

  it('руководитель видит устройства сотрудника и отзывает сессию — она гаснет сразу', async () => {
    const owner = await register();
    const mateEmail = `mate_${uniq()}@t.test`;
    await http.post('/api/users').set(H(owner.token))
      .send({ email: mateEmail, fullName: 'Глеб', password: 'password123', role: 'member' }).expect(201);
    const mate = await login(mateEmail);
    await http.post('/api/mobile/devices').set(H(mate.token)).send({
      deviceUuid: `uuid-${uniq()}`, platform: 'android', model: 'Galaxy S24',
    }).expect(201);

    const list = (await http.get(`/api/team/${mate.userId}/sessions`).set(H(owner.token)).expect(200)).body.data;
    expect(list.length).toBe(1);
    expect(list[0].device.model).toBe('Galaxy S24');

    // сотрудник сотрудника не видит
    await http.get(`/api/team/${owner.userId}/sessions`).set(H(mate.token)).expect(403);

    await http.delete(`/api/team/${mate.userId}/sessions/${list[0].id}`).set(H(owner.token)).expect(200);
    const r = await http.get('/api/me').set(H(mate.token)).expect(401);
    expect(r.body.error.code).toBe('SESSION_REVOKED');
  });

  it('чужая организация: сотрудник не найден', async () => {
    const a = await register();
    const b = await register();
    await http.get(`/api/team/${b.userId}/sessions`).set(H(a.token)).expect(404);
  });
});