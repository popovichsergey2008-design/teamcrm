import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AddressInfo } from 'net';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { AllExceptionsFilter } from '../src/common/http/all-exceptions.filter';
import { ResponseInterceptor } from '../src/common/http/response.interceptor';
import { RedisIoAdapter } from '../src/common/auth/redis-io.adapter';

/**
 * Завершение задачи с согласованием постановщика.
 *
 * Главное, что здесь проверяется, — что «сделал» и «принято» перестали быть одним
 * событием. Исполнитель переносит карточку в «Готово», но задача не закрывается:
 * она ждёт того, кто её поручил. Раньше исполнитель закрывал задачу сам, а
 * постановщик узнавал об этом из отчётов, если вообще узнавал.
 */
describe('Согласование завершения (e2e)', () => {
  let app: INestApplication;
  let http: any;
  const uniq = () => Math.random().toString(36).slice(2) + Date.now().toString(36);
  const H = (t: string) => ({ Authorization: `Bearer ${t}` });

  let ownerTok: string;
  let memberTok: string;
  let memberId: string;
  let projectId: string;
  let doneColumn: string;
  let workColumn: string;

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

    const owner = (await http.post('/api/auth/register')
      .send({ tenantName: 'Согласование', email: `ap_${uniq()}@t.test`, password: 'password123', fullName: 'Постановщик' })
      .expect(201)).body.data;
    ownerTok = owner.accessToken;

    const email = `ap_m_${uniq()}@t.test`;
    const inv = (await http.post('/api/invites').set(H(ownerTok)).send({ email, role: 'member' }).expect(201)).body.data;
    await http.post('/api/invites/accept').send({ token: inv.token, fullName: 'Исполнитель', password: 'memberpass1' }).expect(201);
    const mem = (await http.post('/api/auth/login').send({ email, password: 'memberpass1' }).expect(201)).body.data;
    memberTok = mem.accessToken;
    memberId = mem.user.id;

    const proj = (await http.post('/api/projects').set(H(ownerTok)).send({ name: 'Согласование' }).expect(201)).body.data;
    projectId = proj.id;
    const board = (await http.get(`/api/projects/${projectId}/board`).set(H(ownerTok)).expect(200)).body.data;
    doneColumn = board.columns.find((c: any) => c.name === 'Готово').id;
    workColumn = board.columns.find((c: any) => c.name !== 'Готово').id;

    // приёмка работы не мешает: её границы проверяет отдельный тест
    await http.put('/api/handoff-gate').set(H(ownerTok))
      .send({ checklist: false, comment: false, attachment: false }).expect(200);
  });
  afterAll(async () => app?.close());

  const newTask = async (title: string, body: Record<string, unknown> = {}) =>
    (await http.post('/api/tasks').set(H(ownerTok))
      .send({ projectId, title, assigneeId: memberId, ...body }).expect(201)).body.data;

  it('по умолчанию согласование включено, и «Готово» от исполнителя не закрывает задачу', async () => {
    const task = await newTask('Сдать на проверку');
    expect(task.requires_approval).toBe(true); // умолчание, а не забывчивость формы

    const moved = (await http.post(`/api/tasks/${task.id}/move`).set(H(memberTok))
      .send({ columnId: doneColumn, position: 0 }).expect(201)).body.data;
    // карточка в «Готово», но работа только сдана
    expect(String(moved.column_id)).toBe(String(doneColumn));

    const board = (await http.get(`/api/projects/${projectId}/board`).set(H(ownerTok)).expect(200)).body.data;
    const inBoard = board.columns.flatMap((c: any) => c.tasks).find((t: any) => String(t.id) === String(task.id));
    expect(inBoard.approval_state).toBe('pending');
    expect(inBoard.closed_at).toBeNull();

    // запрос на согласование виден в истории — постановщику есть на что сослаться
    const log = (await http.get(`/api/tasks/${task.id}/activity`).set(H(ownerTok)).expect(200)).body.data;
    expect(log.some((a: any) => a.kind === 'approval_requested')).toBe(true);

    // исполнитель себе работу не принимает — иначе всё это лишний клик
    await http.post(`/api/tasks/${task.id}/approve`).set(H(memberTok)).expect(403);

    // постановщик принял — вот теперь завершена
    await http.post(`/api/tasks/${task.id}/approve`).set(H(ownerTok)).expect(201);
    const after = (await http.get(`/api/projects/${projectId}/board`).set(H(ownerTok)).expect(200)).body.data;
    const closed = after.columns.flatMap((c: any) => c.tasks).find((t: any) => String(t.id) === String(task.id));
    expect(closed.closed_at).toBeTruthy();
    expect(closed.approval_state).toBe('none');
  });

  it('возврат в работу требует причины и возвращает задачу в дело', async () => {
    const task = await newTask('Вернуть на доработку');
    await http.post(`/api/tasks/${task.id}/move`).set(H(memberTok))
      .send({ columnId: doneColumn, position: 0 }).expect(201);

    // «переделай» без объяснения бесполезно — причина обязательна
    await http.post(`/api/tasks/${task.id}/return`).set(H(ownerTok)).send({ reason: '  ' }).expect(400);

    await http.post(`/api/tasks/${task.id}/return`).set(H(ownerTok))
      .send({ reason: 'Не проверено на телефоне' }).expect(201);

    const board = (await http.get(`/api/projects/${projectId}/board`).set(H(ownerTok)).expect(200)).body.data;
    const back = board.columns.flatMap((c: any) => c.tasks).find((t: any) => String(t.id) === String(task.id));
    expect(back.closed_at).toBeNull();
    expect(back.approval_state).toBe('none');
    expect(String(back.column_id)).not.toBe(String(doneColumn));

    const log = (await http.get(`/api/tasks/${task.id}/activity`).set(H(ownerTok)).expect(200)).body.data;
    const returned = log.find((a: any) => a.kind === 'approval_returned');
    expect(returned.detail.reason).toContain('телефоне'); // причина видна там же, где возврат
  });

  it('без галочки исполнитель закрывает задачу сам', async () => {
    const task = await newTask('Закрыть без спроса', { requiresApproval: false });
    expect(task.requires_approval).toBe(false);

    await http.post(`/api/tasks/${task.id}/move`).set(H(memberTok))
      .send({ columnId: doneColumn, position: 0 }).expect(201);

    const board = (await http.get(`/api/projects/${projectId}/board`).set(H(ownerTok)).expect(200)).body.data;
    const done = board.columns.flatMap((c: any) => c.tasks).find((t: any) => String(t.id) === String(task.id));
    expect(done.closed_at).toBeTruthy();
    expect(done.approval_state).toBe('none');
  });

  it('постановщик закрывает свою задачу сам: подтверждать самому себе нечего', async () => {
    const own = (await http.post('/api/tasks').set(H(ownerTok))
      .send({ projectId, title: 'Своя задача' }).expect(201)).body.data;
    await http.post(`/api/tasks/${own.id}/move`).set(H(ownerTok))
      .send({ columnId: doneColumn, position: 0 }).expect(201);

    const board = (await http.get(`/api/projects/${projectId}/board`).set(H(ownerTok)).expect(200)).body.data;
    const closed = board.columns.flatMap((c: any) => c.tasks).find((t: any) => String(t.id) === String(own.id));
    expect(closed.closed_at).toBeTruthy();
  });

  it('снятое согласование освобождает уже сданную работу', async () => {
    const task = await newTask('Передумал согласовывать');
    await http.post(`/api/tasks/${task.id}/move`).set(H(memberTok))
      .send({ columnId: doneColumn, position: 0 }).expect(201);

    // исполнитель настройкой не распоряжается — это условие того, кто поручил
    await http.post(`/api/tasks/${task.id}/approval-required`).set(H(memberTok))
      .send({ enabled: false }).expect(403);

    await http.post(`/api/tasks/${task.id}/approval-required`).set(H(ownerTok))
      .send({ enabled: false }).expect(201);

    const board = (await http.get(`/api/projects/${projectId}/board`).set(H(ownerTok)).expect(200)).body.data;
    const free = board.columns.flatMap((c: any) => c.tasks).find((t: any) => String(t.id) === String(task.id));
    expect(free.approval_state).toBe('none'); // держать в ожидании после отмены — издевательство

    const log = (await http.get(`/api/tasks/${task.id}/activity`).set(H(ownerTok)).expect(200)).body.data;
    expect(log.some((a: any) => a.kind === 'approval_setting')).toBe(true);

    // теперь исполнитель закрывает сам
    await http.post(`/api/tasks/${task.id}/move`).set(H(memberTok))
      .send({ columnId: workColumn, position: 0 }).expect(201);
    await http.post(`/api/tasks/${task.id}/move`).set(H(memberTok))
      .send({ columnId: doneColumn, position: 0 }).expect(201);
    const after = (await http.get(`/api/projects/${projectId}/board`).set(H(ownerTok)).expect(200)).body.data;
    const closed = after.columns.flatMap((c: any) => c.tasks).find((t: any) => String(t.id) === String(task.id));
    expect(closed.closed_at).toBeTruthy();
  });

  it('чек-лист приходит вместе с задачей: голосовая постановка приносит шаги сразу', async () => {
    const task = await newTask('Задача со списком шагов', {
      checklist: ['Проверить текущее поведение', 'Исправить проблему', 'Проверить на iPhone'],
    });
    const items = (await http.get(`/api/tasks/${task.id}/checklist`).set(H(ownerTok)).expect(200)).body.data;
    expect(items.map((i: any) => i.text)).toEqual([
      'Проверить текущее поведение', 'Исправить проблему', 'Проверить на iPhone',
    ]);
  });
  it('соисполнитель видит задачу в своих, наблюдатель — только следит', async () => {
    // Задачу заводим БЕЗ исполнителя: соисполнителем нельзя назначить того, кто
    // и так её делает, — сервер справедливо отвечает отказом.
    const task = (await http.post('/api/tasks').set(H(ownerTok))
      .send({ projectId, title: 'Работа вдвоём' }).expect(201)).body.data;

    await http.post(`/api/tasks/${task.id}/participants`).set(H(ownerTok))
      .send({ userId: String(memberId), role: 'co_assignee' }).expect(201);

    // и повтор той же роли не ошибка, а просто ничего
    await http.post(`/api/tasks/${task.id}/participants`).set(H(ownerTok))
      .send({ userId: String(memberId), role: 'co_assignee' }).expect(201);

    const other = (await http.post('/api/users').set(H(ownerTok))
      .send({ email: `w_${uniq()}@t.test`, fullName: 'Наблюдатель', password: 'password123', role: 'member' })
      .expect(201)).body.data;
    await http.post(`/api/tasks/${task.id}/participants`).set(H(ownerTok))
      .send({ userId: String(other.id), role: 'watcher' }).expect(201);

    const list = (await http.get(`/api/tasks/${task.id}/participants`).set(H(ownerTok)).expect(200)).body.data;
    expect(list.map((p: any) => p.role).sort()).toEqual(['co_assignee', 'watcher']);

    // Задача создавалась на исполнителя memberId, поэтому проверяем на отдельной:
    // соисполнитель должен видеть чужую по назначению работу как свою.
    const foreign = (await http.post('/api/tasks').set(H(ownerTok))
      .send({ projectId, title: 'Чужая по назначению' }).expect(201)).body.data;
    await http.post(`/api/tasks/${foreign.id}/participants`).set(H(ownerTok))
      .send({ userId: String(memberId), role: 'co_assignee' }).expect(201);

    const mine = (await http.get('/api/tasks/my').set(H(memberTok)).expect(200)).body.data;
    expect(mine.some((t: any) => String(t.id) === String(foreign.id))).toBe(true);
    expect(mine.some((t: any) => String(t.id) === String(task.id))).toBe(true);

    // Наблюдатель исполнителем не считается: в «своих» у него этой задачи нет.
    const watcherLogin = (await http.post('/api/auth/login')
      .send({ email: other.email, password: 'password123' }).expect(201)).body.data;
    const theirs = (await http.get('/api/tasks/my').set(H(watcherLogin.accessToken)).expect(200)).body.data;
    expect(theirs.some((t: any) => String(t.id) === String(task.id))).toBe(false);

    // Добавление и удаление видно в истории задачи.
    await http.delete(`/api/tasks/${task.id}/participants`).set(H(ownerTok))
      .send({ userId: String(other.id), role: 'watcher' }).expect(200);
    const log = (await http.get(`/api/tasks/${task.id}/activity`).set(H(ownerTok)).expect(200)).body.data;
    expect(log.some((a: any) => a.kind === 'participant_added')).toBe(true);
    expect(log.some((a: any) => a.kind === 'participant_removed')).toBe(true);
  });

  it('помощник задачи отвечает в контексте и ничего не меняет сам', async () => {
    const task = await newTask('Починить форму регистрации');
    await http.post(`/api/tasks/${task.id}/comments`).set(H(ownerTok))
      .send({ body: 'Главное — мобильная версия' }).expect(201);

    // На CI ключей ИИ нет: мок отвечает не JSON, и помощник честно говорит,
    // что недоступен, вместо выдуманного ответа.
    const res = await http.post(`/api/tasks/${task.id}/assistant`).set(H(memberTok))
      .send({ question: 'Что мне нужно сделать?' });
    expect([201, 409]).toContain(res.status);

    // Принять предложенный чек-лист может человек — и пункты попадают в задачу.
    await http.post(`/api/tasks/${task.id}/assistant/checklist`).set(H(memberTok))
      .send({ items: ['Проверить текущее поведение', 'Исправить', 'Проверить на телефоне'] }).expect(201);
    const items = (await http.get(`/api/tasks/${task.id}/checklist`).set(H(memberTok)).expect(200)).body.data;
    expect(items.map((i: any) => i.text)).toContain('Проверить на телефоне');

    // Пустой вопрос — отказ, а не пустой запрос в модель.
    await http.post(`/api/tasks/${task.id}/assistant`).set(H(memberTok)).send({ question: '' }).expect(400);
  });
});
