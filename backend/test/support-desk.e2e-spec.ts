import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AddressInfo } from 'net';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { AllExceptionsFilter } from '../src/common/http/all-exceptions.filter';
import { ResponseInterceptor } from '../src/common/http/response.interceptor';
import { RedisIoAdapter } from '../src/common/auth/redis-io.adapter';

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

  it('дежурного назначают галочкой, справочник уезжает в базу знаний', async () => {
    const { O, M, mate } = await team('SD6');

    // выбирать дежурного есть из кого: вся команда с отметкой
    const picker = (await http.get('/api/support/desk/team/picker').set(O).expect(200)).body.data;
    expect(picker.some((p: any) => String(p.userId) === String(mate.id))).toBe(true);
    expect(picker.every((p: any) => p.onDuty === false)).toBe(true);
    // сотруднику назначать дежурных не положено
    await http.get('/api/support/desk/team/picker').set(M).expect(403);

    // назначили — и человек стал дежурным: видит очередь
    await http.post('/api/support/desk/team').set(O)
      .send({ userId: String(mate.id), active: true, skills: ['доски'] }).expect(201);
    const team2 = (await http.get('/api/support/desk/team/list').set(O).expect(200)).body.data;
    expect(team2.some((t: any) => String(t.userId) === String(mate.id))).toBe(true);
    await http.get('/api/support/desk/queue').set(M).expect(200);

    // сняли — очередь снова не его дело
    await http.post('/api/support/desk/team').set(O)
      .send({ userId: String(mate.id), active: false }).expect(201);

    /*
      Справочник по системе — то, из чего отвечает помощник.

      Проверяем обещание, а не факт записи: разделы видно, повторная загрузка не
      плодит копии, а сотрудник справочник не загружает.
    */
    const before = (await http.get('/api/support/desk/handbook/state').set(M).expect(200)).body.data;
    expect(before.sections.length).toBeGreaterThan(0);
    expect(before.loadedAt).toBeNull();

    const loaded = (await http.post('/api/support/desk/handbook/load').set(O).expect(201)).body.data;
    expect(loaded.added).toBe(before.sections.length);
    expect(loaded.loadedAt).not.toBeNull();
    expect(loaded.stale).toBe(false);

    const again = (await http.post('/api/support/desk/handbook/load').set(O).expect(201)).body.data;
    expect(again.added).toBe(0);
    expect(again.updated).toBe(before.sections.length);

    await http.post('/api/support/desk/handbook/load').set(M).expect(403);
  }, 60000);

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

  it('чужое обращение не прочитать', async () => {
    const a = await team('SD2');
    const b = await team('SD3');
    const conv = (await http.post('/api/support/desk/messages').set(a.M)
      .send({ text: 'Не открывается отчёт' }).expect(201)).body.data;

    // из другой организации — вообще не существует
    await http.get(`/api/support/desk/${conv.id}`).set(b.M).expect(404);
  }, 30000);
});
