import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AddressInfo } from 'net';
import * as http from 'http';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { AllExceptionsFilter } from '../src/common/http/all-exceptions.filter';
import { ResponseInterceptor } from '../src/common/http/response.interceptor';
import { RedisIoAdapter } from '../src/common/auth/redis-io.adapter';

/** YouGile E1: подключение по ключу + импорт досок/колонок/задач (мок API v2). */
describe('YouGile импорт (e2e)', () => {
  let app: INestApplication;
  let http$: any;
  let mock: http.Server;
  const uniq = () => Math.random().toString(36).slice(2) + Date.now().toString(36);
  const H = (t: string) => ({ Authorization: `Bearer ${t}` });
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  // состояние мока YouGile (заполняем в тесте)
  const deadlineMs = 1893456000000; // 2030-01-01
  const state: any = { users: [], projects: [], boards: [], columns: [], tasksByCol: {}, messagesByTask: {} };

  beforeAll(async () => {
    mock = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://x');
      const page = (arr: any[]) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ content: arr, paging: { limit: 50, offset: 0, next: false, count: arr.length } })); };
      if (url.pathname === '/users') return page(state.users);
      if (url.pathname === '/projects') return page(state.projects);
      if (url.pathname === '/boards') return page(state.boards);
      if (url.pathname === '/columns') return page(state.columns);
      if (url.pathname === '/tasks') { const c = url.searchParams.get('columnId') ?? ''; return page(state.tasksByCol[c] ?? []); }
      const chat = url.pathname.match(/^\/chats\/([^/]+)\/messages$/);
      if (chat) return page(state.messagesByTask[decodeURIComponent(chat[1])] ?? []);
      if (url.pathname.startsWith('/files/')) { res.writeHead(200, { 'content-type': 'image/png' }); res.end(Buffer.from('fakepngbytes')); return; }
      res.writeHead(404); res.end('{}');
    });
    await new Promise<void>((r) => mock.listen(0, '127.0.0.1', () => r()));
    process.env.YOUGILE_API_BASE = `http://127.0.0.1:${(mock.address() as AddressInfo).port}`;

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
  afterAll(async () => { await app?.close(); await new Promise<void>((r) => mock.close(() => r())); });

  it('подключение → импорт доски: проект/колонки/задачи, исполнитель по e-mail, срок, идемпотентность', async () => {
    const email = `yg_${uniq()}@t.test`;
    const reg = (await http$.post('/api/auth/register').send({ tenantName: 'YG', email, password: 'password123', fullName: 'Owner' }).expect(201)).body.data;
    const tok = reg.accessToken;

    // мок-данные YouGile: пользователь с тем же e-mail (для авто-маппинга исполнителя)
    state.users = [{ id: 'u1', email, realName: 'Owner' }, { id: 'u2', email: 'no@x.test', realName: 'Bob' }];
    state.projects = [{ id: 'p1', title: 'Проект А' }];
    state.boards = [{ id: 'b1', title: 'Доска 1', projectId: 'p1' }];
    state.columns = [{ id: 'c1', title: 'To Do', boardId: 'b1' }, { id: 'c2', title: 'Done', boardId: 'b1' }];
    state.tasksByCol = {
      c1: [{ id: 't1', title: 'Задача 1', columnId: 'c1', description: 'детали', assigned: ['u1'], deadline: { deadline: deadlineMs } }],
      c2: [{ id: 't2', title: 'Задача 2', columnId: 'c2', completed: true }],
    };
    state.messagesByTask = {
      t1: [{ id: 'm1', fromUserId: 'u1', text: 'Первый коммент', timestamp: 1700000000000, files: [{ name: 'doc.png', url: '/files/f1', size: 12 }] }],
      t2: [],
    };

    // подключение по ключу (validate дергает /users — мок отвечает)
    const conn = (await http$.post('/api/integrations/yougile/connections').set(H(tok)).send({ apiKey: 'test-key', label: 'Основной' }).expect(201)).body.data;
    expect(conn.id).toBeTruthy();
    const conns = (await http$.get('/api/integrations/yougile/connections').set(H(tok)).expect(200)).body.data;
    expect(conns.some((c: any) => c.id === conn.id)).toBe(true);

    // список досок (с названием проекта)
    const boards = (await http$.get(`/api/integrations/yougile/connections/${conn.id}/boards`).set(H(tok)).expect(200)).body.data;
    expect(boards).toEqual([{ externalId: 'b1', title: 'Доска 1', projectTitle: 'Проект А' }]);

    // импорт доски b1
    const { runId } = (await http$.post(`/api/integrations/yougile/connections/${conn.id}/import`).set(H(tok)).send({ boardExternalIds: ['b1'] }).expect(201)).body.data;
    let run: any;
    for (let i = 0; i < 40; i++) {
      run = (await http$.get(`/api/integrations/yougile/runs/${runId}`).set(H(tok)).expect(200)).body.data;
      if (run.status === 'done' || run.status === 'error') break;
      await sleep(150);
    }
    expect(run.status).toBe('done');
    expect(run.stats.boards).toBe(1);
    expect(run.stats.columns).toBe(2);
    expect(run.stats.tasks).toBe(2);
    expect(run.stats.comments).toBeGreaterThanOrEqual(1);
    expect(run.stats.attachments).toBeGreaterThanOrEqual(1);

    // проект создан, колонки и задачи на месте
    const projects = (await http$.get('/api/projects').set(H(tok)).expect(200)).body.data;
    const proj = projects.find((p: any) => p.name === 'Доска 1');
    expect(proj).toBeTruthy();
    const board = (await http$.get(`/api/projects/${proj.id}/board`).set(H(tok)).expect(200)).body.data;
    expect(board.columns.map((c: any) => c.name)).toEqual(['To Do', 'Done']);
    const all = board.columns.flatMap((c: any) => c.tasks.map((t: any) => ({ ...t, col: c.name })));
    const t1 = all.find((t: any) => t.title === 'Задача 1');
    const t2 = all.find((t: any) => t.title === 'Задача 2');
    expect(t1.col).toBe('To Do');
    expect(t1.assignee_id).toBe(reg.user.id); // исполнитель сопоставлен по e-mail
    expect(t1.deadline_at).toBeTruthy();
    expect(t2.col).toBe('Done');

    // E2: комментарий из чата + вложение из файла сообщения
    const comments = (await http$.get(`/api/tasks/${t1.id}/comments`).set(H(tok)).expect(200)).body.data;
    expect(comments.some((c: any) => /Первый коммент/.test(c.body))).toBe(true);
    const atts = (await http$.get(`/api/tasks/${t1.id}/attachments`).set(H(tok)).expect(200)).body.data;
    expect(atts.some((a: any) => a.file_name === 'doc.png')).toBe(true);

    // E2: несопоставленные юзеры (u2 без e-mail-мэтча) + ручная привязка убирает из списка
    const unm = (await http$.get(`/api/integrations/yougile/connections/${conn.id}/unmatched-users`).set(H(tok)).expect(200)).body.data;
    expect(unm.items.some((i: any) => i.externalId === 'u2')).toBe(true);
    expect(unm.items.some((i: any) => i.externalId === 'u1')).toBe(false); // владелец сопоставлен по e-mail
    await http$.post(`/api/integrations/yougile/connections/${conn.id}/user-map`).set(H(tok)).send({ externalUserId: 'u2', localUserId: reg.user.id }).expect(201);
    const unm2 = (await http$.get(`/api/integrations/yougile/connections/${conn.id}/unmatched-users`).set(H(tok)).expect(200)).body.data;
    expect(unm2.items.some((i: any) => i.externalId === 'u2')).toBe(false);

    // идемпотентность: повторный импорт не плодит дубли
    const r2 = (await http$.post(`/api/integrations/yougile/connections/${conn.id}/import`).set(H(tok)).send({ boardExternalIds: ['b1'] }).expect(201)).body.data;
    for (let i = 0; i < 40; i++) {
      const r = (await http$.get(`/api/integrations/yougile/runs/${r2.runId}`).set(H(tok)).expect(200)).body.data;
      if (r.status === 'done' || r.status === 'error') break;
      await sleep(150);
    }
    const board2 = (await http$.get(`/api/projects/${proj.id}/board`).set(H(tok)).expect(200)).body.data;
    const count1 = board2.columns.flatMap((c: any) => c.tasks).filter((t: any) => t.title === 'Задача 1').length;
    expect(count1).toBe(1);
  });

  it('неверный ключ YouGile → 400 при подключении', async () => {
    const email = `yg2_${uniq()}@t.test`;
    const reg = (await http$.post('/api/auth/register').send({ tenantName: 'YG2', email, password: 'password123', fullName: 'O' }).expect(201)).body.data;
    // мок вернёт 401 на /users, если сходить на несуществующий путь — эмулируем неверный ключ через отдельный base
    const prev = process.env.YOUGILE_API_BASE;
    process.env.YOUGILE_API_BASE = 'http://127.0.0.1:1/api-v2'; // недоступный адрес → validate падает
    await http$.post('/api/integrations/yougile/connections').set(H(reg.accessToken)).send({ apiKey: 'bad' }).expect(400);
    process.env.YOUGILE_API_BASE = prev;
  });
});
