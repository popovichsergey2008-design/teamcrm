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

    const conv = (await http.post('/api/support/desk/messages').set(M)
      .send({
        text: 'Задача не сохраняется, жму «Сохранить» — ничего',
        context: { url: 'https://anthill.team/projects/3/task/9', route: 'projects', entityType: 'task', entityId: '9', browser: 'Chrome 141', os: 'Windows', lastError: 'PATCH /api/tasks/9 500' },
      }).expect(201)).body.data;
    await http.post(`/api/support/desk/${conv.id}/join`).set(O).expect(201);

    // инженер приходит в ТОТ ЖЕ разговор: объяснять второй раз не нужно
    const withEngineer = (await http.post(`/api/support/desk/${conv.id}/engineer`).set(O)
      .send({ userId: String(mate.id) }).expect(201)).body.data;
    expect(withEngineer.participants.some((p: any) => p.role === 'engineer')).toBe(true);

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

  it('сводка службы заботы — для руководства', async () => {
    const { O, M } = await team('SD5');
    await http.post('/api/support/desk/messages').set(M).send({ text: 'Не открывается отчёт' }).expect(201);

    const d = (await http.get('/api/support/desk/dashboard').set(O).expect(200)).body.data;
    expect(d.total).toBeGreaterThanOrEqual(1);
    expect(d.active).toBeGreaterThanOrEqual(1);
    // сотруднику сводка не положена: это управленческие цифры
    await http.get('/api/support/desk/dashboard').set(M).expect(403);
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
