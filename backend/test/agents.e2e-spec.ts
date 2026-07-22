import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AddressInfo } from 'net';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { AllExceptionsFilter } from '../src/common/http/all-exceptions.filter';
import { ResponseInterceptor } from '../src/common/http/response.interceptor';
import { RedisIoAdapter } from '../src/common/auth/redis-io.adapter';

/** Оркестрация ИИ-агентов (день 2, каркас): запуск агента по задаче → черновик в комментарий; журнал запусков. */
describe('AI-агенты (e2e)', () => {
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

  const makeTask = async (tok: string) => {
    const proj = (await http.post('/api/projects').set(H(tok)).send({ name: 'Агенты' }).expect(201)).body.data;
    const board = (await http.get(`/api/projects/${proj.id}/board`).set(H(tok)).expect(200)).body.data;
    return (await http.post('/api/tasks').set(H(tok)).send({
      projectId: proj.id, columnId: board.columns[0].id, title: 'Настроить SEO лендинга',
      description: 'Собрать семантику, прописать мета-теги, ускорить загрузку.',
    }).expect(201)).body.data;
  };

  it('агент по задаче → черновик-комментарий на ревью; запуск в журнале', async () => {
    const a = (await http.post('/api/auth/register').send({ tenantName: 'Ag', email: `ag_${uniq()}@t.test`, password: 'password123', fullName: 'Босс' }).expect(201)).body.data;
    const tok = a.accessToken;
    const task = await makeTask(tok);

    const run = (await http.post(`/api/agents/tasks/${task.id}/run`).set(H(tok)).expect(201)).body.data;
    expect(run.status).toBe('done');
    expect(typeof run.result).toBe('string');
    expect(run.result.length).toBeGreaterThan(0);
    expect(run.commentId).toBeTruthy();

    // черновик реально добавлен комментарием (помечен как от ИИ-агента)
    const comments = (await http.get(`/api/tasks/${task.id}/comments`).set(H(tok)).expect(200)).body.data;
    expect(comments.some((c: any) => /Черновик от ИИ-агента/.test(c.body))).toBe(true);

    // журнал запусков содержит завершённый запуск
    const runs = (await http.get(`/api/agents/tasks/${task.id}/runs`).set(H(tok)).expect(200)).body.data;
    expect(runs.length).toBeGreaterThanOrEqual(1);
    expect(runs[0].status).toBe('done');
  });

  it('автономное выполнение: результат в задачу + авто-перенос в «На тестировании»', async () => {
    const a = (await http.post('/api/auth/register').send({ tenantName: 'Ag-Exec', email: `ae_${uniq()}@t.test`, password: 'password123', fullName: 'Босс' }).expect(201)).body.data;
    const tok = a.accessToken;
    const task = await makeTask(tok); // дефолтные колонки включают «На тестировании»

    const run = (await http.post(`/api/agents/tasks/${task.id}/execute`).set(H(tok)).expect(201)).body.data;
    expect(run.status).toBe('done');
    expect(run.kind).toBe('task_execute');
    expect(run.result.length).toBeGreaterThan(0);
    expect(run.movedTo).toBe('На тестировании');

    // задача реально переехала в колонку «На тестировании»
    const board = (await http.get(`/api/projects/${task.project_id}/board`).set(H(tok)).expect(200)).body.data;
    const testCol = board.columns.find((c: any) => c.name === 'На тестировании');
    expect(testCol.tasks.some((t: any) => t.id === task.id)).toBe(true);

    // результат добавлен комментарием
    const comments = (await http.get(`/api/tasks/${task.id}/comments`).set(H(tok)).expect(200)).body.data;
    expect(comments.some((c: any) => /Результат ИИ-агента/.test(c.body))).toBe(true);
  });

  it('виртуальный исполнитель: передать агенту (флаг + авто-выполнение) и снять', async () => {
    const a = (await http.post('/api/auth/register').send({ tenantName: 'Ag-As', email: `aas_${uniq()}@t.test`, password: 'password123', fullName: 'Босс' }).expect(201)).body.data;
    const tok = a.accessToken;
    const task = await makeTask(tok);

    const res = (await http.post(`/api/agents/tasks/${task.id}/assign`).set(H(tok)).send({ autoRun: true }).expect(201)).body.data;
    expect(res.assigned).toBe(true);
    expect(res.run.status).toBe('done');
    expect(res.run.movedTo).toBe('На тестировании');

    // задача помечена как переданная агенту (флаг виден в доске) + переехала в тестирование
    let board = (await http.get(`/api/projects/${task.project_id}/board`).set(H(tok)).expect(200)).body.data;
    let t = board.columns.flatMap((c: any) => c.tasks).find((x: any) => x.id === task.id);
    expect(t.agent_assigned).toBe(true);
    expect(board.columns.find((c: any) => c.name === 'На тестировании').tasks.some((x: any) => x.id === task.id)).toBe(true);

    // снять с агента
    await http.post(`/api/agents/tasks/${task.id}/unassign`).set(H(tok)).expect(201);
    board = (await http.get(`/api/projects/${task.project_id}/board`).set(H(tok)).expect(200)).body.data;
    t = board.columns.flatMap((c: any) => c.tasks).find((x: any) => x.id === task.id);
    expect(t.agent_assigned).toBe(false);
  });

  it('v3 классификатор: офлайн-задачу (звонок/встреча) агент не выполняет и НЕ переносит', async () => {
    const a = (await http.post('/api/auth/register').send({ tenantName: 'Ag-Cl', email: `acl_${uniq()}@t.test`, password: 'password123', fullName: 'Босс' }).expect(201)).body.data;
    const tok = a.accessToken;
    const proj = (await http.post('/api/projects').set(H(tok)).send({ name: 'Кл' }).expect(201)).body.data;
    const board = (await http.get(`/api/projects/${proj.id}/board`).set(H(tok)).expect(200)).body.data;
    const firstCol = board.columns[0];
    const task = (await http.post('/api/tasks').set(H(tok)).send({
      projectId: proj.id, columnId: firstCol.id, title: 'Позвонить клиенту и встретиться в офисе',
    }).expect(201)).body.data;

    const run = (await http.post(`/api/agents/tasks/${task.id}/execute`).set(H(tok)).expect(201)).body.data;
    expect(run.declined).toBe(true);
    expect(run.status).toBe('declined');
    expect(run.movedTo).toBeNull();

    // задача осталась в исходной колонке (не переехала в «На тестировании»)
    const b2 = (await http.get(`/api/projects/${proj.id}/board`).set(H(tok)).expect(200)).body.data;
    const stillFirst = b2.columns.find((c: any) => c.id === firstCol.id).tasks.some((t: any) => t.id === task.id);
    expect(stillFirst).toBe(true);
    // в журнале статус declined
    const runs = (await http.get(`/api/agents/tasks/${task.id}/runs`).set(H(tok)).expect(200)).body.data;
    expect(runs[0].status).toBe('declined');
  });

  it('v2 доработка: результат выполнения возвращается агенту на доработку (черновик — нельзя)', async () => {
    const a = (await http.post('/api/auth/register').send({ tenantName: 'Ag-RW', email: `arw_${uniq()}@t.test`, password: 'password123', fullName: 'Босс' }).expect(201)).body.data;
    const tok = a.accessToken;
    const task = await makeTask(tok);

    const run = (await http.post(`/api/agents/tasks/${task.id}/execute`).set(H(tok)).expect(201)).body.data;
    const rw = (await http.post(`/api/agents/runs/${run.id}/rework`).set(H(tok)).send({ feedback: 'Сделай короче и добавь цену' }).expect(201)).body.data;
    expect(rw.kind).toBe('task_rework');
    expect(rw.status).toBe('done');
    expect(rw.result.length).toBeGreaterThan(0);

    // в журнале появился запуск доработки + комментарий доработки
    const runs = (await http.get(`/api/agents/tasks/${task.id}/runs`).set(H(tok)).expect(200)).body.data;
    expect(runs.some((r: any) => r.kind === 'task_rework')).toBe(true);
    const comments = (await http.get(`/api/tasks/${task.id}/comments`).set(H(tok)).expect(200)).body.data;
    expect(comments.some((c: any) => /Доработка ИИ-агента/.test(c.body))).toBe(true);

    // доработать ЧЕРНОВИК (task_draft) нельзя → 400
    const draft = (await http.post(`/api/agents/tasks/${task.id}/run`).set(H(tok)).expect(201)).body.data;
    await http.post(`/api/agents/runs/${draft.id}/rework`).set(H(tok)).send({ feedback: 'переделай' }).expect(400);
  });

  it('ревью: «В чеклист» добавляет пункты; «Отклонить» убирает черновик-комментарий', async () => {
    const a = (await http.post('/api/auth/register').send({ tenantName: 'Ag2', email: `ag2_${uniq()}@t.test`, password: 'password123', fullName: 'Босс' }).expect(201)).body.data;
    const tok = a.accessToken;

    // принять в чеклист
    const t1 = await makeTask(tok);
    const run1 = (await http.post(`/api/agents/tasks/${t1.id}/run`).set(H(tok)).expect(201)).body.data;
    const acc = (await http.post(`/api/agents/runs/${run1.id}/accept`).set(H(tok)).send({ toChecklist: true }).expect(201)).body.data;
    expect(acc.accepted).toBe(true);
    expect(acc.addedChecklist).toBeGreaterThanOrEqual(1);
    const checklist = (await http.get(`/api/tasks/${t1.id}/checklist`).set(H(tok)).expect(200)).body.data;
    expect(checklist.length).toBeGreaterThanOrEqual(1);
    // повторно принять нельзя (уже accepted, не done)
    await http.post(`/api/agents/runs/${run1.id}/accept`).set(H(tok)).send({ toChecklist: false }).expect(400);

    // отклонить → черновик-комментарий удаляется
    const t2 = await makeTask(tok);
    const run2 = (await http.post(`/api/agents/tasks/${t2.id}/run`).set(H(tok)).expect(201)).body.data;
    let comments = (await http.get(`/api/tasks/${t2.id}/comments`).set(H(tok)).expect(200)).body.data;
    expect(comments.some((c: any) => /Черновик от ИИ-агента/.test(c.body))).toBe(true);
    await http.post(`/api/agents/runs/${run2.id}/reject`).set(H(tok)).expect(201);
    comments = (await http.get(`/api/tasks/${t2.id}/comments`).set(H(tok)).expect(200)).body.data;
    expect(comments.some((c: any) => /Черновик от ИИ-агента/.test(c.body))).toBe(false);
    const runs = (await http.get(`/api/agents/tasks/${t2.id}/runs`).set(H(tok)).expect(200)).body.data;
    expect(runs[0].status).toBe('rejected');
  });

  it('единый cost of work: работа ИИ-агента входит в полную себестоимость проекта', async () => {
    const a = (await http.post('/api/auth/register').send({ tenantName: 'Ag-CoW', email: `cow_${uniq()}@t.test`, password: 'password123', fullName: 'Босс' }).expect(201)).body.data;
    const tok = a.accessToken;
    const task = await makeTask(tok);
    await http.post(`/api/agents/tasks/${task.id}/run`).set(H(tok)).expect(201);

    const cow = (await http.get(`/api/projects/${task.project_id}/cost-of-work`).set(H(tok)).expect(200)).body.data;
    expect(cow.scope).toBe('project');
    expect(cow.aiRuns).toBeGreaterThanOrEqual(1);
    expect(cow.aiTokens).toBeGreaterThan(0);
    expect(cow.aiCost).toBeGreaterThanOrEqual(0);
    // полная себестоимость = труд + ИИ
    expect(cow.total).toBeCloseTo(cow.laborCost + cow.aiCost, 2);

    // на уровне задачи тоже виден агентский расход
    const cowT = (await http.get(`/api/tasks/${task.id}/cost-of-work`).set(H(tok)).expect(200)).body.data;
    expect(cowT.scope).toBe('task');
    expect(cowT.aiRuns).toBeGreaterThanOrEqual(1);
  });

  it('изоляция: чужую задачу агенту не запустить (404)', async () => {
    const a = (await http.post('/api/auth/register').send({ tenantName: 'Ag-A', email: `aa_${uniq()}@t.test`, password: 'password123', fullName: 'A' }).expect(201)).body.data;
    const task = await makeTask(a.accessToken);
    const b = (await http.post('/api/auth/register').send({ tenantName: 'Ag-B', email: `ab_${uniq()}@t.test`, password: 'password123', fullName: 'B' }).expect(201)).body.data;
    await http.post(`/api/agents/tasks/${task.id}/run`).set(H(b.accessToken)).expect(404);
  });

  it('RBAC: рядовой участник (member) не запускает агента (403)', async () => {
    const a = (await http.post('/api/auth/register').send({ tenantName: 'Ag-R', email: `ar_${uniq()}@t.test`, password: 'password123', fullName: 'Owner' }).expect(201)).body.data;
    const tok = a.accessToken;
    const task = await makeTask(tok);

    const memEmail = `m_${uniq()}@t.test`;
    const inv = (await http.post('/api/invites').set(H(tok)).send({ email: memEmail, role: 'member' }).expect(201)).body.data;
    await http.post('/api/invites/accept').send({ token: inv.token, fullName: 'Участник', password: 'password123' }).expect(201);
    const memTok = (await http.post('/api/auth/login').send({ email: memEmail, password: 'password123' }).expect(201)).body.data.accessToken;

    await http.post(`/api/agents/tasks/${task.id}/run`).set(H(memTok)).expect(403);
  });
});
