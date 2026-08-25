import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AddressInfo } from 'net';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { AllExceptionsFilter } from '../src/common/http/all-exceptions.filter';
import { ResponseInterceptor } from '../src/common/http/response.interceptor';
import { RedisIoAdapter } from '../src/common/auth/redis-io.adapter';

/**
 * Календарь: события личные и компании, приглашения, приватность.
 *
 * Проверяется то, что ломается тихо и дорого: чужое событие не должно быть видно, приватное
 * не должно показывать название, а ответ на приглашение — трогать только свою строку.
 */
describe('Календарь (e2e)', () => {
  let app: INestApplication;
  let http$: any;
  const uniq = () => Math.random().toString(36).slice(2) + Date.now().toString(36);
  const H = (t: string) => ({ Authorization: `Bearer ${t}` });
  const iso = (h: number, day = 0) => {
    const d = new Date();
    d.setDate(d.getDate() + day);
    d.setHours(h, 0, 0, 0);
    return d.toISOString();
  };
  const WINDOW = () => {
    const from = new Date(); from.setDate(from.getDate() - 1); from.setHours(0, 0, 0, 0);
    const to = new Date(); to.setDate(to.getDate() + 7); to.setHours(0, 0, 0, 0);
    return `from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}`;
  };

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

  it('событие с участником: приглашение, ответ, видимость', async () => {
    const owner = (await http$.post('/api/auth/register')
      .send({ tenantName: 'Календарь', email: `own_${uniq()}@t.test`, password: 'password123', fullName: 'Владелец' })
      .expect(201)).body.data;

    const mateEmail = `mate_${uniq()}@t.test`;
    const mate = (await http$.post('/api/users').set(H(owner.accessToken))
      .send({ email: mateEmail, fullName: 'Коллега', password: 'password123', role: 'member' }).expect(201)).body.data;
    const mateToken = (await http$.post('/api/auth/login')
      .send({ email: mateEmail, password: 'password123' }).expect(201)).body.data.accessToken;

    const event = (await http$.post('/api/calendar/events').set(H(owner.accessToken)).send({
      title: 'Планёрка', startsAt: iso(10), endsAt: iso(11), participantIds: [String(mate.id)],
    }).expect(201)).body.data;

    // организатор в участниках и сразу «идёт» — он событие и создал
    const organizer = event.participants.find((p: any) => p.isOrganizer);
    expect(organizer.status).toBe('accepted');
    expect(event.participants.find((p: any) => String(p.userId) === String(mate.id)).status).toBe('invited');

    // приглашённый видит событие и своё непринятое приглашение
    const mineForMate = (await http$.get(`/api/calendar?${WINDOW()}`).set(H(mateToken)).expect(200)).body.data;
    const seen = mineForMate.events.find((e: any) => String(e.id) === String(event.id));
    expect(seen.title).toBe('Планёрка');
    expect(seen.myStatus).toBe('invited');
    expect(seen.canEdit).toBe(false); // правит тот, кто создал
    expect((await http$.get('/api/calendar/pending').set(H(mateToken)).expect(200)).body.data.count).toBe(1);

    // ответ меняет только свою строку
    await http$.post(`/api/calendar/events/${event.id}/respond`).set(H(mateToken)).send({ status: 'accepted' }).expect(201);
    const after = (await http$.get(`/api/calendar/events/${event.id}`).set(H(owner.accessToken)).expect(200)).body.data;
    expect(after.participants.find((p: any) => String(p.userId) === String(mate.id)).status).toBe('accepted');
    expect((await http$.get('/api/calendar/pending').set(H(mateToken)).expect(200)).body.data.count).toBe(0);

    // чужое событие не правит и не удаляет никто, кроме организатора
    await http$.patch(`/api/calendar/events/${event.id}`).set(H(mateToken)).send({ title: 'Взлом' }).expect(403);
    await http$.delete(`/api/calendar/events/${event.id}`).set(H(mateToken)).expect(403);
  });

  it('приватное чужое событие видно как занятость без названия', async () => {
    const owner = (await http$.post('/api/auth/register')
      .send({ tenantName: 'Приват', email: `own_${uniq()}@t.test`, password: 'password123', fullName: 'Владелец' })
      .expect(201)).body.data;
    const otherEmail = `other_${uniq()}@t.test`;
    await http$.post('/api/users').set(H(owner.accessToken))
      .send({ email: otherEmail, fullName: 'Сосед по офису', password: 'password123', role: 'member' }).expect(201);
    const otherToken = (await http$.post('/api/auth/login')
      .send({ email: otherEmail, password: 'password123' }).expect(201)).body.data.accessToken;

    // событие компании видят все — на нём и проверяем скрытие названия
    await http$.post('/api/calendar/events').set(H(owner.accessToken)).send({
      title: 'Разговор с юристом', description: 'подробности', location: 'кабинет',
      startsAt: iso(14), endsAt: iso(15), scope: 'company', isPrivate: true,
    }).expect(201);

    const list = (await http$.get(`/api/calendar?${WINDOW()}`).set(H(otherToken)).expect(200)).body.data;
    const hidden = list.events[0];
    expect(hidden.title).toBe('Занято');
    expect(hidden.description).toBeNull();
    expect(hidden.location).toBeNull();
    expect(hidden.participants).toEqual([]);
    expect(hidden.startsAt).toBeTruthy(); // время занятости видно — в этом и смысл
  });

  it('соседняя организация не видит ничего, а рядовой сотрудник не заводит событие компании', async () => {
    const a = (await http$.post('/api/auth/register')
      .send({ tenantName: 'Своя', email: `a_${uniq()}@t.test`, password: 'password123', fullName: 'Владелец' })
      .expect(201)).body.data;
    const b = (await http$.post('/api/auth/register')
      .send({ tenantName: 'Чужая', email: `b_${uniq()}@t.test`, password: 'password123', fullName: 'Чужой' })
      .expect(201)).body.data;

    const event = (await http$.post('/api/calendar/events').set(H(a.accessToken))
      .send({ title: 'Только наше', startsAt: iso(9), endsAt: iso(10), scope: 'company' }).expect(201)).body.data;

    const foreign = (await http$.get(`/api/calendar?${WINDOW()}`).set(H(b.accessToken)).expect(200)).body.data;
    expect(foreign.events).toEqual([]);
    await http$.get(`/api/calendar/events/${event.id}`).set(H(b.accessToken)).expect(404);

    const memberEmail = `m_${uniq()}@t.test`;
    await http$.post('/api/users').set(H(a.accessToken))
      .send({ email: memberEmail, fullName: 'Сотрудник', password: 'password123', role: 'member' }).expect(201);
    const memberToken = (await http$.post('/api/auth/login')
      .send({ email: memberEmail, password: 'password123' }).expect(201)).body.data.accessToken;

    await http$.post('/api/calendar/events').set(H(memberToken))
      .send({ title: 'Общее от рядового', startsAt: iso(9), endsAt: iso(10), scope: 'company' }).expect(403);
    // своё личное — пожалуйста
    await http$.post('/api/calendar/events').set(H(memberToken))
      .send({ title: 'Личное дело', startsAt: iso(9), endsAt: iso(10) }).expect(201);
  });

  it('рабочее время задаёт владелец, руководитель — нет', async () => {
    const owner = (await http$.post('/api/auth/register')
      .send({ tenantName: 'Часы', email: `own_${uniq()}@t.test`, password: 'password123', fullName: 'Владелец' })
      .expect(201)).body.data;
    const bossEmail = `boss_${uniq()}@t.test`;
    await http$.post('/api/users').set(H(owner.accessToken))
      .send({ email: bossEmail, fullName: 'Руководитель', password: 'password123', role: 'manager' }).expect(201);
    const bossToken = (await http$.post('/api/auth/login')
      .send({ email: bossEmail, password: 'password123' }).expect(201)).body.data.accessToken;

    const work = { workStart: '10:00', workEnd: '19:00', weekendDays: [0, 6], holidays: ['2027-01-01'] };
    await http$.post('/api/calendar/work').set(H(bossToken)).send(work).expect(403);

    const saved = (await http$.post('/api/calendar/work').set(H(owner.accessToken)).send(work).expect(201)).body.data;
    expect(saved.workStart).toBe('10:00');
    expect(saved.holidays).toEqual(['2027-01-01']);

    // начало позже конца — не рабочий день, а опечатка
    await http$.post('/api/calendar/work').set(H(owner.accessToken))
      .send({ ...work, workStart: '20:00', workEnd: '09:00' }).expect(400);
  });

  it('роль сотрудника меняет только владелец', async () => {
    const owner = (await http$.post('/api/auth/register')
      .send({ tenantName: 'Права', email: `own_${uniq()}@t.test`, password: 'password123', fullName: 'Основатель' })
      .expect(201)).body.data;

    const bossEmail = `boss_${uniq()}@t.test`;
    const boss = (await http$.post('/api/users').set(H(owner.accessToken))
      .send({ email: bossEmail, fullName: 'Руководитель', password: 'password123', role: 'manager' }).expect(201)).body.data;
    const bossToken = (await http$.post('/api/auth/login')
      .send({ email: bossEmail, password: 'password123' }).expect(201)).body.data.accessToken;

    // ГЛАВНОЕ: руководитель не может выдать себе владельца — иначе получит ключи интеграций
    await http$.patch(`/api/users/${boss.id}`).set(H(bossToken)).send({ role: 'owner' }).expect(403);
    // а владелец назначить помощника может: владельцев в компании может быть несколько
    await http$.patch(`/api/users/${boss.id}`).set(H(owner.accessToken)).send({ role: 'owner' }).expect(200);

    // и основателя новый владелец не понизит
    const founderId = owner.user?.id ?? owner.id;
    const promotedToken = (await http$.post('/api/auth/login')
      .send({ email: bossEmail, password: 'password123' }).expect(201)).body.data.accessToken;
    await http$.patch(`/api/users/${founderId}`).set(H(promotedToken)).send({ role: 'member' }).expect(403);
  });
});
