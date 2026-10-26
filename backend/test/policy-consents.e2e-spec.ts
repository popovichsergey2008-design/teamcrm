import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AddressInfo } from 'net';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { AllExceptionsFilter } from '../src/common/http/all-exceptions.filter';
import { ResponseInterceptor } from '../src/common/http/response.interceptor';
import { RedisIoAdapter } from '../src/common/auth/redis-io.adapter';
import { DbService } from '../src/database/db.service';

/**
 * #4675: регистрация — только с галочкой «Я принимаю Политику конфиденциальности».
 *
 * Сервер не верит одной кнопке на фронте: без согласия — 400 понятным текстом, и
 * ни аккаунта, ни организации. С согласием — строка в policy_consents с версией,
 * IP и устройством. То же для приглашения по почте и по многоразовой ссылке.
 */
describe('#4675 — согласие с Политикой конфиденциальности (e2e)', () => {
  let app: INestApplication;
  let http: any;
  let db: DbService;
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
    db = app.get(DbService);
  });
  afterAll(async () => { await app?.close(); });

  const consentsOf = (userId: string) => db.many<{ policy: string; version: string; ip: string | null; user_agent: string | null; context: any }>(
    `SELECT policy, version, ip, user_agent, context FROM policy_consents WHERE user_id = $1 ORDER BY id`, [userId],
  );

  it('регистрация организации: без галочки 400, с галочкой — запись в журнал', async () => {
    const email = `pc_${uniq()}@t.test`;
    const body = { tenantName: 'Политики', email, password: 'password123', fullName: 'Ольга' };
    const no = await http.post('/api/auth/register').send(body).expect(400);
    expect(no.body.error.message).toBe('Чтобы зарегистрироваться, примите Политику конфиденциальности');
    await http.post('/api/auth/register').send({ ...body, acceptPrivacy: false }).expect(400);
    // отказ не оставил аккаунта: та же почта регистрируется с первого раза
    const owner = (await http.post('/api/auth/register').set('User-Agent', 'e2e-browser')
      .send({ ...body, acceptPrivacy: true }).expect(201)).body.data;
    const rows = await consentsOf(String(owner.user.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ policy: 'privacy', version: 'v1', user_agent: 'e2e-browser', context: { flow: 'register' } });
    expect(rows[0].ip).toBeTruthy();
  }, 30000);

  it('приглашение по почте и по ссылке: без галочки 400, с галочкой — запись', async () => {
    const owner = (await http.post('/api/auth/register')
      .send({ acceptPrivacy: true, tenantName: 'Приглашения', email: `pc_o_${uniq()}@t.test`, password: 'password123', fullName: 'Владелец' })
      .expect(201)).body.data;
    const O = H(owner.accessToken);

    const inv = (await http.post('/api/invites').set(O).send({ email: `pc_i_${uniq()}@t.test`, role: 'member' }).expect(201)).body.data;
    const noInv = await http.post('/api/invites/accept').send({ token: inv.token, fullName: 'Петя', password: 'memberpass1' }).expect(400);
    expect(noInv.body.error.message).toMatch(/Политику конфиденциальности/);
    const acc = (await http.post('/api/invites/accept').send({ acceptPrivacy: true, token: inv.token, fullName: 'Петя', password: 'memberpass1' }).expect(201)).body.data;
    expect((await consentsOf(String(acc.user.id)))[0]).toMatchObject({ policy: 'privacy', context: { flow: 'invite' } });

    const link = (await http.post('/api/invites/links').set(O).send({ role: 'member' }).expect(201)).body.data;
    const email = `pc_l_${uniq()}@t.test`;
    await http.post('/api/invites/links/accept').send({ token: link.token, email, fullName: 'Аня', password: 'memberpass1' }).expect(400);
    const joined = (await http.post('/api/invites/links/accept').send({ acceptPrivacy: true, token: link.token, email, fullName: 'Аня', password: 'memberpass1' }).expect(201)).body.data;
    expect((await consentsOf(String(joined.user.id)))[0]).toMatchObject({ policy: 'privacy', context: { flow: 'invite_link' } });
  }, 30000);
});
