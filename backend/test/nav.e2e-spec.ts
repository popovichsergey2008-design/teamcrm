import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AddressInfo } from 'net';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { AllExceptionsFilter } from '../src/common/http/all-exceptions.filter';
import { ResponseInterceptor } from '../src/common/http/response.interceptor';
import { RedisIoAdapter } from '../src/common/auth/redis-io.adapter';

/**
 * Счётчики левой панели (ТЗ-2, этап 1, Ш4).
 *
 * Проверяем не «ручка отвечает 200», а что цифры означают то, что написано на бейдже:
 * «требует решения» — сданное другими, а не своя работа; «сегодня» — сроки этого дня
 * в часовом поясе человека; риски видит только руководитель.
 */
describe('ТЗ-2 — счётчики навигации (e2e)', () => {
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
  afterAll(async () => app?.close());

  const counters = (tok: string, tz = 0) =>
    http.get(`/api/nav/counters?tz=${tz}`).set(H(tok)).expect(200).then((r: any) => r.body.data);

  it('считает то, что обещает бейдж, и скрывает риски от рядового сотрудника', async () => {
    const reg = (await http.post('/api/auth/register')
      .send({ tenantName: 'Nav', email: `nav_${uniq()}@t.test`, password: 'password123', fullName: 'Владелец' })
      .expect(201)).body.data;
    const tok = reg.accessToken;
    const ownerId = reg.user.id;

    // пустая организация — все счётчики нули, а не отсутствующие поля
    const empty = await counters(tok);
    expect(empty).toEqual({
      focus: { decide: 0, today: 0 },
      calendar: { pending: 0 },
      radar: { risks: 0 },
      // «новое в моих задачах» — такой же счётчик панели, как остальные
      tasks: { unread: 0 },
    });

    const proj = (await http.post('/api/projects').set(H(tok)).send({ name: 'Счётчики' }).expect(201)).body.data;
    const board = (await http.get(`/api/projects/${proj.id}/board`).set(H(tok)).expect(200)).body.data;
    const cols: Record<string, string> = {};
    for (const c of board.columns) cols[c.name] = c.id;

    // сотрудник, которому будем поручать
    const memEmail = `nav_m_${uniq()}@t.test`;
    const inv = (await http.post('/api/invites').set(H(tok)).send({ email: memEmail, role: 'member' }).expect(201)).body.data;
    await http.post('/api/invites/accept').send({ token: inv.token, fullName: 'Сотрудник', password: 'memberpass1' }).expect(201);
    const memLogin = (await http.post('/api/auth/login').send({ email: memEmail, password: 'memberpass1' }).expect(201)).body.data;
    const memTok = memLogin.accessToken;
    const memId = memLogin.user.id;

    // 1. Своя задача со сроком на сегодня → попадает в «сегодня», но не в «требует решения».
    // Считаем в UTC и спрашиваем счётчики с tz=0: иначе результат зависел бы от того,
    // в каком часовом поясе крутится сборка. Сама арифметика поясов покрыта nav.service.spec.
    const now = new Date();
    const todayEvening = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 23, 0, 0));
    await http.post('/api/tasks').set(H(tok)).send({
      projectId: proj.id, columnId: cols['В работе'], title: 'Моя на сегодня',
      assigneeId: ownerId, deadlineAt: todayEvening.toISOString(),
    }).expect(201);

    // 2. Задача со сроком через неделю → сегодня её не показываем
    const nextWeek = new Date(Date.now() + 7 * 24 * 3600 * 1000);
    await http.post('/api/tasks').set(H(tok)).send({
      projectId: proj.id, columnId: cols['В работе'], title: 'Моя на будущее',
      assigneeId: ownerId, deadlineAt: nextWeek.toISOString(),
    }).expect(201);

    // 3. Поручена сотруднику и лежит в «В работе» → ещё не моё решение
    const delegated = (await http.post('/api/tasks').set(H(tok)).send({
      projectId: proj.id, columnId: cols['В работе'], title: 'Поручено сотруднику', assigneeId: memId,
    }).expect(201)).body.data;

    let c = await counters(tok);
    expect(c.focus.today).toBe(1);
    expect(c.focus.decide).toBe(0);

    // 4. Сотрудник сдал работу — задача уехала на проверку → теперь она ждёт меня
    // confirmGate: приёмка работы здесь ни при чём — проверяем счётчики, а не отчёт исполнителя
    await http.post(`/api/tasks/${delegated.id}/move`).set(H(memTok))
      .send({ columnId: cols['На тестировании'], position: 0, confirmGate: true }).expect(201);

    c = await counters(tok);
    expect(c.focus.decide).toBe(1);
    // календарь стал разделом панели: неотвеченное приглашение видно бейджем
    expect(c.calendar.pending).toBe(0);

    // та же задача попадает в сквозную выборку «сдано мне на проверку» —
    // из неё собирается первая колонка «Фокуса дня»
    const onReview = (await http.get('/api/tasks/my?scope=review').set(H(tok)).expect(200)).body.data;
    expect(onReview.map((t: any) => String(t.id))).toContain(String(delegated.id));

    // 5. Принял работу → счётчик падает сразу, без ожидания кэша
    await http.post(`/api/tasks/${delegated.id}/move`).set(H(tok))
      .send({ columnId: cols['Готово'], position: 0 }).expect(201);
    c = await counters(tok);
    expect(c.focus.decide).toBe(0);

    // 6. У рядового сотрудника раздела «Пульс» нет — и счётчика по организации тоже
    const memCounters = await counters(memTok);
    expect(memCounters.radar).toBeNull();
    expect(memCounters.focus.decide).toBe(0);

    // 7. «Пульс команды» считает по фактическим данным, а не по обещаниям
    const radar = (await http.get('/api/radar?tz=0').set(H(tok)).expect(200)).body.data;
    const health = radar.projects.find((p: any) => String(p.id) === String(proj.id));
    expect(health.total).toBe(3);
    expect(health.closed).toBe(1);          // принятая задача
    expect(radar.velocity.last7).toBeGreaterThanOrEqual(1);
    // в загрузке видны оба человека организации
    expect(radar.people.length).toBe(2);
    // ничего не залежалось: задачу только что двигали
    expect(radar.stuck).toEqual([]);

    // экран руководителя рядовому сотруднику закрыт
    await http.get('/api/radar').set(H(memTok)).expect(403);
  });

  /**
   * Красная отметка «что нового» и её счётчик в панели.
   *
   * Две жалобы разом, и обе про доверие к цифре: она не гасла до перезагрузки
   * страницы и горела там, где смотреть было нечего. Проверяем ровно это —
   * открытие задачи гасит счётчик СРАЗУ, а архивный проект в него не попадает.
   */
  it('счётчик «нового» гаснет от открытия задачи и не считает архивные проекты', async () => {
    const owner = (await http.post('/api/auth/register')
      .send({ tenantName: 'Unread', email: `un_${uniq()}@t.test`, password: 'password123', fullName: 'Ольга' })
      .expect(201)).body.data;
    const memEmail = `un_m_${uniq()}@t.test`;
    const inv = (await http.post('/api/invites').set(H(owner.accessToken))
      .send({ email: memEmail, role: 'member' }).expect(201)).body.data;
    await http.post('/api/invites/accept')
      .send({ token: inv.token, fullName: 'Пётр Сотрудник', password: 'memberpass1' }).expect(201);
    const mem = (await http.post('/api/auth/login')
      .send({ email: memEmail, password: 'memberpass1' }).expect(201)).body.data;

    const proj = (await http.post('/api/projects').set(H(owner.accessToken))
      .send({ name: `Живой ${uniq()}` }).expect(201)).body.data;
    const task = (await http.post('/api/tasks').set(H(owner.accessToken))
      .send({ projectId: proj.id, title: 'Сверстать', assigneeId: mem.user.id }).expect(201)).body.data;

    // чужое действие по моей задаче — вот оно и есть «новое»
    await http.post(`/api/tasks/${task.id}/comments`).set(H(owner.accessToken))
      .send({ body: 'Посмотри, пожалуйста' }).expect(201);
    expect((await counters(mem.accessToken)).tasks!.unread).toBeGreaterThan(0);

    // открыл карточку — счётчик обязан упасть сразу, а не после перезагрузки
    await http.post(`/api/tasks/${task.id}/read`).set(H(mem.accessToken)).expect(201);
    expect((await counters(mem.accessToken)).tasks!.unread).toBe(0);

    // задача в архивном проекте в счётчик не попадает: дойти до неё человек не может
    const old = (await http.post('/api/projects').set(H(owner.accessToken))
      .send({ name: `Архивный ${uniq()}` }).expect(201)).body.data;
    const oldTask = (await http.post('/api/tasks').set(H(owner.accessToken))
      .send({ projectId: old.id, title: 'Забытая', assigneeId: mem.user.id }).expect(201)).body.data;
    await http.post(`/api/tasks/${oldTask.id}/comments`).set(H(owner.accessToken))
      .send({ body: 'И это тоже' }).expect(201);
    expect((await counters(mem.accessToken)).tasks!.unread).toBeGreaterThan(0);

    await http.post(`/api/projects/${old.id}/archive`).set(H(owner.accessToken)).expect(201);
    expect((await counters(mem.accessToken)).tasks!.unread).toBe(0);
  });
});
