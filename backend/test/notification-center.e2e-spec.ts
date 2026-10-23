import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AddressInfo } from 'net';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { AllExceptionsFilter } from '../src/common/http/all-exceptions.filter';
import { ResponseInterceptor } from '../src/common/http/response.interceptor';
import { RedisIoAdapter } from '../src/common/auth/redis-io.adapter';

/**
 * Центр уведомлений (#4655): история событий по задачам, значок непрочитанного,
 * «Прочитать все», фильтры и поиск — и всё только своё.
 */
describe('Центр уведомлений (e2e)', () => {
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

  const center = async (tok: string, query = '') =>
    (await http.get(`/api/notifications/center${query}`).set(H(tok)).expect(200)).body.data;

  /** Запись рождается фоном, после ответа на действие, — ждём её до пяти секунд. */
  async function waitFor(tok: string, eventKey: string, query = ''): Promise<any> {
    for (let i = 0; i < 50; i++) {
      const page = await center(tok, query);
      const hit = page.items.find((x: any) => x.eventKey === eventKey);
      if (hit) return { page, hit };
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`не дождались записи ${eventKey} в центре`);
  }

  async function member(ownerTok: string, fullName: string) {
    const email = `m_${uniq()}@t.test`;
    const user = (await http.post('/api/users').set(H(ownerTok))
      .send({ email, password: 'password123', fullName, role: 'member' }).expect(201)).body.data;
    const tok = (await http.post('/api/auth/login').send({ email, password: 'password123' }).expect(201)).body.data.accessToken;
    return { id: String(user.id), tok };
  }

  it('история по задаче: исполнителю, наблюдателю и упомянутому — да, автору — нет; фильтры, поиск, прочтение', async () => {
    const owner = (await http.post('/api/auth/register')
      .send({ tenantName: 'Центр', email: `o_${uniq()}@t.test`, password: 'password123', fullName: 'Ольга Ким' }).expect(201)).body.data;
    const O = owner.accessToken;
    const ivan = await member(O, 'Иван Петров');
    const gleb = await member(O, 'Глеб Смирнов');

    const proj = (await http.post('/api/projects').set(H(O)).send({ name: 'Сайт' }).expect(201)).body.data;
    const board = (await http.get(`/api/projects/${proj.id}/board`).set(H(O)).expect(200)).body.data;
    const task = (await http.post('/api/tasks').set(H(O)).send({
      projectId: proj.id, columnId: board.columns[0].id, title: 'Обновить прайс',
      assigneeId: ivan.id, watcherIds: [gleb.id],
    }).expect(201)).body.data;

    // исполнитель: «Ольга Ким поставил вам задачу [#N] Обновить прайс», со ссылкой на задачу
    const created = (await waitFor(ivan.tok, 'task.created')).hit;
    expect(created.actor.name).toBe('Ольга Ким');
    expect(created.task).toEqual({ id: String(task.id), title: 'Обновить прайс', projectId: String(proj.id) });
    expect(created.details.phrase).toBe('поставил вам задачу');
    expect(created.path).toBe(`/projects/${proj.id}/task/${task.id}`);
    expect(created.readAt).toBeNull();

    // наблюдатель — своей строкой
    const watch = (await waitFor(gleb.tok, 'task.participant')).hit;
    expect(watch.details.phrase).toBe('добавил вас наблюдателем в задачу');

    // автор о своём действии не узнаёт
    expect((await center(O)).items).toEqual([]);
    expect((await http.get('/api/notifications/center/unread').set(H(O)).expect(200)).body.data.unread).toBe(0);

    // исполнитель пишет в обсуждение и зовёт наблюдателя по имени
    await http.post(`/api/tasks/${task.id}/comments`).set(H(ivan.tok)).send({ body: '@Глеб Смирнов посмотри цены' }).expect(201);
    const mention = (await waitFor(gleb.tok, 'task.mention')).hit;
    expect(mention.category).toBe('mention');
    expect(mention.details.comment).toContain('посмотри цены');
    // постановщику — «оставил комментарий», упомянутому второй строки о том же комментарии нет
    await waitFor(O, 'task.commented');
    const glebPage = await center(gleb.tok);
    expect(glebPage.items.filter((x: any) => x.eventKey === 'task.commented')).toEqual([]);
    expect((await center(ivan.tok)).items.some((x: any) => x.eventKey === 'task.commented')).toBe(false);

    // фильтр по виду и поиск
    const onlyMentions = await center(gleb.tok, '?category=mention');
    expect(onlyMentions.items.map((x: any) => x.eventKey)).toEqual(['task.mention']);
    expect((await center(gleb.tok, `?q=${encodeURIComponent('прайс')}`)).items.length).toBe(2);
    expect((await center(gleb.tok, `?q=%23${task.id}`)).items.length).toBe(2);
    expect((await center(gleb.tok, '?q=nothing-like-this')).items).toEqual([]);

    // прочитать одну — счётчик меньше; «Прочитать все» — ноль
    expect(glebPage.unread).toBe(2);
    const afterOne = (await http.post('/api/notifications/center/read').set(H(gleb.tok)).send({ ids: [mention.id] }).expect(201)).body.data;
    expect(afterOne.unread).toBe(1);
    expect((await center(gleb.tok, '?unread=1')).items.map((x: any) => x.eventKey)).toEqual(['task.participant']);
    const all = (await http.post('/api/notifications/center/read-all').set(H(gleb.tok)).send({}).expect(201)).body.data;
    expect(all.unread).toBe(0);

    // чужие записи прочитать нельзя: у Ивана счётчик не изменился
    const ivanBefore = (await http.get('/api/notifications/center/unread').set(H(ivan.tok)).expect(200)).body.data.unread;
    await http.post('/api/notifications/center/read').set(H(gleb.tok)).send({ ids: [created.id] }).expect(201);
    expect((await http.get('/api/notifications/center/unread').set(H(ivan.tok)).expect(200)).body.data.unread).toBe(ivanBefore);

    // задачу удалили — её записи из истории пропадают
    await http.delete(`/api/tasks/${task.id}`).set(H(O)).expect(200);
    expect((await center(ivan.tok)).items.filter((x: any) => x.task)).toEqual([]);
  });

  it('смена исполнителя и срока: новому — «назначил вас», прежнему — «передал»; листание истории', async () => {
    const owner = (await http.post('/api/auth/register')
      .send({ tenantName: 'Центр-2', email: `o_${uniq()}@t.test`, password: 'password123', fullName: 'Ольга' }).expect(201)).body.data;
    const O = owner.accessToken;
    const ivan = await member(O, 'Иван');
    const petr = await member(O, 'Пётр');
    const proj = (await http.post('/api/projects').set(H(O)).send({ name: 'Склад' }).expect(201)).body.data;
    const board = (await http.get(`/api/projects/${proj.id}/board`).set(H(O)).expect(200)).body.data;
    const task = (await http.post('/api/tasks').set(H(O))
      .send({ projectId: proj.id, columnId: board.columns[0].id, title: 'Пересчитать остатки', assigneeId: ivan.id }).expect(201)).body.data;
    await waitFor(ivan.tok, 'task.created');

    await http.patch(`/api/tasks/${task.id}`).set(H(O)).send({ assigneeId: petr.id }).expect(200);
    const toPetr = (await waitFor(petr.tok, 'task.assignee')).hit;
    expect(toPetr.details.phrase).toBe('назначил вас исполнителем задачи');
    const fromIvan = (await waitFor(ivan.tok, 'task.assignee')).hit;
    expect(fromIvan.details.phrase).toBe('передал другому исполнителю задачу');

    await http.post(`/api/tasks/${task.id}/plan`).set(H(O)).send({ deadlineAt: '2026-12-01T15:00:00.000Z' }).expect(201);
    const deadline = (await waitFor(petr.tok, 'task.deadline')).hit;
    expect(deadline.details.deadline).toBe('2026-12-01T15:00:00.000Z');

    // листание: страница по одной записи, следующая — по курсору `before`
    const first = await center(petr.tok, '?limit=1');
    expect(first.items.length).toBe(1);
    expect(first.next).toBe(first.items[0].id);
    const second = await center(petr.tok, `?limit=1&before=${first.next}`);
    expect(second.items.length).toBe(1);
    expect(Number(second.items[0].id)).toBeLessThan(Number(first.items[0].id));

    // в другой компании этих записей не видно
    const stranger = (await http.post('/api/auth/register')
      .send({ tenantName: 'Чужие', email: `s_${uniq()}@t.test`, password: 'password123', fullName: 'Сергей' }).expect(201)).body.data;
    expect((await center(stranger.accessToken)).items).toEqual([]);
    await http.get('/api/notifications/center?category=spam').set(H(petr.tok)).expect(400);
  });
});
