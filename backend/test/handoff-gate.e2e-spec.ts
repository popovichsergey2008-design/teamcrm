import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AddressInfo } from 'net';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { AllExceptionsFilter } from '../src/common/http/all-exceptions.filter';
import { ResponseInterceptor } from '../src/common/http/response.interceptor';
import { RedisIoAdapter } from '../src/common/auth/redis-io.adapter';

/**
 * Приёмка работы («Quality Gatekeeper»).
 *
 * Проверяем не столько «не пустил», сколько границы: гейт спрашивает ТОГО, КТО СДАЁТ
 * свою работу, пускает по подтверждению и оставляет след в истории. Постановщика,
 * который принимает работу, он трогать не должен — иначе показывал бы человеку
 * список претензий к чужой работе в момент, когда тот её принимает.
 *
 * Требование вложения здесь выключено сознательно: файл живёт в объектном хранилище,
 * и завязывать правило приёмки на его доступность в тесте незачем — само правило
 * покрыто unit-тестами (handoff-gate.spec.ts).
 */
describe('Приёмка работы (e2e)', () => {
  let app: INestApplication;
  let http: any;
  const uniq = () => Math.random().toString(36).slice(2) + Date.now().toString(36);
  const H = (t: string) => ({ Authorization: `Bearer ${t}` });

  let ownerTok: string;
  let memberTok: string;
  let memberId: string;
  let projectId: string;
  let reviewColumn: string;
  let doneColumn: string;

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
      .send({ tenantName: 'Gate', email: `g_${uniq()}@t.test`, password: 'password123', fullName: 'Владелец' })
      .expect(201)).body.data;
    ownerTok = owner.accessToken;

    const email = `g_m_${uniq()}@t.test`;
    const inv = (await http.post('/api/invites').set(H(ownerTok)).send({ email, role: 'member' }).expect(201)).body.data;
    await http.post('/api/invites/accept').send({ token: inv.token, fullName: 'Исполнитель', password: 'memberpass1' }).expect(201);
    const mem = (await http.post('/api/auth/login').send({ email, password: 'memberpass1' }).expect(201)).body.data;
    memberTok = mem.accessToken;
    memberId = mem.user.id;

    const proj = (await http.post('/api/projects').set(H(ownerTok)).send({ name: 'Приёмка' }).expect(201)).body.data;
    projectId = proj.id;
    const board = (await http.get(`/api/projects/${projectId}/board`).set(H(ownerTok)).expect(200)).body.data;
    reviewColumn = board.columns.find((c: any) => c.name === 'На тестировании').id;
    doneColumn = board.columns.find((c: any) => c.name === 'Готово').id;

    // вложение не требуем: проверяем чек-лист и отчёт
    await http.put('/api/handoff-gate').set(H(ownerTok))
      .send({ checklist: true, comment: true, attachment: false }).expect(200);
  });
  afterAll(async () => app?.close());

  const newTask = async (title: string) =>
    (await http.post('/api/tasks').set(H(ownerTok))
      .send({ projectId, title, assigneeId: memberId }).expect(201)).body.data;

  it('исполнителя спрашивают, что не готово, и пускают по подтверждению', async () => {
    const task = await newTask('Сдать без отчёта');
    const item = (await http.post(`/api/tasks/${task.id}/checklist`).set(H(memberTok))
      .send({ text: 'Второй шаг' }).expect(201)).body.data;

    // 1. Сдача с незакрытым чек-листом и без отчёта — вопрос, а не молчаливый перенос
    const blocked = await http.post(`/api/tasks/${task.id}/move`).set(H(memberTok))
      .send({ columnId: reviewColumn, position: 0 }).expect(409);
    const codes = blocked.body.error.details.gate.missing.map((m: any) => m.code);
    expect(codes).toEqual(['checklist', 'comment']);
    expect(blocked.body.error.details.gate.column).toBe('На тестировании');

    // 2. Пункт отмечен — остаётся одна нехватка, а не весь список заново
    await http.patch(`/api/tasks/${task.id}/checklist/${item.id}`).set(H(memberTok))
      .send({ isDone: true }).expect(200);
    const again = await http.post(`/api/tasks/${task.id}/move`).set(H(memberTok))
      .send({ columnId: reviewColumn, position: 0 }).expect(409);
    expect(again.body.error.details.gate.missing.map((m: any) => m.code)).toEqual(['comment']);

    // 3. «Сдать всё равно» — задача уходит, но обход остаётся в истории
    const moved = (await http.post(`/api/tasks/${task.id}/move`).set(H(memberTok))
      .send({ columnId: reviewColumn, position: 0, confirmGate: true }).expect(201)).body.data;
    expect(String(moved.column_id)).toBe(String(reviewColumn));

    const log = (await http.get(`/api/tasks/${task.id}/activity`).set(H(ownerTok)).expect(200)).body.data;
    const forced = log.find((a: any) => a.kind === 'handoff_forced');
    expect(forced).toBeTruthy();
    expect(forced.detail.missing.join(' ')).toContain('комментария');
  });

  it('отчёт исполнителя снимает вопрос', async () => {
    const task = await newTask('Сдать с отчётом');
    await http.post(`/api/tasks/${task.id}/comments`).set(H(memberTok))
      .send({ body: 'Готово: макет отправлен заказчику' }).expect(201);

    const moved = (await http.post(`/api/tasks/${task.id}/move`).set(H(memberTok))
      .send({ columnId: reviewColumn, position: 0 }).expect(201)).body.data;
    expect(String(moved.column_id)).toBe(String(reviewColumn));
  });

  it('постановщика гейт не трогает: он принимает работу, а не сдаёт', async () => {
    const task = await newTask('Принимаю сам');
    const moved = (await http.post(`/api/tasks/${task.id}/move`).set(H(ownerTok))
      .send({ columnId: doneColumn, position: 0 }).expect(201)).body.data;
    expect(String(moved.column_id)).toBe(String(doneColumn));
  });

  it('рабочие колонки не считаются сдачей', async () => {
    const task = await newTask('Просто в работу');
    const board = (await http.get(`/api/projects/${projectId}/board`).set(H(ownerTok)).expect(200)).body.data;
    const inProgress = board.columns.find((c: any) => c.name === 'В работе').id;
    await http.post(`/api/tasks/${task.id}/move`).set(H(memberTok))
      .send({ columnId: inProgress, position: 0 }).expect(201);
  });

  it('условия задаёт владелец, и выключенные условия никого не держат', async () => {
    // сотрудник условия компании не меняет
    await http.put('/api/handoff-gate').set(H(memberTok))
      .send({ checklist: false, comment: false, attachment: false }).expect(403);

    await http.put('/api/handoff-gate').set(H(ownerTok))
      .send({ checklist: false, comment: false, attachment: false }).expect(200);
    const task = await newTask('Без условий');
    await http.post(`/api/tasks/${task.id}/move`).set(H(memberTok))
      .send({ columnId: doneColumn, position: 0 }).expect(201);

    // возвращаем как было, чтобы порядок тестов ничего не решал
    await http.put('/api/handoff-gate').set(H(ownerTok))
      .send({ checklist: true, comment: true, attachment: false }).expect(200);
  });
});
