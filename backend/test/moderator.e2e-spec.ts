import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AddressInfo } from 'net';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { AllExceptionsFilter } from '../src/common/http/all-exceptions.filter';
import { ResponseInterceptor } from '../src/common/http/response.interceptor';
import { RedisIoAdapter } from '../src/common/auth/redis-io.adapter';
import { ModeratorScheduler } from '../src/modules/assistant/moderator.scheduler';

/**
 * Модератор встреч: повестка за пять минут до начала.
 *
 * Проверяем не текст (его пишет модель, и он разный), а границы: повестка появляется
 * у ВСЕХ участников, собирается один раз на это время, не появляется там, где обсуждать
 * нечего, и молчит при выключенном ассистенте.
 *
 * Ключа ИИ на CI нет — и это часть проверки: повестка обязана уходить фактами,
 * когда модель недоступна. Встреча через пять минут не ждёт, пока починят ИИ.
 */
describe('Модератор встреч (e2e)', () => {
  let app: INestApplication;
  let http: any;
  let scheduler: ModeratorScheduler;
  const uniq = () => Math.random().toString(36).slice(2) + Date.now().toString(36);
  const H = (t: string) => ({ Authorization: `Bearer ${t}` });
  /** Встреча начинается через пять минут — ровно окно планировщика. */
  const inMinutes = (m: number) => new Date(Date.now() + m * 60_000).toISOString();

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
    scheduler = app.get(ModeratorScheduler);
  });
  afterAll(async () => { await app?.close(); });

  const org = async (name: string) => {
    const owner = (await http.post('/api/auth/register')
      .send({ tenantName: name, email: `m_${uniq()}@t.test`, password: 'password123', fullName: 'Организатор' })
      .expect(201)).body.data;
    const email = `m_u_${uniq()}@t.test`;
    const mate = (await http.post('/api/users').set(H(owner.accessToken))
      .send({ email, fullName: 'Участник', password: 'password123', role: 'member' }).expect(201)).body.data;
    const mateToken = (await http.post('/api/auth/login')
      .send({ email, password: 'password123' }).expect(201)).body.data.accessToken;
    return { owner, mate, mateToken };
  };

  const event = async (token: string, body: Record<string, unknown>) =>
    (await http.post('/api/calendar/events').set(H(token)).send({
      title: 'Планёрка отдела',
      startsAt: inMinutes(5),
      endsAt: inMinutes(35),
      reminders: [],
      ...body,
    }).expect(201)).body.data;

  it('повестка собирается один раз и приходит всем участникам', async () => {
    const s = await org('Модератор');

    // просроченная задача участника — повод, который на встрече и обсудят
    const project = (await http.post('/api/projects').set(H(s.owner.accessToken))
      .send({ name: 'Стройка' }).expect(201)).body.data;
    await http.post('/api/tasks').set(H(s.owner.accessToken)).send({
      projectId: project.id, title: 'Договор с подрядчиком',
      assigneeId: s.mate.id, deadlineAt: new Date(Date.now() - 2 * 864e5).toISOString(),
    }).expect(201);

    const ev = await event(s.owner.accessToken, {
      description: 'Обсудить сроки по стройке',
      participantIds: [String(s.mate.id)],
    });

    expect(await scheduler.tick()).toBeGreaterThan(0);

    // повестку видят оба: и организатор, и приглашённый
    for (const token of [s.owner.accessToken, s.mateToken]) {
      const list = (await http.get('/api/assistant/agendas').set(H(token)).expect(200)).body.data;
      const mine = list.find((a: any) => String(a.eventId) === String(ev.id));
      expect(mine).toBeTruthy();
      expect(mine.title).toBe('Планёрка отдела');
      expect(mine.body).toContain('сроки по стройке');
      expect(mine.body).toContain('Договор с подрядчиком');
    }

    // отдельной ручкой повестка тоже открывается — из уведомления
    const one = (await http.get(`/api/assistant/agendas/${ev.id}`).set(H(s.mateToken)).expect(200)).body.data;
    expect(one.body.length).toBeGreaterThan(10);
    expect(Array.isArray(one.facts)).toBe(true);

    // второй проход ничего не пересобирает: повестка на это время уже есть
    const before = one.body;
    await scheduler.tick();
    const after = (await http.get(`/api/assistant/agendas/${ev.id}`).set(H(s.mateToken)).expect(200)).body.data;
    expect(after.body).toBe(before);
  });

  it('обсуждать нечего — повестки нет; встреча в одиночку — тоже', async () => {
    const s = await org('Пусто');

    // событие с участником, но без единого повода: ни описания, ни задач, ни вопросов
    const empty = await event(s.owner.accessToken, { participantIds: [String(s.mate.id)] });
    // событие с описанием, но без второго участника
    const alone = await event(s.owner.accessToken, { title: 'Подумать', description: 'Наедине с собой' });

    await scheduler.tick();

    await http.get(`/api/assistant/agendas/${empty.id}`).set(H(s.mateToken)).expect(404);
    await http.get(`/api/assistant/agendas/${alone.id}`).set(H(s.owner.accessToken)).expect(404);
  });

  it('выключенный ассистент повесток не готовит', async () => {
    const s = await org('Тишина');
    await http.put('/api/assistant/mode').set(H(s.owner.accessToken)).send({ mode: 'off' }).expect(200);

    const ev = await event(s.owner.accessToken, {
      description: 'Есть что обсудить',
      participantIds: [String(s.mate.id)],
    });
    await scheduler.tick();

    await http.get(`/api/assistant/agendas/${ev.id}`).set(H(s.owner.accessToken)).expect(404);
  });

  it('перенос встречи заставляет собрать повестку заново', async () => {
    const s = await org('Перенос');
    const ev = await event(s.owner.accessToken, {
      description: 'Первая редакция',
      participantIds: [String(s.mate.id)],
    });
    await scheduler.tick();
    const first = (await http.get(`/api/assistant/agendas/${ev.id}`).set(H(s.owner.accessToken)).expect(200)).body.data;
    expect(first.body).toContain('Первая редакция');

    // перенесли на другое время и переписали описание — старая повестка устарела
    await http.patch(`/api/calendar/events/${ev.id}`).set(H(s.owner.accessToken)).send({
      description: 'Вторая редакция', startsAt: inMinutes(5), endsAt: inMinutes(40),
    }).expect(200);
    await scheduler.tick();

    const second = (await http.get(`/api/assistant/agendas/${ev.id}`).set(H(s.owner.accessToken)).expect(200)).body.data;
    expect(second.body).toContain('Вторая редакция');
  });

  it('настройку «создавать задачи со встречи» задаёт владелец', async () => {
    const s = await org('Задачи');
    expect((await http.get('/api/assistant/mode').set(H(s.owner.accessToken)).expect(200)).body.data.autoTasks)
      .toBe(true);

    await http.put('/api/assistant/meeting-tasks').set(H(s.mateToken)).send({ enabled: false }).expect(403);
    await http.put('/api/assistant/meeting-tasks').set(H(s.owner.accessToken)).send({ enabled: false }).expect(200);
    expect((await http.get('/api/assistant/mode').set(H(s.mateToken)).expect(200)).body.data.autoTasks)
      .toBe(false);
  });
});
