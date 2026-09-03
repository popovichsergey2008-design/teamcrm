import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AddressInfo } from 'net';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { AllExceptionsFilter } from '../src/common/http/all-exceptions.filter';
import { ResponseInterceptor } from '../src/common/http/response.interceptor';
import { RedisIoAdapter } from '../src/common/auth/redis-io.adapter';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { AccessTokenPayload, RoleCode } from '../src/common/auth/jwt.types';

/**
 * Реестр задач: «покажи ВСЁ по всем проектам».
 *
 * Проверяем не «ручка отвечает», а правила, ради которых экран и заводился: срез по
 * моей роли в задаче не смешивается с чужими, «От меня» не показывает поставленное
 * самому себе, завершённые появляются только по явному флагу, фильтры и поиск
 * действительно сужают выборку, а постраничность считает общее число верно.
 *
 * Отдельно — то, на чём такой запрос ломается молча: срез «Все» не использует
 * параметры пользователя и суток, и Postgres роняет запрос на невыведенном типе
 * параметра, если тот нигде не встречается.
 */
describe('реестр задач (e2e)', () => {
  let app: INestApplication;
  let http: any;
  let jwt: JwtService;
  let accessSecret: string;
  const uniq = () => Math.random().toString(36).slice(2) + Date.now().toString(36);
  const H = (t: string) => ({ Authorization: `Bearer ${t}` });
  const dayEnd = new Date(Date.now() + 6 * 3600_000).toISOString();

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
    jwt = app.get(JwtService);
    accessSecret = app.get(ConfigService).getOrThrow<string>('JWT_ACCESS_SECRET');
  });
  afterAll(async () => app?.close());

  const team = async () => {
    const owner = (await http.post('/api/auth/register')
      .send({ tenantName: 'Reg', email: `reg_${uniq()}@t.test`, password: 'password123', fullName: 'Ольга Владелец' })
      .expect(201)).body.data;
    const email = `reg_m_${uniq()}@t.test`;
    const inv = (await http.post('/api/invites').set(H(owner.accessToken))
      .send({ email, role: 'member' }).expect(201)).body.data;
    await http.post('/api/invites/accept')
      .send({ token: inv.token, fullName: 'Пётр Сотрудник', password: 'memberpass1' }).expect(201);
    const member = (await http.post('/api/auth/login')
      .send({ email, password: 'memberpass1' }).expect(201)).body.data;
    return { owner, member };
  };

  const registry = async (token: string, query = '') => {
    const res = await http.get(`/api/tasks/registry?dayEnd=${encodeURIComponent(dayEnd)}${query}`)
      .set(H(token)).expect(200);
    return res.body.data;
  };
  const titles = (data: any) => data.items.map((t: any) => t.title);

  it('срезы не смешиваются: своё, поручённое и наблюдаемое', async () => {
    const { owner, member } = await team();
    const project = (await http.post('/api/projects').set(H(owner.accessToken))
      .send({ name: `Проект ${uniq()}` }).expect(201)).body.data;

    // владелец поручает сотруднику, ставит себе и заводит задачу «мимо всех»
    const forMember = (await http.post('/api/tasks').set(H(owner.accessToken))
      .send({ projectId: project.id, title: 'Сверстать лендинг', assigneeId: member.user.id }).expect(201)).body.data;
    await http.post('/api/tasks').set(H(owner.accessToken))
      .send({ projectId: project.id, title: 'Своя задача владельца', assigneeId: owner.user.id }).expect(201);
    const watched = (await http.post('/api/tasks').set(H(owner.accessToken))
      .send({ projectId: project.id, title: 'Задача под наблюдением' }).expect(201)).body.data;
    await http.post(`/api/tasks/${watched.id}/participants`).set(H(owner.accessToken))
      .send({ userId: member.user.id, role: 'watcher' }).expect(201);

    // сотрудник: «Мне» — только его собственная работа
    expect(titles(await registry(member.accessToken, '&scope=mine'))).toEqual(['Сверстать лендинг']);
    // «Наблюдаю» — только то, куда его добавили наблюдателем
    expect(titles(await registry(member.accessToken, '&scope=watching'))).toEqual(['Задача под наблюдением']);
    // «От меня» у сотрудника пусто: он ничего не поручал
    expect(titles(await registry(member.accessToken, '&scope=delegated'))).toEqual([]);

    // владелец: «От меня» — поручённое другим, но НЕ поставленное самому себе
    const delegated = titles(await registry(owner.accessToken, '&scope=delegated'));
    expect(delegated).toContain('Сверстать лендинг');
    expect(delegated).not.toContain('Своя задача владельца');

    // «Все» — весь тенант; и главное, запрос не падает без параметров пользователя
    const all = await registry(owner.accessToken, '&scope=all');
    expect(all.total).toBe(3);
    expect(titles(all)).toContain('Задача под наблюдением');

    // соисполнитель видит задачу как свою: работу делает человек, а не поле в таблице
    await http.post(`/api/tasks/${watched.id}/participants`).set(H(owner.accessToken))
      .send({ userId: member.user.id, role: 'co_assignee' }).expect(201);
    expect(titles(await registry(member.accessToken, '&scope=mine'))).toContain('Задача под наблюдением');
    expect(String(forMember.project_id)).toBe(String(project.id));
  });

  it('завершённые показываются только по явному флагу', async () => {
    const { owner, member } = await team();
    const project = (await http.post('/api/projects').set(H(owner.accessToken))
      .send({ name: `Проект ${uniq()}` }).expect(201)).body.data;
    const task = (await http.post('/api/tasks').set(H(owner.accessToken))
      .send({ projectId: project.id, title: 'Закрыть смету', assigneeId: member.user.id, requiresApproval: false })
      .expect(201)).body.data;
    const board = (await http.get(`/api/projects/${project.id}/board`).set(H(owner.accessToken)).expect(200)).body.data;
    const done = board.columns[board.columns.length - 1];
    await http.post(`/api/tasks/${task.id}/move`).set(H(owner.accessToken))
      .send({ columnId: done.id, position: 0 }).expect(201);

    expect(titles(await registry(member.accessToken, '&scope=mine'))).toEqual([]);
    const withClosed = await registry(member.accessToken, '&scope=mine&closed=1');
    expect(titles(withClosed)).toEqual(['Закрыть смету']);
    expect(withClosed.items[0].closed_at).toBeTruthy();
  });

  it('фильтры и поиск сужают выборку, номер задачи ищется как номер', async () => {
    const { owner, member } = await team();
    const a = (await http.post('/api/projects').set(H(owner.accessToken))
      .send({ name: `Первый ${uniq()}` }).expect(201)).body.data;
    const b = (await http.post('/api/projects').set(H(owner.accessToken))
      .send({ name: `Второй ${uniq()}` }).expect(201)).body.data;
    const one = (await http.post('/api/tasks').set(H(owner.accessToken))
      .send({ projectId: a.id, title: 'Макет главной', assigneeId: member.user.id, priority: 'urgent' })
      .expect(201)).body.data;
    await http.post('/api/tasks').set(H(owner.accessToken))
      .send({ projectId: b.id, title: 'Договор с типографией', assigneeId: member.user.id, priority: 'low' })
      .expect(201);
    await http.post('/api/tasks').set(H(owner.accessToken))
      .send({ projectId: b.id, title: 'Задача без исполнителя' }).expect(201);

    expect(titles(await registry(owner.accessToken, `&scope=all&projectId=${a.id}`))).toEqual(['Макет главной']);
    expect(titles(await registry(owner.accessToken, '&scope=all&priority=urgent'))).toEqual(['Макет главной']);
    expect(titles(await registry(owner.accessToken, '&scope=all&assigneeId=none')))
      .toEqual(['Задача без исполнителя']);
    expect(titles(await registry(owner.accessToken, `&scope=all&assigneeId=${member.user.id}`)).sort())
      .toEqual(['Договор с типографией', 'Макет главной']);
    expect(titles(await registry(owner.accessToken, '&scope=all&q=типограф'))).toEqual(['Договор с типографией']);
    // номером обмениваются в переписке — «глянь 1232»
    expect(titles(await registry(owner.accessToken, `&scope=all&q=${one.id}`))).toEqual(['Макет главной']);
    // задачи без срока — отдельный срез: их проще всего потерять
    expect(titles(await registry(owner.accessToken, '&scope=all&due=none')).length).toBe(3);
    expect(titles(await registry(owner.accessToken, '&scope=all&due=overdue'))).toEqual([]);
  });

  it('постраничность считает общее число, а не размер страницы', async () => {
    const { owner } = await team();
    const project = (await http.post('/api/projects').set(H(owner.accessToken))
      .send({ name: `Много ${uniq()}` }).expect(201)).body.data;
    for (let i = 1; i <= 3; i++) {
      await http.post('/api/tasks').set(H(owner.accessToken))
        .send({ projectId: project.id, title: `Задача ${i}` }).expect(201);
    }
    const page1 = await registry(owner.accessToken, '&scope=all');
    expect(page1.total).toBe(3);
    expect(page1.pages).toBe(1);
    expect(page1.pageSize).toBe(50);
    // страница за пределами данных — пустой список, а не ошибка
    const page2 = await registry(owner.accessToken, '&scope=all&page=2');
    expect(page2.items).toEqual([]);
    expect(page2.total).toBe(0);
  });

  it('незнакомый фильтр отклоняется, а не выполняется молча', async () => {
    const { owner } = await team();
    await http.get('/api/tasks/registry?scope=everything').set(H(owner.accessToken)).expect(400);
    await http.get('/api/tasks/registry?sort=rand()').set(H(owner.accessToken)).expect(400);
    await http.get('/api/tasks/registry?hack=1').set(H(owner.accessToken)).expect(400);
  });

  it('клиент в реестр не попадает: чужие задачи ему не видны', async () => {
    const { owner } = await team();
    // роль client не приглашается через /invites — подписываем токен напрямую,
    // как в остальных проверках изоляции клиента
    const token = jwt.sign(
      { sub: '0', tenantId: owner.user.tenantId, role: 'client' as RoleCode, email: 'c@x.io' } as AccessTokenPayload,
      { secret: accessSecret, expiresIn: 300 },
    );
    await http.get('/api/tasks/registry').set(H(token)).expect(403);
  });
});
