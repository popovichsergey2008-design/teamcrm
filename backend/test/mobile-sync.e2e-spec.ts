import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AddressInfo } from 'net';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { AllExceptionsFilter } from '../src/common/http/all-exceptions.filter';
import { ResponseInterceptor } from '../src/common/http/response.interceptor';
import { RedisIoAdapter } from '../src/common/auth/redis-io.adapter';

/**
 * ТЗ-9, волна 9: работа без сети — идемпотентность повторов, версии задач, delta-sync.
 */
describe('Mobile — offline: Idempotency-Key, If-Match, sync (e2e)', () => {
  let app: INestApplication;
  let http: any;
  const uniq = () => Math.random().toString(36).slice(2) + Date.now().toString(36);
  const H = (t: string) => ({ Authorization: `Bearer ${t}` });

  let owner: { accessToken: string; id: string };
  let member: { token: string; id: string };
  let proj: any;
  let board: any;

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

    owner = (await http.post('/api/auth/register')
      .send({ tenantName: 'Офлайн', email: `own_${uniq()}@t.test`, password: 'password123', fullName: 'Ольга' }).expect(201)).body.data;
    const memberEmail = `mem_${uniq()}@t.test`;
    const m = (await http.post('/api/users').set(H(owner.accessToken))
      .send({ email: memberEmail, password: 'password123', fullName: 'Иван', role: 'member' }).expect(201)).body.data;
    member = {
      id: m.id,
      token: (await http.post('/api/auth/login').send({ email: memberEmail, password: 'password123' }).expect(201)).body.data.accessToken,
    };
    proj = (await http.post('/api/projects').set(H(owner.accessToken)).send({ name: 'Общий' }).expect(201)).body.data;
    board = (await http.get(`/api/projects/${proj.id}/board`).set(H(owner.accessToken)).expect(200)).body.data;
  });
  afterAll(async () => app?.close());

  const onBoard = async (taskId: string) => {
    const b = (await http.get(`/api/projects/${proj.id}/board`).set(H(owner.accessToken)).expect(200)).body.data;
    return b.columns.flatMap((c: any) => c.tasks).find((t: any) => String(t.id) === String(taskId));
  };

  it('повтор запроса с тем же Idempotency-Key не создаёт вторую задачу и отдаёт тот же ответ', async () => {
    const key = `k-${uniq()}`;
    const body = { projectId: proj.id, columnId: board.columns[0].id, title: 'Один раз' };
    const first = (await http.post('/api/tasks').set(H(owner.accessToken)).set('Idempotency-Key', key).send(body).expect(201)).body.data;
    const second = (await http.post('/api/tasks').set(H(owner.accessToken)).set('Idempotency-Key', key).send(body).expect(201)).body.data;
    expect(second.id).toBe(first.id);

    const list = (await http.get(`/api/projects/${proj.id}/board`).set(H(owner.accessToken)).expect(200)).body.data;
    const same = list.columns.flatMap((c: any) => c.tasks).filter((t: any) => t.title === 'Один раз');
    expect(same.length).toBe(1);

    // чужой человек с тем же ключом — свой запрос, не чужой ответ
    const other = (await http.post('/api/tasks').set(H(member.token)).set('Idempotency-Key', key).send(body).expect(201)).body.data;
    expect(other.id).not.toBe(first.id);

    // кривой ключ — 400, а не молчаливое игнорирование
    await http.post('/api/tasks').set(H(owner.accessToken)).set('Idempotency-Key', 'x').send(body).expect(400);
  });

  it('If-Match: правка на старую версию — 409 с текущей задачей; на актуальную — проходит и растит версию', async () => {
    const task = (await http.post('/api/tasks').set(H(owner.accessToken))
      .send({ projectId: proj.id, columnId: board.columns[0].id, title: 'Версии' }).expect(201)).body.data;
    expect(task.version).toBe(1);

    // коллега правит из веба (без заголовка) — версия растёт
    const v2 = (await http.patch(`/api/tasks/${task.id}`).set(H(owner.accessToken)).send({ description: 'из веба' }).expect(200)).body.data;
    expect(v2.version).toBe(2);

    // телефон привёз правку на версию 1
    const conflict = await http.patch(`/api/tasks/${task.id}`).set(H(member.token)).set('If-Match', '1')
      .send({ description: 'с телефона' }).expect(409);
    expect(conflict.body.error.code).toBe('CONFLICT');
    expect(conflict.body.error.details.reason).toBe('version');
    expect(conflict.body.error.details.current).toBe(2);
    expect(conflict.body.error.details.task.description).toBe('из веба');
    expect(conflict.body.error.details.fields).toEqual(['description']);

    // на актуальную — проходит, кавычки как в ETag допустимы
    const v3 = (await http.patch(`/api/tasks/${task.id}`).set(H(member.token)).set('If-Match', '"2"')
      .send({ description: 'с телефона' }).expect(200)).body.data;
    expect(v3.version).toBe(3);
    expect(v3.description).toBe('с телефона');

    // перенос чужой карточки в той же колонке версию НЕ трогает (сдвиг позиции — не правка)
    const other = (await http.post('/api/tasks').set(H(owner.accessToken))
      .send({ projectId: proj.id, columnId: board.columns[0].id, title: 'Сосед' }).expect(201)).body.data;
    await http.post(`/api/tasks/${other.id}/move`).set(H(owner.accessToken))
      .send({ columnId: board.columns[0].id, position: 0 }).expect(201);
    expect((await onBoard(task.id)).version).toBe(3);

    // перенос самой задачи с устаревшей версией — тоже 409
    await http.post(`/api/tasks/${task.id}/move`).set(H(member.token)).set('If-Match', '1')
      .send({ columnId: board.columns[1].id, position: 0 }).expect(409);
  });

  it('sync: без курсора — голова журнала; после курсора — ссылки на изменившееся; приватный проект чужому не виден', async () => {
    const head = (await http.get('/api/mobile/sync').set(H(member.token)).expect(200)).body.data;
    expect(head.reset).toBe(false);
    expect(head.changes).toEqual([]);
    expect(typeof head.cursor).toBe('string');

    const task = (await http.post('/api/tasks').set(H(owner.accessToken))
      .send({ projectId: proj.id, columnId: board.columns[0].id, title: 'Синхр' }).expect(201)).body.data;
    await http.post(`/api/tasks/${task.id}/comments`).set(H(owner.accessToken)).send({ body: 'привет' }).expect(201);

    // приватный проект без участника — его задачи в выдачу члена не попадают
    const priv = (await http.post('/api/projects').set(H(owner.accessToken)).send({ name: 'Тайный', visibility: 'members' }).expect(201)).body.data;
    const pboard = (await http.get(`/api/projects/${priv.id}/board`).set(H(owner.accessToken)).expect(200)).body.data;
    const secret = (await http.post('/api/tasks').set(H(owner.accessToken))
      .send({ projectId: priv.id, columnId: pboard.columns[0].id, title: 'Секрет' }).expect(201)).body.data;

    const page = (await http.get(`/api/mobile/sync?cursor=${head.cursor}`).set(H(member.token)).expect(200)).body.data;
    expect(page.reset).toBe(false);
    const kinds = page.changes.map((c: any) => `${c.entity_type}:${c.op}:${c.entity_id}`);
    expect(kinds).toContain(`task:insert:${task.id}`);
    expect(page.changes.some((c: any) => c.entity_type === 'task_comment' && c.parent_id === String(task.id))).toBe(true);
    expect(page.changes.some((c: any) => c.entity_id === String(secret.id))).toBe(false);
    expect(BigInt(page.cursor) > BigInt(head.cursor)).toBe(true);

    // владелец видит и тайное
    const bossPage = (await http.get(`/api/mobile/sync?cursor=${head.cursor}`).set(H(owner.accessToken)).expect(200)).body.data;
    expect(bossPage.changes.some((c: any) => c.entity_id === String(secret.id) && c.entity_type === 'task')).toBe(true);

    // после нового курсора — пусто; удаление приходит как delete
    const quiet = (await http.get(`/api/mobile/sync?cursor=${page.cursor}`).set(H(member.token)).expect(200)).body.data;
    expect(quiet.changes).toEqual([]);
    await http.delete(`/api/tasks/${task.id}`).set(H(owner.accessToken)).expect(200);
    const del = (await http.get(`/api/mobile/sync?cursor=${page.cursor}`).set(H(member.token)).expect(200)).body.data;
    expect(del.changes.some((c: any) => c.entity_type === 'task' && c.op === 'delete' && c.entity_id === String(task.id))).toBe(true);

    // страница с лимитом — more=true и курсор посередине
    const small = (await http.get(`/api/mobile/sync?cursor=${head.cursor}&limit=1`).set(H(member.token)).expect(200)).body.data;
    expect(small.changes.length).toBe(1);
    expect(small.more).toBe(true);
  });
});
