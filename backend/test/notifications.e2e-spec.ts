import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AddressInfo } from 'net';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { AllExceptionsFilter } from '../src/common/http/all-exceptions.filter';
import { ResponseInterceptor } from '../src/common/http/response.interceptor';
import { RedisIoAdapter } from '../src/common/auth/redis-io.adapter';
import { DbService } from '../src/database/db.service';

/**
 * Почтовые уведомления по задачам.
 *
 * Отправку наружу не трогаем: без ключа сервиса транспорт пишет в журнал.
 * Проверяем то, что и должно проверяться, — доходит ли событие до очереди,
 * кому, не дублируется ли и слушаются ли настройки.
 */
describe('Почтовые уведомления (e2e)', () => {
  let app: INestApplication;
  let http: any;
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
    http = request(`http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`);
    db = app.get(DbService);
  });
  afterAll(async () => app?.close());

  const readMail = (email: string) =>
    db.many<{ subject: string; event_key: string; body_text: string }>(
      `SELECT subject, event_key, body_text FROM mail_outbox WHERE to_email=$1 ORDER BY id`, [email]);

  /**
   * Письмо ставится в очередь, не задерживая ответ пользователю, поэтому сразу
   * после запроса его может ещё не быть. Ждём появления нужного события.
   */
  const mailFor = async (email: string, expect?: { event: string; count?: number }) => {
    for (let i = 0; i < 40; i++) {
      const rows = await readMail(email);
      if (!expect) return rows;
      if (rows.filter((m) => m.event_key === expect.event).length >= (expect.count ?? 1)) return rows;
      await new Promise((r) => setTimeout(r, 100));
    }
    return readMail(email);
  };

  it('исполнитель получает письма о задаче, автор действия — нет', async () => {
    const ownerEmail = `own_${uniq()}@t.test`;
    const reg = (await http.post('/api/auth/register')
      .send({ tenantName: 'Почта', email: ownerEmail, password: 'password123', fullName: 'Ольга Владелец' })
      .expect(201)).body.data;
    const tok = reg.accessToken;

    // исполнитель — отдельный человек, иначе письмо себе же и не полагается
    const execEmail = `exe_${uniq()}@t.test`;
    const exec = (await http.post('/api/users').set(H(tok))
      .send({ email: execEmail, password: 'password123', fullName: 'Иван Исполнитель', role: 'member' })
      .expect(201)).body.data;

    const proj = (await http.post('/api/projects').set(H(tok)).send({ name: 'Проект' }).expect(201)).body.data;
    const board = (await http.get(`/api/projects/${proj.id}/board`).set(H(tok)).expect(200)).body.data;
    const col = board.columns[0].id;

    const task = (await http.post('/api/tasks').set(H(tok))
      .send({ projectId: proj.id, columnId: col, title: 'Обновить прайс', assigneeId: exec.id })
      .expect(201)).body.data;

    const created = await mailFor(execEmail, { event: 'task.created' });
    expect(created.some((m) => m.event_key === 'task.created')).toBe(true);
    expect(created[0].body_text).toContain('Обновить прайс');
    expect(created[0].body_text).toContain('Ольга Владелец'); // видно, кто поставил
    // автор действия тоже получает письмо: задача, поставленная себе, должна дойти
    const mine = await mailFor(ownerEmail, { event: 'task.created' });
    expect(mine.length).toBeGreaterThan(0);

    // комментарий владельца → письмо исполнителю
    await http.post(`/api/tasks/${task.id}/comments`).set(H(tok)).send({ body: 'Уточнение по срокам' }).expect(201);
    const afterComment = await mailFor(execEmail, { event: 'task.commented' });
    const comment = afterComment.find((m) => m.event_key === 'task.commented');
    expect(comment).toBeTruthy();
    expect(comment!.body_text).toContain('Уточнение по срокам');

    // перенос в другую колонку → письмо о смене статуса
    const target = board.columns[1]?.id;
    if (target) {
      await http.post(`/api/tasks/${task.id}/move`).set(H(tok)).send({ columnId: target, position: 0 }).expect(201);
      const afterMove = await mailFor(execEmail, { event: 'task.status' });
      expect(afterMove.some((m) => m.event_key === 'task.status')).toBe(true);
      // повторный перенос в ту же колонку письмо не плодит
      await http.post(`/api/tasks/${task.id}/move`).set(H(tok)).send({ columnId: target, position: 0 }).expect(201);
      await new Promise((r) => setTimeout(r, 500)); // дали шанс появиться лишнему письму
      const again = await readMail(execEmail);
      expect(again.filter((m) => m.event_key === 'task.status').length).toBe(1);
    }
  });

  it('настройки выключают письма, отписка из письма — тоже', async () => {
    const email = `pr_${uniq()}@t.test`;
    const reg = (await http.post('/api/auth/register')
      .send({ tenantName: 'Настройки', email, password: 'password123', fullName: 'Пётр Настройка' })
      .expect(201)).body.data;
    const tok = reg.accessToken;

    const prefs = (await http.get('/api/notifications/prefs').set(H(tok)).expect(200)).body.data;
    expect(prefs.map((p: any) => p.eventKey).sort())
      .toEqual(['task.commented', 'task.created', 'task.own', 'task.status']);
    expect(prefs.every((p: any) => p.enabled)).toBe(true); // по умолчанию письма приходят

    await http.put('/api/notifications/prefs').set(H(tok))
      .send({ eventKey: 'task.created', enabled: false }).expect(200);
    const off = (await http.get('/api/notifications/prefs').set(H(tok)).expect(200)).body.data;
    expect(off.find((p: any) => p.eventKey === 'task.created').enabled).toBe(false);

    // неизвестное событие не принимаем
    await http.put('/api/notifications/prefs').set(H(tok))
      .send({ eventKey: 'task.whatever', enabled: false }).expect(400);

    // выключение писем о собственных действиях
    await http.put('/api/notifications/prefs').set(H(tok))
      .send({ eventKey: 'task.own', enabled: false }).expect(200);
    const own = (await http.get('/api/notifications/prefs').set(H(tok)).expect(200)).body.data;
    expect(own.find((p: any) => p.eventKey === 'task.own').enabled).toBe(false);

    // отписка по битому токену не должна ничего менять и не должна падать
    await http.get('/api/notifications/unsubscribe?token=нет-такого').expect(404);
  });
});
