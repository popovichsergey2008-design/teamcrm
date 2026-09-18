import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AddressInfo } from 'net';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { AllExceptionsFilter } from '../src/common/http/all-exceptions.filter';
import { ResponseInterceptor } from '../src/common/http/response.interceptor';
import { RedisIoAdapter } from '../src/common/auth/redis-io.adapter';
import { PlatformService } from '../src/modules/platform/platform.service';

/**
 * Служба заботы (ТЗ-8, MVP 1).
 *
 * Проверяем не «ручки отвечают», а обещания продукта: разговор заводится сам,
 * человека зовут одной просьбой, специалист видит очередь и подключается, закрыть
 * разговор может только тот, кто обратился, и чужие обращения не читаются.
 */
describe('служба заботы (e2e)', () => {
  let app: INestApplication;
  let http: any;
  let platform: PlatformService;
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
    platform = app.get(PlatformService);
  });
  afterAll(async () => { await app?.close(); });

  /** Владелец (он же дежурный по умолчанию) и сотрудник, которому нужна помощь. */
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

  it('разговор заводится сам, человек зовётся просьбой, закрывает его только автор', async () => {
    const { owner, M, O } = await team('SD');

    // до обращения панель пуста, но уже знает, кто дежурит
    const empty = (await http.get('/api/support/desk').set(M).expect(200)).body.data;
    expect(empty.conversation).toBeNull();
    expect(empty.isAgent).toBe(false);

    // первое сообщение — и разговор уже есть, без анкеты и выбора категории
    const first = (await http.post('/api/support/desk/messages').set(M)
      .send({
        text: 'Не сохраняется задача на доске',
        context: { url: 'https://anthill.team/projects/1', route: 'projects', entityType: 'task', entityId: '7', browser: 'Chrome 141', os: 'Windows' },
      })
      .expect(201)).body.data;
    expect(first.id).toBeTruthy();
    expect(first.messages[0].body).toBe('Не сохраняется задача на доске');
    // технический контекст сохранён — специалисту не придётся спрашивать «а где вы были»
    expect(first.context.route).toBe('projects');
    expect(first.context.entity_id).toBe('7');

    // просьба о человеке слышна по словам, без нажатия кнопки
    const asked = (await http.post('/api/support/desk/messages').set(M)
      .send({ text: 'позовите человека' }).expect(201)).body.data;
    expect(asked.status).toBe('waiting_agent');
    expect(asked.statusText).toBe('Ищем свободного специалиста');

    // владелец — дежурный по умолчанию: видит очередь и берёт разговор
    const queue = (await http.get('/api/support/desk/queue').set(O).expect(200)).body.data;
    expect(queue.some((c: any) => String(c.id) === String(first.id))).toBe(true);
    const joined = (await http.post(`/api/support/desk/${first.id}/join`).set(O).expect(201)).body.data;
    expect(joined.status).toBe('in_progress');
    expect(String(joined.agentId)).toBe(String(owner.user.id));

    // ответ специалиста фиксирует первый ответ — по нему считается SLA
    const replied = (await http.post(`/api/support/desk/${first.id}/reply`).set(O)
      .send({ text: 'Вижу проблему, чиню' }).expect(201)).body.data;
    expect(replied.firstResponseAt).toBeTruthy();

    // «решено» НЕ закрывает разговор: он ждёт слова человека
    const waiting = (await http.post(`/api/support/desk/${first.id}/resolve`).set(O)
      .send({ text: 'Поправил, проверьте' }).expect(201)).body.data;
    expect(waiting.status).toBe('waiting_user');
    expect(waiting.closedAt).toBeNull();

    // специалист закрыть за человека не может
    await http.post(`/api/support/desk/${first.id}/confirm`).set(O).send({ ok: true }).expect(403);

    // «нет, не помогло» возвращает разговор в работу
    const back = (await http.post(`/api/support/desk/${first.id}/confirm`).set(M)
      .send({ ok: false }).expect(201)).body.data;
    expect(back.status).toBe('in_progress');
    expect(back.reopens).toBe(1);

    // и только «да» закрывает — вместе с оценкой
    const closed = (await http.post(`/api/support/desk/${first.id}/confirm`).set(M)
      .send({ ok: true, csat: 4 }).expect(201)).body.data;
    expect(closed.status).toBe('closed');
    expect(closed.csat).toBe(4);

    // закрытый разговор уходит в историю, живого больше нет
    const after = (await http.get('/api/support/desk').set(M).expect(200)).body.data;
    expect(after.conversation).toBeNull();
    expect(after.history[0].id).toBe(String(first.id));
    expect(after.history[0].statusText).toBe('Готово');

    // «проблема снова появилась» — тот же разговор со всей прошлой перепиской
    const again = (await http.post(`/api/support/desk/${first.id}/reopen`).set(M)
      .send({ text: 'Снова не сохраняется' }).expect(201)).body.data;
    expect(again.closedAt).toBeNull();
    expect(again.messages.length).toBeGreaterThan(5);
  }, 60000);

  it('инженер входит в тот же разговор, баг уносит контекст, фикс возвращается вестью', async () => {
    const { mate, O, M } = await team('SD4');
    // инженер — ТРЕТИЙ человек: автора обращения звать инженером незачем, он и так здесь
    const engEmail = `sd4_e_${uniq()}@t.test`;
    const engineer = (await http.post('/api/users').set(O)
      .send({ email: engEmail, fullName: 'Юрий Инженер', password: 'password123', role: 'member' })
      .expect(201)).body.data;

    const conv = (await http.post('/api/support/desk/messages').set(M)
      .send({
        text: 'Задача не сохраняется, жму «Сохранить» — ничего',
        context: { url: 'https://anthill.team/projects/3/task/9', route: 'projects', entityType: 'task', entityId: '9', browser: 'Chrome 141', os: 'Windows', lastError: 'PATCH /api/tasks/9 500' },
      }).expect(201)).body.data;
    await http.post(`/api/support/desk/${conv.id}/join`).set(O).expect(201);

    // инженер приходит в ТОТ ЖЕ разговор: объяснять второй раз не нужно
    const withEngineer = (await http.post(`/api/support/desk/${conv.id}/engineer`).set(O)
      .send({ userId: String(engineer.id) }).expect(201)).body.data;
    expect(withEngineer.participants.some((p: any) => p.role === 'engineer')).toBe(true);
    // автор обращения остаётся автором: его инженером не зовут
    await http.post(`/api/support/desk/${conv.id}/engineer`).set(O)
      .send({ userId: String(mate.id) }).expect(400);

    // баг заводится из разговора и уносит контекст с собой
    const bug = (await http.post(`/api/support/desk/${conv.id}/bug`).set(O)
      .send({ title: 'Задача не сохраняется' }).expect(201)).body.data;
    expect(bug.taskId).toBeTruthy();
    const task = (await http.get(`/api/projects/${bug.projectId}/board`).set(O).expect(200)).body.data
      .columns.flatMap((c: any) => c.tasks).find((t: any) => String(t.id) === String(bug.taskId));
    expect(task.description).toContain('PATCH /api/tasks/9 500');
    expect(task.description).toContain('Chrome 141');
    expect(task.description).toContain(`Обращение №${conv.id}`);

    // диагностика собрана для специалиста в одном месте
    const diag = (await http.get(`/api/support/desk/${conv.id}/diagnostics`).set(O).expect(200)).body.data;
    expect(diag.context.route).toBe('projects');
    expect(diag.issues.some((i: any) => String(i.taskId) === String(bug.taskId))).toBe(true);

    // задачу закрыли — человеку приходит весть об исправлении, разговор ждёт проверки
    const board = (await http.get(`/api/projects/${bug.projectId}/board`).set(O).expect(200)).body.data;
    const done = board.columns.find((c: any) => /готов/i.test(c.name)) ?? board.columns[board.columns.length - 1];
    await http.post(`/api/tasks/${bug.taskId}/move`).set(O).send({ columnId: String(done.id), position: 0 }).expect(201);
    await new Promise((r) => setTimeout(r, 400)); // весть уходит следом за закрытием

    const after = (await http.get(`/api/support/desk/${conv.id}`).set(M).expect(200)).body.data;
    expect(after.messages.some((m: any) => /выпустили исправление/i.test(m.body))).toBe(true);
    expect(after.status).toBe('waiting_user');
  }, 60000);

  it('действие делается только с разрешения человека и откатывается', async () => {
    const { O, M } = await team('SD6');
    const proj = (await http.post('/api/projects').set(O).send({ name: 'Работа' }).expect(201)).body.data;
    const board = (await http.get(`/api/projects/${proj.id}/board`).set(O).expect(200)).body.data;
    const task = (await http.post('/api/tasks').set(O)
      .send({ projectId: proj.id, columnId: board.columns[0].id, title: 'Отчёт' }).expect(201)).body.data;

    const conv = (await http.post('/api/support/desk/messages').set(M)
      .send({ text: 'Не могу поставить срок задаче' }).expect(201)).body.data;
    await http.post(`/api/support/desk/${conv.id}/join`).set(O).expect(201);

    // специалист ПРЕДЛАГАЕТ — и пока ничего не происходит
    const when = new Date(Date.now() + 3 * 864e5).toISOString();
    const proposed = (await http.post(`/api/support/desk/${conv.id}/actions`).set(O)
      .send({ kind: 'task.deadline', entityId: String(task.id), value: when }).expect(201)).body.data;
    const action = proposed.actions[proposed.actions.length - 1];
    expect(action.status).toBe('proposed');
    expect(action.preview).toContain('Отчёт');
    const still = (await http.get(`/api/projects/${proj.id}/board`).set(O).expect(200)).body.data
      .columns.flatMap((c: any) => c.tasks).find((t: any) => String(t.id) === String(task.id));
    expect(still.deadline_at).toBeNull();

    // разрешить может только тот, кто обратился
    await http.post(`/api/support/desk/${conv.id}/actions/${action.id}`).set(O).send({ allow: true }).expect(403);

    const done = (await http.post(`/api/support/desk/${conv.id}/actions/${action.id}`).set(M)
      .send({ allow: true }).expect(201)).body.data;
    expect(done.actions[done.actions.length - 1].status).toBe('done');
    const after = (await http.get(`/api/projects/${proj.id}/board`).set(O).expect(200)).body.data
      .columns.flatMap((c: any) => c.tasks).find((t: any) => String(t.id) === String(task.id));
    expect(new Date(after.deadline_at).toISOString()).toBe(when);

    // и возвращается как было
    await http.post(`/api/support/desk/${conv.id}/actions/${action.id}/undo`).set(M).expect(201);
    const back = (await http.get(`/api/projects/${proj.id}/board`).set(O).expect(200)).body.data
      .columns.flatMap((c: any) => c.tasks).find((t: any) => String(t.id) === String(task.id));
    expect(back.deadline_at).toBeNull();
  }, 60000);

  it('известная проблема узнаётся сразу, а массовый сбой доходит до всех', async () => {
    const { O, M } = await team('SD7');
    const proj = (await http.post('/api/projects').set(O).send({ name: 'Баги' }).expect(201)).body.data;
    const board = (await http.get(`/api/projects/${proj.id}/board`).set(O).expect(200)).body.data;
    const bug = (await http.post('/api/tasks').set(O)
      .send({ projectId: proj.id, columnId: board.columns[0].id, title: 'Вложения не грузятся' }).expect(201)).body.data;

    await http.post('/api/support/desk/known').set(O)
      .send({ taskId: String(bug.id), title: 'Вложения не грузятся', pattern: 'вложени, файл не приклад' })
      .expect(201);

    // человек пишет о том же — и узнаёт об этом в первую же минуту
    const conv = (await http.post('/api/support/desk/messages').set(M)
      .send({ text: 'У меня вложения не открываются в задаче' }).expect(201)).body.data;
    expect(conv.messages.some((m: any) => /известную проблему/i.test(m.body))).toBe(true);
    expect(conv.messages.some((m: any) => m.body.includes(`#${bug.id}`))).toBe(true);

    // массовый сбой: сообщение доходит до открытых разговоров и видно в панели
    await http.post('/api/support/desk/incident').set(O)
      .send({ title: 'Медленно открываются доски', message: 'Мы нашли проблему и уже работаем над исправлением.' })
      .expect(201);
    const desk = (await http.get('/api/support/desk').set(M).expect(200)).body.data;
    expect(desk.incident.title).toBe('Медленно открываются доски');
    expect(desk.conversation.messages.some((m: any) => /уже работаем над исправлением/i.test(m.body))).toBe(true);

    const inc = (await http.get('/api/support/desk').set(O).expect(200)).body.data.incident;
    await http.post(`/api/support/desk/incident/${inc.id}/resolve`).set(O).expect(201);
    const after = (await http.get('/api/support/desk').set(M).expect(200)).body.data;
    expect(after.incident).toBeNull();
    expect(after.conversation.messages.some((m: any) => /^Исправлено/i.test(m.body))).toBe(true);
  }, 60000);

  it('сводка службы заботы — для руководства', async () => {
    const { O, M } = await team('SD5');
    await http.post('/api/support/desk/messages').set(M).send({ text: 'Не открывается отчёт' }).expect(201);

    const d = (await http.get('/api/support/desk/dashboard').set(O).expect(200)).body.data;
    expect(d.total).toBeGreaterThanOrEqual(1);
    expect(d.active).toBeGreaterThanOrEqual(1);
    // сотруднику сводка не положена: это управленческие цифры
    await http.get('/api/support/desk/dashboard').set(M).expect(403);
  }, 30000);

  it('справочник уезжает в базу знаний и не правится руками клиента', async () => {
    const { O, M } = await team('SD6');

    /*
      Справочник по системе — то, из чего отвечает помощник.

      Проверяем обещание, а не факт записи: разделы видно, повторная загрузка не
      плодит копии, а клиент не может ни загрузить его, ни переписать у себя.
    */
    const before = (await http.get('/api/support/desk/handbook/state').set(O).expect(200)).body.data;
    expect(before.sections.length).toBeGreaterThan(0);
    expect(before.loadedAt).toBeNull();
    // сотруднику эта кухня не показывается вовсе
    await http.get('/api/support/desk/handbook/state').set(M).expect(403);

    const loaded = (await http.post('/api/support/desk/handbook/load').set(O).expect(201)).body.data;
    expect(loaded.added).toBe(before.sections.length);
    expect(loaded.loadedAt).not.toBeNull();
    expect(loaded.stale).toBe(false);

    // повтор ничего не переиндексирует: сверяется текст, а не дата файла
    const again = (await http.post('/api/support/desk/handbook/load').set(O).expect(201)).body.data;
    expect(again.added).toBe(0);
    expect(again.updated).toBe(0);
    expect(again.unchanged).toBe(before.sections.length);

    await http.post('/api/support/desk/handbook/load').set(M).expect(403);

    // в базе знаний он системный: правка и удаление запрещены — выкладка всё равно затрёт
    const regs = (await http.get('/api/regulations').set(O).expect(200)).body.data;
    const sys = regs.find((r: any) => String(r.title).startsWith('Справочник ANTHILL'));
    expect(sys).toBeTruthy();
    expect(sys.is_system).toBe(true);
    await http.put(`/api/regulations/${sys.id}`).set(O)
      .send({ title: sys.title, body: 'моя версия' }).expect(403);
    await http.delete(`/api/regulations/${sys.id}`).set(O).expect(403);
  }, 60000);

  /*
    Служба заботы — вендорская.

    Главное обещание этой части: настройки поддержки принадлежат разработчику
    продукта, а клиент их не видит и не трогает. Проверяем обе стороны — что техотдел
    работает с обращениями всех организаций и что чужой клиент к ним не подступится.
  */
  it('поддержку ведёт техотдел вендора: очередь по всем клиентам, клиенту кухня не видна', async () => {
    const vendor = await team('SDV');
    const client = await team('SDC');
    // Организация вендора: отсюда и дальше поддержку ведёт она.
    await platform.declarePlatform(String(vendor.owner.user.tenantId), String(vendor.owner.user.id));

    try {
      // клиент пишет — и обращение попадает в очередь ТЕХОТДЕЛА, а не своей компании
      const conv = (await http.post('/api/support/desk/messages').set(client.M)
        .send({ text: 'Позовите специалиста: не открывается доска' }).expect(201)).body.data;

      const queue = (await http.get('/api/support/desk/queue').set(vendor.O).expect(200)).body.data;
      const row = queue.find((q: any) => String(q.id) === String(conv.id));
      expect(row).toBeTruthy();
      expect(row.orgName).toBeTruthy(); // видно, У КОГО сломалось

      // владелец клиентской организации кухни поддержки больше не видит
      await http.get('/api/support/desk/queue').set(client.O).expect(403);
      await http.get('/api/support/desk/dashboard').set(client.O).expect(403);
      await http.get('/api/support/desk/known/list').set(client.O).expect(403);
      await http.post('/api/support/desk/incident').set(client.O)
        .send({ title: 'Тест', message: 'Тест' }).expect(403);

      // техотдел открывает чужое обращение и отвечает в него
      const seen = (await http.get(`/api/support/desk/${conv.id}`).set(vendor.O).expect(200)).body.data;
      expect(String(seen.id)).toBe(String(conv.id));
      await http.post(`/api/support/desk/${conv.id}/join`).set(vendor.O).expect(201);
      const answered = (await http.post(`/api/support/desk/${conv.id}/reply`).set(vendor.O)
        .send({ text: 'Смотрим, вернусь через пару минут' }).expect(201)).body.data;
      expect(answered.messages.some((m: any) => m.body.includes('Смотрим'))).toBe(true);

      // а посторонняя организация — нет: чужое обращение для неё не существует
      const stranger = await team('SDX');
      await http.get(`/api/support/desk/${conv.id}`).set(stranger.O).expect(404);

      // закрыть его по-прежнему может только тот, кто обратился
      await http.post(`/api/support/desk/${conv.id}/close`).set(vendor.O).send({}).expect(403);
      const closed = (await http.post(`/api/support/desk/${conv.id}/close`).set(client.M)
        .send({}).expect(201)).body.data;
      expect(closed.status).toBe('closed');

      // состав техотдела виден только ему, и берут в него лишь своих
      const staff = (await http.get('/api/platform/staff').set(vendor.O).expect(200)).body.data;
      expect(staff.length).toBeGreaterThanOrEqual(1);
      await http.get('/api/platform/staff').set(client.O).expect(403);
      await http.post('/api/platform/staff').set(vendor.O)
        .send({ userId: String(client.mate.id), active: true }).expect(400);
      await http.post('/api/platform/staff').set(vendor.O)
        .send({ userId: String(vendor.mate.id), active: true }).expect(201);

      // организации-клиенты видны техотделу счётчиками, без единой строки содержимого
      const orgs = (await http.get('/api/platform/tenants').set(vendor.O).expect(200)).body.data;
      expect(Array.isArray(orgs)).toBe(true);
      await http.get('/api/platform/tenants').set(client.O).expect(403);
    } finally {
      // возвращаем систему в прежний вид: платформа — общая на всю базу
      await platform.clearPlatform();
    }
  }, 90000);

  it('«вопрос снят»: человек закрывает свой разговор сам', async () => {
    const { M, O } = await team('SD7');
    const conv = (await http.post('/api/support/desk/messages').set(M)
      .send({ text: 'Не вижу кнопку переноса задачи' }).expect(201)).body.data;

    // чужой разговор так не закрыть
    await http.post(`/api/support/desk/${conv.id}/close`).set(O).send({}).expect(403);

    const closed = (await http.post(`/api/support/desk/${conv.id}/close`).set(M)
      .send({ csat: 4 }).expect(201)).body.data;
    expect(closed.status).toBe('closed');
    // повторное закрытие ничего не ломает
    await http.post(`/api/support/desk/${conv.id}/close`).set(M).send({}).expect(201);

    // вернуться к нему можно: переписка на месте
    const back = (await http.post(`/api/support/desk/${conv.id}/reopen`).set(M).send({}).expect(201)).body.data;
    expect(back.status).not.toBe('closed');
    expect(back.messages.length).toBeGreaterThan(1);
  }, 30000);

  /*
    Этап 1 коммерческой архитектуры: роли техотдела и срочный доступ инженера.

    Проверяем главное обещание раздела 03_RBAC: инженер — не первая линия. Он не видит
    очередь, не может открыть обращение без доступа, получает его на срок и теряет
    после отзыва.
  */
  it('инженер видит только то, куда его позвали, и только пока доступ жив', async () => {
    const vendor = await team('SDE');
    const client = await team('SDEC');
    await platform.declarePlatform(String(vendor.owner.user.tenantId), String(vendor.owner.user.id));

    try {
      // второй человек платформы — инженер
      await http.post('/api/platform/staff').set(vendor.O)
        .send({ userId: String(vendor.mate.id), active: true, role: 'engineer' }).expect(201);

      const conv = (await http.post('/api/support/desk/messages').set(client.M)
        .send({ text: 'Позовите специалиста: не грузится импорт' }).expect(201)).body.data;

      // инженер не видит ни очереди, ни сводки, ни самого обращения
      await http.get('/api/support/desk/queue').set(vendor.M).expect(403);
      await http.get('/api/support/desk/dashboard').set(vendor.M).expect(403);
      await http.get(`/api/support/desk/${conv.id}`).set(vendor.M).expect(404);
      // и настройками службы не распоряжается
      await http.post('/api/support/desk/incident').set(vendor.M)
        .send({ title: 'Тест', message: 'Тест' }).expect(403);

      // зато видит пустой список своих эскалаций
      const empty = (await http.get('/api/support/desk/escalations').set(vendor.M).expect(200)).body.data;
      expect(empty).toEqual([]);

      // дежурный берёт разговор и зовёт инженера
      await http.post(`/api/support/desk/${conv.id}/join`).set(vendor.O).expect(201);
      await http.post(`/api/support/desk/${conv.id}/engineer`).set(vendor.O)
        .send({ userId: String(vendor.mate.id) }).expect(201);

      // теперь обращение открыто — и видно, до какого времени
      const seen = (await http.get(`/api/support/desk/${conv.id}`).set(vendor.M).expect(200)).body.data;
      expect(String(seen.id)).toBe(String(conv.id));
      const mine = (await http.get('/api/support/desk/escalations').set(vendor.M).expect(200)).body.data;
      expect(mine.length).toBe(1);
      expect(mine[0].accessUntil).toBeTruthy();
      // но очередь ему по-прежнему не положена
      await http.get('/api/support/desk/queue').set(vendor.M).expect(403);

      // инженер может ответить в своём разговоре
      await http.post(`/api/support/desk/${conv.id}/reply`).set(vendor.M)
        .send({ text: 'Смотрю логи импорта' }).expect(201);

      // доступ отозвали — обращение снова не существует для него
      await http.post(`/api/support/desk/${conv.id}/engineer/${vendor.mate.id}/revoke`)
        .set(vendor.O).send({}).expect(201);
      await http.get(`/api/support/desk/${conv.id}`).set(vendor.M).expect(404);
      const after = (await http.get('/api/support/desk/escalations').set(vendor.M).expect(200)).body.data;
      expect(after).toEqual([]);

      // а переписка инженера осталась в разговоре: история не переписывается
      const asAgent = (await http.get(`/api/support/desk/${conv.id}`).set(vendor.O).expect(200)).body.data;
      expect(asAgent.messages.some((m: any) => String(m.body).includes('логи импорта'))).toBe(true);
    } finally {
      await platform.clearPlatform();
    }
  }, 90000);

  it('настройки службы — руководителю поддержки, а не всякому в отделе', async () => {
    const vendor = await team('SDR');
    await platform.declarePlatform(String(vendor.owner.user.tenantId), String(vendor.owner.user.id));

    try {
      // первая линия: очередь видит, состав отдела и справочник — нет
      await http.post('/api/platform/staff').set(vendor.O)
        .send({ userId: String(vendor.mate.id), active: true, role: 'support' }).expect(201);
      await http.get('/api/support/desk/queue').set(vendor.M).expect(200);
      await http.get('/api/support/desk/handbook/state').set(vendor.M).expect(403);
      await http.post('/api/platform/staff').set(vendor.M)
        .send({ userId: String(vendor.mate.id), active: false }).expect(403);

      // руководитель поддержки: и очередь, и настройки
      await http.post('/api/platform/staff').set(vendor.O)
        .send({ userId: String(vendor.mate.id), role: 'support_admin' }).expect(201);
      await http.get('/api/support/desk/handbook/state').set(vendor.M).expect(200);

      // роль видна в составе отдела человеческим словом
      const staff = (await http.get('/api/platform/staff').set(vendor.O).expect(200)).body.data;
      const mate = staff.find((x: any) => String(x.userId) === String(vendor.mate.id));
      expect(mate.role).toBe('support_admin');
      expect(mate.roleTitle).toBeTruthy();
    } finally {
      await platform.clearPlatform();
    }
  }, 60000);

  /*
    Этап 2: помощник как первая линия и как копилот.

    Проверяем обещание раздела 02_ANTHILLBOT §7: позвали человека — помощник замолчал,
    даже если специалист ещё не взял разговор. Раньше условием было «агент не назначен»,
    и бот продолжал отвечать поверх уже позванного человека.
  */
  it('позвали человека — помощник молчит, пока его не вернут', async () => {
    const { O, M } = await team('SDA');

    const first = (await http.post('/api/support/desk/messages').set(M)
      .send({ text: 'Позовите специалиста, пожалуйста' }).expect(201)).body.data;
    expect(first.aiMode).toBe('copilot');
    expect(first.status).toBe('waiting_agent');

    // пишем ещё раз, ожидая специалиста: помощник не вмешивается
    const again = (await http.post('/api/support/desk/messages').set(M)
      .send({ text: 'Жду, когда подключитесь' }).expect(201)).body.data;
    expect(again.aiMode).toBe('copilot');

    // специалист может вернуть помощника — но только явным действием
    const back = (await http.post(`/api/support/desk/${first.id}/ai/return`).set(O)
      .send({}).expect(201)).body.data;
    expect(back.aiMode).toBe('agent');
    expect(back.messages.some((m: any) => String(m.body).includes('вернул помощника'))).toBe(true);

    // клиент вернуть помощника не может: это решение специалиста
    await http.post(`/api/support/desk/${first.id}/ai/return`).set(M).send({}).expect(403);
  }, 60000);

  it('часы помощника и человека считаются отдельно', async () => {
    const { O, M } = await team('SDT');
    const conv = (await http.post('/api/support/desk/messages').set(M)
      .send({ text: 'Дайте специалиста' }).expect(201)).body.data;
    // до ответа человека его отметки нет
    expect(conv.firstResponseAt).toBeNull();

    await http.post(`/api/support/desk/${conv.id}/join`).set(O).expect(201);
    const answered = (await http.post(`/api/support/desk/${conv.id}/reply`).set(O)
      .send({ text: 'Здравствуйте, смотрю' }).expect(201)).body.data;
    expect(answered.firstResponseAt).toBeTruthy();

    // в сводке обе цифры живут порознь
    const d = (await http.get('/api/support/desk/dashboard').set(O).expect(200)).body.data;
    expect(d).toHaveProperty('aiResponseSeconds');
    expect(d).toHaveProperty('escalated');
    expect(Number(d.escalated)).toBeGreaterThanOrEqual(1);
  }, 60000);

  /*
    Этап 3: очередь, навыки и назначение.

    Проверяем обещание раздела 05_SCALING §4–§7: обращение не лежит «пока кто-нибудь
    заметит», а уходит дежурному само; перегруженному не достаётся; поправить выбор
    можно руками.
  */
  it('обращение назначается само, а поправить выбор можно руками', async () => {
    const vendor = await team('SDQ');
    const client = await team('SDQC');
    await platform.declarePlatform(String(vendor.owner.user.tenantId), String(vendor.owner.user.id));

    try {
      // в отделе двое: владелец (админ) и первая линия
      await http.post('/api/platform/staff').set(vendor.O)
        .send({ userId: String(vendor.mate.id), active: true, role: 'support', skills: ['imports'] })
        .expect(201);

      const conv = (await http.post('/api/support/desk/messages').set(client.M)
        .send({ text: 'Позовите специалиста: не идёт импорт' }).expect(201)).body.data;

      // обращение уже у кого-то: его не нужно «замечать» в очереди
      const queue = (await http.get('/api/support/desk/queue').set(vendor.O).expect(200)).body.data;
      const row = queue.find((q: any) => String(q.id) === String(conv.id));
      expect(row).toBeTruthy();
      expect(row.agentId).toBeTruthy();

      // и видно, почему он у этого человека
      const diag = (await http.get(`/api/support/desk/${conv.id}/diagnostics`).set(vendor.O).expect(200)).body.data;
      expect(diag.routing.length).toBeGreaterThanOrEqual(1);
      expect(diag.sla.queuedAt).toBeTruthy();
      expect(diag.sla.assignedAt).toBeTruthy();

      // «ничьи» его больше не показывают
      const free = (await http.get('/api/support/desk/queue?assigned=none').set(vendor.O).expect(200)).body.data;
      expect(free.some((q: any) => String(q.id) === String(conv.id))).toBe(false);

      // выбор поправим руками: возвращаем в очередь и назначаем на другого
      await http.post(`/api/support/desk/${conv.id}/unassign`).set(vendor.O).send({}).expect(201);
      const back = (await http.get('/api/support/desk/queue').set(vendor.O).expect(200)).body.data;
      expect(back.find((q: any) => String(q.id) === String(conv.id))).toBeTruthy();

      const assigned = (await http.post(`/api/support/desk/${conv.id}/assign`).set(vendor.O)
        .send({ agentId: String(vendor.mate.id) }).expect(201)).body.data;
      expect(String(assigned.agentId)).toBe(String(vendor.mate.id));

      // «мои» у назначенного его видят, а у другого — нет
      const mine = (await http.get('/api/support/desk/queue?assigned=me').set(vendor.M).expect(200)).body.data;
      expect(mine.some((q: any) => String(q.id) === String(conv.id))).toBe(true);
      const notMine = (await http.get('/api/support/desk/queue?assigned=me').set(vendor.O).expect(200)).body.data;
      expect(notMine.some((q: any) => String(q.id) === String(conv.id))).toBe(false);
    } finally {
      await platform.clearPlatform();
    }
  }, 90000);

  it('перегруженному дежурному новые обращения не назначаются', async () => {
    const vendor = await team('SDL');
    const client = await team('SDLC');
    await platform.declarePlatform(String(vendor.owner.user.tenantId), String(vendor.owner.user.id));

    try {
      // единственный дежурный тянет ровно один разговор
      await http.post('/api/platform/staff').set(vendor.O)
        .send({ userId: String(vendor.owner.user.id), maxConversations: 1 }).expect(201);

      const first = (await http.post('/api/support/desk/messages').set(client.M)
        .send({ text: 'Позовите специалиста, первая беда' }).expect(201)).body.data;
      expect(first.agentId).toBeTruthy();

      // второй человек той же компании пишет своё обращение — свободных нет
      const second = (await http.post('/api/support/desk/messages').set(client.O)
        .send({ text: 'Позовите специалиста, вторая беда' }).expect(201)).body.data;
      expect(second.agentId).toBeNull();

      // но оно видно в очереди как ничьё: проблема на виду, а не спрятана
      const free = (await http.get('/api/support/desk/queue?assigned=none').set(vendor.O).expect(200)).body.data;
      expect(free.some((q: any) => String(q.id) === String(second.id))).toBe(true);
    } finally {
      await platform.clearPlatform();
    }
  }, 90000);

  /*
    Этап 4: созвон по просьбе и согласию.

    Главное обещание раздела 04_SUPPORT_HUDDLE §2: нажатие на трубку никому не звонит.
    Вторая сторона решает сама, удобно ли ей сейчас, и отказ — обычный ответ, а не сбой.
  */
  it('созвон не начинается без согласия второй стороны', async () => {
    const { O, M } = await team('SDH');
    const conv = (await http.post('/api/support/desk/messages').set(M)
      .send({ text: 'Позовите специалиста' }).expect(201)).body.data;
    await http.post(`/api/support/desk/${conv.id}/join`).set(O).expect(201);

    // специалист предлагает созвон — комнаты пока нет, есть просьба
    const asked = (await http.post(`/api/support/desk/${conv.id}/call/request`).set(O)
      .send({}).expect(201)).body.data;
    expect(asked.call).toBeTruthy();
    expect(asked.call.byRole).toBe('agent');
    expect(asked.messages.some((m: any) => String(m.body).includes('предлагает созвониться'))).toBe(true);

    // сам себе принять созвон нельзя: соглашается вторая сторона
    await http.post(`/api/support/desk/${conv.id}/call/accept`).set(O)
      .send({ roomId: 'room-1' }).expect(400);

    // человек отказывается — это обычное состояние, разговор продолжается
    const declined = (await http.post(`/api/support/desk/${conv.id}/call/decline`).set(M)
      .send({}).expect(201)).body.data;
    expect(declined.call).toBeNull();
    expect(declined.messages.some((m: any) => String(m.body).includes('сейчас неудобно'))).toBe(true);
    // отказ закрыл просьбу: принять её задним числом уже нельзя
    await http.post(`/api/support/desk/${conv.id}/call/accept`).set(M)
      .send({ roomId: 'room-1' }).expect(409);

    // теперь просит человек, соглашается специалист — и только тут появляется комната
    const again = (await http.post(`/api/support/desk/${conv.id}/call/request`).set(M)
      .send({}).expect(201)).body.data;
    expect(again.call.byRole).toBe('user');

    const started = (await http.post(`/api/support/desk/${conv.id}/call/accept`).set(O)
      .send({ roomId: 'room-42', joinUrl: 'https://anthill.team/meet/token' }).expect(201)).body.data;
    expect(started.call).toBeNull();
    expect(started.messages.some((m: any) => String(m.body).includes('meet/token'))).toBe(true);
    // и о записи предупредили в самом разговоре, а не галочкой
    expect(started.messages.some((m: any) => String(m.body).includes('может записываться'))).toBe(true);
  }, 60000);

  /*
    Этап 5: статусы, лента событий и внутренние заметки.

    Главные обещания: статус отвечает на вопрос «что сейчас» без чтения переписки,
    недопустимый переход отклоняется словами, а заметка для своих не уходит клиенту ни
    одним путём.
  */
  it('состояния переключаются по правилам, а недопустимое — отклоняется словами', async () => {
    const { O, M } = await team('SDS');
    const conv = (await http.post('/api/support/desk/messages').set(M)
      .send({ text: 'Позовите специалиста' }).expect(201)).body.data;
    await http.post(`/api/support/desk/${conv.id}/join`).set(O).expect(201);

    // дежурный передаёт инженерам и отмечает починку
    const esc = (await http.post(`/api/support/desk/${conv.id}/status`).set(O)
      .send({ to: 'engineer_escalated' }).expect(201)).body.data;
    expect(esc.status).toBe('engineer_escalated');
    expect(esc.statusText).toBe('Разбираются инженеры');

    const fixing = (await http.post(`/api/support/desk/${conv.id}/status`).set(O)
      .send({ to: 'fix_in_progress' }).expect(201)).body.data;
    expect(fixing.status).toBe('fix_in_progress');

    // клиент не может закрыть обращение через переход статуса мимо подтверждения…
    const denied = await http.post(`/api/support/desk/${conv.id}/status`).set(O)
      .send({ to: 'closed' }).expect(409);
    expect(String(denied.body.error.message)).toContain('только тот, кто обратился');

    // …и специалист не может перевести в состояние, которого из текущего не бывает
    await http.post(`/api/support/desk/${conv.id}/status`).set(O)
      .send({ to: 'ai' }).expect(409);

    // лента событий рассказывает историю обращения
    const tl = (await http.get(`/api/support/desk/${conv.id}/timeline`).set(O).expect(200)).body.data;
    expect(tl.events.length).toBeGreaterThanOrEqual(3);
    expect(tl.events.some((e: any) => e.kind === 'conversation.created')).toBe(true);
    expect(tl.events.some((e: any) => e.kind === 'agent.assigned')).toBe(true);
    // и участники видны отдельной ручкой
    const parts = (await http.get(`/api/support/desk/${conv.id}/participants`).set(O).expect(200)).body.data;
    expect(parts.length).toBeGreaterThanOrEqual(2);
  }, 60000);

  it('заметка для своих не уходит клиенту ни одним путём', async () => {
    const { O, M } = await team('SDN');
    const conv = (await http.post('/api/support/desk/messages').set(M)
      .send({ text: 'Позовите специалиста' }).expect(201)).body.data;
    await http.post(`/api/support/desk/${conv.id}/join`).set(O).expect(201);

    const secret = 'внутреннее: у них старая сборка, сказать мягко';
    const notes = (await http.post(`/api/support/desk/${conv.id}/notes`).set(O)
      .send({ text: secret }).expect(201)).body.data;
    expect(notes.length).toBe(1);

    // клиенту заметки не отдаются вовсе
    await http.get(`/api/support/desk/${conv.id}/notes`).set(M).expect(403);
    // и в самом разговоре её нет — ни в сообщениях, ни в любом другом поле
    const seen = (await http.get(`/api/support/desk/${conv.id}`).set(M).expect(200)).body.data;
    expect(JSON.stringify(seen)).not.toContain('старая сборка');
  }, 60000);

  it('чужое обращение не прочитать', async () => {
    const a = await team('SD2');
    const b = await team('SD3');
    const conv = (await http.post('/api/support/desk/messages').set(a.M)
      .send({ text: 'Не открывается отчёт' }).expect(201)).body.data;

    // из другой организации — вообще не существует
    await http.get(`/api/support/desk/${conv.id}`).set(b.M).expect(404);
  }, 30000);
});
