import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AddressInfo } from 'net';
import * as http from 'http';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { AllExceptionsFilter } from '../src/common/http/all-exceptions.filter';
import { ResponseInterceptor } from '../src/common/http/response.interceptor';
import { RedisIoAdapter } from '../src/common/auth/redis-io.adapter';

/**
 * YouGile E4: обратная выгрузка CRM → YouGile.
 * Мок YouGile отвечает и на запись (POST/PUT) и записывает все вызовы — по ним и проверяем.
 * Фоновый воркер в тесте выключен (YOUGILE_PUSH_DISABLED=1), очередь проталкиваем вручную
 * через /push/flush — так тест детерминирован и не зависит от таймеров.
 */
describe('YouGile двусторонняя синхронизация (e2e)', () => {
  let app: INestApplication;
  let http$: any;
  let mock: http.Server;
  const uniq = () => Math.random().toString(36).slice(2) + Date.now().toString(36);
  const H = (t: string) => ({ Authorization: `Bearer ${t}` });

  const state: any = { users: [], projects: [], boards: [], columns: [], tasksByCol: {}, taskById: {}, messagesByTask: {} };
  let calls: { method: string; path: string; body: any }[] = [];
  const findCall = (method: string, re: RegExp) => calls.filter((c) => c.method === method && re.test(c.path));

  beforeAll(async () => {
    mock = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(Buffer.from(c)));
      req.on('end', () => {
        const url = new URL(req.url ?? '/', 'http://x');
        const raw = Buffer.concat(chunks);
        let body: any = null;
        try { body = raw.length ? JSON.parse(raw.toString('utf8')) : null; } catch { body = raw.toString('latin1'); }
        calls.push({ method: req.method ?? 'GET', path: url.pathname, body });

        const json = (o: unknown) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
        const page = (arr: any[]) => json({ content: arr, paging: { limit: 50, offset: 0, next: false, count: arr.length } });
        const method = req.method ?? 'GET';

        // ── чтение ──
        if (url.pathname === '/users') return page(state.users);
        if (url.pathname === '/projects') return page(state.projects);
        if (url.pathname === '/boards') return page(state.boards);
        if (url.pathname === '/columns' && method === 'GET') return page(state.columns);
        if (url.pathname === '/tasks' && method === 'GET') return page(state.tasksByCol[url.searchParams.get('columnId') ?? ''] ?? []);
        if (url.pathname === '/webhooks') return method === 'POST' ? json({ id: 'wh1' }) : page([]);
        if (url.pathname.startsWith('/files/')) { res.writeHead(200, { 'content-type': 'image/png' }); res.end(Buffer.from('fakepng')); return; }

        // ── запись ──
        if (url.pathname === '/tasks' && method === 'POST') {
          const id = `new${(state.seq = (state.seq ?? 0) + 1)}`;
          state.taskById[id] = { id, ...body };
          return json({ id });
        }
        if (url.pathname === '/columns' && method === 'POST') {
          const id = `nc${state.columns.length + 1}`;
          state.columns.push({ id, title: body?.title, boardId: body?.boardId });
          return json({ id });
        }
        if (url.pathname === '/upload-file' && method === 'POST') return json({ result: 'ok', url: '/files/up1', fullUrl: 'http://yg.test/files/up1' });

        const one = url.pathname.match(/^\/tasks\/([^/]+)$/);
        if (one) {
          const id = decodeURIComponent(one[1]);
          if (method === 'PUT') { state.taskById[id] = { ...(state.taskById[id] ?? { id }), ...body }; return json({ id }); }
          const t = state.taskById[id] ?? (Object.values(state.tasksByCol).flat() as any[]).find((x: any) => String(x.id) === id);
          if (!t) { res.writeHead(404); res.end('{}'); return; }
          return json(t);
        }
        const col = url.pathname.match(/^\/columns\/([^/]+)$/);
        if (col && method === 'PUT') return json({ id: decodeURIComponent(col[1]) });
        const chat = url.pathname.match(/^\/chats\/([^/]+)\/messages$/);
        if (chat) {
          const taskId = decodeURIComponent(chat[1]);
          if (method === 'POST') {
            const list = (state.messagesByTask[taskId] ??= []);
            const m = { id: `m${list.length + 100}`, fromUserId: 'u1', text: body?.text, timestamp: 1700000000000 };
            list.push(m);
            return json({ id: m.id });
          }
          return page(state.messagesByTask[taskId] ?? []);
        }
        res.writeHead(404); res.end('{}');
      });
    });
    await new Promise<void>((r) => mock.listen(0, '127.0.0.1', () => r()));
    process.env.YOUGILE_API_BASE = `http://127.0.0.1:${(mock.address() as AddressInfo).port}`;
    process.env.YOUGILE_PUSH_DISABLED = '1'; // очередь проталкиваем вручную

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
  afterAll(async () => {
    delete process.env.YOUGILE_PUSH_DISABLED;
    await app?.close();
    await new Promise<void>((r) => mock.close(() => r()));
  });

  it('перенос/правка/коммент/файл/новая задача из CRM уезжают в YouGile, эхо не откатывает и не дублирует', async () => {
    const email = `yg4_${uniq()}@t.test`;
    const reg = (await http$.post('/api/auth/register').send({ tenantName: 'YG4', email, password: 'password123', fullName: 'Иван Петров' }).expect(201)).body.data;
    const tok = reg.accessToken;

    state.users = [{ id: 'u1', email, realName: 'Иван Петров' }];
    state.projects = [{ id: 'p1', title: 'Проект А' }];
    state.boards = [{ id: 'b1', title: 'Доска 1', projectId: 'p1' }];
    state.columns = [{ id: 'c1', title: 'To Do', boardId: 'b1' }, { id: 'c2', title: 'Готово', boardId: 'b1' }];
    state.tasksByCol = { c1: [{ id: 't1', title: 'Задача 1', columnId: 'c1', assigned: ['u1'] }], c2: [] };
    state.taskById = { t1: { id: 't1', title: 'Задача 1', columnId: 'c1', assigned: ['u1'] } };
    state.messagesByTask = { t1: [] };

    const conn = (await http$.post('/api/integrations/yougile/connections').set(H(tok)).send({ apiKey: 'k', label: 'Основной' }).expect(201)).body.data;
    const { runId } = (await http$.post(`/api/integrations/yougile/connections/${conn.id}/import`).set(H(tok)).send({ boardExternalIds: ['b1'] }).expect(201)).body.data;
    for (let i = 0; i < 60; i++) {
      const r = (await http$.get(`/api/integrations/yougile/runs/${runId}`).set(H(tok)).expect(200)).body.data;
      if (r.status === 'done' || r.status === 'error') { expect(r.status).toBe('done'); break; }
      await new Promise((r2) => setTimeout(r2, 150));
    }

    const proj = (await http$.get('/api/projects').set(H(tok)).expect(200)).body.data.find((p: any) => p.name === 'Доска 1');
    const board = (await http$.get(`/api/projects/${proj.id}/board`).set(H(tok)).expect(200)).body.data;
    const todo = board.columns.find((c: any) => c.name === 'To Do');
    const done = board.columns.find((c: any) => c.name === 'Готово');
    const task = todo.tasks.find((t: any) => t.title === 'Задача 1');

    // выгрузка выключена по умолчанию: перенос в CRM ничего не шлёт
    calls = [];
    await http$.post(`/api/tasks/${task.id}/move`).set(H(tok)).send({ columnId: done.id, position: 0 }).expect(201);
    await http$.post(`/api/integrations/yougile/connections/${conn.id}/push/flush`).set(H(tok)).expect(201);
    expect(findCall('PUT', /^\/tasks\//)).toHaveLength(0);

    // включаем двустороннюю синхронизацию
    const push = (await http$.post(`/api/integrations/yougile/connections/${conn.id}/push`).set(H(tok)).send({ enabled: true }).expect(201)).body.data;
    expect(push.pushEnabled).toBe(true);

    // 1) перенос карточки обратно в To Do → PUT задачи с новой колонкой
    calls = [];
    await http$.post(`/api/tasks/${task.id}/move`).set(H(tok)).send({ columnId: todo.id, position: 0 }).expect(201);
    await http$.post(`/api/integrations/yougile/connections/${conn.id}/push/flush`).set(H(tok)).expect(201);
    const moved = findCall('PUT', /^\/tasks\/t1$/);
    expect(moved).toHaveLength(1);
    expect(moved[0].body.columnId).toBe('c1');
    expect(moved[0].body.completed).toBe(false);

    // 2) правка названия → PUT с новым заголовком и исполнителем (сопоставлен по e-mail)
    calls = [];
    await http$.patch(`/api/tasks/${task.id}`).set(H(tok)).send({ title: 'Задача 1 (правка из CRM)' }).expect(200);
    await http$.post(`/api/integrations/yougile/connections/${conn.id}/push/flush`).set(H(tok)).expect(201);
    const upd = findCall('PUT', /^\/tasks\/t1$/);
    expect(upd).toHaveLength(1);
    expect(upd[0].body.title).toBe('Задача 1 (правка из CRM)');
    expect(upd[0].body.assigned).toEqual(['u1']);

    // 3) комментарий → сообщение в чат задачи, автор подписан в тексте
    calls = [];
    await http$.post(`/api/tasks/${task.id}/comments`).set(H(tok)).send({ body: 'Комментарий из CRM' }).expect(201);
    await http$.post(`/api/integrations/yougile/connections/${conn.id}/push/flush`).set(H(tok)).expect(201);
    const msg = findCall('POST', /^\/chats\/t1\/messages$/);
    expect(msg).toHaveLength(1);
    expect(msg[0].body.text).toBe('Иван Петров: Комментарий из CRM');

    // 4) вложение → загрузка файла + ссылка сообщением в чат
    calls = [];
    await http$.post(`/api/tasks/${task.id}/attachments`).set(H(tok))
      .attach('file', Buffer.from('hello'), { filename: 'note.txt', contentType: 'text/plain' }).expect(201);
    await http$.post(`/api/integrations/yougile/connections/${conn.id}/push/flush`).set(H(tok)).expect(201);
    expect(findCall('POST', /^\/upload-file$/)).toHaveLength(1);
    expect(findCall('POST', /^\/chats\/t1\/messages$/)[0].body.text).toContain('note.txt');

    // 5) новая задача в CRM → POST /tasks и привязка внешнего id (повторная правка идёт уже PUT-ом)
    calls = [];
    const created = (await http$.post('/api/tasks').set(H(tok)).send({ projectId: proj.id, columnId: todo.id, title: 'Создано в CRM' }).expect(201)).body.data;
    await http$.post(`/api/integrations/yougile/connections/${conn.id}/push/flush`).set(H(tok)).expect(201);
    const posted = findCall('POST', /^\/tasks$/);
    expect(posted).toHaveLength(1);
    expect(posted[0].body.title).toBe('Создано в CRM');
    expect(posted[0].body.columnId).toBe('c1');
    calls = [];
    await http$.patch(`/api/tasks/${created.id}`).set(H(tok)).send({ title: 'Создано в CRM v2' }).expect(200);
    await http$.post(`/api/integrations/yougile/connections/${conn.id}/push/flush`).set(H(tok)).expect(201);
    expect(findCall('POST', /^\/tasks$/)).toHaveLength(0);
    expect(findCall('PUT', /^\/tasks\/new1$/)).toHaveLength(1);

    // 6) эхо: YouGile присылает вебхук о НАШЕЙ же правке — карточка не откатывается,
    //    а наши сообщения из чата не превращаются в дубли комментариев
    const conns = (await http$.get('/api/integrations/yougile/connections').set(H(tok)).expect(200)).body.data;
    const token = conns.find((c: any) => c.id === conn.id).event_token;
    await http$.post(`/api/integrations/yougile/events/${token}`).send({ event: 'task-updated', id: 't1' }).expect(201);
    await new Promise((r) => setTimeout(r, 1500));

    const after = (await http$.get(`/api/projects/${proj.id}/board`).set(H(tok)).expect(200)).body.data;
    const stillTodo = after.columns.find((c: any) => c.name === 'To Do').tasks.find((t: any) => t.id === task.id);
    expect(stillTodo).toBeTruthy();                                   // не уехала обратно в «Готово»
    expect(stillTodo.title).toBe('Задача 1 (правка из CRM)');          // название не откатилось
    const comments = (await http$.get(`/api/tasks/${task.id}/comments`).set(H(tok)).expect(200)).body.data;
    expect(comments.filter((c: any) => /Комментарий из CRM/.test(c.body))).toHaveLength(1);
    expect(comments.filter((c: any) => /note\.txt/.test(c.body))).toHaveLength(0);
  });
});
