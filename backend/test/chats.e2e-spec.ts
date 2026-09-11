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

  it('управление группой: добавить, переименовать, убрать, выйти', async () => {
    const email = `gm_${uniq()}@t.test`;
    const owner = (await http$.post('/api/auth/register')
      .send({ tenantName: 'GM', email, password: 'password123', fullName: 'Владелец' }).expect(201)).body.data;

    const make = async (name: string) => {
      const mail = `${name}_${uniq()}@t.test`;
      const u = (await http$.post('/api/users').set(H(owner.accessToken))
        .send({ email: mail, fullName: name, password: 'password123', role: 'member' }).expect(201)).body.data;
      const login = (await http$.post('/api/auth/login').send({ email: mail, password: 'password123' }).expect(201)).body.data;
      return { id: u.id, token: login.accessToken };
    };
    const alice = await make('Алиса');
    const bob = await make('Боб');

    const group = (await http$.post('/api/chats/groups').set(H(owner.accessToken))
      .send({ title: 'Смена', userIds: [alice.id] }).expect(201)).body.data;

    // добавление: любой участник вправе позвать коллегу
    const added = (await http$.post(`/api/chats/${group.id}/members`).set(H(alice.token))
      .send({ userIds: [bob.id] }).expect(201)).body.data;
    expect(added.added).toBe(1);
    const withBob = (await http$.get(`/api/chats/${group.id}/members`).set(H(owner.accessToken)).expect(200)).body.data;
    expect(withBob.members).toHaveLength(3);

    // повторное добавление того же человека ничего не меняет
    expect((await http$.post(`/api/chats/${group.id}/members`).set(H(alice.token))
      .send({ userIds: [bob.id] }).expect(201)).body.data.added).toBe(0);

    // переименование и удаление — только создателю или руководству
    await http$.patch(`/api/chats/${group.id}`).set(H(alice.token)).send({ title: 'Чужое имя' }).expect(403);
    await http$.delete(`/api/chats/${group.id}/members/${bob.id}`).set(H(alice.token)).expect(403);

    const renamed = (await http$.patch(`/api/chats/${group.id}`).set(H(owner.accessToken)).send({ title: 'Ночная смена' }).expect(200)).body.data;
    expect(renamed.title).toBe('Ночная смена');

    await http$.delete(`/api/chats/${group.id}/members/${bob.id}`).set(H(owner.accessToken)).expect(200);
    // убранный теряет доступ к переписке
    await http$.get(`/api/chats/${group.id}/messages`).set(H(bob.token)).expect(403);

    // выход: доступен каждому, но не через удаление самого себя
    await http$.delete(`/api/chats/${group.id}/members/${alice.id}`).set(H(alice.token)).expect(400);
    await http$.post(`/api/chats/${group.id}/leave`).set(H(alice.token)).expect(201);
    await http$.get(`/api/chats/${group.id}/messages`).set(H(alice.token)).expect(403);

    // в ленте остались служебные строки — без автора
    const feed = (await http$.get(`/api/chats/${group.id}/messages`).set(H(owner.accessToken)).expect(200)).body.data;
    const system = feed.filter((m: any) => m.author_id === null);
    expect(system.length).toBeGreaterThanOrEqual(4); // добавлен, переименована, удалён, вышел
    expect(system.some((m: any) => /Ночная смена/.test(m.body))).toBe(true);

    // состав диалога и чата проекта не меняется
    const dm = (await http$.post('/api/chats/dm').set(H(owner.accessToken)).send({ userId: bob.id }).expect(201)).body.data;
    await http$.post(`/api/chats/${dm.id}/members`).set(H(owner.accessToken)).send({ userIds: [alice.id] }).expect(400);
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

  it('поиск по всем чатам находит чужие слова только там, куда есть доступ', async () => {
    const email = `sr_${uniq()}@t.test`;
    const owner = (await http$.post('/api/auth/register')
      .send({ tenantName: 'Поиск', email, password: 'password123', fullName: 'Владелец' }).expect(201)).body.data;
    const mateEmail = `srm_${uniq()}@t.test`;
    const mate = (await http$.post('/api/users').set(H(owner.accessToken))
      .send({ email: mateEmail, fullName: 'Коллега', password: 'password123', role: 'member' }).expect(201)).body.data;
    const mateLogin = (await http$.post('/api/auth/login')
      .send({ email: mateEmail, password: 'password123' }).expect(201)).body.data;

    const dm = (await http$.post('/api/chats/dm').set(H(owner.accessToken)).send({ userId: mate.id }).expect(201)).body.data;
    await http$.post(`/api/chats/${dm.id}/messages`).set(H(owner.accessToken))
      .send({ body: 'нужна пиликалка на кнопку' }).expect(201);

    const found = (await http$.get('/api/chats/search?q=пиликалка').set(H(owner.accessToken)).expect(200)).body.data;
    expect(found.items).toHaveLength(1);
    expect(found.items[0].body).toContain('пиликалка');
    expect(found.items[0].chatId).toBe(String(dm.id));

    // окно вокруг найденного открывается и содержит само сообщение
    const around = (await http$.get(`/api/chats/${dm.id}/around/${found.items[0].messageId}`)
      .set(H(owner.accessToken)).expect(200)).body.data;
    expect(around.some((m: any) => String(m.id) === String(found.items[0].messageId))).toBe(true);

    // одна буква ничего не ищет: такой запрос находит всё и не сообщает ничего
    const tiny = (await http$.get('/api/chats/search?q=п').set(H(owner.accessToken)).expect(200)).body.data;
    expect(tiny.items).toEqual([]);

    // чужой личный диалог в поиск не попадает
    const third = `sr3_${uniq()}@t.test`;
    const outsider = (await http$.post('/api/users').set(H(owner.accessToken))
      .send({ email: third, fullName: 'Посторонний', password: 'password123', role: 'member' }).expect(201)).body.data;
    const outLogin = (await http$.post('/api/auth/login')
      .send({ email: third, password: 'password123' }).expect(201)).body.data;
    void outsider;
    const alien = (await http$.get('/api/chats/search?q=пиликалка').set(H(outLogin.accessToken)).expect(200)).body.data;
    expect(alien.items).toEqual([]);
    void mateLogin;
  });

  it('отложенное сообщение: время только в будущем, отменить может лишь автор', async () => {
    const email = `sc_${uniq()}@t.test`;
    const owner = (await http$.post('/api/auth/register')
      .send({ tenantName: 'Отложенные', email, password: 'password123', fullName: 'Владелец' }).expect(201)).body.data;
    const mateEmail = `scm_${uniq()}@t.test`;
    const mate = (await http$.post('/api/users').set(H(owner.accessToken))
      .send({ email: mateEmail, fullName: 'Коллега', password: 'password123', role: 'member' }).expect(201)).body.data;
    const mateLogin = (await http$.post('/api/auth/login')
      .send({ email: mateEmail, password: 'password123' }).expect(201)).body.data;
    const dm = (await http$.post('/api/chats/dm').set(H(owner.accessToken)).send({ userId: mate.id }).expect(201)).body.data;

    const soon = new Date(Date.now() + 3600_000).toISOString();
    const past = new Date(Date.now() - 3600_000).toISOString();

    await http$.post(`/api/chats/${dm.id}/scheduled`).set(H(owner.accessToken))
      .send({ body: 'напоминаю про встречу', sendAt: past }).expect(400);

    const made = (await http$.post(`/api/chats/${dm.id}/scheduled`).set(H(owner.accessToken))
      .send({ body: 'напоминаю про встречу', sendAt: soon }).expect(201)).body.data;
    expect(made.id).toBeTruthy();

    // до срока сообщения в чате НЕТ: иначе оно уедет собеседнику прямо сейчас
    const feed = (await http$.get(`/api/chats/${dm.id}/messages`).set(H(mateLogin.accessToken)).expect(200)).body.data;
    expect(feed.some((m: any) => String(m.body).includes('напоминаю'))).toBe(false);

    const mine = (await http$.get(`/api/chats/${dm.id}/scheduled`).set(H(owner.accessToken)).expect(200)).body.data;
    expect(mine.items).toHaveLength(1);

    // чужое отложенное не отменить и не увидеть в своём списке
    await http$.delete(`/api/chats/scheduled/${made.id}`).set(H(mateLogin.accessToken)).expect(403);
    const alien = (await http$.get(`/api/chats/${dm.id}/scheduled`).set(H(mateLogin.accessToken)).expect(200)).body.data;
    expect(alien.items).toEqual([]);

    await http$.delete(`/api/chats/scheduled/${made.id}`).set(H(owner.accessToken)).expect(200);
    const after = (await http$.get(`/api/chats/${dm.id}/scheduled`).set(H(owner.accessToken)).expect(200)).body.data;
    expect(after.items).toEqual([]);
  });

  it('правка своего сообщения и галочки «прочитано»', async () => {
    const email = `ed_${uniq()}@t.test`;
    const owner = (await http$.post('/api/auth/register')
      .send({ tenantName: 'ED', email, password: 'password123', fullName: 'Владелец' }).expect(201)).body.data;
    const mateEmail = `edm_${uniq()}@t.test`;
    const mate = (await http$.post('/api/users').set(H(owner.accessToken))
      .send({ email: mateEmail, fullName: 'Коллега', password: 'password123', role: 'member' }).expect(201)).body.data;
    const mateLogin = (await http$.post('/api/auth/login')
      .send({ email: mateEmail, password: 'password123' }).expect(201)).body.data;

    const chat = (await http$.post('/api/chats/dm').set(H(owner.accessToken)).send({ userId: mate.id }).expect(201)).body.data;
    const msg = (await http$.post(`/api/chats/${chat.id}/messages`).set(H(owner.accessToken))
      .send({ body: 'превет' }).expect(201)).body.data;

    // чужое сообщение править нельзя — это не про права руководителя, а про чужие слова
    await http$.patch(`/api/chats/${chat.id}/messages/${msg.id}`).set(H(mateLogin.accessToken))
      .send({ body: 'подменил' }).expect(403);
    // пустой текст — это удаление, и делается оно отдельной кнопкой
    await http$.patch(`/api/chats/${chat.id}/messages/${msg.id}`).set(H(owner.accessToken))
      .send({ body: '   ' }).expect(400);

    await http$.patch(`/api/chats/${chat.id}/messages/${msg.id}`).set(H(owner.accessToken))
      .send({ body: 'привет' }).expect(200);

    // до того как собеседник открыл чат — одна галочка (прочитавших ноль)
    let list = (await http$.get(`/api/chats/${chat.id}/messages`).set(H(owner.accessToken)).expect(200)).body.data;
    let mine = list.find((m: any) => String(m.id) === String(msg.id));
    expect(mine.body).toBe('привет');
    expect(mine.edited_at).not.toBeNull();
    expect(mine.others).toBe(1);
    expect(mine.read_by).toBe(0);

    // собеседник открыл чат — сообщение прочитано
    await http$.get(`/api/chats/${chat.id}/messages`).set(H(mateLogin.accessToken)).expect(200);
    list = (await http$.get(`/api/chats/${chat.id}/messages`).set(H(owner.accessToken)).expect(200)).body.data;
    mine = list.find((m: any) => String(m.id) === String(msg.id));
    expect(mine.read_by).toBe(1);
  });
});
