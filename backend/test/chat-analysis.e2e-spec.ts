import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AddressInfo } from 'net';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { AllExceptionsFilter } from '../src/common/http/all-exceptions.filter';
import { ResponseInterceptor } from '../src/common/http/response.interceptor';
import { RedisIoAdapter } from '../src/common/auth/redis-io.adapter';
import { DbService } from '../src/database/db.service';
import { ChatAnalysisRepository } from '../src/modules/chat-analysis/chat-analysis.repository';

/**
 * Разбор переписки (ТЗ-12, этапы 1–2).
 *
 * Проверяем обещания, а не внутренности:
 *   1. выключено по умолчанию — пока владелец не включил, не читается ничего;
 *   2. ЛИЧНЫЕ переписки не разбираются даже при включённом разборе и даже когда
 *      разговор затих: это решение заказчика, и оно не должно зависеть от настройки;
 *   3. сам агент задач не заводит — это делает человек нажатием;
 *   4. постановщиком становится тот, кто ПОРУЧИЛ в переписке, а не тот, кто нажал;
 *   5. включать разбор вправе только владелец.
 */
describe('разбор переписки (e2e)', () => {
  let app: INestApplication;
  let http: any;
  let db: DbService;
  let repo: ChatAnalysisRepository;
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
    repo = app.get(ChatAnalysisRepository);
  });
  afterAll(async () => { await app?.close(); });

  const team = async (tag: string) => {
    const owner = (await http.post('/api/auth/register')
      .send({ tenantName: tag, email: `${tag}_${uniq()}@t.test`, password: 'password123', fullName: 'Ольга Владелец' })
      .expect(201)).body.data;
    const email = `${tag}_m_${uniq()}@t.test`;
    const mate = (await http.post('/api/users').set(H(owner.accessToken))
      .send({ email, fullName: 'Пётр Коллега', password: 'password123', role: 'member' })
      .expect(201)).body.data;
    const login = (await http.post('/api/auth/login').send({ email, password: 'password123' }).expect(201)).body.data;
    return { owner, mate, O: H(owner.accessToken), M: H(login.accessToken) };
  };

  /** Отматываем разговор назад: «затих» — это про время, и ждать его в тесте нечего. */
  const quiet = async (chatId: string, minutes: number) => {
    await db.query(
      `UPDATE chat_messages SET created_at = now() - make_interval(mins => $2) WHERE chat_id = $1`,
      [chatId, minutes],
    );
    await db.query(
      `UPDATE chats SET last_message_at = now() - make_interval(mins => $2) WHERE id = $1`,
      [chatId, minutes],
    );
  };

  it('выключено по умолчанию и включается только владельцем', async () => {
    const { O, M } = await team('CA1');

    const off = (await http.get('/api/chat-analysis/settings').set(O).expect(200)).body.data;
    expect(off.enabled).toBe(false);
    // Режим по умолчанию — «только предлагать»: решение заказчика от 29.09.
    expect(off.mode).toBe('suggest');

    await http.patch('/api/chat-analysis/settings').set(M).send({ enabled: true }).expect(403);

    const on = (await http.patch('/api/chat-analysis/settings').set(O)
      .send({ enabled: true, quietMinutes: 15 }).expect(200)).body.data;
    expect(on).toMatchObject({ enabled: true, quiet_minutes: 15 });
  }, 60000);

  it('личная переписка не разбирается, даже когда разбор включён и разговор затих', async () => {
    const { owner, mate, O } = await team('CA2');
    await http.patch('/api/chat-analysis/settings').set(O).send({ enabled: true, quietMinutes: 10 }).expect(200);

    const dm = (await http.post('/api/chats/dm').set(O).send({ userId: mate.id }).expect(201)).body.data;
    await http.post(`/api/chats/${dm.id}/messages`).set(O).send({ body: 'Пётр, сделай отчёт до пятницы' }).expect(201);

    const group = (await http.post('/api/chats/groups').set(O).send({ title: 'Разработка' }).expect(201)).body.data;
    await http.post(`/api/chats/${group.id}/messages`).set(O).send({ body: 'Пётр, сделай отчёт до пятницы' }).expect(201);

    await quiet(String(dm.id), 60);
    await quiet(String(group.id), 60);

    const due = await repo.dueChats(new Date(), String(owner.user.tenantId));
    const ids = due.map((d) => String(d.chat_id));
    // Рабочий чат в очередь попал, личный — нет, и включить его нечем.
    expect(ids).toContain(String(group.id));
    expect(ids).not.toContain(String(dm.id));
  }, 90000);

  it('заметки себе тоже не разбираются', async () => {
    const { owner, O } = await team('CA3');
    await http.patch('/api/chat-analysis/settings').set(O).send({ enabled: true, quietMinutes: 10 }).expect(200);

    const self = (await http.post('/api/chats/self').set(O).send({}).expect(201)).body.data;
    await http.post(`/api/chats/${self.id}/messages`).set(O).send({ body: 'не забыть позвонить в банк' }).expect(201);
    await quiet(String(self.id), 60);

    const due = await repo.dueChats(new Date(), String(owner.user.tenantId));
    expect(due.map((d) => String(d.chat_id))).not.toContain(String(self.id));
  }, 90000);

  it('выключенный у чата разбор убирает его из очереди', async () => {
    const { owner, O } = await team('CA4');
    await http.patch('/api/chat-analysis/settings').set(O).send({ enabled: true, quietMinutes: 10 }).expect(200);

    const group = (await http.post('/api/chats/groups').set(O).send({ title: 'Кадры' }).expect(201)).body.data;
    await http.post(`/api/chats/${group.id}/messages`).set(O).send({ body: 'обсудим оклад Петра' }).expect(201);
    await quiet(String(group.id), 60);

    const before = await repo.dueChats(new Date(), String(owner.user.tenantId));
    expect(before.map((d) => String(d.chat_id))).toContain(String(group.id));

    await http.patch(`/api/chat-analysis/chats/${group.id}`).set(O).send({ enabled: false }).expect(200);

    const after = await repo.dueChats(new Date(), String(owner.user.tenantId));
    expect(after.map((d) => String(d.chat_id))).not.toContain(String(group.id));
  }, 90000);

  it('пока разбор выключен, очередь пуста при любой тишине', async () => {
    const { owner, O } = await team('CA5');
    const group = (await http.post('/api/chats/groups').set(O).send({ title: 'Тишина' }).expect(201)).body.data;
    await http.post(`/api/chats/${group.id}/messages`).set(O).send({ body: 'Пётр, посмотри почту' }).expect(201);
    await quiet(String(group.id), 120);

    expect(await repo.dueChats(new Date(), String(owner.user.tenantId))).toEqual([]);
  }, 90000);

  /**
   * Второй этап: наблюдение становится задачей ТОЛЬКО по нажатию человека, и
   * постановщиком становится тот, кто поручил в переписке, а не тот, кто нажал.
   *
   * Наблюдение заводим напрямую: в прогоне участвует модель, а у проверки её нет —
   * а проверяем мы здесь не разбор, а то, что с разбором делают дальше.
   */
  const plant = async (o: {
    tenantId: string; chatId: string; projectId: string | null;
    assignerId: string; assigneeId: string | null; messageId: string;
  }) => {
    const run = await db.one<{ id: string }>(
      `INSERT INTO chat_analysis_runs (tenant_id, chat_id, mode, status, messages)
       VALUES ($1,$2,'segment','done',2) RETURNING id::text`,
      [o.tenantId, o.chatId],
    );
    const action = await db.one<{ id: string }>(
      `INSERT INTO chat_extracted_actions (
         tenant_id, run_id, chat_id, action_type, title, project_id, assigner_id, assignee_id,
         intent_confidence, project_confidence, assigner_confidence, assignee_confidence,
         status, dedup_key)
       VALUES ($1,$2,$3,'task','Сделать отчёт по складу',$4,$5,$6,0.95,1,0.95,0.95,'ready',$7)
       RETURNING id::text`,
      [o.tenantId, run!.id, o.chatId, o.projectId, o.assignerId, o.assigneeId, `qa-${Math.random()}`],
    );
    await db.query(
      `INSERT INTO chat_extracted_action_messages (action_id, message_id, role)
       VALUES ($1,$2,'instruction')`,
      [action!.id, o.messageId],
    );
    return String(action!.id);
  };

  it('задачу заводит человек, а постановщиком становится тот, кто поручил', async () => {
    const { owner, mate, O, M } = await team('CA7');
    const project = (await http.post('/api/projects').set(O).send({ name: 'Склад' }).expect(201)).body.data;
    const chat = (await http.post('/api/chats/groups').set(O)
      .send({ title: 'Склад', userIds: [String(mate.id)] }).expect(201)).body.data;
    const msg = (await http.post(`/api/chats/${chat.id}/messages`).set(O)
      .send({ body: 'Пётр, сделай отчёт по складу до пятницы' }).expect(201)).body.data;

    const actionId = await plant({
      tenantId: String(owner.user.tenantId), chatId: String(chat.id), projectId: String(project.id),
      assignerId: String(owner.user.id), assigneeId: String(mate.id), messageId: String(msg.id),
    });

    // Подтверждает КОЛЛЕГА — и постановщиком всё равно остаётся тот, кто поручил.
    const res = (await http.post(`/api/chat-analysis/actions/${actionId}/confirm`).set(M).send({}).expect(201)).body.data;
    const task = await db.one<any>(
      `SELECT assignee_id::text, created_by::text, source_chat_message_id::text FROM tasks WHERE id = $1`,
      [res.task.id],
    );
    expect(task!.created_by).toBe(String(owner.user.id));
    expect(task!.assignee_id).toBe(String(mate.id));
    // Из задачи виден исходный разговор.
    expect(task!.source_chat_message_id).toBe(String(msg.id));

    // Дважды одну задачу не заводим.
    await http.post(`/api/chat-analysis/actions/${actionId}/confirm`).set(O).send({}).expect(409);
  }, 90000);

  it('без проекта задача не заводится, а выбранный в ответе — принимается', async () => {
    const { owner, mate, O } = await team('CA8');
    const project = (await http.post('/api/projects').set(O).send({ name: 'Второй' }).expect(201)).body.data;
    const chat = (await http.post('/api/chats/groups').set(O).send({ title: 'Без проекта' }).expect(201)).body.data;
    const msg = (await http.post(`/api/chats/${chat.id}/messages`).set(O)
      .send({ body: 'Пётр, посчитай остатки' }).expect(201)).body.data;

    const actionId = await plant({
      tenantId: String(owner.user.tenantId), chatId: String(chat.id), projectId: null,
      assignerId: String(owner.user.id), assigneeId: String(mate.id), messageId: String(msg.id),
    });

    await http.post(`/api/chat-analysis/actions/${actionId}/confirm`).set(O).send({}).expect(400);
    const ok = (await http.post(`/api/chat-analysis/actions/${actionId}/confirm`).set(O)
      .send({ projectId: String(project.id) }).expect(201)).body.data;
    expect(ok.task.id).toBeTruthy();
  }, 90000);

  it('«это не задача» закрывает наблюдение, но не стирает его', async () => {
    const { owner, O } = await team('CA9');
    const chat = (await http.post('/api/chats/groups').set(O).send({ title: 'Отказ' }).expect(201)).body.data;
    const msg = (await http.post(`/api/chats/${chat.id}/messages`).set(O)
      .send({ body: 'может когда-нибудь переделаем шапку' }).expect(201)).body.data;
    const actionId = await plant({
      tenantId: String(owner.user.tenantId), chatId: String(chat.id), projectId: null,
      assignerId: String(owner.user.id), assigneeId: null, messageId: String(msg.id),
    });

    await http.post(`/api/chat-analysis/actions/${actionId}/reject`).set(O).send({}).expect(201);
    const row = await db.one<{ status: string }>(
      `SELECT status FROM chat_extracted_actions WHERE id = $1`, [actionId],
    );
    // Отказы нужны: по ним видно, где агент ошибается.
    expect(row!.status).toBe('rejected');
    await http.post(`/api/chat-analysis/actions/${actionId}/confirm`).set(O).send({}).expect(409);
  }, 90000);

  it('сам агент задач не заводит: без нажатия человека их не появляется', async () => {
    const { owner, O } = await team('CA6');
    await http.patch('/api/chat-analysis/settings').set(O).send({ enabled: true }).expect(200);

    expect((await http.get('/api/chat-analysis/actions').set(O).expect(200)).body.data).toEqual([]);

    const before = await db.one<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM tasks WHERE tenant_id = $1`, [owner.user.tenantId],
    );
    await http.post('/api/chat-analysis/run').set(O).send({}).expect(201);
    const after = await db.one<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM tasks WHERE tenant_id = $1`, [owner.user.tenantId],
    );
    expect(after!.n).toBe(before!.n);
  }, 90000);
});
