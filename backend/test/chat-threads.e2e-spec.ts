import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AddressInfo } from 'net';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { AllExceptionsFilter } from '../src/common/http/all-exceptions.filter';
import { ResponseInterceptor } from '../src/common/http/response.interceptor';
import { RedisIoAdapter } from '../src/common/auth/redis-io.adapter';

/**
 * Треды в мессенджере (ТЗ-3, слой 1).
 *
 * Проверяем не «ручка отвечает», а правила, ради которых ветки и заводились:
 * ответ в ветке НЕ засоряет общую ленту, счётчик ответов виден на самом сообщении,
 * «Также отправить в основной чат» — осознанное исключение, а раздел «Треды»
 * показывает ветки человека и считает ЧУЖИЕ ответы, которых он ещё не видел.
 */
describe('треды в чатах (e2e)', () => {
  let app: INestApplication;
  let http: any;
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
  });
  afterAll(async () => { await app?.close(); });

  it('ответы уходят в ветку, лента остаётся чистой, «Треды» считают чужое', async () => {
    const owner = (await http.post('/api/auth/register')
      .send({ tenantName: 'TH', email: `th_${uniq()}@t.test`, password: 'password123', fullName: 'Ольга Владелец' })
      .expect(201)).body.data;
    const mateEmail = `th_m_${uniq()}@t.test`;
    const mate = (await http.post('/api/users').set(H(owner.accessToken))
      .send({ email: mateEmail, fullName: 'Пётр Коллега', password: 'password123', role: 'member' })
      .expect(201)).body.data;
    const mateLogin = (await http.post('/api/auth/login')
      .send({ email: mateEmail, password: 'password123' }).expect(201)).body.data;
    const O = H(owner.accessToken);
    const M = H(mateLogin.accessToken);

    const chat = (await http.post('/api/chats/dm').set(O).send({ userId: mate.id }).expect(201)).body.data;
    const root = (await http.post(`/api/chats/${chat.id}/messages`).set(O)
      .send({ body: 'На проде перестала работать форма регистрации' }).expect(201)).body.data;

    // ответ в ветку
    await http.post(`/api/chats/${chat.id}/messages`).set(M)
      .send({ body: 'Смотрю логи', threadRootId: String(root.id) }).expect(201);
    await http.post(`/api/chats/${chat.id}/messages`).set(M)
      .send({ body: 'Дело в токене', threadRootId: String(root.id) }).expect(201);

    // ЛЕНТА чистая: в ней только корневое сообщение
    const feed = (await http.get(`/api/chats/${chat.id}/messages`).set(O).expect(200)).body.data;
    expect(feed.length).toBe(1);
    expect(String(feed[0].id)).toBe(String(root.id));
    // а счётчик ответов виден прямо на нём — иначе о ветке никто не узнает
    expect(Number(feed[0].reply_count)).toBe(2);
    expect(feed[0].last_reply_at).toBeTruthy();

    // ВЕТКА: корень и оба ответа
    const thread = (await http.get(`/api/chats/${chat.id}/threads/${root.id}`).set(O).expect(200)).body.data;
    expect(thread.length).toBe(3);
    expect(String(thread[0].id)).toBe(String(root.id));

    // «Также отправить в основной чат» — осознанное исключение
    await http.post(`/api/chats/${chat.id}/messages`).set(M)
      .send({ body: 'Всем: деплой откатили', threadRootId: String(root.id), alsoInChannel: true }).expect(201);
    const feed2 = (await http.get(`/api/chats/${chat.id}/messages`).set(O).expect(200)).body.data;
    expect(feed2.length).toBe(2);
    expect(feed2.some((m: any) => m.body === 'Всем: деплой откатили')).toBe(true);

    // ответ на ответ уходит в ту же ветку: дерева обсуждений не строим
    const reply = thread[1];
    await http.post(`/api/chats/${chat.id}/messages`).set(O)
      .send({ body: 'Спасибо', threadRootId: String(reply.id) }).expect(201);
    const thread2 = (await http.get(`/api/chats/${chat.id}/threads/${root.id}`).set(O).expect(200)).body.data;
    expect(thread2.length).toBe(5);
    expect(thread2.every((m: any) => !m.thread_root_id || String(m.thread_root_id) === String(root.id))).toBe(true);
  }, 40000);

  it('раздел «Треды»: своя ветка с чужими ответами, открытие гасит счётчик', async () => {
    const owner = (await http.post('/api/auth/register')
      .send({ tenantName: 'TH2', email: `t2_${uniq()}@t.test`, password: 'password123', fullName: 'Ольга' })
      .expect(201)).body.data;
    const mateEmail = `t2_m_${uniq()}@t.test`;
    const mate = (await http.post('/api/users').set(H(owner.accessToken))
      .send({ email: mateEmail, fullName: 'Пётр', password: 'password123', role: 'member' })
      .expect(201)).body.data;
    const mateLogin = (await http.post('/api/auth/login')
      .send({ email: mateEmail, password: 'password123' }).expect(201)).body.data;
    const O = H(owner.accessToken);
    const M = H(mateLogin.accessToken);

    const chat = (await http.post('/api/chats/dm').set(O).send({ userId: mate.id }).expect(201)).body.data;
    const root = (await http.post(`/api/chats/${chat.id}/messages`).set(O)
      .send({ body: 'Вопрос по авторизации' }).expect(201)).body.data;

    // пока ответов нет, ветки нет и в разделе
    expect((await http.get('/api/chats/threads').set(O).expect(200)).body.data.length).toBe(0);

    await http.post(`/api/chats/${chat.id}/messages`).set(M)
      .send({ body: 'Отвечаю', threadRootId: String(root.id) }).expect(201);

    // автор корня видит ветку с одним НОВЫМ ответом
    const mine = (await http.get('/api/chats/threads').set(O).expect(200)).body.data;
    expect(mine.length).toBe(1);
    expect(String(mine[0].root_id)).toBe(String(root.id));
    expect(Number(mine[0].unread)).toBe(1);
    expect(Number(mine[0].reply_count)).toBe(1);

    // открыл ветку — новых ответов нет
    await http.get(`/api/chats/${chat.id}/threads/${root.id}`).set(O).expect(200);
    const after = (await http.get('/api/chats/threads').set(O).expect(200)).body.data;
    expect(Number(after[0].unread)).toBe(0);

    // свой собственный ответ новостью для себя не становится
    await http.post(`/api/chats/${chat.id}/messages`).set(O)
      .send({ body: 'Понял', threadRootId: String(root.id) }).expect(201);
    const afterOwn = (await http.get('/api/chats/threads').set(O).expect(200)).body.data;
    expect(Number(afterOwn[0].unread)).toBe(0);

    // отвечавший тоже видит эту ветку у себя — он в ней участвует
    const mateThreads = (await http.get('/api/chats/threads').set(M).expect(200)).body.data;
    expect(mateThreads.some((t: any) => String(t.root_id) === String(root.id))).toBe(true);
  }, 40000);

  /**
   * Реакции и закрепления.
   *
   * Реакция — переключатель и знак, а не событие: ни уведомлений, ни записи в историю.
   * Закрепление видно обоим собеседникам сразу: доступы к серверу ищут прокруткой на
   * сотню сообщений назад, и ради этого закрепление и существует.
   */
  it('реакция переключается и видна обоим; закрепление живёт в шапке чата', async () => {
    const owner = (await http.post('/api/auth/register')
      .send({ tenantName: 'RP', email: `rp_${uniq()}@t.test`, password: 'password123', fullName: 'Ольга' })
      .expect(201)).body.data;
    const mateEmail = `rp_m_${uniq()}@t.test`;
    const mate = (await http.post('/api/users').set(H(owner.accessToken))
      .send({ email: mateEmail, fullName: 'Пётр', password: 'password123', role: 'member' })
      .expect(201)).body.data;
    const mateLogin = (await http.post('/api/auth/login')
      .send({ email: mateEmail, password: 'password123' }).expect(201)).body.data;
    const O = H(owner.accessToken);
    const M = H(mateLogin.accessToken);

    const chat = (await http.post('/api/chats/dm').set(O).send({ userId: mate.id }).expect(201)).body.data;
    const msg = (await http.post(`/api/chats/${chat.id}/messages`).set(O)
      .send({ body: 'Доступ к тестовому серверу: test / 12345' }).expect(201)).body.data;

    // собеседник поддержал знаком
    await http.post(`/api/chats/${chat.id}/messages/${msg.id}/reactions`).set(M).send({ emoji: '👍' }).expect(201);
    const seenByMate = (await http.get(`/api/chats/${chat.id}/messages`).set(M).expect(200)).body.data[0];
    expect(seenByMate.reactions).toEqual([{ emoji: '👍', count: 1, mine: true }]);
    // автору видно ту же реакцию, но она не его
    const seenByOwner = (await http.get(`/api/chats/${chat.id}/messages`).set(O).expect(200)).body.data[0];
    expect(seenByOwner.reactions[0].mine).toBe(false);
    expect(seenByOwner.reactions[0].count).toBe(1);

    // повторное нажатие снимает свою
    await http.post(`/api/chats/${chat.id}/messages/${msg.id}/reactions`).set(M).send({ emoji: '👍' }).expect(201);
    const cleared = (await http.get(`/api/chats/${chat.id}/messages`).set(M).expect(200)).body.data[0];
    expect(cleared.reactions).toEqual([]);

    // закрепление видно обоим
    expect((await http.get(`/api/chats/${chat.id}/pinned`).set(M).expect(200)).body.data.length).toBe(0);
    await http.post(`/api/chats/${chat.id}/messages/${msg.id}/pin`).set(M).send({ pinned: true }).expect(201);
    const pins = (await http.get(`/api/chats/${chat.id}/pinned`).set(O).expect(200)).body.data;
    expect(pins.length).toBe(1);
    expect(String(pins[0].id)).toBe(String(msg.id));

    // и снимается любым участником — закрепление обратимо
    await http.post(`/api/chats/${chat.id}/messages/${msg.id}/pin`).set(O).send({ pinned: false }).expect(201);
    expect((await http.get(`/api/chats/${chat.id}/pinned`).set(O).expect(200)).body.data.length).toBe(0);

    // чужой чат недоступен: правила изоляции важнее любых реакций
    const other = (await http.post('/api/auth/register')
      .send({ tenantName: 'RP2', email: `rp2_${uniq()}@t.test`, password: 'password123', fullName: 'Чужой' })
      .expect(201)).body.data;
    await http.post(`/api/chats/${chat.id}/messages/${msg.id}/reactions`)
      .set(H(other.accessToken)).send({ emoji: '👍' }).expect(404);
  }, 40000);
});
