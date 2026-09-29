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
 * Разбор переписки (ТЗ-12, этап 1).
 *
 * Проверяем обещания, а не внутренности:
 *   1. выключено по умолчанию — пока владелец не включил, не читается ничего;
 *   2. ЛИЧНЫЕ переписки не разбираются даже при включённом разборе и даже когда
 *      разговор затих: это решение заказчика, и оно не должно зависеть от настройки;
 *   3. агент ничего не создаёт — на этом этапе он только наблюдает;
 *   4. включать разбор вправе только владелец.
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

  it('на этом этапе агент ничего не создаёт: наблюдений нет, задач не появилось', async () => {
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
