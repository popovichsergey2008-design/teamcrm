import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AddressInfo } from 'net';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { AllExceptionsFilter } from '../src/common/http/all-exceptions.filter';
import { ResponseInterceptor } from '../src/common/http/response.interceptor';
import { RedisIoAdapter } from '../src/common/auth/redis-io.adapter';

/**
 * ТЗ-14: встреча календаря с постоянной ссылкой.
 *
 * Ссылка есть сразу при создании, открывается всегда и говорит, что сейчас; при переносе
 * не меняется; после отмены отвечает «отменена», а не «не найдено».
 */
describe('Ссылка на встречу (e2e)', () => {
  let app: INestApplication;
  let http$: any;
  const uniq = () => Math.random().toString(36).slice(2) + Date.now().toString(36);
  const H = (t: string) => ({ Authorization: `Bearer ${t}` });
  const inMin = (m: number) => new Date(Date.now() + m * 60_000).toISOString();

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

  it('создал встречу с участником → ссылка сразу; перенос не меняет её; отмена — «отменена»', async () => {
    const owner = (await http$.post('/api/auth/register')
      .send({ tenantName: 'Встречи', email: `ml_${uniq()}@t.test`, password: 'password123', fullName: 'Организатор' })
      .expect(201)).body.data;
    const mate = (await http$.post('/api/users').set(H(owner.accessToken))
      .send({ email: `mlm_${uniq()}@t.test`, fullName: 'Участник', password: 'password123', role: 'member' })
      .expect(201)).body.data;

    // с участником — созвон включается сам (решение заказчика 05.10)
    const ev = (await http$.post('/api/calendar/events').set(H(owner.accessToken)).send({
      title: 'Обсуждение релиза', startsAt: inMin(24 * 60), endsAt: inMin(24 * 60 + 30), participantIds: [String(mate.id)],
    }).expect(201)).body.data;
    expect(ev.isCall).toBe(true);
    expect(ev.meeting.publicId).toMatch(/^[0-9A-Za-z]{10}$/);
    expect(ev.meeting.url).toContain(`/meet/${ev.meeting.publicId}`);
    const pid = ev.meeting.publicId;

    // открытая страница — без входа: «слишком рано», время, отсчёт по часам сервера
    const info = (await http$.get(`/api/meet/m/${pid}`).expect(200)).body.data;
    expect(info).toMatchObject({ valid: true, state: 'scheduled', title: 'Обсуждение релиза', guestsAllowed: true, accessPolicy: 'trusted' });
    expect(info.serverNow).toBeTruthy();
    // гостю за сутки в зал ожидания рано
    await http$.post(`/api/meet/m/${pid}/guest`).send({ name: 'Гость' }).expect(400);
    // своя часть — роль и участники
    const me = (await http$.get(`/api/meet/m/${pid}/me`).set(H(owner.accessToken)).expect(200)).body.data;
    expect(me).toMatchObject({ member: true, role: 'organizer' });
    expect(me.people.map((p: any) => p.name)).toEqual(expect.arrayContaining(['Участник']));

    // перенос — ссылка та же, время на её странице — новое
    const moved = inMin(26 * 60);
    const upd = (await http$.patch(`/api/calendar/events/${ev.id}`).set(H(owner.accessToken))
      .send({ startsAt: moved, endsAt: inMin(26 * 60 + 30) }).expect(200)).body.data;
    expect(upd.meeting.publicId).toBe(pid);
    expect((await http$.get(`/api/meet/m/${pid}`).expect(200)).body.data.startsAt).toBe(moved);

    // встреча через 10 минут — ранний вход: гость попадает в зал ожидания
    await http$.patch(`/api/calendar/events/${ev.id}`).set(H(owner.accessToken))
      .send({ startsAt: inMin(10), endsAt: inMin(40) }).expect(200);
    expect((await http$.get(`/api/meet/m/${pid}`).expect(200)).body.data.state).toBe('early');
    const guest = (await http$.post(`/api/meet/m/${pid}/guest`).send({ name: 'Гость Вектор' }).expect(201)).body.data;
    expect(guest.userId).toMatch(/^guest:/);
    // сотрудник входит — комната поднимается сама (раньше: «Созвон не найден»)
    const enter = (await http$.post(`/api/meet/m/${pid}/enter`).set(H(owner.accessToken)).expect(201)).body.data;
    expect(enter.roomId).toBeTruthy();

    // гостей можно выключить
    await http$.patch(`/api/calendar/events/${ev.id}`).set(H(owner.accessToken)).send({ guestsAllowed: false }).expect(200);
    await http$.post(`/api/meet/m/${pid}/guest`).send({ name: 'Гость' }).expect(403);

    // отмена — ссылка жива и говорит «отменена»
    await http$.delete(`/api/calendar/events/${ev.id}`).set(H(owner.accessToken)).expect(200);
    expect((await http$.get(`/api/meet/m/${pid}`).expect(200)).body.data).toMatchObject({ valid: true, state: 'cancelled' });
    await http$.post(`/api/meet/m/${pid}/enter`).set(H(owner.accessToken)).expect(409);

    // несуществующая — «нет такой», а не ошибка
    expect((await http$.get('/api/meet/m/zzzzzzzzzz').expect(200)).body.data).toMatchObject({ valid: false });
  });

  it('личное событие без участников — без созвона; чужой не входит по своей ссылке другой компании', async () => {
    const a = (await http$.post('/api/auth/register')
      .send({ tenantName: 'Компания А', email: `mla_${uniq()}@t.test`, password: 'password123', fullName: 'А' }).expect(201)).body.data;
    const solo = (await http$.post('/api/calendar/events').set(H(a.accessToken))
      .send({ title: 'Подумать', startsAt: inMin(60), endsAt: inMin(90) }).expect(201)).body.data;
    expect(solo.isCall).toBe(false);
    expect(solo.meeting).toBeNull();

    const call = (await http$.post('/api/calendar/events').set(H(a.accessToken))
      .send({ title: 'Созвон', startsAt: inMin(60), endsAt: inMin(90), isCall: true }).expect(201)).body.data;
    const b = (await http$.post('/api/auth/register')
      .send({ tenantName: 'Компания Б', email: `mlb_${uniq()}@t.test`, password: 'password123', fullName: 'Б' }).expect(201)).body.data;
    expect((await http$.get(`/api/meet/m/${call.meeting.publicId}/me`).set(H(b.accessToken)).expect(200)).body.data).toEqual({ member: false });
    await http$.post(`/api/meet/m/${call.meeting.publicId}/enter`).set(H(b.accessToken)).expect(404);
  });

  it('гость по email: личная ссылка с именем, отзыв поштучно, отмена встречи', async () => {
    const owner = (await http$.post('/api/auth/register')
      .send({ tenantName: 'Гости по почте', email: `mg_${uniq()}@t.test`, password: 'password123', fullName: 'Организатор' })
      .expect(201)).body.data;
    const ev = (await http$.post('/api/calendar/events').set(H(owner.accessToken))
      .send({ title: 'Показ клиенту', startsAt: inMin(24 * 60), endsAt: inMin(24 * 60 + 60), isCall: true }).expect(201)).body.data;

    const a = (await http$.post(`/api/calendar/events/${ev.id}/guests`).set(H(owner.accessToken))
      .send({ email: 'John.Smith@Client.test', name: 'John Smith' }).expect(201)).body.data;
    expect(a).toMatchObject({ email: 'john.smith@client.test', name: 'John Smith', active: true });
    const b = (await http$.post(`/api/calendar/events/${ev.id}/guests`).set(H(owner.accessToken))
      .send({ email: 'anna@client.test' }).expect(201)).body.data;
    // плохой адрес — отказ словами
    await http$.post(`/api/calendar/events/${ev.id}/guests`).set(H(owner.accessToken)).send({ email: 'не почта' }).expect(400);

    const tokA = a.url.split('/meet/')[1];
    const infoA = (await http$.get(`/api/meet/guest/${tokA}`).expect(200)).body.data;
    expect(infoA).toMatchObject({ valid: true, invitedAs: 'John Smith' });
    expect(infoA.startsAt).toBe(ev.startsAt);

    const list = (await http$.get(`/api/calendar/events/${ev.id}/guests`).set(H(owner.accessToken)).expect(200)).body.data;
    expect(list.map((i: any) => i.email).sort()).toEqual(['anna@client.test', 'john.smith@client.test']);
    // в общем списке гостевых ссылок личные приглашения встреч не путаются с постоянной ссылкой
    await http$.post(`/api/calendar/events/${ev.id}/guests/${a.id}/resend`).set(H(owner.accessToken)).expect(201);

    // отозвали одного — его ссылка «больше не активна», у второго работает
    await http$.delete(`/api/calendar/events/${ev.id}/guests/${a.id}`).set(H(owner.accessToken)).expect(200);
    expect((await http$.get(`/api/meet/guest/${tokA}`).expect(200)).body.data).toEqual({ valid: false, reason: 'invite-revoked' });
    const tokB = b.url.split('/meet/')[1];
    expect((await http$.get(`/api/meet/guest/${tokB}`).expect(200)).body.data.valid).toBe(true);

    // гостей зовёт организатор: коллега без прав — отказ
    const mate = (await http$.post('/api/users').set(H(owner.accessToken))
      .send({ email: `mgm_${uniq()}@t.test`, fullName: 'Коллега', password: 'password123', role: 'member' }).expect(201)).body.data;
    const mateTok = (await http$.post('/api/auth/login').send({ email: mate.email, password: 'password123' }).expect(201)).body.data.accessToken;
    await http$.post(`/api/calendar/events/${ev.id}/guests`).set(H(mateTok)).send({ email: 'x@y.test' }).expect(403);

    // встречу отменили — ссылка гостя говорит «отменена»
    await http$.delete(`/api/calendar/events/${ev.id}`).set(H(owner.accessToken)).expect(200);
    expect((await http$.get(`/api/meet/guest/${tokB}`).expect(200)).body.data).toEqual({ valid: false, reason: 'cancelled' });
  });
});
