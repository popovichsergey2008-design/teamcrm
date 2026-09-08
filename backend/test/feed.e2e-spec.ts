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

  /**
   * Кто пишет новости.
   *
   * Лента компании — издание, а не общая стена: публикуют руководитель и тот, кому это
   * доверено ДОЛЖНОСТЬЮ (пресс-секретарь). Читают и комментируют все — лента без
   * обсуждения превращается в доску объявлений в подъезде.
   */
  it('новости пишет руководитель и должность с правом, читают все', async () => {
    const owner = await org('Права ленты');
    const mate = await employee(owner.accessToken);

    // рядовой сотрудник по умолчанию не публикует ничего
    await http$.post('/api/feed').set(H(mate.token))
      .send({ body: 'Важное от рядового', isAnnouncement: true }).expect(403);
    await http$.post('/api/feed').set(H(mate.token))
      .send({ body: 'Кто-нибудь видел мою кружку?' }).expect(403);
    expect((await http$.get('/api/feed').set(H(mate.token)).expect(200)).body.data.canPost).toBe(false);

    // владелец заводит должность «Пресс-секретарь», даёт ей право и назначает человеку
    const position = (await http$.post('/api/positions').set(H(owner.accessToken))
      .send({ name: `Пресс-секретарь ${uniq()}` }).expect(201)).body.data;
    await http$.patch(`/api/positions/${position.id}/news-right`).set(H(owner.accessToken))
      .send({ canPostNews: true }).expect(200);
    await http$.patch(`/api/users/${mate.user.id}`).set(H(owner.accessToken))
      .send({ positionId: String(position.id) }).expect(200);

    // теперь он публикует — и знает об этом до того, как напишет текст
    expect((await http$.get('/api/feed').set(H(mate.token)).expect(200)).body.data.canPost).toBe(true);
    const normal = (await http$.post('/api/feed').set(H(mate.token))
      .send({ body: 'Во вторник переезжаем в новый офис' }).expect(201)).body.data;
    expect(normal.isAnnouncement).toBe(false);
    // но объявление с подтверждением прочтения — по-прежнему право руководства
    await http$.post('/api/feed').set(H(mate.token))
      .send({ body: 'Важное', isAnnouncement: true }).expect(403);

    // право снимается вместе с галочкой у должности — человека трогать не нужно
    await http$.patch(`/api/positions/${position.id}/news-right`).set(H(owner.accessToken))
      .send({ canPostNews: false }).expect(200);
    await http$.post('/api/feed').set(H(mate.token)).send({ body: 'Ещё новость' }).expect(403);

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
    expect(comments.items).toHaveLength(1);
    expect(comments.items[0].body).toBe('А во сколько?');
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

  it('вложение видно в ленте, приложить его к чужому посту нельзя', async () => {
    const owner = await org('Вложения');
    const mate = await employee(owner.accessToken);

    const post = (await http$.post('/api/feed').set(H(owner.accessToken))
      .send({ body: 'Инструкция по пропускам' }).expect(201)).body.data;

    await http$.post(`/api/feed/${post.id}/files`).set(H(owner.accessToken))
      .attach('file', Buffer.from('порядок выдачи пропусков'), 'propuska.txt')
      .expect(201);

    const list = (await http$.get('/api/feed').set(H(mate.token)).expect(200)).body.data.items;
    const mine = list.find((p: any) => String(p.id) === String(post.id));
    expect(mine.files).toHaveLength(1);
    expect(mine.files[0].name).toBe('propuska.txt');
    expect(Number(mine.files[0].size)).toBeGreaterThan(0);

    // чужая стена: дополнить чужое сообщение файлом рядовой сотрудник не может
    await http$.post(`/api/feed/${post.id}/files`).set(H(mate.token))
      .attach('file', Buffer.from('что-то своё'), 'chuzhoe.txt')
      .expect(403);
  });

  /**
   * Постраничность ленты.
   *
   * Новости читают не только сегодняшние: к объявлению месячной давности возвращаются,
   * и добираться до него прокруткой на сотню постов невозможно. Проверяем то, на чём
   * такие списки ошибаются: размер страницы, общее число и отсутствие нахлёста между
   * страницами.
   */
  it('лента листается по десять, страницы не перекрываются', async () => {
    const owner = await org(`Постранично ${uniq()}`);
    for (let i = 1; i <= 12; i++) {
      await http$.post('/api/feed').set(H(owner.accessToken))
        .send({ body: `Новость номер ${i}` }).expect(201);
    }

    const first = (await http$.get('/api/feed').set(H(owner.accessToken)).expect(200)).body.data;
    expect(first.items).toHaveLength(10);
    expect(first.total).toBe(12);
    expect(first.pages).toBe(2);
    expect(first.page).toBe(1);

    const second = (await http$.get('/api/feed?page=2').set(H(owner.accessToken)).expect(200)).body.data;
    expect(second.items).toHaveLength(2);
    expect(second.page).toBe(2);

    // ни одна новость не попадает на обе страницы сразу
    const ids = [...first.items, ...second.items].map((p: any) => String(p.id));
    expect(new Set(ids).size).toBe(12);
    // и порядок сохраняется: свежее — первым
    expect(first.items[0].body).toBe('Новость номер 12');
    expect(second.items[1].body).toBe('Новость номер 1');
  });

  /**
   * Длинное обсуждение.
   *
   * Комментарии читают с конца: важно, чем всё кончилось, а не начало переписки
   * трёхмесячной давности. Поэтому отдаём хвост и даём поднять предыдущие — и
   * проверяем ровно это, включая порядок и отсутствие нахлёста.
   */
  it('комментарии отдаются последними десятью, предыдущие поднимаются', async () => {
    const owner = await org(`Обсуждение ${uniq()}`);
    const post = (await http$.post('/api/feed').set(H(owner.accessToken))
      .send({ body: 'Есть что обсудить' }).expect(201)).body.data;

    for (let i = 1; i <= 13; i++) {
      await http$.post(`/api/feed/${post.id}/comments`).set(H(owner.accessToken))
        .send({ body: `Реплика ${i}` }).expect(201);
    }

    const last = (await http$.get(`/api/feed/${post.id}/comments`).set(H(owner.accessToken)).expect(200)).body.data;
    expect(last.items).toHaveLength(10);
    expect(last.total).toBe(13);
    expect(last.hasMore).toBe(true);
    // хвост, а не начало: последняя реплика внизу, порядок обычный — сверху вниз
    expect(last.items[0].body).toBe('Реплика 4');
    expect(last.items[9].body).toBe('Реплика 13');

    const earlier = (await http$.get(`/api/feed/${post.id}/comments?before=${last.items[0].id}`)
      .set(H(owner.accessToken)).expect(200)).body.data;
    expect(earlier.items.map((c: any) => c.body)).toEqual(['Реплика 1', 'Реплика 2', 'Реплика 3']);
    expect(earlier.hasMore).toBe(false); // выше уже ничего нет
  });

  it('упоминание чужого человека публикацию не ломает', async () => {
    const a = await org('Упоминания А');
    const b = await org('Упоминания Б');

    // id из другой организации до рассылки не доходит, но и падать на нём нельзя:
    // список упомянутых приходит от клиента, а клиенту верить нельзя ни в чём
    const post = (await http$.post('/api/feed').set(H(a.accessToken))
      .send({ body: `Вопрос к @${b.user.fullName}`, mentionIds: [String(b.user.id)] }).expect(201)).body.data;
    expect(post.body).toContain('Вопрос к');

    const mate = await employee(a.accessToken);
    await http$.post(`/api/feed/${post.id}/comments`).set(H(a.accessToken))
      .send({ body: `@${mate.user.fullName}, посмотрите`, mentionIds: [String(mate.user.id)] }).expect(201);
    const comments = (await http$.get(`/api/feed/${post.id}/comments`).set(H(mate.token)).expect(200)).body.data;
    expect(comments.items[0].body).toContain('посмотрите');
  });
});
