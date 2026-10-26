import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AddressInfo } from 'net';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { AllExceptionsFilter } from '../src/common/http/all-exceptions.filter';
import { ResponseInterceptor } from '../src/common/http/response.interceptor';
import { RedisIoAdapter } from '../src/common/auth/redis-io.adapter';
import { DbService } from '../src/database/db.service';
import { NewsAgentService } from '../src/modules/feed/news-agent.service';

/**
 * «Новости» (ТЗ-20): лента значимых событий компании — объявления с «Ознакомился»,
 * спасибо, опросы, релизы и вехи, хайлайт дня. Сценарии — из §106 ТЗ.
 */
describe('Новости (e2e)', () => {
  let app: INestApplication;
  let http$: any;
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
    http$ = request(`http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`);
    db = app.get(DbService);
  });
  afterAll(async () => { await app?.close(); });

  const org = async (name: string) => (await http$.post('/api/auth/register')
    .send({ acceptPrivacy: true, tenantName: name, email: `own_${uniq()}@t.test`, password: 'password123', fullName: 'Владелец' })
    .expect(201)).body.data;

  const employee = async (ownerToken: string, name = 'Сотрудник', role = 'member') => {
    const email = `u_${uniq()}@t.test`;
    const user = (await http$.post('/api/users').set(H(ownerToken))
      .send({ email, fullName: name, password: 'password123', role }).expect(201)).body.data;
    const token = (await http$.post('/api/auth/login')
      .send({ email, password: 'password123' }).expect(201)).body.data.accessToken;
    return { user, token, id: String(user.id) };
  };

  const feed = async (token: string, q = '') => (await http$.get(`/api/feed${q}`).set(H(token)).expect(200)).body.data;
  const unread = async (token: string) => (await http$.get('/api/feed/unread').set(H(token)).expect(200)).body.data.count;

  it('объявление: «Ознакомился», кто прочитал и кто нет, комментарий засчитывается', async () => {
    const owner = await org('Объявления');
    const O = owner.accessToken;
    const mate = await employee(O, 'Глеб');
    const anna = await employee(O, 'Анна');

    const post = (await http$.post('/api/feed').set(H(O))
      .send({ type: 'announcement', title: 'Переезд', body: 'В пятницу переезжаем в новый офис', ctaLabel: 'Схема', ctaUrl: 'https://example.com/map' })
      .expect(201)).body.data;
    expect(post.type).toBe('announcement');
    expect(post.requiresAck).toBe(true);
    expect(post.cta).toEqual({ label: 'Схема', url: 'https://example.com/map' });

    expect(await unread(mate.token)).toBe(1);
    expect(await unread(O)).toBe(0); // своё — не новое

    const before = (await http$.get(`/api/feed/${post.id}/readers`).set(H(O)).expect(200)).body.data;
    expect(before.total).toBe(2);
    expect(before.pending.map((p: any) => p.fullName).sort()).toEqual(['Анна', 'Глеб']);
    await http$.get(`/api/feed/${post.id}/readers`).set(H(mate.token)).expect(403);

    await http$.post(`/api/feed/${post.id}/ack`).set(H(mate.token)).expect(201);
    await http$.post(`/api/feed/${post.id}/comments`).set(H(anna.token)).send({ body: 'А парковка будет?' }).expect(201);
    const after = (await http$.get(`/api/feed/${post.id}/readers`).set(H(O)).expect(200)).body.data;
    expect(after.read).toHaveLength(2);
    expect(after.pending).toHaveLength(0);

    // посмотрел ленту — новое кончилось; объявление подтверждено — счётчик ноль
    await http$.post('/api/feed/seen').set(H(mate.token)).expect(201);
    expect(await unread(mate.token)).toBe(0);
    // сотруднику объявлять нельзя, ссылка в кнопке — только http(s) или путь
    await http$.post('/api/feed').set(H(mate.token)).send({ type: 'announcement', body: 'Важное' }).expect(403);
    await http$.post('/api/feed').set(H(O)).send({ type: 'announcement', body: 'X', ctaLabel: 'A', ctaUrl: 'javascript:alert(1)' }).expect(400);
  });

  it('права: новости — руководство и должность с правом; спасибо и опрос — каждый', async () => {
    const owner = await org('Права');
    const O = owner.accessToken;
    const mate = await employee(O, 'Глеб');
    await http$.post('/api/feed').set(H(mate.token)).send({ body: 'Кто видел мою кружку?' }).expect(403);
    const c1 = (await feed(mate.token)).can;
    expect(c1).toMatchObject({ post: false, announce: false, poll: true, kudos: true, approve: false });

    const position = (await http$.post('/api/positions').set(H(O)).send({ name: `Пресс-секретарь ${uniq()}` }).expect(201)).body.data;
    await http$.patch(`/api/positions/${position.id}/news-right`).set(H(O)).send({ canPostNews: true }).expect(200);
    await http$.patch(`/api/users/${mate.id}`).set(H(O)).send({ positionId: String(position.id) }).expect(200);
    expect((await feed(mate.token)).can.post).toBe(true);
    const p = (await http$.post('/api/feed').set(H(mate.token)).send({ body: 'Во вторник субботник' }).expect(201)).body.data;
    expect(p.can.edit).toBe(true);

    // чужой пост руководство правит и удаляет; сотрудник — нет
    const other = await employee(O, 'Анна');
    await http$.patch(`/api/feed/${p.id}`).set(H(other.token)).send({ body: 'Подменил' }).expect(403);
    const edited = (await http$.patch(`/api/feed/${p.id}`).set(H(O)).send({ body: 'Во вторник субботник в 10:00' }).expect(200)).body.data;
    expect(edited.body).toContain('10:00');
    expect(edited.editedAt).toBeTruthy();
  });

  it('видимость: отдел, закрытый проект, чужая организация — по номеру тоже не открыть', async () => {
    const owner = await org('Видимость');
    const O = owner.accessToken;
    const dev = await employee(O, 'Разработчик');
    const sales = await employee(O, 'Продажник');
    const group = (await http$.post('/api/groups').set(H(O)).send({ name: `Разработка ${uniq()}`, kind: 'department' }).expect(201)).body.data;
    await http$.post(`/api/groups/${group.id}/members`).set(H(O)).send({ userId: dev.id }).expect(201);

    const forDev = (await http$.post('/api/feed').set(H(O))
      .send({ body: 'Только разработке', visibility: 'department', groupIds: [String(group.id)] }).expect(201)).body.data;
    expect(forDev.visibility).toBe('department');
    await http$.get(`/api/feed/${forDev.id}`).set(H(dev.token)).expect(200);
    // раньше по номеру поста комментарии открывались кому угодно (ошибка 3 разбора)
    await http$.get(`/api/feed/${forDev.id}`).set(H(sales.token)).expect(404);
    await http$.get(`/api/feed/${forDev.id}/comments`).set(H(sales.token)).expect(404);
    await http$.post(`/api/feed/${forDev.id}/comments`).set(H(sales.token)).send({ body: 'Подсмотрел' }).expect(404);
    expect((await feed(sales.token)).items.some((x: any) => x.id === String(forDev.id))).toBe(false);

    // закрытый проект: «всем» превращается в «проекту» (§56)
    const project = (await http$.post('/api/projects').set(H(O)).send({ name: 'Тайный' }).expect(201)).body.data;
    await db.query(`UPDATE projects SET visibility = 'members' WHERE id = $1`, [project.id]);
    const secret = (await http$.post('/api/feed').set(H(O)).send({ body: 'Секретная веха', projectId: String(project.id) }).expect(201)).body.data;
    expect(secret.visibility).toBe('project');
    await http$.get(`/api/feed/${secret.id}`).set(H(dev.token)).expect(404);

    // «свои люди»
    const custom = (await http$.post('/api/feed').set(H(O)).send({ body: 'Лично вам', visibility: 'custom', userIds: [sales.id] }).expect(201)).body.data;
    await http$.get(`/api/feed/${custom.id}`).set(H(sales.token)).expect(200);
    await http$.get(`/api/feed/${custom.id}`).set(H(dev.token)).expect(404);

    const stranger = await org('Чужие');
    await http$.get(`/api/feed/${custom.id}`).set(H(stranger.accessToken)).expect(404);
    expect((await feed(stranger.accessToken)).items).toEqual([]);
  });

  it('лента: закреплённые сверху (не больше трёх), курсор, фильтр и поиск', async () => {
    const owner = await org('Лента');
    const O = owner.accessToken;
    const ids: string[] = [];
    for (let i = 1; i <= 20; i++) {
      ids.push(String((await http$.post('/api/feed').set(H(O)).send({ body: `Новость номер ${i}` }).expect(201)).body.data.id));
    }
    for (const id of ids.slice(0, 3)) await http$.post(`/api/feed/${id}/pin`).set(H(O)).send({ pinned: true }).expect(201);
    await http$.post(`/api/feed/${ids[3]}/pin`).set(H(O)).send({ pinned: true }).expect(409);

    const first = await feed(O);
    expect(first.top.map((p: any) => p.id).sort()).toEqual(ids.slice(0, 3).sort());
    expect(first.items).toHaveLength(15);
    expect(first.items[0].body).toBe('Новость номер 20');
    expect(first.nextCursor).toBeTruthy();
    const second = await feed(O, `?before=${first.nextCursor}`);
    expect(second.top).toEqual([]);
    expect(second.items).toHaveLength(2); // 20 − 3 закреплённых − 15 на первой
    expect(second.nextCursor).toBeNull();
    const all = [...first.top, ...first.items, ...second.items].map((p: any) => p.id);
    expect(new Set(all).size).toBe(20);

    expect((await feed(O, `?q=${encodeURIComponent('номер 7')}`)).items.map((p: any) => p.body)).toEqual(['Новость номер 7']);
    expect((await feed(O, '?filter=polls')).items).toEqual([]);

    await http$.delete(`/api/feed/${ids[0]}`).set(H(O)).expect(200);
    expect((await feed(O)).top.some((p: any) => p.id === ids[0])).toBe(false);
  });

  it('спасибо: бейдж, уведомление получателю, реакции; себя — нельзя', async () => {
    const owner = await org('Спасибо');
    const O = owner.accessToken;
    const gleb = await employee(O, 'Глеб');
    const anna = await employee(O, 'Анна');
    await http$.post('/api/feed/kudos').set(H(anna.token)).send({ toUserId: anna.id, text: 'Себе молодец' }).expect(400);
    const k = (await http$.post('/api/feed/kudos').set(H(anna.token))
      .send({ toUserId: gleb.id, text: 'Спас релиз с интеграцией', badge: 'saver' }).expect(201)).body.data;
    expect(k.type).toBe('kudos');
    expect(k.kudos).toMatchObject({ toUserId: gleb.id, toName: 'Глеб', badge: { key: 'saver', label: 'Спаситель дня' } });
    expect(k.can.edit).toBe(false);

    // получатель узнаёт без почты — запись в ящике уведомлений
    // уведомление уходит в фоне (void thank) — ждём его, а не читаем сразу: иначе тест через раз падает гонкой
    let inbox: any[] = [];
    for (let i = 0; i < 30 && !inbox.length; i++) {
      inbox = await db.many(`SELECT * FROM notification_inbox WHERE user_id = $1 AND event_key = 'feed.kudos'`, [gleb.id]);
      if (!inbox.length) await new Promise((r) => setTimeout(r, 100));
    }
    expect(inbox).toHaveLength(1);
    expect(inbox[0].path).toBe(`/news/${k.id}`);

    const r1 = (await http$.post(`/api/feed/${k.id}/reactions`).set(H(gleb.token)).send({ reaction: '❤️' }).expect(201)).body.data;
    expect(r1.reactions).toEqual([{ emoji: '❤️', count: 1, mine: true }]);
    await http$.post(`/api/feed/${k.id}/reactions`).set(H(O)).send({ reaction: '❤️' }).expect(201);
    const r2 = (await http$.post(`/api/feed/${k.id}/reactions`).set(H(gleb.token)).send({ reaction: '❤️' }).expect(201)).body.data;
    expect(r2.reactions).toEqual([{ emoji: '❤️', count: 1, mine: false }]); // снял свою
    await http$.post(`/api/feed/${k.id}/reactions`).set(H(gleb.token)).send({ reaction: '💩' }).expect(400);
    expect((await feed(O, '?filter=kudos')).items.map((p: any) => p.id)).toEqual([k.id]);
  });

  it('опрос: голос, один вариант, анонимность, закрытие и итог', async () => {
    const owner = await org('Опросы');
    const O = owner.accessToken;
    const gleb = await employee(O, 'Глеб');
    const anna = await employee(O, 'Анна');
    await http$.post('/api/feed/polls').set(H(gleb.token)).send({ question: 'Во сколько разбор?', options: ['16:00', '16:00'] }).expect(400);
    const poll = (await http$.post('/api/feed/polls').set(H(gleb.token))
      .send({ question: 'Во сколько пятничный разбор?', options: ['16:00', '17:00'], anonymous: true }).expect(201)).body.data;
    const [o16, o17] = poll.poll.options;
    await http$.post(`/api/feed/${poll.id}/vote`).set(H(anna.token)).send({ optionIds: [o16.id, o17.id] }).expect(400);
    await http$.post(`/api/feed/${poll.id}/vote`).set(H(anna.token)).send({ optionIds: [o17.id] }).expect(201);
    const v = (await http$.post(`/api/feed/${poll.id}/vote`).set(H(O)).send({ optionIds: [o17.id] }).expect(201)).body.data;
    expect(v.poll.options.find((o: any) => o.id === o17.id)).toMatchObject({ votes: 2, mine: true });
    expect(v.poll.voters).toBe(2);
    // анонимный — кто как голосовал, не показываем никому, даже автору
    await http$.get(`/api/feed/${poll.id}/voters`).set(H(gleb.token)).expect(403);
    await http$.post(`/api/feed/${poll.id}/close`).set(H(anna.token)).expect(403);
    const closed = (await http$.post(`/api/feed/${poll.id}/close`).set(H(gleb.token)).expect(201)).body.data;
    expect(closed.poll.closed).toBe(true);
    expect(closed.poll.result).toBe('Победил вариант: 17:00');
    await http$.post(`/api/feed/${poll.id}/vote`).set(H(anna.token)).send({ optionIds: [o16.id] }).expect(409);

    // срок вышел — планировщик закрывает сам и сообщает автору итог
    const p2 = (await http$.post('/api/feed/polls').set(H(gleb.token)).send({ question: 'Пицца или суши?', options: ['Пицца', 'Суши'] }).expect(201)).body.data;
    await http$.post(`/api/feed/${p2.id}/vote`).set(H(anna.token)).send({ optionIds: [p2.poll.options[1].id] }).expect(201);
    await db.query(`UPDATE feed_polls SET deadline_at = now() - interval '1 minute' WHERE post_id = $1`, [p2.id]);
    await app.get(NewsAgentService).tick();
    const after = (await http$.get(`/api/feed/${p2.id}`).set(H(gleb.token)).expect(200)).body.data;
    expect(after.poll.closed).toBe(true);
    expect(after.poll.result).toBe('Победил вариант: Суши');
    const note = await db.many(`SELECT * FROM notification_inbox WHERE user_id = $1 AND event_key = 'feed.poll'`, [gleb.id]);
    expect(note.some((n: any) => n.body === 'Победил вариант: Суши')).toBe(true);
  });

  it('хайлайт дня: повод — факты, нет повода — пропуск, второй раз — не дублируется', async () => {
    const owner = await org('Хайлайт');
    const O = owner.accessToken;
    const tenantId = String(owner.user.tenantId);
    // день без событий — честный пропуск (§69)
    const quiet = (await http$.post('/api/feed/highlights/generate').set(H(O)).expect(201)).body.data;
    expect(quiet.status).toBe('skipped');

    const owner2 = await org('Хайлайт 2');
    const O2 = owner2.accessToken;
    const t2 = String(owner2.user.tenantId);
    await db.query(`UPDATE tenants SET timezone = 'Europe/Moscow' WHERE id = $1`, [t2]);
    const project = (await http$.post('/api/projects').set(H(O2)).send({ name: 'Гостевые ссылки' }).expect(201)).body.data;
    const board = (await http$.get(`/api/projects/${project.id}/board`).set(H(O2)).expect(200)).body.data;
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) {
      ids.push(String((await http$.post('/api/tasks').set(H(O2)).send({ projectId: project.id, columnId: board.columns[0].id, title: `Задача ${i}`, priority: i === 0 ? 'urgent' : 'normal' }).expect(201)).body.data.id));
    }
    // закрыты «вчера» по Москве (в понедельник хайлайт берёт пятницу и выходные — тоже попадут)
    await db.query(`UPDATE tasks SET closed_at = date_trunc('day', now() AT TIME ZONE 'Europe/Moscow') AT TIME ZONE 'Europe/Moscow' - interval '6 hours' WHERE id = ANY($1::bigint[])`, [ids]);
    const h = (await http$.post('/api/feed/highlights/generate').set(H(O2)).expect(201)).body.data;
    expect(h.status).toBe('published');
    const post = (await http$.get(`/api/feed/${h.postId}`).set(H(O2)).expect(200)).body.data;
    expect(post.type).toBe('highlight');
    expect(post.title).toBe('AI-хайлайты дня');
    expect(post.byAgent).toBe(true);
    expect(post.body).toContain('закрыто 6 задач');
    // #1526: цифры для плиток карточки
    expect(post.highlight).toMatchObject({ tasks: 6, projects: 1, subtitle: 'Самые яркие и важные моменты' });
    expect(post.highlight.main.title).toBe('Задача 0');
    expect(post.sources.length).toBeGreaterThan(0);
    expect((await feed(O2)).top.some((p: any) => p.id === h.postId)).toBe(true);
    const again = (await http$.post('/api/feed/highlights/generate').set(H(O2)).expect(201)).body.data;
    expect(again.status).toBe('exists');
    expect(tenantId).toBeTruthy();

    // ручное одобрение: хайлайт уходит черновиком в очередь
    const owner3 = await org('Хайлайт 3');
    const O3 = owner3.accessToken;
    await http$.patch('/api/feed/settings').set(H(O3)).send({ highlightsAuto: false }).expect(200);
    const p3 = (await http$.post('/api/projects').set(H(O3)).send({ name: 'Проект' }).expect(201)).body.data;
    const b3 = (await http$.get(`/api/projects/${p3.id}/board`).set(H(O3)).expect(200)).body.data;
    const ids3: string[] = [];
    for (let i = 0; i < 5; i++) ids3.push(String((await http$.post('/api/tasks').set(H(O3)).send({ projectId: p3.id, columnId: b3.columns[0].id, title: `Т${i}` }).expect(201)).body.data.id));
    await db.query(`UPDATE tasks SET closed_at = date_trunc('day', now() AT TIME ZONE 'Europe/Moscow') AT TIME ZONE 'Europe/Moscow' - interval '6 hours' WHERE id = ANY($1::bigint[])`, [ids3]);
    const d = (await http$.post('/api/feed/highlights/generate').set(H(O3)).expect(201)).body.data;
    expect(d.status).toBe('draft');
    expect((await feed(O3)).top).toEqual([]);
    const review = (await http$.get('/api/feed/review').set(H(O3)).expect(200)).body.data;
    expect(review.drafts.map((x: any) => x.id)).toEqual([d.postId]);
    await http$.post(`/api/feed/${d.postId}/publish`).set(H(O3)).send({}).expect(201);
    expect((await feed(O3)).top.some((p: any) => p.id === d.postId)).toBe(true);
  });

  it('релиз и веха: авторы из задач, закрытый проект — только участникам, без дублей', async () => {
    const owner = await org('Релизы');
    const O = owner.accessToken;
    const gleb = await employee(O, 'Глеб');
    const project = (await http$.post('/api/projects').set(H(O)).send({ name: 'Гостевые ссылки' }).expect(201)).body.data;
    const board = (await http$.get(`/api/projects/${project.id}/board`).set(H(O)).expect(200)).body.data;
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      ids.push(String((await http$.post('/api/tasks').set(H(O)).send({ projectId: project.id, columnId: board.columns[0].id, title: `Ссылки ${i}`, assigneeId: gleb.id }).expect(201)).body.data.id));
    }
    await db.query(`UPDATE tasks SET closed_at = now() - interval '1 hour' WHERE id = ANY($1::bigint[])`, [ids]);

    const tasks = (await http$.get(`/api/feed/releases/tasks?projectId=${project.id}`).set(H(O)).expect(200)).body.data;
    expect(tasks).toHaveLength(3);
    const rel = (await http$.post('/api/feed/releases').set(H(O))
      .send({ projectId: String(project.id), title: 'Гостевые ссылки 1.0', taskIds: ids.slice(0, 2) }).expect(201)).body.data;
    expect(rel.type).toBe('release');
    expect(rel.contributors.map((c: any) => c.name)).toEqual(['Глеб']);
    await http$.post('/api/feed/releases').set(H(O)).send({ projectId: String(project.id), title: 'Гостевые ссылки 1.0' }).expect(409);
    await http$.post('/api/feed/releases').set(H(gleb.token)).send({ projectId: String(project.id), title: 'Свой релиз' }).expect(403);

    // все задачи проекта закрыты — кандидат на веху; без автопубликации — по одобрению, один раз
    await http$.patch('/api/feed/settings').set(H(O)).send({ highlightsAuto: false }).expect(200);
    const found = (await http$.post('/api/feed/candidates/detect').set(H(O)).expect(201)).body.data;
    expect(found.added).toBeGreaterThanOrEqual(1);
    expect((await http$.post('/api/feed/candidates/detect').set(H(O)).expect(201)).body.data.added).toBe(0);
    const review = (await http$.get('/api/feed/review').set(H(O)).expect(200)).body.data;
    const cand = review.candidates.find((c: any) => c.type === 'milestone');
    expect(cand.title).toContain('Гостевые ссылки');
    expect(cand.contributors.map((c: any) => c.name)).toContain('Глеб');
    await http$.get('/api/feed/review').set(H(gleb.token)).expect(403);
    const ms = (await http$.post(`/api/feed/candidates/${cand.id}/publish`).set(H(O)).send({ title: 'Веха: ссылки готовы' }).expect(201)).body.data;
    expect(ms.type).toBe('milestone');
    expect(ms.title).toBe('Веха: ссылки готовы');
    await http$.post(`/api/feed/candidates/${cand.id}/publish`).set(H(O)).send({}).expect(409);
    expect((await feed(O, '?filter=releases')).items.map((p: any) => p.type).sort()).toEqual(['milestone', 'release']);
  });

  it('#1526: при «Публиковать сами» веха выходит в ленту сама, один раз', async () => {
    const owner = await org('Вехи сами');
    const O = owner.accessToken;
    const project = (await http$.post('/api/projects').set(H(O)).send({ name: 'Гостевые инвайты' }).expect(201)).body.data;
    const board = (await http$.get(`/api/projects/${project.id}/board`).set(H(O)).expect(200)).body.data;
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      ids.push(String((await http$.post('/api/tasks').set(H(O)).send({ projectId: project.id, columnId: board.columns[0].id, title: `Инвайт ${i}` }).expect(201)).body.data.id));
    }
    await db.query(`UPDATE tasks SET closed_at = now() - interval '1 hour' WHERE id = ANY($1::bigint[])`, [ids]);
    expect((await http$.post('/api/feed/candidates/detect').set(H(O)).expect(201)).body.data.added).toBe(1);
    expect((await http$.post('/api/feed/candidates/detect').set(H(O)).expect(201)).body.data.added).toBe(0);
    const items = (await feed(O, '?filter=releases')).items;
    expect(items.map((p: any) => p.type)).toEqual(['milestone']);
    expect(items[0].title).toBe('Ура! Веха завершена: «Гостевые инвайты»');
    expect(items[0].byAgent).toBe(true);
  });

  it('ноль системного шума: работа с задачами в ленту не пишет ничего', async () => {
    const owner = await org('Без шума');
    const O = owner.accessToken;
    const project = (await http$.post('/api/projects').set(H(O)).send({ name: 'Работа' }).expect(201)).body.data;
    const board = (await http$.get(`/api/projects/${project.id}/board`).set(H(O)).expect(200)).body.data;
    const task = (await http$.post('/api/tasks').set(H(O)).send({ projectId: project.id, columnId: board.columns[0].id, title: 'Обычная задача' }).expect(201)).body.data;
    await http$.post(`/api/tasks/${task.id}/move`).set(H(O)).send({ columnId: board.columns[board.columns.length - 1].id, position: 0 }).expect(201);
    await http$.patch(`/api/tasks/${task.id}`).set(H(O)).send({ title: 'Обычная задача, уточнили', isBlocked: true }).expect(200);
    const rows = await db.many(`SELECT id FROM feed_posts WHERE tenant_id = $1`, [owner.user.tenantId]);
    expect(rows).toEqual([]);
  });

  it('комментарии: последние десять, предыдущие поднимаются, удалить своё можно', async () => {
    const owner = await org('Комментарии');
    const O = owner.accessToken;
    const mate = await employee(O, 'Глеб');
    const post = (await http$.post('/api/feed').set(H(O)).send({ body: 'Есть что обсудить' }).expect(201)).body.data;
    for (let i = 1; i <= 13; i++) await http$.post(`/api/feed/${post.id}/comments`).set(H(O)).send({ body: `Реплика ${i}` }).expect(201);
    const last = (await http$.get(`/api/feed/${post.id}/comments`).set(H(O)).expect(200)).body.data;
    expect(last.items).toHaveLength(10);
    expect(last.total).toBe(13);
    expect(last.items[0].body).toBe('Реплика 4');
    const earlier = (await http$.get(`/api/feed/${post.id}/comments?before=${last.items[0].id}`).set(H(O)).expect(200)).body.data;
    expect(earlier.items.map((c: any) => c.body)).toEqual(['Реплика 1', 'Реплика 2', 'Реплика 3']);

    const mine = (await http$.post(`/api/feed/${post.id}/comments`).set(H(mate.token)).send({ body: 'Моё' }).expect(201)).body.data.items.pop();
    await http$.delete(`/api/feed/comments/${last.items[0].id}`).set(H(mate.token)).expect(403);
    await http$.delete(`/api/feed/comments/${mine.id}`).set(H(mate.token)).expect(200);
  });

  it('вложение видно в посте, к чужому посту приложить нельзя, правая колонка считается', async () => {
    const owner = await org('Файлы');
    const O = owner.accessToken;
    const mate = await employee(O, 'Глеб');
    const post = (await http$.post('/api/feed').set(H(O)).send({ body: 'Инструкция по пропускам' }).expect(201)).body.data;
    await http$.post(`/api/feed/${post.id}/files`).set(H(O)).attach('file', Buffer.from('пропуск'), 'propuska.txt').expect(201);
    const got = (await http$.get(`/api/feed/${post.id}`).set(H(mate.token)).expect(200)).body.data;
    expect(got.files.map((f: any) => f.name)).toEqual(['propuska.txt']);
    await http$.post(`/api/feed/${post.id}/files`).set(H(mate.token)).attach('file', Buffer.from('x'), 'x.txt').expect(403);

    await http$.post('/api/feed').set(H(O)).send({ type: 'announcement', body: 'В пятницу общий сбор' }).expect(201);
    await http$.post('/api/feed/polls').set(H(O)).send({ question: 'Куда едем?', options: ['Лес', 'Море'] }).expect(201);
    const now = new Date();
    const md = `${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    await http$.patch('/api/me').set(H(mate.token)).send({ birthDate: `1990-${md}` }).expect(200);
    const side = (await http$.get('/api/feed/sidebar').set(H(mate.token)).expect(200)).body.data;
    expect(side.announcements.map((a: any) => a.body)).toEqual(['В пятницу общий сбор']);
    expect(side.announcements[0].needsAck).toBe(true);
    expect(side.polls.map((p: any) => p.question)).toEqual(['Куда едем?']);
    expect(side.birthdays.map((b: any) => b.fullName)).toContain('Глеб');
    expect(side.newcomers).toHaveLength(2);
  });
});
