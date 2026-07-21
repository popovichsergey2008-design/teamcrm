import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AddressInfo } from 'net';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { AllExceptionsFilter } from '../src/common/http/all-exceptions.filter';
import { ResponseInterceptor } from '../src/common/http/response.interceptor';
import { RedisIoAdapter } from '../src/common/auth/redis-io.adapter';

/**
 * Входящие → авто-задачи. Под mock LLM интент распознавания не гарантирован (черновик может
 * быть none/ignored), поэтому проверяем детерминированный контур: приём вебхука → подтверждение
 * ЯВНОГО черновика создаёт задачу; отклонение; управление каналами; публичность вебхука.
 */
describe('Inbox — авто-задачи из переписок (e2e)', () => {
  let app: INestApplication;
  let http$: any;
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
  });

  afterAll(async () => { await app?.close(); });

  it('канал → вебхук принимает письмо → подтверждение черновика создаёт задачу; отклонение; изоляция ролей', async () => {
    const email = `inbox_${uniq()}@t.test`;
    const reg = (await http$.post('/api/auth/register').send({ tenantName: 'Inbox', email, password: 'password123', fullName: 'Босс' }).expect(201)).body.data;
    const tok = reg.accessToken;
    const proj = (await http$.post('/api/projects').set(H(tok)).send({ name: 'Продажи' }).expect(201)).body.data;

    // создать канал приёма
    const source = (await http$.post('/api/inbox/sources').set(H(tok)).send({ label: 'Почта продаж', defaultProjectId: proj.id }).expect(201)).body.data;
    expect(source.token).toMatch(/^[0-9a-f]{48}$/);

    // канал виден в списке (с проектом по умолчанию)
    const sources = (await http$.get('/api/inbox/sources').set(H(tok)).expect(200)).body.data;
    expect(sources.some((s: any) => s.id === source.id && s.default_project_name === 'Продажи')).toBe(true);

    // публичный вебхук (без авторизации) принимает письмо
    const rcv = (await http$.post(`/api/inbox/hook/${source.token}`)
      .send({ from: 'client@acme.com', subject: 'Нужен лендинг', body: 'Сделайте посадочную страницу к пятнице' }).expect(201)).body.data;
    expect(rcv.received).toBe(true);
    expect(rcv.itemId).toBeTruthy();

    // подтвердить ЯВНЫЙ (возможно отредактированный) черновик → создаётся задача, статус item=created
    const confirmed = (await http$.post(`/api/inbox/items/${rcv.itemId}/confirm`).set(H(tok))
      .send({ task: { projectId: proj.id, title: 'Лендинг к пятнице', priority: 'high' } }).expect(201)).body.data;
    expect(confirmed.created).toBe(true);
    expect(confirmed.task.title).toBe('Лендинг к пятнице');

    // задача реально на доске
    const board = (await http$.get(`/api/projects/${proj.id}/board`).set(H(tok)).expect(200)).body.data;
    const task = board.columns.flatMap((c: any) => c.tasks).find((x: any) => x.title === 'Лендинг к пятнице');
    expect(task).toBeTruthy();

    // повторное подтверждение → 409 (задача уже создана)
    await http$.post(`/api/inbox/items/${rcv.itemId}/confirm`).set(H(tok))
      .send({ task: { projectId: proj.id, title: 'Дубль' } }).expect(409);

    // item перешёл в статус created (фоновый парсинг НЕ затирает решение человека)
    const created = (await http$.get('/api/inbox/items?status=created').set(H(tok)).expect(200)).body.data;
    expect(created.some((i: any) => i.id === rcv.itemId)).toBe(true);

    // Mailgun-стиль: multipart/form-data (поля from/subject/body-plain + «вложение») → приём и создание задачи
    const rcvMp = (await http$.post(`/api/inbox/hook/${source.token}`)
      .field('from', 'lead@acme.com').field('subject', 'Коммерческое предложение')
      .field('body-plain', 'Подготовьте КП по нашему проекту')
      .attach('attachment-1', Buffer.from('dummy file content'), 'brief.txt')
      .expect(201)).body.data;
    expect(rcvMp.received).toBe(true);
    expect(rcvMp.itemId).toBeTruthy();
    const confirmedMp = (await http$.post(`/api/inbox/items/${rcvMp.itemId}/confirm`).set(H(tok))
      .send({ task: { projectId: proj.id, title: 'Подготовить КП' } }).expect(201)).body.data;
    expect(confirmedMp.created).toBe(true);

    // второе письмо → отклонить
    const rcv2 = (await http$.post(`/api/inbox/hook/${source.token}`)
      .send({ from: 'spam@x.com', body: 'реклама' }).expect(201)).body.data;
    await http$.post(`/api/inbox/items/${rcv2.itemId}/dismiss`).set(H(tok)).expect(201);
    const dismissed = (await http$.get('/api/inbox/items?status=dismissed').set(H(tok)).expect(200)).body.data;
    expect(dismissed.some((i: any) => i.id === rcv2.itemId)).toBe(true);

    // неизвестный token → received:false (задачу не создаём)
    const bad = (await http$.post('/api/inbox/hook/deadbeef').send({ body: 'привет' }).expect(201)).body.data;
    expect(bad.received).toBe(false);

    // рядовой участник (member) не имеет доступа к управлению входящими
    const memEmail = `member_${uniq()}@t.test`;
    const inv = (await http$.post('/api/invites').set(H(tok)).send({ email: memEmail, role: 'member' }).expect(201)).body.data;
    await http$.post('/api/invites/accept').send({ token: inv.token, fullName: 'Работник', password: 'password123' }).expect(201);
    const memTok = (await http$.post('/api/auth/login').send({ email: memEmail, password: 'password123' }).expect(201)).body.data.accessToken;
    await http$.get('/api/inbox/sources').set(H(memTok)).expect(403);

    // голосовая заметка: multipart-аудио принимается; под mock Whisper речь пустая → 400 (нужен ключ)
    await http$.post('/api/inbox/voice').set(H(tok))
      .attach('audio', Buffer.from('fake audio bytes'), 'note.webm').expect(400);
    // без файла → 400
    await http$.post('/api/inbox/voice').set(H(tok)).expect(400);

    // удаление канала
    await http$.delete(`/api/inbox/sources/${source.id}`).set(H(tok)).expect(200);
    const after = (await http$.get('/api/inbox/sources').set(H(tok)).expect(200)).body.data;
    expect(after.some((s: any) => s.id === source.id)).toBe(false);
  });
});
