import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AddressInfo } from 'net';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { AllExceptionsFilter } from '../src/common/http/all-exceptions.filter';
import { ResponseInterceptor } from '../src/common/http/response.interceptor';
import { RedisIoAdapter } from '../src/common/auth/redis-io.adapter';

/**
 * Сброс пароля владельцем + поведение приглашения на уже существующий аккаунт.
 * Почты в проекте нет: владелец выдаёт одноразовую ссылку, пароль задаёт сам сотрудник.
 */
describe('Сброс пароля и приглашение на существующий аккаунт (e2e)', () => {
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
  afterAll(async () => { await app?.close(); });

  it('владелец выдаёт ссылку → сотрудник задаёт новый пароль, старый перестаёт работать, ссылка одноразовая', async () => {
    const ownerEmail = `own_${uniq()}@t.test`;
    const owner = (await http$.post('/api/auth/register')
      .send({ tenantName: 'PR', email: ownerEmail, password: 'password123', fullName: 'Владелец' }).expect(201)).body.data;

    // сотрудник с известным паролем
    const staffEmail = `st_${uniq()}@t.test`;
    const staff = (await http$.post('/api/users').set(H(owner.accessToken))
      .send({ email: staffEmail, fullName: 'Сотрудник', password: 'oldpassword1', role: 'member' }).expect(201)).body.data;
    expect(staff.usedExistingAccount).toBe(false); // аккаунт заведён впервые
    await http$.post('/api/auth/login').send({ email: staffEmail, password: 'oldpassword1' }).expect(201);

    // владелец выдаёт ссылку; пароль он при этом не узнаёт
    const link = (await http$.post('/api/auth/password/reset-link').set(H(owner.accessToken))
      .send({ userId: staff.id }).expect(201)).body.data;
    expect(link.token).toBeTruthy();
    expect(link.email).toBe(staffEmail);
    expect(link.alsoAffectsOrgs).toEqual([]); // аккаунт только в этой организации
    expect(JSON.stringify(link)).not.toContain('oldpassword1');

    // страница сброса показывает, чей это аккаунт
    const info = (await http$.get(`/api/auth/password/reset/${link.token}`).expect(200)).body.data;
    expect(info.email).toBe(staffEmail);

    // задаём новый пароль
    await http$.post('/api/auth/password/reset').send({ token: link.token, password: 'newpassword9' }).expect(201);

    await http$.post('/api/auth/login').send({ email: staffEmail, password: 'oldpassword1' }).expect(401); // старый мёртв
    await http$.post('/api/auth/login').send({ email: staffEmail, password: 'newpassword9' }).expect(201); // новый работает

    // токен одноразовый
    await http$.post('/api/auth/password/reset').send({ token: link.token, password: 'another12345' }).expect(401);
    await http$.get(`/api/auth/password/reset/${link.token}`).expect(401);
  });

  it('выдача новой ссылки гасит предыдущую; чужой/битый токен не принимается', async () => {
    const ownerEmail = `own2_${uniq()}@t.test`;
    const owner = (await http$.post('/api/auth/register')
      .send({ tenantName: 'PR2', email: ownerEmail, password: 'password123', fullName: 'Владелец' }).expect(201)).body.data;
    const staffEmail = `st2_${uniq()}@t.test`;
    const staff = (await http$.post('/api/users').set(H(owner.accessToken))
      .send({ email: staffEmail, fullName: 'Сотрудник 2', password: 'oldpassword1', role: 'member' }).expect(201)).body.data;

    const first = (await http$.post('/api/auth/password/reset-link').set(H(owner.accessToken)).send({ userId: staff.id }).expect(201)).body.data;
    const second = (await http$.post('/api/auth/password/reset-link').set(H(owner.accessToken)).send({ userId: staff.id }).expect(201)).body.data;

    await http$.get(`/api/auth/password/reset/${first.token}`).expect(401);  // прежняя погашена
    await http$.get(`/api/auth/password/reset/${second.token}`).expect(200); // действует последняя
    await http$.get('/api/auth/password/reset/deadbeef').expect(401);
  });

  it('member не может выдать ссылку на сброс — только владелец', async () => {
    const ownerEmail = `own3_${uniq()}@t.test`;
    const owner = (await http$.post('/api/auth/register')
      .send({ tenantName: 'PR3', email: ownerEmail, password: 'password123', fullName: 'Владелец' }).expect(201)).body.data;
    const memberEmail = `mem_${uniq()}@t.test`;
    const member = (await http$.post('/api/users').set(H(owner.accessToken))
      .send({ email: memberEmail, fullName: 'Рядовой', password: 'password123', role: 'member' }).expect(201)).body.data;
    const memberLogin = (await http$.post('/api/auth/login').send({ email: memberEmail, password: 'password123' }).expect(201)).body.data;

    await http$.post('/api/auth/password/reset-link').set(H(memberLogin.accessToken)).send({ userId: member.id }).expect(403);
  });

  it('приглашение на существующий аккаунт НЕ меняет его пароль и честно об этом сообщает', async () => {
    // человек уже зарегистрирован своей организацией
    const personEmail = `dbl_${uniq()}@t.test`;
    await http$.post('/api/auth/register')
      .send({ tenantName: 'Своя', email: personEmail, password: 'ownpassword1', fullName: 'Юрий' }).expect(201);

    // другая организация зовёт его по многоразовой ссылке
    const hostEmail = `host_${uniq()}@t.test`;
    const host = (await http$.post('/api/auth/register')
      .send({ tenantName: 'Чужая', email: hostEmail, password: 'password123', fullName: 'Хозяин' }).expect(201)).body.data;
    const inviteLink = (await http$.post('/api/invites/links').set(H(host.accessToken)).send({ role: 'member' }).expect(201)).body.data;

    const accepted = (await http$.post('/api/invites/links/accept')
      .send({ token: inviteLink.token, email: personEmail, fullName: 'Юрий', password: 'attacker9999' }).expect(201)).body.data;
    expect(accepted.usedExistingAccount).toBe(true); // фронт покажет «входите прежним паролем»

    // ключевое: пароль аккаунта НЕ перезаписан введённым при вступлении
    await http$.post('/api/auth/login').send({ email: personEmail, password: 'attacker9999' }).expect(401);
    const stillWorks = (await http$.post('/api/auth/login').send({ email: personEmail, password: 'ownpassword1' }).expect(201)).body.data;
    expect(stillWorks.accessToken).toBeTruthy();
    // при этом в новую организацию он действительно добавлен
    expect((stillWorks.organizations ?? []).map((o: any) => o.name)).toContain('Чужая');
  });

  it('сброс из одной организации предупреждает, что затронет другие организации того же человека', async () => {
    const personEmail = `multi_${uniq()}@t.test`;
    await http$.post('/api/auth/register')
      .send({ tenantName: 'Первая', email: personEmail, password: 'ownpassword1', fullName: 'Мультиюзер' }).expect(201);
    const hostEmail = `host2_${uniq()}@t.test`;
    const host = (await http$.post('/api/auth/register')
      .send({ tenantName: 'Вторая', email: hostEmail, password: 'password123', fullName: 'Хозяин' }).expect(201)).body.data;
    const inviteLink = (await http$.post('/api/invites/links').set(H(host.accessToken)).send({ role: 'member' }).expect(201)).body.data;
    const joined = (await http$.post('/api/invites/links/accept')
      .send({ token: inviteLink.token, email: personEmail, fullName: 'Мультиюзер', password: 'irrelevant123' }).expect(201)).body.data;

    const link = (await http$.post('/api/auth/password/reset-link').set(H(host.accessToken))
      .send({ userId: joined.user.id }).expect(201)).body.data;
    expect(link.alsoAffectsOrgs).toContain('Первая'); // владелец увидит предупреждение

    await http$.post('/api/auth/password/reset').send({ token: link.token, password: 'brandnew1234' }).expect(201);
    await http$.post('/api/auth/login').send({ email: personEmail, password: 'ownpassword1' }).expect(401);
    await http$.post('/api/auth/login').send({ email: personEmail, password: 'brandnew1234' }).expect(201);
  });
});
