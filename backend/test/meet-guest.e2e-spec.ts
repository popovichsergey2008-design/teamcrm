import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AddressInfo } from 'net';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { AllExceptionsFilter } from '../src/common/http/all-exceptions.filter';
import { ResponseInterceptor } from '../src/common/http/response.interceptor';
import { RedisIoAdapter } from '../src/common/auth/redis-io.adapter';

/**
 * Гостевой доступ в созвон по ссылке.
 *
 * Сам разговор (mediasoup, сигналинг) сюда не попадает намеренно: пакет лежит в
 * optionalDependencies и на CI не ставится. Проверяем то, что решает вопрос доступа:
 * кому ссылка выдаёт токен, кому отказывает и что этот токен НЕ открывает.
 */
describe('Гостевой доступ в созвон (e2e)', () => {
  let app: INestApplication;
  let http$: any;
  const uniq = () => Math.random().toString(36).slice(2) + Date.now().toString(36);
  const H = (t: string) => ({ Authorization: `Bearer ${t}` });

  const register = async (name: string) => {
    const email = `${name}_${uniq()}@t.test`;
    return (await http$.post('/api/auth/register')
      .send({ tenantName: name, email, password: 'password123', fullName: 'Владелец' })
      .expect(201)).body.data;
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

  it('ссылка → гость называется и получает токен на ОДНУ комнату; отзыв закрывает вход', async () => {
    const owner = await register('Гости');

    const link = (await http$.post('/api/meet/guest-links').set(H(owner.accessToken))
      .send({ label: 'ООО Вектор' }).expect(201)).body.data;
    expect(link.url).toContain('/meet/');
    const token = link.url.split('/meet/')[1];

    // страница приглашения: название организации и для кого ссылка — и ничего лишнего
    const info = (await http$.get(`/api/meet/guest/${token}`).expect(200)).body.data;
    // ответ обязан приезжать в общем конверте {ok, data}: поле `ok` внутри данных
    // проходило бы обёртку насквозь, и фронт получал бы пустоту
    expect(info.valid).toBe(true);
    expect(info.orgName).toBe('Гости');
    expect(info.label).toBe('ООО Вектор');
    // созвон ещё не идёт — гостю это честно сообщается, а не «ссылка битая»
    expect(info.roomActive).toBe(false);
    expect(info.hostPresent).toBe(false);

    // безымянный гость не проходит: в стенограмме и в списке должно быть имя
    await http$.post(`/api/meet/guest/${token}/join`).send({ name: 'X' }).expect(400);

    const admitted = (await http$.post(`/api/meet/guest/${token}/join`)
      .send({ name: 'Сергей из Вектора' }).expect(201)).body.data;
    expect(admitted.token).toBeTruthy();
    expect(admitted.roomId).toBe(link.roomId);
    expect(admitted.userId).toMatch(/^guest:/);
    expect(Array.isArray(admitted.iceServers)).toBe(true);

    // ГЛАВНОЕ: гостевой токен — не пропуск в CRM. Ни одного обычного маршрута.
    await http$.get('/api/tasks/my').set(H(admitted.token)).expect(401);
    await http$.get('/api/projects').set(H(admitted.token)).expect(401);
    await http$.get('/api/meet/guest-links').set(H(admitted.token)).expect(401);

    // ссылка видна хозяину и отзывается
    const list = (await http$.get('/api/meet/guest-links').set(H(owner.accessToken)).expect(200)).body.data;
    expect(list.some((l: any) => String(l.id) === String(link.id))).toBe(true);

    await http$.delete(`/api/meet/guest-links/${link.id}`).set(H(owner.accessToken)).expect(200);

    const after = (await http$.get(`/api/meet/guest/${token}`).expect(200)).body.data;
    expect(after).toEqual({ valid: false, reason: 'revoked' });
    await http$.post(`/api/meet/guest/${token}/join`).send({ name: 'Сергей из Вектора' }).expect(401);

    // отозванная ссылка пропадает из списка активных
    const listAfter = (await http$.get('/api/meet/guest-links').set(H(owner.accessToken)).expect(200)).body.data;
    expect(listAfter.some((l: any) => String(l.id) === String(link.id))).toBe(false);

    // и войти в её комнату хозяин больше не может: встреча по отозванной ссылке не «полуживая»
    await http$.post(`/api/meet/guest-links/${link.id}/open`).set(H(owner.accessToken)).expect(404);
  });

  it('чужую ссылку соседняя организация не отзывает, выдуманный токен ничего не открывает', async () => {
    const a = await register('Своя');
    const b = await register('Чужая');

    const link = (await http$.post('/api/meet/guest-links').set(H(a.accessToken)).send({}).expect(201)).body.data;

    // сосед не видит и не может отозвать
    const foreignList = (await http$.get('/api/meet/guest-links').set(H(b.accessToken)).expect(200)).body.data;
    expect(foreignList).toEqual([]);
    await http$.delete(`/api/meet/guest-links/${link.id}`).set(H(b.accessToken)).expect(404);

    // и войти в чужую комнату по номеру ссылки тоже нельзя
    await http$.post(`/api/meet/guest-links/${link.id}/open`).set(H(b.accessToken)).expect(404);

    // ссылка соседа при этом продолжает работать
    const token = link.url.split('/meet/')[1];
    const info = (await http$.get(`/api/meet/guest/${token}`).expect(200)).body.data;
    expect(info.valid).toBe(true);

    // выдуманный токен — «нет такой ссылки», без подсказок
    const bogus = (await http$.get('/api/meet/guest/definitely-not-a-token').expect(200)).body.data;
    expect(bogus).toEqual({ valid: false, reason: 'unknown' });
    await http$.post('/api/meet/guest/definitely-not-a-token/join').send({ name: 'Кто-то' }).expect(401);
  });
  it('ссылка привязывается к чату и подписывается им в списке', async () => {
    const owner = await register('ГостиЧат');
    const mate = (await http$.post('/api/users').set(H(owner.accessToken))
      .send({ email: `gl_${Date.now()}@t.test`, fullName: 'Коллега', password: 'password123', role: 'member' })
      .expect(201)).body.data;
    const chat = (await http$.post('/api/chats/groups').set(H(owner.accessToken))
      .send({ title: 'Клиент Вектор', userIds: [String(mate.id)] }).expect(201)).body.data;

    const link = (await http$.post('/api/meet/guest-links').set(H(owner.accessToken))
      .send({ label: 'ООО Вектор', chatId: String(chat.id), ttlHours: 72 }).expect(201)).body.data;
    expect(link.url).toContain('/meet/');

    // В списке видно, ради какого разговора ссылка: «для кого» без «для чего»
    // через неделю превращается в загадку.
    const list = (await http$.get('/api/meet/guest-links').set(H(owner.accessToken)).expect(200)).body.data;
    const mine = list.find((l: any) => String(l.id) === String(link.id));
    expect(mine.chat_title).toBe('Клиент Вектор');

    // Срок действия — тот, что выбрали, а не всегда сутки.
    const hours = (new Date(mine.expires_at).getTime() - Date.now()) / 3_600_000;
    expect(hours).toBeGreaterThan(70);
    expect(hours).toBeLessThan(74);
  });

  it('встреча «завтра в 9»: гость видит время, в созвон рано; ссылка из события — в комнату события', async () => {
    const owner = await register('ГостиВремя');
    const at = new Date(Date.now() + 26 * 3_600_000);
    at.setUTCMinutes(0, 0, 0);

    // ссылка на время: срок «4 часа» не должен убить её до встречи
    const link = (await http$.post('/api/meet/guest-links').set(H(owner.accessToken))
      .send({ label: 'Вектор', startsAt: at.toISOString(), ttlHours: 4 }).expect(201)).body.data;
    expect(new Date(link.expiresAt).getTime()).toBeGreaterThan(at.getTime());
    const token = link.url.split('/meet/')[1];
    const info = (await http$.get(`/api/meet/guest/${token}`).expect(200)).body.data;
    expect(info.startsAt).toBe(at.toISOString());
    expect(new Date(info.opensAt).getTime()).toBe(at.getTime() - 15 * 60_000);
    expect(info.hasChat).toBe(false);
    // за сутки до встречи ссылка «только на созвон» не пускает
    await http$.post(`/api/meet/guest/${token}/join`).send({ name: 'Сергей' }).expect(400);
    // прошедшее время не принимаем
    await http$.post('/api/meet/guest-links').set(H(owner.accessToken))
      .send({ startsAt: new Date(Date.now() - 3_600_000).toISOString() }).expect(400);

    // из события: время и комната — его; «Войти в созвон» и гость ведут в одно место
    const start = new Date(Date.now() + 3 * 86_400_000); start.setUTCHours(9, 0, 0, 0);
    const end = new Date(start.getTime() + 3_600_000);
    const event = (await http$.post('/api/calendar/events').set(H(owner.accessToken))
      .send({ title: 'Показ клиенту', startsAt: start.toISOString(), endsAt: end.toISOString() }).expect(201)).body.data;
    const fromEvent = (await http$.post('/api/meet/guest-links').set(H(owner.accessToken))
      .send({ eventId: String(event.id) }).expect(201)).body.data;
    expect(fromEvent.startsAt).toBe(start.toISOString());
    expect(fromEvent.label).toBe('Показ клиенту');
    const again = (await http$.post('/api/meet/guest-links').set(H(owner.accessToken))
      .send({ eventId: String(event.id) }).expect(201)).body.data;
    expect(again.roomId).toBe(fromEvent.roomId);

    // встречу перенесли — ссылка переехала следом
    const moved = new Date(start.getTime() + 2 * 3_600_000);
    await http$.patch(`/api/calendar/events/${event.id}`).set(H(owner.accessToken))
      .send({ startsAt: moved.toISOString(), endsAt: new Date(moved.getTime() + 3_600_000).toISOString() }).expect(200);
    const evToken = fromEvent.url.split('/meet/')[1];
    const evInfo = (await http$.get(`/api/meet/guest/${evToken}`).expect(200)).body.data;
    expect(evInfo.startsAt).toBe(moved.toISOString());

    // чужое событие ссылкой не завернуть
    const stranger = await register('Чужие');
    await http$.post('/api/meet/guest-links').set(H(stranger.accessToken))
      .send({ eventId: String(event.id) }).expect(404);
  });
});
