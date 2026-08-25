import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AddressInfo } from 'net';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { AllExceptionsFilter } from '../src/common/http/all-exceptions.filter';
import { ResponseInterceptor } from '../src/common/http/response.interceptor';
import { RedisIoAdapter } from '../src/common/auth/redis-io.adapter';

/**
 * Лента компании.
 *
 * Смысл объявления — подтверждение прочтения: автор должен видеть поимённо, кто прочитал,
 * а кто нет. Всё остальное в ленте — обычная переписка, которая и так есть в чатах.
 */
describe('Лента компании (e2e)', () => {
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

  const org = async (name: string) => (await http$.post('/api/auth/register')
    .send({ tenantName: name, email: `own_${uniq()}@t.test`, password: 'password123', fullName: 'Владелец' })
    .expect(201)).body.data;

  const employee = async (ownerToken: string, role = 'member') => {
    const email = `u_${uniq()}@t.test`;
    const user = (await http$.post('/api/users').set(H(ownerToken))
      .send({ email, fullName: `Сотрудник ${role}`, password: 'password123', role }).expect(201)).body.data;
    const token = (await http$.post('/api/auth/login')
      .send({ email, password: 'password123' }).expect(201)).body.data.accessToken;
    return { user, token };
  };

  it('объявление: подтверждение прочтения, список прочитавших и оставшихся', async () => {
    const owner = await org('Лента');
    const mate = await employee(owner.accessToken);

    const post = (await http$.post('/api/feed').set(H(owner.accessToken))
      .send({ body: 'В пятницу переезжаем в новый офис', isAnnouncement: true }).expect(201)).body.data;
    expect(post.isAnnouncement).toBe(true);

    // автор своё объявление читать не должен — он его и написал
    expect((await http$.get('/api/feed/unread').set(H(owner.accessToken)).expect(200)).body.data.count).toBe(0);

    // сотруднику оно висит непрочитанным
    const unread = (await http$.get('/api/feed/unread').set(H(mate.token)).expect(200)).body.data;
    expect(unread.count).toBe(1);
    expect(unread.items[0].body).toContain('переезжаем');

    // до подтверждения автор видит его в «ещё не прочитали»
    const before = (await http$.get(`/api/feed/${post.id}/readers`).set(H(owner.accessToken)).expect(200)).body.data;
    expect(before.pending.some((p: any) => String(p.fullName).includes('Сотрудник'))).toBe(true);

    await http$.post(`/api/feed/${post.id}/read`).set(H(mate.token)).expect(201);

    const after = (await http$.get(`/api/feed/${post.id}/readers`).set(H(owner.accessToken)).expect(200)).body.data;
    expect(after.read.some((p: any) => String(p.fullName).includes('Сотрудник'))).toBe(true);
    expect(after.pending.some((p: any) => String(p.fullName).includes('Сотрудник'))).toBe(false);
    expect((await http$.get('/api/feed/unread').set(H(mate.token)).expect(200)).body.data.count).toBe(0);
  });

  it('объявление публикует владелец или руководитель, обычное сообщение — кто угодно', async () => {
    const owner = await org('Права ленты');
    const mate = await employee(owner.accessToken);

    await http$.post('/api/feed').set(H(mate.token))
      .send({ body: 'Важное от рядового', isAnnouncement: true }).expect(403);

    // обычное сообщение писать может каждый: это общая стена, а не доска приказов
    const normal = (await http$.post('/api/feed').set(H(mate.token))
      .send({ body: 'Кто-нибудь видел мою кружку?' }).expect(201)).body.data;
    expect(normal.isAnnouncement).toBe(false);

    // список прочитавших — не всеобщее достояние
    const post = (await http$.post('/api/feed').set(H(owner.accessToken))
      .send({ body: 'Объявление', isAnnouncement: true }).expect(201)).body.data;
    await http$.get(`/api/feed/${post.id}/readers`).set(H(mate.token)).expect(403);
  });

  it('лента чужой организации не видна, комментарий засчитывается как прочтение', async () => {
    const a = await org('Своя лента');
    const b = await org('Чужая лента');
    const mate = await employee(a.accessToken);

    const post = (await http$.post('/api/feed').set(H(a.accessToken))
      .send({ body: 'Только для своих', isAnnouncement: true }).expect(201)).body.data;

    expect((await http$.get('/api/feed').set(H(b.accessToken)).expect(200)).body.data.items).toEqual([]);
    await http$.get(`/api/feed/${post.id}/readers`).set(H(b.accessToken)).expect(404);

    // человек ответил на объявление — значит прочитал; спрашивать ещё раз незачем
    await http$.post(`/api/feed/${post.id}/comments`).set(H(mate.token))
      .send({ body: 'А во сколько?' }).expect(201);
    expect((await http$.get('/api/feed/unread').set(H(mate.token)).expect(200)).body.data.count).toBe(0);

    const comments = (await http$.get(`/api/feed/${post.id}/comments`).set(H(a.accessToken)).expect(200)).body.data;
    expect(comments).toHaveLength(1);
    expect(comments[0].body).toBe('А во сколько?');
  });

  it('закреплённое держится наверху, удалённое пропадает из ленты', async () => {
    const owner = await org('Закрепление');
    await http$.post('/api/feed').set(H(owner.accessToken)).send({ body: 'Первое' }).expect(201);
    const pinned = (await http$.post('/api/feed').set(H(owner.accessToken)).send({ body: 'Второе' }).expect(201)).body.data;
    await http$.post('/api/feed').set(H(owner.accessToken)).send({ body: 'Третье' }).expect(201);

    await http$.post(`/api/feed/${pinned.id}/pin`).set(H(owner.accessToken)).send({ pinned: true }).expect(201);
    const list = (await http$.get('/api/feed').set(H(owner.accessToken)).expect(200)).body.data.items;
    expect(list[0].body).toBe('Второе');

    await http$.delete(`/api/feed/${pinned.id}`).set(H(owner.accessToken)).expect(200);
    const after = (await http$.get('/api/feed').set(H(owner.accessToken)).expect(200)).body.data.items;
    expect(after.some((p: any) => String(p.id) === String(pinned.id))).toBe(false);
    expect(after).toHaveLength(2);
  });
});
