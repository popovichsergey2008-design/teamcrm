import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AddressInfo } from 'net';
import * as http from 'http';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { AllExceptionsFilter } from '../src/common/http/all-exceptions.filter';
import { ResponseInterceptor } from '../src/common/http/response.interceptor';
import { RedisIoAdapter } from '../src/common/auth/redis-io.adapter';

/** Импорт задач из Битрикс24 (E1) — через мок Bitrix REST на localhost. */
describe('Enhancements v1 — Bitrix import (e2e)', () => {
  let app: INestApplication;
  let http$: any;
  let mock: http.Server;
  let webhookBase: string;
  let ownerEmail = '';
  const uniq = () => Math.random().toString(36).slice(2) + Date.now().toString(36);
  const H = (t: string) => ({ Authorization: `Bearer ${t}` });
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  beforeAll(async () => {
    // мок Bitrix REST
    mock = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        // отдача содержимого файла по DOWNLOAD_URL
        if ((req.url ?? '').startsWith('/dl/')) {
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          res.end('содержимое файла из битрикса');
          return;
        }
        const method = (req.url ?? '').split('/').filter(Boolean).pop();
        const port = (mock.address() as AddressInfo).port;
        const reply = (result: any, extra: any = {}) => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ result, ...extra }));
        };
        switch (method) {
          case 'profile': return reply({ ID: 1, NAME: 'Admin' });
          case 'disk.file.get':
          case 'disk.attachedObject.get':
            return reply({ ID: '1', NAME: 'договор.txt', DOWNLOAD_URL: `http://127.0.0.1:${port}/dl/dogovor.txt` });
          case 'log.blogpost.get': {
            let hasGroup = false;
            try { hasGroup = JSON.parse(body)?.filter?.SOCNET_GROUP_ID !== undefined; } catch { /* */ }
            return reply(hasGroup
              ? [{ ID: '50', AUTHOR_ID: '5', DETAIL_TEXT: 'пост в ленте проекта', DATE_PUBLISH: '2026-06-03T09:00:00+03:00' }]
              : [{ ID: '70', AUTHOR_ID: '5', DETAIL_TEXT: 'пост в общей ленте компании', DATE_PUBLISH: '2026-06-04T09:00:00+03:00' }]);
          }
          case 'user.get': return reply([
            { ID: '5', NAME: 'Анна', LAST_NAME: 'Босс', EMAIL: ownerEmail },
            { ID: '6', NAME: 'Гость', LAST_NAME: '', EMAIL: 'ghost@x.test' },
          ]);
          case 'sonet_group.get': return reply([{ ID: '10', NAME: 'Медицина' }, { ID: '20', NAME: 'Разработка' }]);
          case 'task.stages.get': {
            let entityId = '';
            try { entityId = String(JSON.parse(body).entityId ?? ''); } catch { /* */ }
            if (entityId === '20') { // группа без колонки «Готово» — проверяем авто-создание
              return reply({
                '400': { ID: '400', TITLE: 'Бэклог', SORT: 100 },
                '500': { ID: '500', TITLE: 'Разработка', SORT: 200 },
              });
            }
            return reply({
              '100': { ID: '100', TITLE: 'Новые', SORT: 100 },
              '200': { ID: '200', TITLE: 'В работе', SORT: 200 },
              '300': { ID: '300', TITLE: 'Готово', SORT: 300 },
            });
          }
          case 'tasks.task.list': {
            let groupId = '';
            try { groupId = String(JSON.parse(body)?.filter?.GROUP_ID ?? ''); } catch { /* */ }
            if (groupId === '0') {
              // задачи вне рабочих групп (GROUP_ID=0); 92 — недоступные комменты; 93 — завершённая (для авто-колонки)
              return reply({ tasks: [
                { id: '90', title: 'Медицина договор с клиникой', description: '', responsibleId: '5', createdBy: '5', status: '2', priority: '1', deadline: '', tags: [] },
                { id: '91', title: 'Купить кофе в офис', description: '', responsibleId: '5', createdBy: '5', status: '2', priority: '1', deadline: '', tags: [] },
                { id: '92', title: 'Кофемашина сломалась', description: '', responsibleId: '5', createdBy: '5', status: '2', priority: '1', deadline: '', tags: [] },
                { id: '93', title: 'Релиз выкачен', description: '', responsibleId: '5', createdBy: '5', status: '5', priority: '1', deadline: '', closedDate: '2026-06-10', tags: [] },
              ] });
            }
            if (groupId === '20') return reply({ tasks: [] }); // группа «Разработка» — без своих задач в тесте
            return reply({
              tasks: [{
                id: '1', title: 'Задача A', description: 'описание', responsibleId: '5', createdBy: '5',
                stageId: '200', status: '2', priority: '2', deadline: '', tags: [{ id: '7', title: 'дизайн' }],
                ufTaskWebdavFiles: ['n1'],
              }],
            });
          }
          case 'tasks.task.get': {
            let tid = '';
            try { tid = String(JSON.parse(body).taskId ?? ''); } catch { /* */ }
            return reply({ task: {
              id: tid, title: tid === '2' ? 'Событийная задача' : 'Задача A', description: 'x',
              responsibleId: '5', createdBy: '5', groupId: '10', stageId: tid === '2' ? '300' : '200',
              status: '2', priority: '1', deadline: '', tags: [], ufTaskWebdavFiles: [],
            } });
          }
          case 'task.commentitem.getlist': {
            let ctid = '';
            try { ctid = String(JSON.parse(body).TASKID ?? ''); } catch { /* */ }
            if (ctid === '92') { // нет доступа к комментариям задачи — не должно ронять весь прогон
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'ACCESS_DENIED', error_description: 'Вы не можете просматривать задачи в этой группе' }));
              return;
            }
            return reply([
            {
              ID: '11', AUTHOR_ID: '5', AUTHOR_NAME: 'Анна Босс', POST_MESSAGE: '[B]коммент из битрикса[/B]', POST_DATE: '2026-06-01T10:00:00+03:00',
              ATTACHED_OBJECTS: { '99': { NAME: 'скрин.png', DOWNLOAD_URL: `http://127.0.0.1:${port}/dl/screen.png` } },
            },
            { ID: '12', AUTHOR_ID: '6', AUTHOR_NAME: 'Гость', POST_MESSAGE: 'от несопоставленного', POST_DATE: '2026-06-02T10:00:00+03:00' },
            ]);
          }
          default: return reply([]);
        }
      });
    });
    await new Promise<void>((r) => mock.listen(0, '127.0.0.1', r));
    webhookBase = `http://127.0.0.1:${(mock.address() as AddressInfo).port}/rest/1/tok/`;

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
    await app?.close();
    await new Promise<void>((r) => mock.close(() => r()));
  });

  const waitRun = async (tok: string, runId: string) => {
    for (let i = 0; i < 40; i++) {
      const run = (await http$.get(`/api/integrations/bitrix/runs/${runId}`).set(H(tok)).expect(200)).body.data;
      if (run.status === 'done' || run.status === 'error') return run;
      await sleep(150);
    }
    throw new Error('import did not finish');
  };

  it('подключение → проекты → импорт доски + задач + комментариев; идемпотентно', async () => {
    ownerEmail = `own_${uniq()}@t.test`;
    const reg = (await http$.post('/api/auth/register').send({ tenantName: 'Имп', email: ownerEmail, password: 'password123', fullName: 'Анна Босс' }).expect(201)).body.data;
    const tok = reg.accessToken;

    // connect
    const conn = (await http$.post('/api/integrations/bitrix/connections').set(H(tok)).send({ webhookUrl: webhookBase, label: 'Тест' }).expect(201)).body.data;
    expect(conn.portal).toContain('127.0.0.1');
    const cid = conn.id;

    // projects
    const projects = (await http$.get(`/api/integrations/bitrix/connections/${cid}/projects`).set(H(tok)).expect(200)).body.data;
    expect(projects).toEqual([{ externalId: '10', name: 'Медицина' }, { externalId: '20', name: 'Разработка' }]);

    // import
    const started = (await http$.post(`/api/integrations/bitrix/connections/${cid}/import`).set(H(tok)).send({ projectExternalIds: ['10'] }).expect(201)).body.data;
    let run = await waitRun(tok, started.runId);
    expect(run.status).toBe('done');
    expect(run.stats.tasks).toBe(1);
    expect(run.stats.comments).toBe(2);
    expect(run.stats.attachments).toBe(2); // файл задачи (n1) + файл из комментария (ATTACHED_OBJECTS)
    expect(run.stats.messages).toBe(1);    // пост из ленты проекта

    // проект появился как импортированный
    const list = (await http$.get('/api/projects').set(H(tok)).expect(200)).body.data;
    const proj = list.find((p: any) => p.name === 'Медицина');
    expect(proj).toBeTruthy();
    expect(proj.origin).toBe('bitrix');

    // доска: 3 колонки из стадий, задача в «В работе», исполнитель сматчен
    const board = (await http$.get(`/api/projects/${proj.id}/board`).set(H(tok)).expect(200)).body.data;
    expect(board.columns.map((c: any) => c.name)).toEqual(['Новые', 'В работе', 'Готово']);
    const inWork = board.columns.find((c: any) => c.name === 'В работе');
    expect(inWork.tasks.length).toBe(1);
    const task = inWork.tasks[0];
    expect(task.title).toBe('Задача A');
    expect(task.priority).toBe('high');
    expect((task.labels ?? []).some((l: any) => l.name === 'дизайн')).toBe(true); // тег-объект → корректное имя метки
    expect(task.assignee_name).toBe('Анна Босс');
    expect(task.manager_name).toBe('Анна Босс');

    // комментарии: один от сматченного автора, один с префиксом импорта
    const comments = (await http$.get(`/api/tasks/${task.id}/comments`).set(H(tok)).expect(200)).body.data;
    expect(comments.length).toBe(2);
    const bodies = comments.map((c: any) => c.body);
    expect(bodies).toContain('коммент из битрикса');
    expect(bodies.some((b: string) => b.includes('[Импортировано из Битрикса, автор: Гость]'))).toBe(true);

    // вложение задачи (Bitrix Disk → MinIO)
    const atts = (await http$.get(`/api/tasks/${task.id}/attachments`).set(H(tok)).expect(200)).body.data;
    expect(atts.length).toBe(2); // файл задачи + файл из комментария
    const attNames = atts.map((a: any) => a.file_name);
    expect(attNames.some((n: string) => n.includes('договор'))).toBe(true); // кириллица сохраняется
    expect(attNames).toContain('скрин.png');

    // лента проекта → архив сообщений
    const messages = (await http$.get(`/api/integrations/bitrix/projects/${proj.id}/messages`).set(H(tok)).expect(200)).body.data;
    expect(messages.length).toBe(1);
    expect(messages[0].body).toBe('пост в ленте проекта');

    // несопоставленные пользователи + ручная привязка
    let unmatched = (await http$.get(`/api/integrations/bitrix/connections/${cid}/unmatched-users`).set(H(tok)).expect(200)).body.data;
    expect(unmatched.items.some((u: any) => u.email === 'ghost@x.test')).toBe(true);
    await http$.post(`/api/integrations/bitrix/connections/${cid}/user-map`).set(H(tok)).send({ externalUserId: '6', localUserId: reg.user.id }).expect(201);
    unmatched = (await http$.get(`/api/integrations/bitrix/connections/${cid}/unmatched-users`).set(H(tok)).expect(200)).body.data;
    expect(unmatched.items.some((u: any) => u.externalId === '6')).toBe(false); // после привязки исчез

    // повторный импорт — идемпотентно (без дублей)
    const started2 = (await http$.post(`/api/integrations/bitrix/connections/${cid}/import`).set(H(tok)).send({ projectExternalIds: ['10'] }).expect(201)).body.data;
    run = await waitRun(tok, started2.runId);
    expect(run.status).toBe('done');
    const board2 = (await http$.get(`/api/projects/${proj.id}/board`).set(H(tok)).expect(200)).body.data;
    const inWork2 = board2.columns.find((c: any) => c.name === 'В работе');
    expect(inWork2.tasks.length).toBe(1); // не задвоилось
    const comments2 = (await http$.get(`/api/tasks/${task.id}/comments`).set(H(tok)).expect(200)).body.data;
    expect(comments2.length).toBe(2); // комментарии не задвоились
    const atts2 = (await http$.get(`/api/tasks/${task.id}/attachments`).set(H(tok)).expect(200)).body.data;
    expect(atts2.length).toBe(2); // вложения не задвоились
    const messages2 = (await http$.get(`/api/integrations/bitrix/projects/${proj.id}/messages`).set(H(tok)).expect(200)).body.data;
    expect(messages2.length).toBe(1); // сообщения ленты не задвоились

    // E3: живое событие — новая задача через исходящий вебхук
    expect(conn.eventToken).toBeTruthy();
    const evUrl = `/api/integrations/bitrix/events/${conn.eventToken}`;
    await http$.post(evUrl).set('Content-Type', 'application/x-www-form-urlencoded')
      .send('event=ONTASKUPDATE&data[FIELDS_AFTER][ID]=2&auth[domain]=127.0.0.1').expect(201);
    let appeared = false;
    for (let k = 0; k < 25 && !appeared; k++) {
      const bd = (await http$.get(`/api/projects/${proj.id}/board`).set(H(tok)).expect(200)).body.data;
      const done = bd.columns.find((c: any) => c.name === 'Готово');
      if (done?.tasks.some((t: any) => t.title === 'Событийная задача')) appeared = true;
      else await sleep(250);
    }
    expect(appeared).toBe(true); // задача из события синхронизирована в «Готово»

    // E3: удаление задачи по событию ONTASKDELETE
    await http$.post(evUrl).set('Content-Type', 'application/x-www-form-urlencoded')
      .send('event=ONTASKDELETE&data[FIELDS_BEFORE][ID]=1').expect(201);
    let gone = false;
    for (let k = 0; k < 25 && !gone; k++) {
      const bd = (await http$.get(`/api/projects/${proj.id}/board`).set(H(tok)).expect(200)).body.data;
      const all = bd.columns.flatMap((c: any) => c.tasks);
      if (!all.some((t: any) => String(t.id) === String(task.id))) gone = true;
      else await sleep(250);
    }
    expect(gone).toBe(true); // задача удалена по событию

    // неизвестный event_token — тихо игнорируется (200)
    await http$.post('/api/integrations/bitrix/events/deadbeef').set('Content-Type', 'application/x-www-form-urlencoded')
      .send('event=ONTASKUPDATE&data[FIELDS_AFTER][ID]=9').expect(201);

    // отключение
    await http$.delete(`/api/integrations/bitrix/connections/${cid}`).set(H(tok)).expect(200);
    const after = (await http$.get('/api/integrations/bitrix/connections').set(H(tok)).expect(200)).body.data;
    expect(after.find((c: any) => String(c.id) === String(cid))).toBeUndefined();
  });

  it('нельзя подключить не-https не-localhost и дубль портала', async () => {
    const reg = (await http$.post('/api/auth/register').send({ tenantName: 'Имп2', email: `own_${uniq()}@t.test`, password: 'password123', fullName: 'Б' }).expect(201)).body.data;
    const tok = reg.accessToken;
    await http$.post('/api/integrations/bitrix/connections').set(H(tok)).send({ webhookUrl: 'http://evil.example.com/rest/1/x/' }).expect(400);
    // первый ок, второй тот же портал → 409
    await http$.post('/api/integrations/bitrix/connections').set(H(tok)).send({ webhookUrl: webhookBase }).expect(201);
    await http$.post('/api/integrations/bitrix/connections').set(H(tok)).send({ webhookUrl: webhookBase }).expect(409);
  });

  it('задачи вне проектов: ИИ-раскладка по проектам + общая Живая лента в «Входящие»', async () => {
    ownerEmail = `ung_${uniq()}@t.test`;
    const reg = (await http$.post('/api/auth/register').send({ tenantName: 'ИмпUng', email: ownerEmail, password: 'password123', fullName: 'Анна Босс' }).expect(201)).body.data;
    const tok = reg.accessToken;
    const conn = (await http$.post('/api/integrations/bitrix/connections').set(H(tok)).send({ webhookUrl: webhookBase }).expect(201)).body.data;
    const cid = conn.id;

    // импортируем группы — они станут кандидатами для ИИ-раскладки
    const started = (await http$.post(`/api/integrations/bitrix/connections/${cid}/import`).set(H(tok)).send({ projectExternalIds: ['10', '20'] }).expect(201)).body.data;
    expect((await waitRun(tok, started.runId)).status).toBe('done');
    const projList = (await http$.get('/api/projects').set(H(tok)).expect(200)).body.data;
    const medProj = projList.find((p: any) => p.name === 'Медицина');
    const devProj = projList.find((p: any) => p.name === 'Разработка');
    expect(medProj).toBeTruthy();
    expect(devProj).toBeTruthy();
    // у «Разработки» нет колонки «Готово» (только Бэклог/Разработка)
    const devBoard0 = (await http$.get(`/api/projects/${devProj.id}/board`).set(H(tok)).expect(200)).body.data;
    expect(devBoard0.columns.map((c: any) => c.name)).toEqual(['Бэклог', 'Разработка']);

    // предпросмотр раскладки: без LLM-ключа работает эвристика (совпадение слов)
    const ana = (await http$.post(`/api/integrations/bitrix/connections/${cid}/ungrouped/analyze`).set(H(tok)).expect(201)).body.data;
    expect(ana.projects.some((p: any) => p.name === 'Медицина')).toBe(true);
    const t90 = ana.tasks.find((t: any) => t.externalId === '90');
    const t91 = ana.tasks.find((t: any) => t.externalId === '91');
    expect(t90.suggestedProjectId).toBe(medProj.id); // «Медицина …» → проект Медицина
    expect(t91.suggestedProjectId).toBeNull();       // «Купить кофе …» → ни один проект → Входящие

    // применяем подтверждённую раскладку (принимаем предложение ИИ)
    const applied = (await http$.post(`/api/integrations/bitrix/connections/${cid}/ungrouped/apply`).set(H(tok))
      .send({ assignments: [{ externalId: '90', projectId: medProj.id }, { externalId: '91', projectId: null }] }).expect(201)).body.data;
    const runApply = await waitRun(tok, applied.runId);
    expect(runApply.status).toBe('done');
    expect(runApply.stats.routed).toBe(1);
    expect(runApply.stats.inbox).toBe(1);

    // задача 90 попала в доску «Медицина»
    const medBoard = (await http$.get(`/api/projects/${medProj.id}/board`).set(H(tok)).expect(200)).body.data;
    expect(medBoard.columns.flatMap((c: any) => c.tasks).some((t: any) => t.title.includes('Медицина договор'))).toBe(true);

    // появился служебный проект «Входящие из Битрикса» с задачей 91
    const inbox = (await http$.get('/api/projects').set(H(tok)).expect(200)).body.data.find((p: any) => p.name === 'Входящие из Битрикса');
    expect(inbox).toBeTruthy();
    expect(inbox.origin).toBe('bitrix');
    const inboxBoard = (await http$.get(`/api/projects/${inbox.id}/board`).set(H(tok)).expect(200)).body.data;
    expect(inboxBoard.columns.flatMap((c: any) => c.tasks).some((t: any) => t.title.includes('кофе'))).toBe(true);

    // повторный analyze — задачи 90/91 уже разложены? Нет: они остаются в Битриксе, но analyze их снова покажет.
    // Идемпотентность применения: повторный apply не задваивает (external_refs task).
    const applied2 = (await http$.post(`/api/integrations/bitrix/connections/${cid}/ungrouped/apply`).set(H(tok))
      .send({ assignments: [{ externalId: '90', projectId: medProj.id }] }).expect(201)).body.data;
    expect((await waitRun(tok, applied2.runId)).status).toBe('done');
    const medBoard2 = (await http$.get(`/api/projects/${medProj.id}/board`).set(H(tok)).expect(200)).body.data;
    expect(medBoard2.columns.flatMap((c: any) => c.tasks).filter((t: any) => t.title.includes('Медицина договор')).length).toBe(1);

    // устойчивость: задача 92 с недоступными комментариями не роняет прогон, импортируется без них
    const applied92 = (await http$.post(`/api/integrations/bitrix/connections/${cid}/ungrouped/apply`).set(H(tok))
      .send({ assignments: [{ externalId: '92', projectId: null }] }).expect(201)).body.data;
    const run92 = await waitRun(tok, applied92.runId);
    expect(run92.status).toBe('done'); // не error, несмотря на ACCESS_DENIED по комментам
    expect(run92.stats.inbox).toBe(1);
    const inboxBoard2 = (await http$.get(`/api/projects/${inbox.id}/board`).set(H(tok)).expect(200)).body.data;
    const task92 = inboxBoard2.columns.flatMap((c: any) => c.tasks).find((t: any) => t.title.includes('Кофемашина'));
    expect(task92).toBeTruthy();
    const comments92 = (await http$.get(`/api/tasks/${task92.id}/comments`).set(H(tok)).expect(200)).body.data;
    expect(comments92.length).toBe(0); // комментарии недоступны — задача импортирована без них

    // авто-создание колонки: завершённую задачу 93 кладём в «Разработку», где нет «Готово» → колонка создаётся
    const applied93 = (await http$.post(`/api/integrations/bitrix/connections/${cid}/ungrouped/apply`).set(H(tok))
      .send({ assignments: [{ externalId: '93', projectId: devProj.id }] }).expect(201)).body.data;
    expect((await waitRun(tok, applied93.runId)).status).toBe('done');
    const devBoard = (await http$.get(`/api/projects/${devProj.id}/board`).set(H(tok)).expect(200)).body.data;
    const doneCol = devBoard.columns.find((c: any) => c.name === 'Готово');
    expect(doneCol).toBeTruthy(); // колонка создана автоматически под завершённую задачу
    expect(doneCol.tasks.some((t: any) => t.title.includes('Релиз'))).toBe(true);

    // общая Живая лента → «Входящие из Битрикса» (импорт только ленты, без проектов)
    const feedRun = (await http$.post(`/api/integrations/bitrix/connections/${cid}/import`).set(H(tok))
      .send({ projectExternalIds: [], includeGeneralFeed: true }).expect(201)).body.data;
    const runFeed = await waitRun(tok, feedRun.runId);
    expect(runFeed.status).toBe('done');
    expect(runFeed.stats.messages).toBeGreaterThanOrEqual(1);
    const msgs = (await http$.get(`/api/integrations/bitrix/projects/${inbox.id}/messages`).set(H(tok)).expect(200)).body.data;
    expect(msgs.some((m: any) => m.body.includes('общей ленте компании'))).toBe(true);
  });

  it('удаление импортированного проекта целиком (лента/refs/чанки не блокируют)', async () => {
    ownerEmail = `del_${uniq()}@t.test`;
    const reg = (await http$.post('/api/auth/register').send({ tenantName: 'ИмпDel', email: ownerEmail, password: 'password123', fullName: 'Анна Босс' }).expect(201)).body.data;
    const tok = reg.accessToken;
    const conn = (await http$.post('/api/integrations/bitrix/connections').set(H(tok)).send({ webhookUrl: webhookBase }).expect(201)).body.data;
    const started = (await http$.post(`/api/integrations/bitrix/connections/${conn.id}/import`).set(H(tok)).send({ projectExternalIds: ['10'] }).expect(201)).body.data;
    const run = await waitRun(tok, started.runId);
    expect(run.status).toBe('done');

    const list = (await http$.get('/api/projects').set(H(tok)).expect(200)).body.data;
    const proj = list.find((p: any) => p.name === 'Медицина');
    expect(proj.origin).toBe('bitrix');

    // удаляем импортированный проект — раньше падало 500 из-за imported_messages FK
    await http$.delete(`/api/projects/${proj.id}`).set(H(tok)).expect(200);
    const after = (await http$.get('/api/projects').set(H(tok)).expect(200)).body.data;
    expect(after.find((p: any) => String(p.id) === String(proj.id))).toBeUndefined();
  });
});
