import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AddressInfo } from 'net';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { AllExceptionsFilter } from '../src/common/http/all-exceptions.filter';
import { ResponseInterceptor } from '../src/common/http/response.interceptor';
import { RedisIoAdapter } from '../src/common/auth/redis-io.adapter';
import { MaintenanceService } from '../src/modules/assistant/maintenance.service';

/**
 * Zero-Maintenance: уборка брошенного.
 *
 * Главное здесь не «предложил», а две страховки: система ничего не делает сама,
 * и всё сделанное возвращается на место. Пороги в тестах нулевые (сервис принимает
 * их параметром) — состарить задачу на два месяца через API нельзя, а проверять
 * надо решения и откат, а не арифметику дат.
 */
describe('Уборка брошенного (e2e)', () => {
  let app: INestApplication;
  let http: any;
  let maintenance: MaintenanceService;
  const uniq = () => Math.random().toString(36).slice(2) + Date.now().toString(36);
  const H = (t: string) => ({ Authorization: `Bearer ${t}` });
  /** Пороги нулевые: всё, что есть в базе, считается брошенным. */
  const NOW: any = { taskDays: 0, projectDays: 0, draftDays: 0 };

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
    maintenance = app.get(MaintenanceService);
  });
  afterAll(async () => { await app?.close(); });

  const org = async (name: string) => {
    const owner = (await http.post('/api/auth/register')
      .send({ tenantName: name, email: `z_${uniq()}@t.test`, password: 'password123', fullName: 'Владелец' })
      .expect(201)).body.data;
    const email = `z_m_${uniq()}@t.test`;
    await http.post('/api/users').set(H(owner.accessToken))
      .send({ email, fullName: 'Сотрудник', password: 'password123', role: 'member' }).expect(201);
    const mateToken = (await http.post('/api/auth/login')
      .send({ email, password: 'password123' }).expect(201)).body.data.accessToken;
    const project = (await http.post('/api/projects').set(H(owner.accessToken))
      .send({ name: `Проект ${name}` }).expect(201)).body.data;
    return { owner, mateToken, project, tenantId: String(owner.user.tenantId) };
  };

  const proposals = async (token: string) =>
    (await http.get('/api/assistant/maintenance').set(H(token)).expect(200)).body.data;

  it('забытая задача: предложение, закрытие и возврат ровно туда, откуда убрали', async () => {
    const s = await org('Уборка');
    const board = (await http.get(`/api/projects/${s.project.id}/board`).set(H(s.owner.accessToken)).expect(200)).body.data;
    const inWork = board.columns.find((c: any) => c.name === 'В работе');
    const task = (await http.post('/api/tasks').set(H(s.owner.accessToken))
      .send({ projectId: s.project.id, title: 'Забытая задача', columnId: inWork.id }).expect(201)).body.data;

    expect(await maintenance.runTenant(s.tenantId, NOW)).toBeGreaterThan(0);

    const mine = (await proposals(s.owner.accessToken)).find((p: any) => String(p.subjectId) === String(task.id));
    expect(mine).toBeTruthy();
    expect(mine.status).toBe('pending');
    expect(mine.text).toContain('предлагаю закрыть');
    expect(mine.text).toContain('Забытая задача');

    // задача пока НЕ тронута: система ничего не делает сама
    let live = (await http.get(`/api/projects/${s.project.id}/board`).set(H(s.owner.accessToken)).expect(200)).body.data;
    let onBoard = live.columns.flatMap((c: any) => c.tasks).find((t: any) => String(t.id) === String(task.id));
    expect(onBoard.closed_at).toBeFalsy();

    // повторный проход не задваивает вопрос
    await maintenance.runTenant(s.tenantId, NOW);
    expect((await proposals(s.owner.accessToken)).filter((p: any) => String(p.subjectId) === String(task.id)))
      .toHaveLength(1);

    // владелец согласился — задача закрыта и уехала в «Готово»
    await http.post(`/api/assistant/maintenance/${mine.id}/apply`).set(H(s.owner.accessToken)).expect(201);
    live = (await http.get(`/api/projects/${s.project.id}/board`).set(H(s.owner.accessToken)).expect(200)).body.data;
    onBoard = live.columns.flatMap((c: any) => c.tasks).find((t: any) => String(t.id) === String(task.id));
    expect(onBoard.closed_at).toBeTruthy();
    expect(String(onBoard.column_id)).not.toBe(String(inWork.id));

    // и вернулась ровно в свою колонку живой
    await http.post(`/api/assistant/maintenance/${mine.id}/undo`).set(H(s.owner.accessToken)).expect(201);
    live = (await http.get(`/api/projects/${s.project.id}/board`).set(H(s.owner.accessToken)).expect(200)).body.data;
    onBoard = live.columns.flatMap((c: any) => c.tasks).find((t: any) => String(t.id) === String(task.id));
    expect(onBoard.closed_at).toBeFalsy();
    expect(String(onBoard.column_id)).toBe(String(inWork.id));

    // дважды одно и то же не выполнить и не откатить
    await http.post(`/api/assistant/maintenance/${mine.id}/apply`).set(H(s.owner.accessToken)).expect(409);
    await http.post(`/api/assistant/maintenance/${mine.id}/undo`).set(H(s.owner.accessToken)).expect(409);
  });

  it('проект без открытых задач уходит в архив и возвращается из него', async () => {
    const s = await org('Архив');

    expect(await maintenance.runTenant(s.tenantId, NOW)).toBeGreaterThan(0);
    const p = (await proposals(s.owner.accessToken))
      .find((x: any) => x.kind === 'project_idle' && String(x.subjectId) === String(s.project.id));
    expect(p).toBeTruthy();
    expect(p.text).toContain('в архив');

    await http.post(`/api/assistant/maintenance/${p.id}/apply`).set(H(s.owner.accessToken)).expect(201);
    const archived = (await http.get('/api/projects').set(H(s.owner.accessToken)).expect(200)).body.data;
    expect(archived.some((x: any) => String(x.id) === String(s.project.id))).toBe(false);

    await http.post(`/api/assistant/maintenance/${p.id}/undo`).set(H(s.owner.accessToken)).expect(201);
    const back = (await http.get('/api/projects').set(H(s.owner.accessToken)).expect(200)).body.data;
    expect(back.some((x: any) => String(x.id) === String(s.project.id))).toBe(true);
  });

  it('проект с живой задачей в архив не предлагают', async () => {
    const s = await org('Живой');
    await http.post('/api/tasks').set(H(s.owner.accessToken))
      .send({ projectId: s.project.id, title: 'Ещё в работе' }).expect(201);

    await maintenance.runTenant(s.tenantId, NOW);
    const list = await proposals(s.owner.accessToken);
    expect(list.some((p: any) => p.kind === 'project_idle')).toBe(false);
  });

  it('«не надо» закрывает вопрос навсегда', async () => {
    const s = await org('Отказ');
    await http.post('/api/tasks').set(H(s.owner.accessToken))
      .send({ projectId: s.project.id, title: 'Пусть висит' }).expect(201);

    await maintenance.runTenant(s.tenantId, NOW);
    const p = (await proposals(s.owner.accessToken)).find((x: any) => x.kind === 'task_stale');
    await http.post(`/api/assistant/maintenance/${p.id}/dismiss`).set(H(s.owner.accessToken)).expect(201);

    // следующий проход об этой задаче больше не спрашивает
    await maintenance.runTenant(s.tenantId, NOW);
    expect((await proposals(s.owner.accessToken)).some((x: any) => String(x.id) === String(p.id) && x.status === 'pending'))
      .toBe(false);
    expect((await proposals(s.owner.accessToken)).filter((x: any) => String(x.subjectId) === String(p.subjectId)))
      .toHaveLength(0);
  });

  it('убирает доску владелец или руководитель, не рядовой сотрудник', async () => {
    const s = await org('Права');
    await http.post('/api/tasks').set(H(s.owner.accessToken))
      .send({ projectId: s.project.id, title: 'Чужая забытая' }).expect(201);
    await maintenance.runTenant(s.tenantId, NOW);
    const p = (await proposals(s.mateToken)).find((x: any) => x.kind === 'task_stale');
    expect(p).toBeTruthy(); // видеть — видит: список показывает, что происходит с доской

    await http.post(`/api/assistant/maintenance/${p.id}/apply`).set(H(s.mateToken)).expect(403);
    await http.post(`/api/assistant/maintenance/${p.id}/dismiss`).set(H(s.mateToken)).expect(403);

    // и настройку включает только владелец
    await http.put('/api/assistant/maintenance-enabled').set(H(s.mateToken)).send({ enabled: false }).expect(403);
    await http.put('/api/assistant/maintenance-enabled').set(H(s.owner.accessToken)).send({ enabled: false }).expect(200);
    expect((await http.get('/api/assistant/mode').set(H(s.owner.accessToken)).expect(200)).body.data.maintenance)
      .toBe(false);
  });
});
