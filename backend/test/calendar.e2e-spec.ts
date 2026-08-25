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
  /**
   * Время события. По умолчанию ЗАВТРА, а не сегодня, и это важно: счётчик приглашений
   * считает только незакончившиеся события. С «сегодня в 10:00» тест проходил до обеда
   * и падал после — CI, запустившийся в 11:51 UTC, это и поймал.
   */
  const iso = (h: number, day = 1) => {
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

  it('напоминания сохраняются, а файл встречи отдаётся календарём, а не конвертом', async () => {
    const owner = (await http$.post('/api/auth/register')
      .send({ tenantName: 'Напоминания', email: `own_${uniq()}@t.test`, password: 'password123', fullName: 'Владелец' })
      .expect(201)).body.data;

    // по умолчанию — одно напоминание за 15 минут
    const byDefault = (await http$.post('/api/calendar/events').set(H(owner.accessToken))
      .send({ title: 'Без уточнений', startsAt: iso(12), endsAt: iso(13) }).expect(201)).body.data;
    const listed = (await http$.get(`/api/calendar?${WINDOW()}`).set(H(owner.accessToken)).expect(200)).body.data;
    expect(listed.events.find((e: any) => String(e.id) === String(byDefault.id)).reminders).toEqual([15]);

    // заданные напоминания чистятся от дублей и сортируются
    const event = (await http$.post('/api/calendar/events').set(H(owner.accessToken)).send({
      title: 'Созвон с клиентом', startsAt: iso(15), endsAt: iso(16), reminders: [60, 15, 15],
    }).expect(201)).body.data;
    const again = (await http$.get(`/api/calendar?${WINDOW()}`).set(H(owner.accessToken)).expect(200)).body.data;
    expect(again.events.find((e: any) => String(e.id) === String(event.id)).reminders).toEqual([15, 60]);

    // пустой список — это осознанное «не напоминать», а не «поставь по умолчанию»
    await http$.patch(`/api/calendar/events/${event.id}`).set(H(owner.accessToken))
      .send({ reminders: [] }).expect(200);
    const silent = (await http$.get(`/api/calendar?${WINDOW()}`).set(H(owner.accessToken)).expect(200)).body.data;
    expect(silent.events.find((e: any) => String(e.id) === String(event.id)).reminders).toEqual([]);

    // файл встречи: настоящий text/calendar, а не поле JSON
    const ics = await http$.get(`/api/calendar/events/${event.id}/ics`).set(H(owner.accessToken)).expect(200);
    expect(ics.headers['content-type']).toContain('text/calendar');
    expect(ics.text.startsWith('BEGIN:VCALENDAR')).toBe(true);
    expect(ics.text).toContain('SUMMARY:Созвон с клиентом');
    expect(ics.text).toContain('DTSTART:');

    // чужому файл не отдаём
    const stranger = (await http$.post('/api/auth/register')
      .send({ tenantName: 'Мимо', email: `x_${uniq()}@t.test`, password: 'password123', fullName: 'Чужой' })
      .expect(201)).body.data;
    await http$.get(`/api/calendar/events/${event.id}/ics`).set(H(stranger.accessToken)).expect(404);
  });

  it('на занятое время встречу не поставить, а отказ объясняет кто и когда занят', async () => {
    const owner = (await http$.post('/api/auth/register')
      .send({ tenantName: 'Пересечения', email: `own_${uniq()}@t.test`, password: 'password123', fullName: 'Владелец' })
      .expect(201)).body.data;
    const mateEmail = `mate_${uniq()}@t.test`;
    const mate = (await http$.post('/api/users').set(H(owner.accessToken))
      .send({ email: mateEmail, fullName: 'Занятой Коллега', password: 'password123', role: 'member' }).expect(201)).body.data;
    const mateToken = (await http$.post('/api/auth/login')
      .send({ email: mateEmail, password: 'password123' }).expect(201)).body.data.accessToken;

    await http$.post('/api/calendar/events').set(H(owner.accessToken)).send({
      title: 'Первая встреча', startsAt: iso(11), endsAt: iso(12), participantIds: [String(mate.id)],
    }).expect(201);

    // занятость видна ДО сохранения — и без названия чужой встречи
    const busy = (await http$.get(
      `/api/calendar/busy?from=${encodeURIComponent(iso(11))}&to=${encodeURIComponent(iso(12))}&userIds=${mate.id}`,
    ).set(H(owner.accessToken)).expect(200)).body.data;
    expect(busy.busy[String(mate.id)].length).toBe(1);
    expect(JSON.stringify(busy)).not.toContain('Первая встреча');

    // вторая встреча на то же время не проходит, и отказ называет человека
    const denied = await http$.post('/api/calendar/events').set(H(owner.accessToken)).send({
      title: 'Вторая на то же время', startsAt: iso(11), endsAt: iso(12), participantIds: [String(mate.id)],
    }).expect(409);
    expect(denied.body.error.message).toContain('Занятой Коллега');

    // соседнее время свободно
    await http$.post('/api/calendar/events').set(H(owner.accessToken)).send({
      title: 'Позже', startsAt: iso(13), endsAt: iso(14), participantIds: [String(mate.id)],
    }).expect(201);

    // сам организатор себе не мешает: своё событие поверх своего — его осознанный выбор
    await http$.post('/api/calendar/events').set(H(owner.accessToken))
      .send({ title: 'Своё поверх своего', startsAt: iso(11), endsAt: iso(12) }).expect(201);

    // человек снял у себя запрет — и его снова можно звать внахлёст
    await http$.patch('/api/me').set(H(mateToken)).send({ calendarBlockOverlap: false }).expect(200);
    await http$.post('/api/calendar/events').set(H(owner.accessToken)).send({
      title: 'Внахлёст по согласию', startsAt: iso(11), endsAt: iso(12), participantIds: [String(mate.id)],
    }).expect(201);

    // и настройка видна в профиле
    const me = (await http$.get('/api/me').set(H(mateToken)).expect(200)).body.data;
    expect(me.calendarBlockOverlap).toBe(false);
  });

  it('событие на весь день не запирает сутки, а правка не конфликтует сама с собой', async () => {
    const owner = (await http$.post('/api/auth/register')
      .send({ tenantName: 'Весь день', email: `own_${uniq()}@t.test`, password: 'password123', fullName: 'Владелец' })
      .expect(201)).body.data;
    const mateEmail = `mate_${uniq()}@t.test`;
    const mate = (await http$.post('/api/users').set(H(owner.accessToken))
      .send({ email: mateEmail, fullName: 'Коллега', password: 'password123', role: 'member' }).expect(201)).body.data;

    // «весь день» — это пометка на сутки, а не занятое время: встречи в этот день можно ставить
    const allDay = (await http$.post('/api/calendar/events').set(H(owner.accessToken)).send({
      title: 'Выезд на объект', startsAt: iso(0), endsAt: iso(23), allDay: true, participantIds: [String(mate.id)],
    }).expect(201)).body.data;

    await http$.post('/api/calendar/events').set(H(owner.accessToken)).send({
      title: 'Планёрка внутри дня', startsAt: iso(10), endsAt: iso(11), participantIds: [String(mate.id)],
    }).expect(201);

    // в занятости оно видно, но отдельным видом — экран не должен пугать им как конфликтом
    const busy = (await http$.get(
      `/api/calendar/busy?from=${encodeURIComponent(iso(9))}&to=${encodeURIComponent(iso(10))}&userIds=${mate.id}`,
    ).set(H(owner.accessToken)).expect(200)).body.data;
    expect(busy.busy[String(mate.id)].some((b: any) => b.kind === 'all_day')).toBe(true);

    // правка собственного события не должна конфликтовать с ним же
    await http$.patch(`/api/calendar/events/${allDay.id}`).set(H(owner.accessToken))
      .send({ title: 'Выезд на объект (перенос)', startsAt: iso(0), endsAt: iso(23) }).expect(200);

    // и занятость при правке считается без него самого
    const withoutSelf = (await http$.get(
      `/api/calendar/busy?from=${encodeURIComponent(iso(9))}&to=${encodeURIComponent(iso(10))}&userIds=${mate.id}&exceptEventId=${allDay.id}`,
    ).set(H(owner.accessToken)).expect(200)).body.data;
    expect(withoutSelf.busy[String(mate.id)].some((b: any) => b.kind === 'all_day')).toBe(false);
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
