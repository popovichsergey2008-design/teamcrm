import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AddressInfo } from 'net';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { AllExceptionsFilter } from '../src/common/http/all-exceptions.filter';
import { ResponseInterceptor } from '../src/common/http/response.interceptor';
import { RedisIoAdapter } from '../src/common/auth/redis-io.adapter';
import { AnthillRepository } from '../src/modules/anthill/anthill.repository';

/**
 * AnthillBot (ТЗ-6, MVP 1): сессии, ответ потоком, действия с подтверждением и откатом.
 * Модель в CI — заглушка, поэтому проверяем конвейер, а не качество текста.
 */
describe('AnthillBot (e2e)', () => {
  let app: INestApplication;
  let http$: any;
  let repo: AnthillRepository;
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
    http$ = request(`http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`);
    repo = app.get(AnthillRepository);
  });
  afterAll(async () => app?.close());

  it('сессия: вопрос потоком с контекстом задачи, история, оценка, чужая сессия закрыта', async () => {
    const owner = (await http$.post('/api/auth/register')
      .send({ tenantName: 'AB', email: `ab_${uniq()}@t.test`, password: 'password123', fullName: 'Сергей' }).expect(201)).body.data;
    const O = H(owner.accessToken);
    const project = (await http$.post('/api/projects').set(O).send({ name: 'Panorama' }).expect(201)).body.data;
    const board = (await http$.get(`/api/projects/${project.id}/board`).set(O).expect(200)).body.data;
    const task = (await http$.post('/api/tasks').set(O)
      .send({ projectId: project.id, columnId: board.columns[0].id, title: 'Исправить авторизацию API', description: 'Падает на refresh' }).expect(201)).body.data;

    // до первого вопроса разговоров нет
    expect((await http$.get('/api/anthill/sessions').set(O).expect(200)).body.data).toEqual([]);

    const session = (await http$.post('/api/anthill/sessions').set(O).send({ context: { type: 'task', id: String(task.id) } }).expect(201)).body.data;
    const res = await http$.post(`/api/anthill/sessions/${session.id}/ask`).set(O).send({ question: 'Что здесь нужно сделать?' }).expect(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    expect(res.text).toContain('event: status');
    expect(res.text).toContain('event: done');

    const msgs = (await http$.get(`/api/anthill/sessions/${session.id}/messages`).set(O).expect(200)).body.data;
    expect(msgs.map((m: any) => m.role)).toEqual(['user', 'assistant']);
    expect(msgs[0].content).toBe('Что здесь нужно сделать?');
    // контекст страницы стал источником: задача под рукой, без ссылки
    expect(msgs[1].citations.some((c: any) => c.kind === 'task' && String(c.id) === String(task.id))).toBe(true);

    // история: разговор назван первым вопросом
    const list = (await http$.get('/api/anthill/sessions').set(O).expect(200)).body.data;
    expect(list[0].title).toBe('Что здесь нужно сделать?');
    expect(list[0].context).toEqual({ type: 'task', id: String(task.id) });

    // оценка ответа — только своего
    await http$.post(`/api/anthill/messages/${msgs[1].id}/feedback`).set(O).send({ vote: -1, reason: 'not_found' }).expect(201);
    const mateEmail = `abm_${uniq()}@t.test`;
    await http$.post('/api/users').set(O).send({ email: mateEmail, fullName: 'Глеб', password: 'password123', role: 'member' }).expect(201);
    const M = H((await http$.post('/api/auth/login').send({ email: mateEmail, password: 'password123' }).expect(201)).body.data.accessToken);
    await http$.get(`/api/anthill/sessions/${session.id}/messages`).set(M).expect(404);
    await http$.post(`/api/anthill/messages/${msgs[1].id}/feedback`).set(M).send({ vote: 1 }).expect(404);

    await http$.delete(`/api/anthill/sessions/${session.id}`).set(O).expect(200);
    expect((await http$.get('/api/anthill/sessions').set(O).expect(200)).body.data).toEqual([]);
  });

  it('действие: напоминание ставится только после «Создать», отменяется и не выполняется дважды', async () => {
    const owner = (await http$.post('/api/auth/register')
      .send({ tenantName: 'AB2', email: `ab2_${uniq()}@t.test`, password: 'password123', fullName: 'Сергей' }).expect(201)).body.data;
    const O = H(owner.accessToken);
    const session = (await http$.post('/api/anthill/sessions').set(O).send({}).expect(201)).body.data;

    // Модель в CI — заглушка и действий не предлагает: карточку кладём так же, как
    // положил бы оркестратор, и проверяем путь подтверждения.
    const when = new Date(Date.now() + 3600_000).toISOString();
    const action = await repo.createAction({
      tenantId: String(owner.user.tenantId), sessionId: String(session.id), userId: String(owner.user.id),
      tool: 'create_reminder', input: { text: 'проверить задачу', when },
    });
    const pending = (await http$.get('/api/anthill/actions').set(O).expect(200)).body.data;
    expect(pending[0]).toMatchObject({ id: String(action.id), tool: 'create_reminder', status: 'pending' });

    // до подтверждения в «Заметках» ничего не запланировано
    const self = (await http$.post('/api/chats/self').set(O).expect(201)).body.data;
    expect((await http$.get(`/api/chats/${self.id}/scheduled`).set(O).expect(200)).body.data.items).toEqual([]);

    // «Редактировать»: правка идёт мимо модели и переписывает карточку на месте
    const edited = (await http$.post(`/api/anthill/actions/${action.id}/edit`).set(O)
      .send({ patch: { text: 'позвонить подрядчику' } }).expect(201)).body.data;
    expect(edited.preview).toContain('позвонить подрядчику');
    expect(edited.values.text).toBe('позвонить подрядчику');
    await http$.post(`/api/anthill/actions/${action.id}/edit`).set(O)
      .send({ patch: { when: '2000-01-01T09:00' } }).expect(400); // время в прошлом

    const done = (await http$.post(`/api/anthill/actions/${action.id}/confirm`).set(O).expect(201)).body.data;
    expect(done.status).toBe('done');
    expect(done.canUndo).toBe(true);
    expect((await http$.get(`/api/chats/${self.id}/scheduled`).set(O).expect(200)).body.data.items.length).toBe(1);

    // второй раз не выполнить; откат убирает напоминание
    await http$.post(`/api/anthill/actions/${action.id}/confirm`).set(O).expect(409);
    await http$.post(`/api/anthill/actions/${action.id}/undo`).set(O).expect(201);
    expect((await http$.get(`/api/chats/${self.id}/scheduled`).set(O).expect(200)).body.data.items).toEqual([]);
    expect((await http$.get('/api/anthill/actions').set(O).expect(200)).body.data[0].status).toBe('undone');

    // отклонённое — не выполнить
    const other = await repo.createAction({
      tenantId: String(owner.user.tenantId), sessionId: String(session.id), userId: String(owner.user.id),
      tool: 'create_reminder', input: { text: 'ещё', when },
    });
    await http$.post(`/api/anthill/actions/${other.id}/reject`).set(O).expect(201);
    await http$.post(`/api/anthill/actions/${other.id}/confirm`).set(O).expect(409);
    // и не поправить: карточка уже обработана
    await http$.post(`/api/anthill/actions/${other.id}/edit`).set(O).send({ patch: { text: 'ещё раз' } }).expect(409);
  });

  it('память: своя, правится и удаляется; чужую не тронуть', async () => {
    const owner = (await http$.post('/api/auth/register')
      .send({ tenantName: 'AB3', email: `ab3_${uniq()}@t.test`, password: 'password123', fullName: 'Сергей' }).expect(201)).body.data;
    const O = H(owner.accessToken);

    expect((await http$.get('/api/anthill/memories').set(O).expect(200)).body.data).toEqual([]);
    const m = (await http$.post('/api/anthill/memories').set(O)
      .send({ type: 'preference', title: 'Часовой пояс', content: 'Работаю по Новосибирску' }).expect(201)).body.data;
    expect(m).toMatchObject({ type: 'preference', title: 'Часовой пояс', source: 'manual' });

    // тот же факт не плодит вторую строку, а обновляет первую
    await http$.post('/api/anthill/memories').set(O)
      .send({ type: 'preference', title: 'часовой пояс', content: 'Новосибирск, UTC+7' }).expect(201);
    const list = (await http$.get('/api/anthill/memories').set(O).expect(200)).body.data;
    expect(list.length).toBe(1);
    expect(list[0].content).toBe('Новосибирск, UTC+7');

    await http$.patch(`/api/anthill/memories/${m.id}`).set(O).send({ title: 'Пояс', content: 'UTC+7' }).expect(200);

    const mateEmail = `ab3m_${uniq()}@t.test`;
    await http$.post('/api/users').set(O).send({ email: mateEmail, fullName: 'Глеб', password: 'password123', role: 'member' }).expect(201);
    const M = H((await http$.post('/api/auth/login').send({ email: mateEmail, password: 'password123' }).expect(201)).body.data.accessToken);
    expect((await http$.get('/api/anthill/memories').set(M).expect(200)).body.data).toEqual([]);
    await http$.patch(`/api/anthill/memories/${m.id}`).set(M).send({ title: 'чужое', content: 'чужое' }).expect(404);
    await http$.delete(`/api/anthill/memories/${m.id}`).set(M).expect(404);

    await http$.delete(`/api/anthill/memories/${m.id}`).set(O).expect(200);
    expect((await http$.get('/api/anthill/memories').set(O).expect(200)).body.data).toEqual([]);
  });

  it('регулярная задача: расписание словами, пауза и удаление', async () => {
    const owner = (await http$.post('/api/auth/register')
      .send({ tenantName: 'AB4', email: `ab4_${uniq()}@t.test`, password: 'password123', fullName: 'Сергей' }).expect(201)).body.data;
    const O = H(owner.accessToken);

    const task = (await http$.post('/api/anthill/schedules').set(O).send({
      title: 'Просроченные за неделю',
      instruction: 'дай список просроченных задач по всем проектам',
      schedule: 'каждый понедельник в 9:00',
    }).expect(201)).body.data;
    expect(task).toMatchObject({ status: 'active', label: 'каждый понедельник в 9:00' });
    expect(new Date(task.nextRunAt).getTime()).toBeGreaterThan(Date.now());

    // «когда-нибудь» расписанием не является — просим сказать по-человечески
    await http$.post('/api/anthill/schedules').set(O)
      .send({ title: 'Как-нибудь', instruction: 'дай сводку', schedule: 'когда будет время' }).expect(400);

    // пауза: следующего запуска у приостановленной нет
    const paused = (await http$.patch(`/api/anthill/schedules/${task.id}`).set(O).send({ status: 'paused' }).expect(200)).body.data;
    expect(paused.status).toBe('paused');
    expect(paused.nextRunAt).toBeNull();

    // сняли с паузы — время посчитано заново, в будущем
    const back = (await http$.patch(`/api/anthill/schedules/${task.id}`).set(O).send({ status: 'active' }).expect(200)).body.data;
    expect(new Date(back.nextRunAt).getTime()).toBeGreaterThan(Date.now());

    const moved = (await http$.patch(`/api/anthill/schedules/${task.id}`).set(O).send({ schedule: 'каждую пятницу в 17:00' }).expect(200)).body.data;
    expect(moved.label).toBe('каждую пятницу в 17:00');

    const mateEmail = `ab4m_${uniq()}@t.test`;
    await http$.post('/api/users').set(O).send({ email: mateEmail, fullName: 'Глеб', password: 'password123', role: 'member' }).expect(201);
    const M = H((await http$.post('/api/auth/login').send({ email: mateEmail, password: 'password123' }).expect(201)).body.data.accessToken);
    expect((await http$.get('/api/anthill/schedules').set(M).expect(200)).body.data).toEqual([]);
    await http$.delete(`/api/anthill/schedules/${task.id}`).set(M).expect(404);

    await http$.delete(`/api/anthill/schedules/${task.id}`).set(O).expect(200);
    expect((await http$.get('/api/anthill/schedules').set(O).expect(200)).body.data).toEqual([]);
  });

  it('навыки: стартовый набор виден всем, свой правится, чужой берут копией', async () => {
    const owner = (await http$.post('/api/auth/register')
      .send({ tenantName: 'AB5', email: `ab5_${uniq()}@t.test`, password: 'password123', fullName: 'Сергей' }).expect(201)).body.data;
    const O = H(owner.accessToken);

    // стартовый набор заводится вместе с организацией — иначе каталог пуст и непонятен
    const start = (await http$.get('/api/anthill/skills').set(O).expect(200)).body.data;
    expect(start.length).toBeGreaterThanOrEqual(4);
    expect(start.every((x: any) => x.shared)).toBe(true);
    const common = start[0];

    // общий навык компании чужой: править нельзя, но можно взять копию под себя
    await http$.patch(`/api/anthill/skills/${common.id}`).set(O).send({ name: 'Моё название' }).expect(404);
    const fork = (await http$.post(`/api/anthill/skills/${common.id}/fork`).set(O).expect(201)).body.data;
    expect(fork.mine).toBe(true);
    expect(fork.shared).toBe(false);
    expect(fork.steps).toEqual(common.steps);

    const own = (await http$.post('/api/anthill/skills').set(O).send({
      name: 'Релизный отчёт', whenToUse: 'просят отчёт о релизе',
      steps: ['Собрать закрытые задачи', 'Найти незакрытые с релиза'], output: 'Список изменений',
    }).expect(201)).body.data;
    expect(own).toMatchObject({ mine: true, visibility: 'private', steps: ['Собрать закрытые задачи', 'Найти незакрытые с релиза'] });

    // навык без шагов — не навык
    await http$.post('/api/anthill/skills').set(O).send({ name: 'Пустой', steps: [] }).expect(400);

    const shared = (await http$.patch(`/api/anthill/skills/${own.id}`).set(O).send({ visibility: 'company' }).expect(200)).body.data;
    expect(shared.shared).toBe(true);

    // коллега видит общий, но не чужой личный
    const mateEmail = `ab5m_${uniq()}@t.test`;
    await http$.post('/api/users').set(O).send({ email: mateEmail, fullName: 'Глеб', password: 'password123', role: 'member' }).expect(201);
    const M = H((await http$.post('/api/auth/login').send({ email: mateEmail, password: 'password123' }).expect(201)).body.data.accessToken);
    const forMate = (await http$.get('/api/anthill/skills').set(M).expect(200)).body.data;
    expect(forMate.some((x: any) => String(x.id) === String(own.id))).toBe(true);
    expect(forMate.some((x: any) => String(x.id) === String(fork.id))).toBe(false);
    await http$.delete(`/api/anthill/skills/${own.id}`).set(M).expect(404);

    await http$.delete(`/api/anthill/skills/${own.id}`).set(O).expect(200);
  });

  it('быстрый ответ приходит слово в слово и мимо модели; заводит его руководство', async () => {
    const owner = (await http$.post('/api/auth/register')
      .send({ tenantName: 'AB6', email: `ab6_${uniq()}@t.test`, password: 'password123', fullName: 'Сергей' }).expect(201)).body.data;
    const O = H(owner.accessToken);

    const answer = 'Инструкция по VPN: https://wiki.example/vpn';
    const resp = (await http$.post('/api/anthill/responses').set(O)
      .send({ trigger: 'vpn, впн', answer }).expect(201)).body.data;
    expect(resp).toMatchObject({ matchKind: 'keyword', scope: 'all', auto: false, enabled: true });

    // спросили у бота — пришёл заготовленный ответ, а не сочинение модели
    const self = (await http$.post('/api/chats/self').set(O).expect(201)).body.data;
    const msg = (await http$.post(`/api/chats/${self.id}/ai`).set(O).send({ question: 'ребята, где взять впн?' }).expect(201)).body.data;
    expect(msg.body).toBe(answer);
    expect((await http$.get('/api/anthill/responses').set(O).expect(200)).body.data[0].hits).toBe(1);

    // «видео» не должно ловиться триггером «вид»: сравниваем по словам, а не по вхождению
    await http$.patch(`/api/anthill/responses/${resp.id}`).set(O).send({ trigger: 'вид' }).expect(200);
    const other = (await http$.post(`/api/chats/${self.id}/ai`).set(O).send({ question: 'а где видео с мита?' }).expect(201)).body.data;
    expect(other.body).not.toBe(answer);

    // выключённый ответ не срабатывает
    await http$.patch(`/api/anthill/responses/${resp.id}`).set(O).send({ trigger: 'vpn', enabled: false }).expect(200);
    const off = (await http$.post(`/api/chats/${self.id}/ai`).set(O).send({ question: 'где vpn?' }).expect(201)).body.data;
    expect(off.body).not.toBe(answer);

    // рядовому сотруднику быстрые ответы не заводить: они звучат от имени компании
    const mateEmail = `ab6m_${uniq()}@t.test`;
    await http$.post('/api/users').set(O).send({ email: mateEmail, fullName: 'Глеб', password: 'password123', role: 'member' }).expect(201);
    const M = H((await http$.post('/api/auth/login').send({ email: mateEmail, password: 'password123' }).expect(201)).body.data.accessToken);
    await http$.get('/api/anthill/responses').set(M).expect(403);
    await http$.post('/api/anthill/responses').set(M).send({ trigger: 'что-то', answer: 'ответ' }).expect(403);

    await http$.delete(`/api/anthill/responses/${resp.id}`).set(O).expect(200);
  });

  it('документ: собирается в файл, уходит в «Заметки» и убирается откатом', async () => {
    const owner = (await http$.post('/api/auth/register')
      .send({ tenantName: 'AB7', email: `ab7_${uniq()}@t.test`, password: 'password123', fullName: 'Сергей' }).expect(201)).body.data;
    const O = H(owner.accessToken);
    const session = (await http$.post('/api/anthill/sessions').set(O).send({}).expect(201)).body.data;

    const action = await repo.createAction({
      tenantId: String(owner.user.tenantId), sessionId: String(session.id), userId: String(owner.user.id),
      tool: 'create_document',
      input: {
        title: 'Отчёт за неделю', format: 'txt', target: 'notes',
        content: 'Сделано: три задачи.\nВ работе: две.\nРиски: нет.',
      },
    });

    const self = (await http$.post('/api/chats/self').set(O).expect(201)).body.data;
    const before = (await http$.get(`/api/chats/${self.id}/messages`).set(O).expect(200)).body.data.length;

    const done = (await http$.post(`/api/anthill/actions/${action.id}/confirm`).set(O).expect(201)).body.data;
    expect(done.status).toBe('done');
    expect(done.text).toContain('Отчёт за неделю.txt');

    const after = (await http$.get(`/api/chats/${self.id}/messages`).set(O).expect(200)).body.data;
    expect(after.length).toBe(before + 1);
    const message = after[after.length - 1];
    expect(message.file_id).toBeTruthy();
    // файл настоящий: его можно скачать, и внутри то, что собрали
    const dl = await http$.get(`/api/files/${message.file_id}`).set(O).expect(200);
    expect(dl.text || String(dl.body)).toContain('Сделано: три задачи.');

    // откат убирает документ из переписки; сам файл остаётся в хранилище — живая
    // ссылка на исчезнувший файл хуже, чем осиротевший объект
    await http$.post(`/api/anthill/actions/${action.id}/undo`).set(O).expect(201);
    const left = (await http$.get(`/api/chats/${self.id}/messages`).set(O).expect(200)).body.data;
    expect(left.some((m: any) => String(m.id) === String(message.id))).toBe(false);
  });

  it('правка задачи: срок и исполнитель меняются только после «Создать» и возвращаются откатом', async () => {
    const owner = (await http$.post('/api/auth/register')
      .send({ tenantName: 'AB8', email: `ab8_${uniq()}@t.test`, password: 'password123', fullName: 'Сергей' }).expect(201)).body.data;
    const O = H(owner.accessToken);
    const mateEmail = `ab8m_${uniq()}@t.test`;
    const mate = (await http$.post('/api/users').set(O)
      .send({ email: mateEmail, fullName: 'Глеб Соколов', password: 'password123', role: 'member' }).expect(201)).body.data;

    const project = (await http$.post('/api/projects').set(O).send({ name: 'Панорама' }).expect(201)).body.data;
    const board = (await http$.get(`/api/projects/${project.id}/board`).set(O).expect(200)).body.data;
    const task = (await http$.post('/api/tasks').set(O).send({
      projectId: project.id, columnId: board.columns[0].id, title: 'Свести смету',
      assigneeId: String(owner.user.id), priority: 'normal',
    }).expect(201)).body.data;

    const session = (await http$.post('/api/anthill/sessions').set(O).send({}).expect(201)).body.data;
    const deadline = new Date(Date.now() + 5 * 86400_000).toISOString();
    const action = await repo.createAction({
      tenantId: String(owner.user.tenantId), sessionId: String(session.id), userId: String(owner.user.id),
      tool: 'update_task',
      input: { taskId: String(task.id), assigneeId: String(mate.id), priority: 'high', deadline },
    });

    // отдельной ручки «дай задачу» нет — читаем её с доски, как это делает экран
    const fromBoard = async () => {
      const b = (await http$.get(`/api/projects/${project.id}/board`).set(O).expect(200)).body.data;
      return b.columns.flatMap((c: any) => c.tasks).find((t: any) => String(t.id) === String(task.id));
    };

    // до подтверждения задача не тронута
    let card = await fromBoard();
    expect(String(card.assignee_id)).toBe(String(owner.user.id));
    expect(card.priority).toBe('normal');

    await http$.post(`/api/anthill/actions/${action.id}/confirm`).set(O).expect(201);
    card = await fromBoard();
    expect(String(card.assignee_id)).toBe(String(mate.id));
    expect(card.priority).toBe('high');
    expect(card.deadline_at).toBeTruthy();

    // откат возвращает ровно прежнее: и человека, и приоритет, и пустой срок
    await http$.post(`/api/anthill/actions/${action.id}/undo`).set(O).expect(201);
    card = await fromBoard();
    expect(String(card.assignee_id)).toBe(String(owner.user.id));
    expect(card.priority).toBe('normal');
    expect(card.deadline_at).toBeNull();
  });
});
