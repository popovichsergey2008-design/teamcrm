import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AddressInfo } from 'net';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { AllExceptionsFilter } from '../src/common/http/all-exceptions.filter';
import { ResponseInterceptor } from '../src/common/http/response.interceptor';
import { RedisIoAdapter } from '../src/common/auth/redis-io.adapter';

/**
 * Присутствие и настройки интерфейса — то, на чём стоит Chat Bar (ТЗ-5, этап 1).
 */
describe('Присутствие и настройки интерфейса (e2e)', () => {
  let app: INestApplication;
  let http$: any;
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
    http$ = request(`http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`);
  });
  afterAll(async () => app?.close());

  it('статус ставится руками, виден всем в компании и в списке чатов у собеседника', async () => {
    const owner = (await http$.post('/api/auth/register')
      .send({ tenantName: 'PR', email: `pr_${uniq()}@t.test`, password: 'password123', fullName: 'Владелец' }).expect(201)).body.data;
    const mateEmail = `prm_${uniq()}@t.test`;
    const mate = (await http$.post('/api/users').set(H(owner.accessToken))
      .send({ email: mateEmail, fullName: 'Коллега', password: 'password123', role: 'member' }).expect(201)).body.data;
    const M = H((await http$.post('/api/auth/login').send({ email: mateEmail, password: 'password123' }).expect(201)).body.data.accessToken);
    const O = H(owner.accessToken);

    // по умолчанию — ничего не поставлено, не в сети (сокетов в тесте нет)
    const before = (await http$.get('/api/presence').set(M).expect(200)).body.data;
    const me = before.find((p: any) => String(p.userId) === String(mate.id));
    expect(me.status).toBeNull();
    expect(me.online).toBe(false);

    await http$.put('/api/presence/status').set(M).send({ status: 'busy' }).expect(200);
    const after = (await http$.get('/api/presence').set(O).expect(200)).body.data;
    expect(after.find((p: any) => String(p.userId) === String(mate.id)).status).toBe('busy');

    // в списке чатов у собеседника — тот же статус
    await http$.post('/api/chats/dm').set(O).send({ userId: mate.id }).expect(201);
    const chats = (await http$.get('/api/chats').set(O).expect(200)).body.data;
    expect(chats.find((c: any) => String(c.peerId) === String(mate.id)).peerStatus).toBe('busy');

    // снять — прислать null; чужое значение не принимается
    await http$.put('/api/presence/status').set(M).send({ status: null }).expect(200);
    await http$.put('/api/presence/status').set(M).send({ status: 'sleeping' }).expect(400);
    expect((await http$.get('/api/presence').set(M).expect(200)).body.data
      .find((p: any) => String(p.userId) === String(mate.id)).status).toBeNull();
  });

  it('настройки интерфейса сливаются, а не затирают друг друга', async () => {
    const owner = (await http$.post('/api/auth/register')
      .send({ tenantName: 'UP', email: `up_${uniq()}@t.test`, password: 'password123', fullName: 'Владелец' }).expect(201)).body.data;
    const O = H(owner.accessToken);

    // меню слева сохранило порядок
    await http$.put('/api/me/ui-prefs').set(O).send({ prefs: { order: ['tasks', 'projects'] } }).expect(200);
    // Chat Bar справа сохранил своё — порядок меню обязан уцелеть
    const merged = (await http$.put('/api/me/ui-prefs').set(O).send({ prefs: { chatBar: { expanded: true } } }).expect(200)).body.data.uiPrefs;
    expect(merged.order).toEqual(['tasks', 'projects']);
    expect(merged.chatBar).toEqual({ expanded: true });

    // сброс — явно пустым значением
    const reset = (await http$.put('/api/me/ui-prefs').set(O).send({ prefs: { order: [], hidden: [] } }).expect(200)).body.data.uiPrefs;
    expect(reset.order).toEqual([]);
    expect(reset.chatBar).toEqual({ expanded: true });
  });
});
