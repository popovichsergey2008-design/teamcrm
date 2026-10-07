import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AddressInfo } from 'net';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { AllExceptionsFilter } from '../src/common/http/all-exceptions.filter';
import { ResponseInterceptor } from '../src/common/http/response.interceptor';
import { RedisIoAdapter } from '../src/common/auth/redis-io.adapter';

/**
 * ТЗ-16, волна 2: «Фокус дня» как дневной план.
 *
 * Проверяем то, что ломается молча: тройка собирается сама и только из своего,
 * неважное не добивает экран, заблокированное не становится главным, план один на
 * день, принятый план целиком не перестраивается, сделанное отмечается само, а
 * удалённая задача не показывает своё название.
 */
describe('ТЗ-16 — Фокус дня: правило трёх (e2e)', () => {
  let app: INestApplication;
  let http: any;
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
  });
  afterAll(async () => app?.close());

  it('тройка, принятие, замена, сделанное и удалённое', async () => {
    const owner = (await http.post('/api/auth/register')
      .send({ tenantName: 'Focus', email: `f_${uniq()}@t.test`, password: 'password123', fullName: 'Ольга' })
      .expect(201)).body.data;
    const tok = owner.accessToken;
    const me = owner.user.id;

    const memEmail = `f_m_${uniq()}@t.test`;
    const inv = (await http.post('/api/invites').set(H(tok)).send({ email: memEmail, role: 'member' }).expect(201)).body.data;
    await http.post('/api/invites/accept').send({ token: inv.token, fullName: 'Глеб', password: 'memberpass1' }).expect(201);
    const mem = (await http.post('/api/auth/login').send({ email: memEmail, password: 'memberpass1' }).expect(201)).body.data;

    const proj = (await http.post('/api/projects').set(H(tok)).send({ name: 'Фокус' }).expect(201)).body.data;
    const mk = async (title: string, extra: Record<string, unknown> = {}) =>
      (await http.post('/api/tasks').set(H(tok)).send({ projectId: proj.id, title, assigneeId: me, ...extra }).expect(201)).body.data;

    const overdue = await mk('Просроченная срочная', { deadlineAt: new Date(Date.now() - 2 * 864e5).toISOString(), priority: 'urgent' });
    const soon = await mk('Через полтора дня', { deadlineAt: new Date(Date.now() + 36 * 3600e3).toISOString() });
    const idle = await mk('Без срока, обычная');
    const blocked = await mk('Заблокированная просроченная', { deadlineAt: new Date(Date.now() - 864e5).toISOString() });
    await http.patch(`/api/tasks/${blocked.id}`).set(H(tok)).send({ isBlocked: true }).expect(200);
    // Глеб ждёт согласования от Ольги
    const appr = (await http.post('/api/approvals').set(H(mem.accessToken))
      .send({ approverId: String(me), subject: 'Бюджет на рекламу' }).expect(201)).body.data;

    // 0. Флаг организации выключен — ничего не собирается; включает владелец, не сотрудник
    expect((await http.get('/api/focus/today').set(H(tok)).expect(200)).body.data).toEqual({ enabled: false });
    await http.patch('/api/focus/today/settings').set(H(mem.accessToken)).send({ enabled: true }).expect(403);
    await http.patch('/api/focus/today/settings').set(H(tok)).send({ enabled: true }).expect(200);

    // 1. Первое открытие собирает план сам
    const day1 = (await http.get('/api/focus/today').set(H(tok)).expect(200)).body.data;
    expect(day1.enabled).toBe(true);
    expect(day1.plan.status).toBe('proposed');
    expect(day1.plan.scoreVersion).toBe('rule_of_3_v1');
    const keys = day1.top.map((i: any) => (i.kind === 'approval' ? `approval:${i.approvalId}` : `task:${i.taskId}`));
    expect(keys).toEqual(expect.arrayContaining([`task:${overdue.id}`, `task:${soon.id}`, `approval:${appr.id}`]));
    expect(keys).not.toContain(`task:${idle.id}`);
    expect(keys).not.toContain(`task:${blocked.id}`);
    expect(day1.top[0].taskId).toBe(String(overdue.id)); // главная миссия — самое весомое
    expect(day1.top[0].reasons.join(' ')).toMatch(/просрочена/);
    expect(day1.waitingDecision).toBe(1);

    // 2. Повторное открытие не плодит второй план
    const again = (await http.get('/api/focus/today').set(H(tok)).expect(200)).body.data;
    expect(again.plan.id).toBe(day1.plan.id);
    expect(again.top).toHaveLength(day1.top.length);

    // 3. Остальное — по очкам, тройки там нет
    const backlog = (await http.get('/api/focus/today/backlog').set(H(tok)).expect(200)).body.data;
    expect(backlog.map((c: any) => c.key)).toEqual(expect.arrayContaining([`task:${idle.id}`, `task:${blocked.id}`]));
    expect(backlog.map((c: any) => c.key)).not.toContain(`task:${overdue.id}`);

    // 4. Принятый план целиком не пересчитывается
    await http.post('/api/focus/today/accept').set(H(tok)).expect(201);
    await http.post('/api/focus/today/recalculate').set(H(tok)).expect(409);

    // 5. Замена по одной: на место согласования — задача без срока
    const apprItem = day1.top.find((i: any) => i.kind === 'approval');
    const replaced = (await http.post('/api/focus/today/items').set(H(tok))
      .send({ key: `task:${idle.id}`, rank: apprItem.rank, reason: 'wrong_priority' }).expect(201)).body.data;
    expect(replaced.plan.status).toBe('modified');
    expect(replaced.top.find((i: any) => i.rank === apprItem.rank).taskId).toBe(String(idle.id));
    // чужое добавить нельзя
    await http.post('/api/focus/today/items').set(H(tok)).send({ key: 'task:999999999' }).expect(400);

    // 6. Порядок меняется: последнее — первым
    const ids = replaced.top.map((i: any) => i.id);
    const reordered = (await http.post('/api/focus/today/items/reorder').set(H(tok))
      .send({ ids: [ids[2], ids[0], ids[1]] }).expect(201)).body.data;
    expect(reordered.top[0].id).toBe(ids[2]);

    // 7. Удалённая задача остаётся местом без названия
    await http.delete(`/api/tasks/${soon.id}`).set(H(tok)).expect(200);
    const afterDelete = (await http.get('/api/focus/today').set(H(tok)).expect(200)).body.data;
    const gone = afterDelete.top.find((i: any) => i.unavailable);
    expect(gone).toBeTruthy();
    expect(gone.title).toBeNull();

    // 8. Чужой план не виден: у Глеба свой, без задач Ольги
    const his = (await http.get('/api/focus/today').set(H(mem.accessToken)).expect(200)).body.data;
    expect(his.plan.id).not.toBe(day1.plan.id);
    expect(his.top.map((i: any) => i.taskId)).not.toContain(String(overdue.id));

    // 9. «Команда сейчас»: оба на месте, клиентов нет
    const pulse = (await http.get('/api/team/pulse').set(H(mem.accessToken)).expect(200)).body.data;
    expect(pulse.map((p: any) => p.fullName)).toEqual(expect.arrayContaining(['Ольга', 'Глеб']));
    expect(pulse[0]).toHaveProperty('status');
  });

  it('решённое согласование в плане отмечается сделанным само', async () => {
    const owner = (await http.post('/api/auth/register')
      .send({ tenantName: 'Focus2', email: `f2_${uniq()}@t.test`, password: 'password123', fullName: 'Анна' })
      .expect(201)).body.data;
    const memEmail = `f2_m_${uniq()}@t.test`;
    const inv = (await http.post('/api/invites').set(H(owner.accessToken)).send({ email: memEmail, role: 'member' }).expect(201)).body.data;
    await http.post('/api/invites/accept').send({ token: inv.token, fullName: 'Пётр', password: 'memberpass1' }).expect(201);
    const mem = (await http.post('/api/auth/login').send({ email: memEmail, password: 'memberpass1' }).expect(201)).body.data;
    const appr = (await http.post('/api/approvals').set(H(mem.accessToken))
      .send({ approverId: String(owner.user.id), subject: 'Отпуск в ноябре' }).expect(201)).body.data;

    await http.patch('/api/focus/today/settings').set(H(owner.accessToken)).send({ enabled: true }).expect(200);
    const d = (await http.get('/api/focus/today').set(H(owner.accessToken)).expect(200)).body.data;
    expect(d.top).toHaveLength(1); // одно достойное — одно место, без добивки
    await http.post(`/api/approvals/${appr.id}/decide`).set(H(owner.accessToken)).send({ approve: true }).expect(201);
    const after = (await http.get('/api/focus/today').set(H(owner.accessToken)).expect(200)).body.data;
    expect(after.top[0].status).toBe('done');
    expect(after.plan.status).toBe('completed');

    // вся тройка сделана — можно завершать день, итоги без упрёков
    expect(after.closeDay.available).toBe(true);
    const sum = (await http.get('/api/focus/today/close').set(H(owner.accessToken)).expect(200)).body.data;
    expect(sum.topDone).toBe(1);
    expect(sum.topTotal).toBe(1);
    expect(sum.unblocked).toBeGreaterThanOrEqual(1);
    const closed = (await http.post('/api/focus/today/close').set(H(owner.accessToken))
      .send({ tomorrow: [], quiet: true }).expect(201)).body.data;
    expect(closed.plan.status).toBe('closed');
    expect(closed.closeDay.available).toBe(false);
    expect(closed.closeDay.workdayClosedUntil).toBeTruthy();
    // коллеги видят «день завершён»
    const pulse = (await http.get('/api/team/pulse').set(H(mem.accessToken)).expect(200)).body.data;
    expect(pulse.find((x: any) => x.fullName === 'Анна').status).toBe('workday_closed');
    // «я ещё поработаю»
    const reopened = (await http.post('/api/focus/today/reopen').set(H(owner.accessToken)).expect(201)).body.data;
    expect(reopened.closeDay.workdayClosedUntil).toBeNull();
  });
  it('глубокая работа: таймер, тишина, стук один раз, перерыв', async () => {
    const owner = (await http.post('/api/auth/register')
      .send({ tenantName: 'Deep', email: `d_${uniq()}@t.test`, password: 'password123', fullName: 'Юрий' })
      .expect(201)).body.data;
    const tok = owner.accessToken;
    const memEmail = `d_m_${uniq()}@t.test`;
    const inv = (await http.post('/api/invites').set(H(tok)).send({ email: memEmail, role: 'member' }).expect(201)).body.data;
    await http.post('/api/invites/accept').send({ token: inv.token, fullName: 'Алина', password: 'memberpass1' }).expect(201);
    const mem = (await http.post('/api/auth/login').send({ email: memEmail, password: 'memberpass1' }).expect(201)).body.data;
    const proj = (await http.post('/api/projects').set(H(tok)).send({ name: 'Глубоко' }).expect(201)).body.data;
    const task = (await http.post('/api/tasks').set(H(tok)).send({ projectId: proj.id, title: 'Сложная задача', assigneeId: owner.user.id }).expect(201)).body.data;

    // нет фокуса — нет сессии; стучать некуда
    expect((await http.get('/api/focus/sessions/current').set(H(tok)).expect(200)).body.data).toBeNull();
    await http.post(`/api/users/${owner.user.id}/knock`).set(H(mem.accessToken)).send({}).expect(409);

    const s = (await http.post('/api/focus/sessions').set(H(tok)).send({ taskId: String(task.id) }).expect(201)).body.data;
    expect(s.status).toBe('running');
    expect(s.plannedMinutes).toBe(50);
    expect(s.remainingSeconds).toBeGreaterThan(49 * 60);
    expect(s.task.title).toBe('Сложная задача');
    // второй фокус поверх первого — нельзя
    await http.post('/api/focus/sessions').set(H(tok)).send({}).expect(409);

    // коллега видит «в глубоком фокусе»
    const pulse = (await http.get('/api/team/pulse').set(H(mem.accessToken)).expect(200)).body.data;
    expect(pulse.find((p: any) => p.fullName === 'Юрий').status).toBe('deep_focus');

    // стук — один раз за сессию
    await http.post(`/api/users/${owner.user.id}/knock`).set(H(mem.accessToken)).send({ reason: 'горит прод' }).expect(201);
    await http.post(`/api/users/${owner.user.id}/knock`).set(H(mem.accessToken)).send({}).expect(409);

    // пауза и продолжение не съедают время
    const paused = (await http.post(`/api/focus/sessions/${s.id}/pause`).set(H(tok)).expect(201)).body.data;
    expect(paused.status).toBe('paused');
    const resumed = (await http.post(`/api/focus/sessions/${s.id}/resume`).set(H(tok)).expect(201)).body.data;
    expect(resumed.status).toBe('running');
    expect(resumed.interruptions).toBe(1);

    await http.put(`/api/focus/sessions/${s.id}/notes`).set(H(tok)).send({ notes: 'проверить индекс' }).expect(200);
    const done = (await http.post(`/api/focus/sessions/${s.id}/finish`).set(H(tok))
      .send({ outcome: 'completed', takeBreak: true }).expect(201)).body.data;
    expect(done.notes).toBe('проверить индекс');
    expect(done.taskId).toBe(String(task.id));

    const after = (await http.get('/api/team/pulse').set(H(mem.accessToken)).expect(200)).body.data;
    expect(after.find((p: any) => p.fullName === 'Юрий').status).toBe('break');
    expect((await http.get('/api/focus/sessions/current').set(H(tok)).expect(200)).body.data).toBeNull();
  });
});
