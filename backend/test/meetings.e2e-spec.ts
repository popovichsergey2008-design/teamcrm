import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AddressInfo } from 'net';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { AllExceptionsFilter } from '../src/common/http/all-exceptions.filter';
import { ResponseInterceptor } from '../src/common/http/response.interceptor';
import { RedisIoAdapter } from '../src/common/auth/redis-io.adapter';

/**
 * Этап 6, М2: загрузка субтитров встречи → стенограмма → черновики задач → подтверждение.
 * Берём именно .vtt: он не требует ни ffmpeg, ни ключей распознавания, поэтому путь
 * проверяется целиком на CI. Разбор идёт mock-провайдером ИИ.
 */
describe('Разбор записей встреч (e2e)', () => {
  let app: INestApplication;
  let http$: any;
  const uniq = () => Math.random().toString(36).slice(2) + Date.now().toString(36);
  const H = (t: string) => ({ Authorization: `Bearer ${t}` });
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  const VTT = [
    'WEBVTT', '',
    '1', '00:00:01.000 --> 00:00:06.000', '<v Иван Петров>Обсудим интеграцию с YouGile',
    '', '2', '00:00:07.000 --> 00:00:12.000', 'Алина: беру интеграцию на себя, сделаю к пятнице',
    '', '3', '00:01:00.000 --> 00:01:04.000', 'Иван Петров: договорились, фиксируем',
  ].join('\n');

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

  it('субтитры → стенограмма с говорящими → черновик → подтверждение создаёт задачу', async () => {
    const email = `mt_${uniq()}@t.test`;
    const owner = (await http$.post('/api/auth/register')
      .send({ tenantName: 'MT', email, password: 'password123', fullName: 'Иван Петров' }).expect(201)).body.data;
    const tok = owner.accessToken;

    const project = (await http$.post('/api/projects').set(H(tok)).send({ name: 'Интеграции' }).expect(201)).body.data;

    // загрузка субтитров
    const created = (await http$.post('/api/meetings').set(H(tok))
      .field('title', 'Планёрка по интеграции')
      .field('projectId', project.id)
      .attach('file', Buffer.from(VTT, 'utf8'), { filename: 'meet.vtt', contentType: 'text/plain' })
      .expect(201)).body.data;
    expect(created.id).toBeTruthy();
    expect(created.source).toBe('transcript');

    // обработка идёт фоном — ждём завершения
    let details: any;
    for (let i = 0; i < 60; i++) {
      details = (await http$.get(`/api/meetings/${created.id}`).set(H(tok)).expect(200)).body.data;
      if (['done', 'error'].includes(details.meeting.status)) break;
      await sleep(200);
    }
    expect(details.meeting.status).toBe('done');

    // стенограмма разобрана: реплики, таймкоды, говорящие из субтитров
    expect(details.segments.length).toBe(3);
    expect(details.segments[0].speaker).toBe('Иван Петров');
    expect(details.segments[1].speaker).toBe('Алина');
    expect(Number(details.segments[2].start_sec)).toBeCloseTo(60, 0);
    expect(details.summary).toBeTruthy();

    // из реплики «Алина: беру интеграцию…» получился черновик с цитатой-источником
    const draft = details.drafts.find((d: any) => /беру интеграцию/i.test(d.title));
    expect(draft).toBeTruthy();
    expect(draft.status).toBe('pending');
    expect(draft.quote).toContain('беру интеграцию');
    expect(draft.assignee_hint).toBe('Алина');
    expect(draft.assignee_id).toBeNull(); // Алины нет в команде — исполнителя не выдумываем

    // до подтверждения задач на доске нет
    const before = (await http$.get(`/api/projects/${project.id}/board`).set(H(tok)).expect(200)).body.data;
    expect(before.columns.flatMap((c: any) => c.tasks)).toHaveLength(0);

    // подтверждение создаёт обычную задачу
    const task = (await http$.post(`/api/meetings/drafts/${draft.id}/apply`).set(H(tok))
      .send({ assigneeId: owner.user.id, projectId: project.id }).expect(201)).body.data;
    expect(task.title).toMatch(/беру интеграцию/i);
    expect(task.assignee_id).toBe(owner.user.id);

    const after = (await http$.get(`/api/projects/${project.id}/board`).set(H(tok)).expect(200)).body.data;
    expect(after.columns.flatMap((c: any) => c.tasks)).toHaveLength(1);

    // повторное подтверждение того же черновика отклоняется
    await http$.post(`/api/meetings/drafts/${draft.id}/apply`).set(H(tok)).send({ projectId: project.id }).expect(409);

    // список показывает встречу и её статус
    const list = (await http$.get('/api/meetings').set(H(tok)).expect(200)).body.data;
    expect(list.some((m: any) => m.id === created.id)).toBe(true);
  });

  it('пустой файл субтитров даёт понятную ошибку, а не падение', async () => {
    const email = `mt2_${uniq()}@t.test`;
    const owner = (await http$.post('/api/auth/register')
      .send({ tenantName: 'MT2', email, password: 'password123', fullName: 'O' }).expect(201)).body.data;

    const created = (await http$.post('/api/meetings').set(H(owner.accessToken))
      .field('title', 'Пустышка')
      .attach('file', Buffer.from('WEBVTT\n\nмусор без таймкодов', 'utf8'), { filename: 'x.vtt', contentType: 'text/plain' })
      .expect(201)).body.data;

    let details: any;
    for (let i = 0; i < 40; i++) {
      details = (await http$.get(`/api/meetings/${created.id}`).set(H(owner.accessToken)).expect(200)).body.data;
      if (['done', 'error'].includes(details.meeting.status)) break;
      await sleep(200);
    }
    expect(details.meeting.status).toBe('error');
    expect(details.meeting.error).toMatch(/реплик/i);
  });

  it('встречу без файла не принимаем', async () => {
    const email = `mt3_${uniq()}@t.test`;
    const owner = (await http$.post('/api/auth/register')
      .send({ tenantName: 'MT3', email, password: 'password123', fullName: 'O' }).expect(201)).body.data;
    await http$.post('/api/meetings').set(H(owner.accessToken)).field('title', 'Без файла').expect(400);
  });
});
