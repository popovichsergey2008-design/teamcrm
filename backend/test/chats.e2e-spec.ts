import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AddressInfo } from 'net';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { AllExceptionsFilter } from '../src/common/http/all-exceptions.filter';
import { ResponseInterceptor } from '../src/common/http/response.interceptor';
import { RedisIoAdapter } from '../src/common/auth/redis-io.adapter';

/** Этап 6, М1 — мессенджер: личные диалоги, группы, чаты проектов, непрочитанное. */
describe('Чаты команды (e2e)', () => {
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

  it('диалог: переписка, непрочитанное, повторное открытие не плодит второй чат', async () => {
    const ownerEmail = `ch_${uniq()}@t.test`;
    const owner = (await http$.post('/api/auth/register')
      .send({ tenantName: 'CH', email: ownerEmail, password: 'password123', fullName: 'Владелец' }).expect(201)).body.data;

    const mateEmail = `mate_${uniq()}@t.test`;
    const mate = (await http$.post('/api/users').set(H(owner.accessToken))
      .send({ email: mateEmail, fullName: 'Коллега', password: 'password123', role: 'member' }).expect(201)).body.data;
    const mateLogin = (await http$.post('/api/auth/login').send({ email: mateEmail, password: 'password123' }).expect(201)).body.data;

    // открываем диалог и пишем
    const chat = (await http$.post('/api/chats/dm').set(H(owner.accessToken)).send({ userId: mate.id }).expect(201)).body.data;
    await http$.post(`/api/chats/${chat.id}/messages`).set(H(owner.accessToken)).send({ body: 'Привет, нужна помощь' }).expect(201);

    // тот же диалог открывается повторно, а не создаётся заново
    const again = (await http$.post('/api/chats/dm').set(H(mateLogin.accessToken)).send({ userId: owner.user.id }).expect(201)).body.data;
    expect(String(again.id)).toBe(String(chat.id));

    // у собеседника чат виден с непрочитанным и именем автора
    const mateChats = (await http$.get('/api/chats').set(H(mateLogin.accessToken)).expect(200)).body.data;
    const seen = mateChats.find((c: any) => String(c.id) === String(chat.id));
    expect(seen.unread).toBe(1);
    expect(seen.title).toBe('Владелец');       // в диалоге заголовок — имя собеседника
    expect(seen.lastBody).toBe('Привет, нужна помощь');

    // прочитал — счётчик обнулился, своё сообщение непрочитанным не считается
    const feed = (await http$.get(`/api/chats/${chat.id}/messages`).set(H(mateLogin.accessToken)).expect(200)).body.data;
    expect(feed).toHaveLength(1);
    const after = (await http$.get('/api/chats').set(H(mateLogin.accessToken)).expect(200)).body.data;
    expect(after.find((c: any) => String(c.id) === String(chat.id)).unread).toBe(0);

    const mine = (await http$.get('/api/chats').set(H(owner.accessToken)).expect(200)).body.data;
    expect(mine.find((c: any) => String(c.id) === String(chat.id)).unread).toBe(0);
  });

  it('в чужой диалог не попасть даже по угаданному id', async () => {
    const aEmail = `pa_${uniq()}@t.test`;
    const a = (await http$.post('/api/auth/register')
      .send({ tenantName: 'PA', email: aEmail, password: 'password123', fullName: 'A' }).expect(201)).body.data;
    const bEmail = `pb_${uniq()}@t.test`;
    const b = (await http$.post('/api/users').set(H(a.accessToken))
      .send({ email: bEmail, fullName: 'B', password: 'password123', role: 'member' }).expect(201)).body.data;
    const chat = (await http$.post('/api/chats/dm').set(H(a.accessToken)).send({ userId: b.id }).expect(201)).body.data;

    // посторонний сотрудник той же организации
    const cEmail = `pc_${uniq()}@t.test`;
    await http$.post('/api/users').set(H(a.accessToken))
      .send({ email: cEmail, fullName: 'C', password: 'password123', role: 'member' }).expect(201);
    const c = (await http$.post('/api/auth/login').send({ email: cEmail, password: 'password123' }).expect(201)).body.data;

    await http$.get(`/api/chats/${chat.id}/messages`).set(H(c.accessToken)).expect(403);
    await http$.post(`/api/chats/${chat.id}/messages`).set(H(c.accessToken)).send({ body: 'подслушиваю' }).expect(403);
  });

  it('чат проекта общий для команды и заводится один раз', async () => {
    const email = `pr_${uniq()}@t.test`;
    const owner = (await http$.post('/api/auth/register')
      .send({ tenantName: 'PR', email, password: 'password123', fullName: 'Владелец' }).expect(201)).body.data;
    const project = (await http$.post('/api/projects').set(H(owner.accessToken)).send({ name: 'Мануфактура' }).expect(201)).body.data;

    const first = (await http$.post(`/api/chats/project/${project.id}`).set(H(owner.accessToken)).expect(201)).body.data;
    const second = (await http$.post(`/api/chats/project/${project.id}`).set(H(owner.accessToken)).expect(201)).body.data;
    expect(String(first.id)).toBe(String(second.id)); // второй чат на тот же проект не заводится

    await http$.post(`/api/chats/${first.id}/messages`).set(H(owner.accessToken)).send({ body: 'обсуждаем доску' }).expect(201);

    // сотрудник без явного членства читает чат проекта: доступ к проектам общий
    const memberEmail = `prm_${uniq()}@t.test`;
    await http$.post('/api/users').set(H(owner.accessToken))
      .send({ email: memberEmail, fullName: 'Сотрудник', password: 'password123', role: 'member' }).expect(201);
    const member = (await http$.post('/api/auth/login').send({ email: memberEmail, password: 'password123' }).expect(201)).body.data;

    const feed = (await http$.get(`/api/chats/${first.id}/messages`).set(H(member.accessToken)).expect(200)).body.data;
    expect(feed.some((m: any) => m.body === 'обсуждаем доску')).toBe(true);

    const list = (await http$.get('/api/chats').set(H(member.accessToken)).expect(200)).body.data;
    expect(list.find((c: any) => String(c.id) === String(first.id)).title).toBe('Мануфактура');
  });

  it('группа: видна участникам, посторонний в неё не попадает', async () => {
    const email = `gr_${uniq()}@t.test`;
    const owner = (await http$.post('/api/auth/register')
      .send({ tenantName: 'GR', email, password: 'password123', fullName: 'Владелец' }).expect(201)).body.data;

    const make = async (name: string) => {
      const mail = `${name}_${uniq()}@t.test`;
      const u = (await http$.post('/api/users').set(H(owner.accessToken))
        .send({ email: mail, fullName: name, password: 'password123', role: 'member' }).expect(201)).body.data;
      const login = (await http$.post('/api/auth/login').send({ email: mail, password: 'password123' }).expect(201)).body.data;
      return { id: u.id, token: login.accessToken };
    };
    const inside = await make('Внутри');
    const outside = await make('Снаружи');

    const group = (await http$.post('/api/chats/groups').set(H(owner.accessToken))
      .send({ title: 'Продакшн', userIds: [inside.id] }).expect(201)).body.data;
    expect(group.title).toBe('Продакшн');

    await http$.post(`/api/chats/${group.id}/messages`).set(H(owner.accessToken)).send({ body: 'сбор в 10' }).expect(201);

    // участник видит группу в списке и читает переписку
    const list = (await http$.get('/api/chats').set(H(inside.token)).expect(200)).body.data;
    const seen = list.find((c: any) => String(c.id) === String(group.id));
    expect(seen.title).toBe('Продакшн');
    expect(seen.unread).toBe(1);
    const feed = (await http$.get(`/api/chats/${group.id}/messages`).set(H(inside.token)).expect(200)).body.data;
    expect(feed[0].body).toBe('сбор в 10');

    // посторонний сотрудник той же организации — мимо
    await http$.get(`/api/chats/${group.id}/messages`).set(H(outside.token)).expect(403);
    const outsideList = (await http$.get('/api/chats').set(H(outside.token)).expect(200)).body.data;
    expect(outsideList.some((c: any) => String(c.id) === String(group.id))).toBe(false);

    // группа без названия не создаётся
    await http$.post('/api/chats/groups').set(H(owner.accessToken)).send({ title: '   ', userIds: [inside.id] }).expect(400);
  });

  it('пустое сообщение и чужое удаление отклоняются', async () => {
    const email = `em_${uniq()}@t.test`;
    const owner = (await http$.post('/api/auth/register')
      .send({ tenantName: 'EM', email, password: 'password123', fullName: 'Владелец' }).expect(201)).body.data;
    const mateEmail = `emm_${uniq()}@t.test`;
    const mate = (await http$.post('/api/users').set(H(owner.accessToken))
      .send({ email: mateEmail, fullName: 'Коллега', password: 'password123', role: 'member' }).expect(201)).body.data;
    const mateLogin = (await http$.post('/api/auth/login').send({ email: mateEmail, password: 'password123' }).expect(201)).body.data;

    const chat = (await http$.post('/api/chats/dm').set(H(owner.accessToken)).send({ userId: mate.id }).expect(201)).body.data;
    await http$.post(`/api/chats/${chat.id}/messages`).set(H(owner.accessToken)).send({ body: '   ' }).expect(400);

    const msg = (await http$.post(`/api/chats/${chat.id}/messages`).set(H(owner.accessToken)).send({ body: 'моё' }).expect(201)).body.data;
    // участник диалога не может удалить чужое сообщение
    await http$.delete(`/api/chats/${chat.id}/messages/${msg.id}`).set(H(mateLogin.accessToken)).expect(403);
    await http$.delete(`/api/chats/${chat.id}/messages/${msg.id}`).set(H(owner.accessToken)).expect(200);
  });
});
