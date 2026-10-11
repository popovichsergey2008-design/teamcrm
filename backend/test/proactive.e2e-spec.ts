import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AddressInfo } from 'net';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { AllExceptionsFilter } from '../src/common/http/all-exceptions.filter';
import { ResponseInterceptor } from '../src/common/http/response.interceptor';
import { DbService } from '../src/database/db.service';
import { CommitmentsService } from '../src/modules/commitments/commitments.service';

/**
 * Проактивный секретарь (ТЗ-21, этапы 1–3): обещание из личной переписки → карточка в
 * ящике → «Уже выполнено»; страж нагрузки при постановке задачи — предупреждение с
 * вариантами, «оставить как есть» проходит с подтверждением.
 */
describe('Проактивный секретарь (e2e)', () => {
  let app: INestApplication;
  let http$: any;
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
    await app.listen(0, '0.0.0.0');
    http$ = request(`http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`);
    db = app.get(DbService);
  });
  afterAll(async () => { await app?.close(); });

  async function org() {
    const owner = (await http$.post('/api/auth/register')
      .send({ tenantName: 'Секретарь', email: `pro_${uniq()}@t.test`, password: 'password123', fullName: 'Владелец' }).expect(201)).body.data;
    const O = H(owner.accessToken);
    const email = `prom_${uniq()}@t.test`;
    const u = (await http$.post('/api/users').set(O).send({ email, fullName: 'Глеб', password: 'password123', role: 'member' }).expect(201)).body.data;
    const tok = (await http$.post('/api/auth/login').send({ email, password: 'password123' }).expect(201)).body.data.accessToken;
    return { owner, O, tenantId: String(owner.user.tenantId), gleb: { id: String(u.id), H: H(tok) } };
  }

  it('обещание из лички: найдено, карточка у обещавшего, «Уже выполнено» закрывает', async () => {
    const { O, owner, tenantId, gleb } = await org();
    const svc = app.get(CommitmentsService);
    await svc.scanSource(tenantId, 'chat_messages', 24); // первый проход ставит курсор, историю не читает

    const chat = (await http$.post('/api/chats/dm').set(O).send({ userId: gleb.id }).expect(201)).body.data;
    await http$.post(`/api/chats/${chat.id}/messages`).set(O).send({ body: 'Глеб, пришлёшь смету для банка?' }).expect(201);
    await http$.post(`/api/chats/${chat.id}/messages`).set(gleb.H).send({ body: 'Да, я отправлю смету для банка завтра' }).expect(201);
    expect(await svc.scanSource(tenantId, 'chat_messages', 24)).toBe(1);

    const mine = (await http$.get('/api/assistant/commitments').set(gleb.H).expect(200)).body.data;
    expect(mine).toHaveLength(1);
    expect(mine[0].mine).toBe(true);
    expect(mine[0].assigner).toBe('Владелец');
    const given = (await http$.get('/api/assistant/commitments').set(O).expect(200)).body.data;
    expect(given[0].mine).toBe(false);

    // срок прошёл — проверка кладёт карточку обещавшему
    await db.query(`UPDATE commitments SET check_at = now() - interval '1 minute' WHERE tenant_id = $1`, [tenantId]);
    await svc.checkDue();
    const inbox = (await http$.get('/api/assistant/proposals').set(gleb.H).expect(200)).body.data.items;
    expect(inbox).toHaveLength(1);
    expect(inbox[0].skill).toBe('commitment');
    expect(inbox[0].section).toBe('commitments');
    expect(inbox[0].actions.map((a: any) => a.key)).toEqual(expect.arrayContaining(['create_task', 'done']));
    expect((await http$.get('/api/assistant/proposals/summary').set(gleb.H).expect(200)).body.data.total).toBe(1);
    // чужую карточку не видно и не выполнить
    await http$.get(`/api/assistant/proposals/${inbox[0].id}`).set(O).expect(404);

    const r = (await http$.post(`/api/assistant/proposals/${inbox[0].id}/confirm`).set(gleb.H).send({ action: 'done' }).expect(201)).body.data;
    expect(r.proposal.status).toBe('executed');
    await http$.post(`/api/assistant/proposals/${inbox[0].id}/confirm`).set(gleb.H).send({ action: 'done' }).expect(409);
    // закрытое ещё неделю видно в списке — уже со статусом «выполнено»
    const after = (await http$.get('/api/assistant/commitments').set(gleb.H).expect(200)).body.data;
    expect(after.map((c: any) => c.status)).toEqual(['fulfilled']);
    expect((await http$.get('/api/assistant/proposals?history=1').set(gleb.H).expect(200)).body.data.items).toHaveLength(1);
    void owner;
  });

  it('карточка: отложить, «больше не предлагать», настройки; компания — только владельцу', async () => {
    const { O, tenantId, gleb } = await org();
    const [p] = await db.many<{ id: string }>(
      `INSERT INTO assistant_proposals (tenant_id, user_id, skill, kind, source_type, source_id, title, priority, confidence, actions, fingerprint)
       VALUES ($1, $2, 'commitment', 'chat:1', 'chat', '1', 'Проверка', 1, 0.9, '[{"key":"done","label":"Готово"}]', $3) RETURNING id`,
      [tenantId, gleb.id, uniq()],
    );
    await http$.post(`/api/assistant/proposals/${p.id}/snooze`).set(gleb.H).send({ preset: 'tomorrow' }).expect(201);
    await http$.post(`/api/assistant/proposals/${p.id}/feedback`).set(gleb.H).send({ useful: false, reason: 'not_needed' }).expect(201);
    await http$.post(`/api/assistant/proposals/${p.id}/dismiss`).set(gleb.H).send({ mute: true }).expect(201);
    const prefs = (await http$.get('/api/assistant/proposals/prefs').set(gleb.H).expect(200)).body.data;
    expect(prefs.mutes).toEqual([{ skill: 'commitment', kind: 'chat:1' }]);
    expect((await http$.patch('/api/assistant/proposals/prefs').set(gleb.H).send({ level: 'quiet' }).expect(200)).body.data.level).toBe('quiet');

    await http$.get('/api/assistant/proposals/settings').set(gleb.H).expect(403);
    const s = (await http$.patch('/api/assistant/proposals/settings').set(O).send({ commitmentCheckHours: 12 }).expect(200)).body.data;
    expect(s.commitmentCheckHours).toBe(12);
  });

  it('страж нагрузки: перегруз — 409 с вариантами; «оставить как есть» ставит задачу', async () => {
    const { O, tenantId, gleb } = await org();
    const project = (await http$.post('/api/projects').set(O).send({ name: 'Сайт' }).expect(201)).body.data;
    const board = (await http$.get(`/api/projects/${project.id}/board`).set(O).expect(200)).body.data;
    const day = new Date(Date.now() + 3 * 86400_000);
    day.setUTCHours(12, 0, 0, 0);
    const body = (title: string) => ({
      projectId: project.id, columnId: board.columns[0].id, title, assigneeId: gleb.id, priority: 'urgent', deadlineAt: day.toISOString(),
    });
    for (let i = 1; i <= 3; i++) await http$.post('/api/tasks').set(O).send({ ...body(`Срочная ${i}`), confirmWorkload: true }).expect(201);

    const res = (await http$.post('/api/tasks').set(O).send(body('Ещё одна срочная')).expect(409)).body;
    expect(res.error.details.workload.reasons.length).toBeGreaterThan(0);
    expect(res.error.details.workload.alternativeDeadline).toBeTruthy();
    expect(res.error.details.workload.assigneeId).toBe(gleb.id);

    await http$.post('/api/tasks').set(O).send({ ...body('Ещё одна срочная'), confirmWorkload: true }).expect(201);
    // журнал пишется без ожидания — даём ему мгновение
    let logged = 0;
    for (let i = 0; i < 20 && !logged; i++) {
      const [row] = await db.many<{ n: number }>(
        `SELECT count(*)::int AS n FROM security_audit WHERE tenant_id = $1 AND event_type = 'workload.override'`, [tenantId],
      );
      logged = row.n;
      if (!logged) await new Promise((r) => setTimeout(r, 100));
    }
    expect(logged).toBeGreaterThan(0);

    // выключили страж — предупреждения нет
    await http$.patch('/api/assistant/proposals/settings').set(O).send({ workloadGuard: false }).expect(200);
    await http$.post('/api/tasks').set(O).send(body('Пятая срочная')).expect(201);
  });
});
