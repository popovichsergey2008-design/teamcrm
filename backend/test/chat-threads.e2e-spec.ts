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

  it('обычный ответ остаётся в ленте с цитатой и веткой не считается', async () => {
    const owner = (await http.post('/api/auth/register')
      .send({ tenantName: 'RP', email: `rp_${uniq()}@t.test`, password: 'password123', fullName: 'Ольга Владелец' })
      .expect(201)).body.data;
    const mateEmail = `rp_m_${uniq()}@t.test`;
    const mate = (await http.post('/api/users').set(H(owner.accessToken))
      .send({ email: mateEmail, fullName: 'Пётр Коллега', password: 'password123', role: 'member' })
      .expect(201)).body.data;
    const mateLogin = (await http.post('/api/auth/login')
      .send({ email: mateEmail, password: 'password123' }).expect(201)).body.data;
    const O = H(owner.accessToken);
    const M = H(mateLogin.accessToken);

    const chat = (await http.post('/api/chats/dm').set(O).send({ userId: mate.id }).expect(201)).body.data;
    const src = (await http.post(`/api/chats/${chat.id}/messages`).set(O)
      .send({ body: 'Ещё нету по всс?' }).expect(201)).body.data;

    // обычный ответ: остаётся в ленте, цитирует исходное
    await http.post(`/api/chats/${chat.id}/messages`).set(M)
      .send({ body: 'еще нет, еще кручу саму фдпу', replyToId: String(src.id) }).expect(201);
    // и ветка — отдельно от него
    await http.post(`/api/chats/${chat.id}/messages`).set(M)
      .send({ body: 'вынесем в ветку', threadRootId: String(src.id) }).expect(201);

    const feed = (await http.get(`/api/chats/${chat.id}/messages`).set(O).expect(200)).body.data;
    // в ленте исходное и обычный ответ; ответ из ветки сюда не попал
    expect(feed).toHaveLength(2);
    const answer = feed[1];
    expect(String(answer.reply_to_id)).toBe(String(src.id));
    expect(answer.reply_body).toBe('Ещё нету по всс?');
    expect(answer.reply_author).toBe('Ольга Владелец');
    expect(answer.thread_root_id).toBeNull();
    // счётчик ветки считает только ветку: обычный ответ его не трогает
    expect(Number(feed[0].reply_count)).toBe(1);
  });

  it('цитата из чужого чата не подтягивается', async () => {
    const owner = (await http.post('/api/auth/register')
      .send({ tenantName: 'RP2', email: `rp2_${uniq()}@t.test`, password: 'password123', fullName: 'Ольга Владелец' })
      .expect(201)).body.data;
    const mateEmail = `rp2_m_${uniq()}@t.test`;
    const mate = (await http.post('/api/users').set(H(owner.accessToken))
      .send({ email: mateEmail, fullName: 'Пётр Коллега', password: 'password123', role: 'member' })
      .expect(201)).body.data;
    const O = H(owner.accessToken);

    const dm = (await http.post('/api/chats/dm').set(O).send({ userId: mate.id }).expect(201)).body.data;
    const other = (await http.post('/api/chats/groups').set(O).send({ title: 'Другой', userIds: [String(mate.id)] }).expect(201)).body.data;
    const alien = (await http.post(`/api/chats/${other.id}/messages`).set(O).send({ body: 'чужая реплика' }).expect(201)).body.data;

    const res = (await http.post(`/api/chats/${dm.id}/messages`).set(O)
      .send({ body: 'ответ не туда', replyToId: String(alien.id) }).expect(201)).body.data;
    expect(res.reply_to_id ?? null).toBeNull();
  });

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

  /**
   * Слой 2: ничего не теряется.
   *
   * Сохранённое — для того, из чего не получается задача. Напоминание — потому что
   * читают сообщения когда пришли, а делают по ним позже. Упоминание — единственный
   * способ достучаться в чате, где сто сообщений в день. «Входящие» собирают всё это
   * в одну ленту, чтобы не обходить тридцать переписок.
   */
  it('сохранённое, напоминание, упоминание и «Входящие» одной лентой', async () => {
    const owner = (await http.post('/api/auth/register')
      .send({ tenantName: 'L2', email: `l2_${uniq()}@t.test`, password: 'password123', fullName: 'Ольга' })
      .expect(201)).body.data;
    const mateEmail = `l2_m_${uniq()}@t.test`;
    const mate = (await http.post('/api/users').set(H(owner.accessToken))
      .send({ email: mateEmail, fullName: 'Пётр', password: 'password123', role: 'member' })
      .expect(201)).body.data;
    const mateLogin = (await http.post('/api/auth/login')
      .send({ email: mateEmail, password: 'password123' }).expect(201)).body.data;
    const O = H(owner.accessToken);
    const M = H(mateLogin.accessToken);

    const chat = (await http.post('/api/chats/dm').set(O).send({ userId: mate.id }).expect(201)).body.data;

    // упоминание: владелец зовёт коллегу по имени
    const called = (await http.post(`/api/chats/${chat.id}/messages`).set(O)
      .send({ body: '@Пётр посмотри доступы', mentionIds: [String(mate.id)] }).expect(201)).body.data;

    /*
      У коллеги это в «Входящих» и помечено как новое.

      Счётчик при открытии сразу ноль — раздел показал упоминания, значит человек их
      увидел. Раньше цифра гасла только в отдельном разделе «Упоминания», куда этот
      экран не ходит, и висела вечно: ровно на это и жаловались. Новизну показывает
      не счётчик, а пустой seen_at у строк — они и подсвечиваются.
    */
    const inbox = (await http.get('/api/chats/inbox').set(M).expect(200)).body.data;
    expect(inbox.counts.mentions).toBe(0);
    const mine = inbox.mentions.find((m: any) => String(m.id) === String(called.id));
    expect(mine).toBeTruthy();
    expect(mine.seen_at).toBeNull();
    // личная переписка там же: «Входящие» — это то, что адресовано лично мне
    expect(inbox.dms.length).toBe(1);

    // при следующем открытии упоминание уже не новое
    const again = (await http.get('/api/chats/inbox').set(M).expect(200)).body.data;
    expect(again.counts.mentions).toBe(0);
    expect(again.mentions.find((m: any) => String(m.id) === String(called.id)).seen_at).toBeTruthy();

    /*
      Обычное сообщение в ОБЩИЙ чат во «Входящие» не попадает.

      Просьба заказчика: раздел светится только личным. Проверяем прямо: пишем в
      групповой чат без упоминаний — и во «Входящих» у коллеги пусто, хотя на самом
      чате непрочитанное есть.
    */
    const group = (await http.post('/api/chats/groups').set(O)
      .send({ title: 'Общий', userIds: [String(mate.id)] }).expect(201)).body.data;
    await http.post(`/api/chats/${group.id}/messages`).set(O).send({ body: 'всем привет' }).expect(201);
    const quiet = (await http.get('/api/chats/inbox').set(M).expect(200)).body.data;
    expect(quiet.dms.some((c: any) => String(c.id) === String(group.id))).toBe(false);
    expect(quiet.replies.length).toBe(0);

    // а ОТВЕТ на моё сообщение — попадает: это обращение ко мне, просто без имени
    const mineMsg = (await http.post(`/api/chats/${group.id}/messages`).set(M)
      .send({ body: 'я займусь стендом' }).expect(201)).body.data;
    await http.post(`/api/chats/${group.id}/messages`).set(O)
      .send({ body: 'спасибо, жду', replyToId: String(mineMsg.id) }).expect(201);
    const answered = (await http.get('/api/chats/inbox').set(M).expect(200)).body.data;
    expect(answered.replies.length).toBe(1);
    expect(answered.replies[0].my_body).toBe('я займусь стендом');

    // себя упоминанием не зовут: оповещать человека о собственном сообщении незачем
    await http.post(`/api/chats/${chat.id}/messages`).set(O)
      .send({ body: 'Заметка вслух @Ольга', mentionIds: [String(owner.user.id)] }).expect(201);
    expect((await http.get('/api/chats/inbox').set(O).expect(200)).body.data.counts.mentions).toBe(0);

    // сохранённое: переключатель, и сообщение видно в разделе
    await http.post(`/api/chats/${chat.id}/messages/${called.id}/save`).set(M).expect(201);
    const saved = (await http.get('/api/chats/saved').set(M).expect(200)).body.data;
    expect(saved.length).toBe(1);
    expect(String(saved[0].id)).toBe(String(called.id));
    await http.post(`/api/chats/${chat.id}/messages/${called.id}/save`).set(M).expect(201);
    expect((await http.get('/api/chats/saved').set(M).expect(200)).body.data.length).toBe(0);
    // сохранённое — личное: у второго человека его нет
    expect((await http.get('/api/chats/saved').set(O).expect(200)).body.data.length).toBe(0);

    // напоминание принимается только на будущее: на прошедшее оно сработало бы мгновенно
    const future = new Date(Date.now() + 3600_000).toISOString();
    await http.post(`/api/chats/${chat.id}/messages/${called.id}/remind`).set(M)
      .send({ remindAt: future }).expect(201);
    await http.post(`/api/chats/${chat.id}/messages/${called.id}/remind`).set(M)
      .send({ remindAt: new Date(Date.now() - 60_000).toISOString() }).expect(400);
    await http.post(`/api/chats/${chat.id}/messages/${called.id}/remind`).set(M)
      .send({ remindAt: 'вчера' }).expect(400);
  }, 40000);

  /**
   * Слой 3: разговор превращается в работу и не теряет источник.
   *
   * Самый частый способ появления задачи — фраза в переписке. Проверяем то, ради чего
   * связь и заводилась: по сообщению видно, что задача уже есть (иначе заведут вторую),
   * а по задаче — из какой фразы она выросла. И контекст чата проекта в шапке.
   */
  it('задача из сообщения: связь в обе стороны и защита от второй задачи', async () => {
    const owner = (await http.post('/api/auth/register')
      .send({ tenantName: 'L3', email: `l3_${uniq()}@t.test`, password: 'password123', fullName: 'Ольга' })
      .expect(201)).body.data;
    const O = H(owner.accessToken);

    const project = (await http.post('/api/projects').set(O).send({ name: 'Сайт' }).expect(201)).body.data;
    const chat = (await http.post(`/api/chats/project/${project.id}`).set(O).expect(201)).body.data;

    const msg = (await http.post(`/api/chats/${chat.id}/messages`).set(O)
      .send({ body: 'На мобильной версии блок съезжает и кнопка закрывает текст' }).expect(201)).body.data;

    // черновик ничего не создаёт — человек ещё правит формулировку
    const draft = (await http.post(`/api/chats/${chat.id}/messages/${msg.id}/task/draft`).set(O).expect(201)).body.data;
    expect(draft.task).toBeTruthy();
    expect(String(draft.task.title ?? '').length).toBeGreaterThan(2);

    const created = (await http.post(`/api/chats/${chat.id}/messages/${msg.id}/task`).set(O).send({
      projectId: String(project.id),
      title: 'Исправить блок на мобильной версии',
      description: 'Кнопка перекрывает текст',
      checklist: ['Проверить блок', 'Исправить адаптив'],
    }).expect(201)).body.data;
    expect(created.taskId).toBeTruthy();

    // на сообщении видно, что задача уже заведена
    const feed = (await http.get(`/api/chats/${chat.id}/messages`).set(O).expect(200)).body.data;
    const linked = feed.find((m: any) => String(m.id) === String(msg.id));
    expect(String(linked.task_id)).toBe(String(created.taskId));
    expect(linked.task_title).toBe('Исправить блок на мобильной версии');

    // вторую по той же фразе завести нельзя — иначе на разборе окажется два дубля
    await http.post(`/api/chats/${chat.id}/messages/${msg.id}/task`).set(O)
      .send({ projectId: String(project.id), title: 'Ещё раз то же самое' }).expect(409);

    // из задачи видно источник
    const src = (await http.get(`/api/chats/of-task/${created.taskId}`).set(O).expect(200)).body.data;
    expect(String(src.message_id)).toBe(String(msg.id));
    expect(String(src.chat_id)).toBe(String(chat.id));
    expect(src.body).toContain('мобильной версии');

    // шапка чата проекта знает, что это за чат
    const ctx = (await http.get(`/api/chats/${chat.id}/context`).set(O).expect(200)).body.data;
    expect(ctx.project_name).toBe('Сайт');
    expect(ctx.open_tasks).toBe(1);
    expect(ctx.overdue).toBe(0);

    // чек-лист из черновика доехал до задачи, а не остался в окне
    const steps = (await http.get(`/api/tasks/${created.taskId}/checklist`).set(O).expect(200)).body.data;
    expect(steps.length).toBe(2);
  }, 60000);

  /**
   * Задача из сообщения с уточнением: главный сценарий нового ТЗ.
   *
   * Поручение сказано в ГРУППОВОМ чате — проекта в нём нет, и угадывать его нельзя.
   * Значит: черновик ждёт, бот спрашивает автора прямо в чате, ответ автора обычной
   * репликой дозаполняет черновик, и только после этого задача создаётся. Проверяем
   * всю цепочку и то, ради чего она затевалась: черновик переживает перезагрузку
   * (лежит на сервере), второй по той же фразе не заводится, вложение уезжает в задачу.
   */
  it('задача из сообщения: бот спрашивает о проекте, ответ автора дозаполняет черновик', async () => {
    const owner = (await http.post('/api/auth/register')
      .send({ tenantName: 'Draft', email: `dr_${uniq()}@t.test`, password: 'password123', fullName: 'Ольга' })
      .expect(201)).body.data;
    const O = H(owner.accessToken);
    const project = (await http.post('/api/projects').set(O).send({ name: 'Панорама' }).expect(201)).body.data;
    await http.post('/api/projects').set(O).send({ name: 'Складской учёт' }).expect(201);

    // Групповой чат: проекта у него нет — значит, определить его можно только из текста.
    const chat = (await http.post('/api/chats/groups').set(O)
      .send({ title: 'Общий', userIds: [] }).expect(201)).body.data;
    const msg = (await http.post(`/api/chats/${chat.id}/messages`).set(O)
      .send({ body: 'Фильтр на мобилке открывается криво, сделай чтобы снизу выезжал' }).expect(201)).body.data;

    const started = (await http.post(`/api/chats/${chat.id}/messages/${msg.id}/task-draft`).set(O).expect(201)).body.data;
    expect(started.draft.draftId).toBeTruthy();
    expect(started.draft.status).toBe('needs_clarification'); // проект не назван — ждём ответа
    expect(started.draft.projectId).toBeFalsy();
    const draftId = started.draft.draftId;

    // Повторное нажатие не плодит второй черновик по той же фразе.
    const again = (await http.post(`/api/chats/${chat.id}/messages/${msg.id}/task-draft`).set(O).expect(201)).body.data;
    expect(again.draft.draftId).toBe(draftId);

    // Бот спрашивает в том же чате — вопрос виден в ленте.
    await http.post(`/api/chats/task-drafts/${draftId}/ask`).set(O).expect(201);
    const feed = (await http.get(`/api/chats/${chat.id}/messages`).set(O).expect(200)).body.data;
    const question = feed.find((m: any) => m.is_ai && String(m.body).includes('какому проекту'));
    expect(question).toBeTruthy();

    // Автор отвечает обычной репликой — и черновик дозаполняется сам.
    await http.post(`/api/chats/${chat.id}/messages`).set(O).send({ body: 'Панорама' }).expect(201);
    await new Promise((r) => setTimeout(r, 500)); // ответ разбирается в стороне от отправки
    const afterAnswer = (await http.get(`/api/chats/task-drafts/${draftId}`).set(O).expect(200)).body.data;
    expect(String(afterAnswer.draft.projectId)).toBe(String(project.id));
    expect(afterAnswer.draft.status).toBe('ready');

    // Черновик живёт на сервере: он есть в списке открытых по чату (это и переживает F5).
    const open = (await http.get(`/api/chats/${chat.id}/task-drafts`).set(O).expect(200)).body.data;
    expect(open.items.some((d: any) => String(d.draftId) === String(draftId))).toBe(true);

    // Постановщик поправил название — правка уходит на сервер, а не живёт в окне.
    await http.patch(`/api/chats/task-drafts/${draftId}`).set(O)
      .send({ title: 'Исправить мобильный фильтр' }).expect(200);

    const done = (await http.post(`/api/chats/task-drafts/${draftId}/confirm`).set(O).expect(201)).body.data;
    expect(done.taskId).toBeTruthy();
    expect(done.already).toBe(false);
    // Повтор возвращает ТУ ЖЕ задачу, а не создаёт вторую: защита от двойного нажатия.
    const repeat = (await http.post(`/api/chats/task-drafts/${draftId}/confirm`).set(O).expect(201)).body.data;
    expect(String(repeat.taskId)).toBe(String(done.taskId));
    expect(repeat.already).toBe(true);

    // Под сообщением видна задача, у задачи — исходная фраза.
    const feed2 = (await http.get(`/api/chats/${chat.id}/messages`).set(O).expect(200)).body.data;
    const linked = feed2.find((m: any) => String(m.id) === String(msg.id));
    expect(String(linked.task_id)).toBe(String(done.taskId));
    const src = (await http.get(`/api/chats/of-task/${done.taskId}`).set(O).expect(200)).body.data;
    expect(src.body).toContain('Фильтр на мобилке');

    // Черновик закрыт: строка «идёт работа» под сообщением больше не нужна.
    const openAfter = (await http.get(`/api/chats/${chat.id}/task-drafts`).set(O).expect(200)).body.data;
    expect(openAfter.items.some((d: any) => String(d.draftId) === String(draftId))).toBe(false);
  }, 90000);

  /**
   * Слой 4: каналы, избранное, чат с собой.
   *
   * Главное правило каналов — приватный не должен даже упоминаться у того, кому он
   * не открыт: витрина отдаёт только публичные, и вступить в закрытый нельзя.
   */
  it('каналы: публичный виден и открыт, закрытый не виден и не пускает', async () => {
    const owner = (await http.post('/api/auth/register')
      .send({ tenantName: 'L4', email: `l4_${uniq()}@t.test`, password: 'password123', fullName: 'Ольга' })
      .expect(201)).body.data;
    const mateEmail = `l4_m_${uniq()}@t.test`;
    await http.post('/api/users').set(H(owner.accessToken))
      .send({ email: mateEmail, fullName: 'Пётр', password: 'password123', role: 'member' }).expect(201);
    const mateLogin = (await http.post('/api/auth/login')
      .send({ email: mateEmail, password: 'password123' }).expect(201)).body.data;
    const O = H(owner.accessToken);
    const M = H(mateLogin.accessToken);

    const open = (await http.post('/api/chats/channels').set(O)
      .send({ title: 'разработка', description: 'Технические вопросы', isPrivate: false }).expect(201)).body.data;
    const closed = (await http.post('/api/chats/channels').set(O)
      .send({ title: 'руководство', isPrivate: true }).expect(201)).body.data;

    // витрина: публичный виден всем, закрытого в ней нет вовсе
    const shelf = (await http.get('/api/chats/channels').set(M).expect(200)).body.data;
    expect(shelf.some((c: any) => String(c.id) === String(open.id))).toBe(true);
    expect(shelf.some((c: any) => String(c.id) === String(closed.id))).toBe(false);
    expect(shelf.find((c: any) => String(c.id) === String(open.id)).joined).toBe(false);

    // до вступления канал недоступен на чтение
    await http.get(`/api/chats/${open.id}/messages`).set(M).expect(403);
    await http.post(`/api/chats/${open.id}/join`).set(M).expect(201);
    await http.get(`/api/chats/${open.id}/messages`).set(M).expect(200);

    // в закрытый канал войти нельзя — иначе «приватный» просто слово в интерфейсе
    await http.post(`/api/chats/${closed.id}/join`).set(M).expect(403);

    // канал появился в списке чатов вступившего
    const list = (await http.get('/api/chats').set(M).expect(200)).body.data;
    expect(list.some((c: any) => String(c.id) === String(open.id))).toBe(true);

    // избранное: переключатель и личное — у второго человека своё
    await http.post(`/api/chats/${open.id}/favorite`).set(M).expect(201);
    const withFav = (await http.get('/api/chats').set(M).expect(200)).body.data;
    expect(withFav.find((c: any) => String(c.id) === String(open.id)).favorite).toBe(true);
    const ownerList = (await http.get('/api/chats').set(O).expect(200)).body.data;
    expect(ownerList.find((c: any) => String(c.id) === String(open.id)).favorite).toBe(false);

    // чат с собой: сколько ни нажимай — он один
    const notes1 = (await http.post('/api/chats/self').set(M).expect(201)).body.data;
    const notes2 = (await http.post('/api/chats/self').set(M).expect(201)).body.data;
    expect(String(notes1.id)).toBe(String(notes2.id));
    await http.post(`/api/chats/${notes1.id}/messages`).set(M).send({ body: 'пароль от стенда' }).expect(201);
    // и он личный: чужие заметки недоступны
    await http.get(`/api/chats/${notes1.id}/messages`).set(O).expect(403);
  }, 60000);

  /**
   * Слой 6: помощник внутри переписки.
   *
   * Проверяем не качество ответов (на CI отвечает заглушка), а правило, которое важнее
   * любого качества: ИИ видит только то, что видит спрашивающий. Ответ по чужой
   * переписке — не удобство, а утечка.
   */
  it('@AI отвечает в чат, а поиск не заглядывает в чужую переписку', async () => {
    const owner = (await http.post('/api/auth/register')
      .send({ tenantName: 'L6', email: `l6_${uniq()}@t.test`, password: 'password123', fullName: 'Ольга' })
      .expect(201)).body.data;
    const mateEmail = `l6_m_${uniq()}@t.test`;
    const mate = (await http.post('/api/users').set(H(owner.accessToken))
      .send({ email: mateEmail, fullName: 'Пётр', password: 'password123', role: 'member' })
      .expect(201)).body.data;
    const mateLogin = (await http.post('/api/auth/login')
      .send({ email: mateEmail, password: 'password123' }).expect(201)).body.data;
    const O = H(owner.accessToken);
    const M = H(mateLogin.accessToken);

    const chat = (await http.post('/api/chats/dm').set(O).send({ userId: mate.id }).expect(201)).body.data;
    await http.post(`/api/chats/${chat.id}/messages`).set(O)
      .send({ body: 'Договорились переносить релиз на пятницу' }).expect(201);

    // ответ помощника ложится в тот же чат и помечен как ответ ИИ
    const answer = (await http.post(`/api/chats/${chat.id}/ai`).set(M)
      .send({ question: 'что решили по релизу?' }).expect(201)).body.data;
    expect(String(answer.body ?? '').length).toBeGreaterThan(3);
    const feed = (await http.get(`/api/chats/${chat.id}/messages`).set(O).expect(200)).body.data;
    const ai = feed.find((m: any) => String(m.id) === String(answer.id));
    expect(ai.is_ai).toBe(true);

    // сводка непрочитанного считает ЧУЖИЕ сообщения и ничего не помечает прочитанным
    const digest = (await http.post('/api/chats/ai/digest').set(M).expect(201)).body.data;
    expect(digest.messages).toBeGreaterThan(0);
    const stillUnread = (await http.get('/api/chats').set(M).expect(200)).body.data
      .find((c: any) => String(c.id) === String(chat.id));
    expect(Number(stillUnread.unread)).toBeGreaterThan(0);

    // ГЛАВНОЕ: закрытый разговор владельца в поиск сотрудника не попадает
    const secret = (await http.post('/api/chats/channels').set(O)
      .send({ title: 'руководство', isPrivate: true }).expect(201)).body.data;
    await http.post(`/api/chats/${secret.id}/messages`).set(O)
      .send({ body: 'Пароль от расчётного счёта менять в понедельник' }).expect(201);

    const mineSearch = (await http.post('/api/chats/ai/search').set(M)
      .send({ query: 'пароль от расчётного счёта' }).expect(201)).body.data;
    expect(mineSearch.refs.every((r: any) => String(r.chatId) !== String(secret.id))).toBe(true);

    // а владельцу его же переписка находится
    const ownerSearch = (await http.post('/api/chats/ai/search').set(O)
      .send({ query: 'пароль от расчётного счёта' }).expect(201)).body.data;
    expect(ownerSearch.refs.some((r: any) => String(r.chatId) === String(secret.id))).toBe(true);

    // и спросить помощника про чужой чат нельзя
    await http.post(`/api/chats/${secret.id}/ai`).set(M).send({ question: 'о чём тут' }).expect(403);
  }, 60000);

  /**
   * Слой 8: внешний разговор.
   *
   * Здесь проверяется единственное, что по-настоящему важно: ссылка открывает ОДИН
   * разговор и ничего больше. Ссылку пересылают, её теряют, она живёт неделями —
   * и всё это время она не должна давать доступ ни к чему, кроме своего чата.
   */
  it('внешний чат: ссылка открывает один разговор и не пускает во внутренние', async () => {
    const owner = (await http.post('/api/auth/register')
      .send({ tenantName: 'L8', email: `l8_${uniq()}@t.test`, password: 'password123', fullName: 'Ольга' })
      .expect(201)).body.data;
    const O = H(owner.accessToken);

    // внутренний разговор о клиенте и внешний с клиентом — РАЗНЫЕ чаты
    const project = (await http.post('/api/projects').set(O).send({ name: 'Вектор' }).expect(201)).body.data;
    const inner = (await http.post(`/api/chats/project/${project.id}`).set(O).expect(201)).body.data;
    await http.post(`/api/chats/${inner.id}/messages`).set(O)
      .send({ body: 'Клиент опять поменял требования' }).expect(201);

    const outer = (await http.post('/api/chats/external').set(O)
      .send({ title: 'ООО Вектор' }).expect(201)).body.data;
    await http.post(`/api/chats/${outer.id}/messages`).set(O)
      .send({ body: 'Добрый день! Показываем макет в пятницу' }).expect(201);

    // ссылка выдаётся под внешний разговор
    const link = (await http.post('/api/meet/guest-links').set(O)
      .send({ label: 'ООО Вектор', chatId: String(outer.id), ttlHours: 24 }).expect(201)).body.data;
    const token = String(link.url).split('/').pop();

    const guest = (await http.post(`/api/meet/guest/${token}/join`)
      .send({ name: 'Иван Петров' }).expect(201)).body.data;
    expect(String(guest.chatId)).toBe(String(outer.id));

    // гость видит свой разговор
    const seen = (await http.post('/api/meet/guest/chat/messages')
      .send({ token: guest.token }).expect(201)).body.data;
    expect(seen.some((m: any) => String(m.body).includes('макет в пятницу'))).toBe(true);
    // и НЕ видит внутреннего: там сказано то, что клиенту знать не следует
    expect(seen.some((m: any) => String(m.body).includes('поменял требования'))).toBe(false);

    // гость пишет — сотрудники видят это обычным сообщением с его именем
    await http.post('/api/meet/guest/chat/send')
      .send({ token: guest.token, body: 'Хорошо, ждём' }).expect(201);
    const feed = (await http.get(`/api/chats/${outer.id}/messages`).set(O).expect(200)).body.data;
    const fromGuest = feed.find((m: any) => m.guest_name);
    expect(fromGuest.guest_name).toBe('Иван Петров');
    expect(fromGuest.body).toBe('Хорошо, ждём');

    // выдуманный токен не открывает ничего
    await http.post('/api/meet/guest/chat/messages').send({ token: 'подделка' }).expect(401);

    // и внутренний чат остаётся внутренним: по ссылке в него не попасть
    const innerLink = (await http.post('/api/meet/guest-links').set(O)
      .send({ chatId: String(inner.id), ttlHours: 24 }).expect(201)).body.data;
    const innerToken = String(innerLink.url).split('/').pop();
    const innerGuest = (await http.post(`/api/meet/guest/${innerToken}/join`)
      .send({ name: 'Чужой' }).expect(201)).body.data;
    await http.post('/api/meet/guest/chat/messages').send({ token: innerGuest.token }).expect(403);
  }, 60000);
});
