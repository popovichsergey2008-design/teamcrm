import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AddressInfo } from 'net';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { AllExceptionsFilter } from '../src/common/http/all-exceptions.filter';
import { ResponseInterceptor } from '../src/common/http/response.interceptor';
import { RedisIoAdapter } from '../src/common/auth/redis-io.adapter';
import { RecurrenceScheduler } from '../src/modules/tasks/recurrence.scheduler';

/**
 * Регулярные задачи.
 *
 * Проверяем не «ручка отвечает», а два правила, ради которых всё и делалось:
 * 1) по расписанию появляется КОПИЯ образца — со сроком, исполнителем и чек-листом;
 * 2) НЕ ПЛОДИТЬ: пока прежняя задача не закрыта, новая не создаётся — у старой
 *    сдвигается срок. Второе и есть решение заказчика; без него доска к концу месяца
 *    забивается одинаковыми копиями.
 *
 * Время не ждём: планировщику передаём будущий момент — он и есть его «сейчас».
 */
describe('регулярные задачи (e2e)', () => {
  let app: INestApplication;
  let http: any;
  const uniq = () => Math.random().toString(36).slice(2) + Date.now().toString(36);
  const H = (t: string) => ({ Authorization: `Bearer ${t}` });
  const DAY = 24 * 3600_000;

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

  const setup = async () => {
    const owner = (await http.post('/api/auth/register')
      .send({ tenantName: 'Rec', email: `rec_${uniq()}@t.test`, password: 'password123', fullName: 'Ольга Владелец' })
      .expect(201)).body.data;
    const project = (await http.post('/api/projects').set(H(owner.accessToken))
      .send({ name: `Проект ${uniq()}` }).expect(201)).body.data;
    const task = (await http.post('/api/tasks').set(H(owner.accessToken))
      .send({
        projectId: project.id,
        title: 'Отчёт за неделю',
        assigneeId: owner.user.id,
        checklist: ['Собрать цифры', 'Свести таблицу'],
        requiresApproval: false,
      }).expect(201)).body.data;
    return { owner, project, task };
  };

  const board = async (token: string, projectId: string) =>
    (await http.get(`/api/projects/${projectId}/board`).set(H(token)).expect(200)).body.data;

  const allTasks = (b: any) => b.columns.flatMap((c: any) => c.tasks);

  it('кривое расписание отвергается, а не чинится молча', async () => {
    const { owner, task } = await setup();
    // «еженедельно» без дней недели формально корректно, но работать не может
    await http.put(`/api/tasks/${task.id}/recurrence`).set(H(owner.accessToken))
      .send({ freq: 'weekly', weekdays: [], atTime: '10:00' }).expect(400);
    await http.put(`/api/tasks/${task.id}/recurrence`).set(H(owner.accessToken))
      .send({ freq: 'daily', atTime: 'утром' }).expect(400);
    expect((await http.get(`/api/tasks/${task.id}/recurrence`).set(H(owner.accessToken)).expect(200)).body.data)
      .toBeNull();
  });

  it('по расписанию появляется копия — со сроком, исполнителем и чек-листом', async () => {
    const { owner, project, task } = await setup();

    const saved = (await http.put(`/api/tasks/${task.id}/recurrence`).set(H(owner.accessToken))
      .send({ freq: 'daily', atTime: '10:00', tz: 'Europe/Moscow' }).expect(200)).body.data;
    expect(saved.description).toBe('каждый день в 10:00');
    expect(new Date(saved.nextRunAt).getTime()).toBeGreaterThan(Date.now());

    // задача-образец помечена повтором — значок на карточке берётся отсюда
    const before = allTasks(await board(owner.accessToken, project.id));
    expect(before).toHaveLength(1);
    expect(String(before[0].recurrence_id)).toBe(String(saved.id));

    // ЗАКРЫВАЕМ образец: только тогда повтор вправе создать следующую.
    // confirmGate — как в карточке: у задачи есть незакрытый чек-лист, и приёмка
    // работы законно спрашивает, точно ли сдаём не доделав.
    const b = await board(owner.accessToken, project.id);
    const done = b.columns[b.columns.length - 1];
    await http.post(`/api/tasks/${task.id}/move`).set(H(owner.accessToken))
      .send({ columnId: done.id, position: 0, confirmGate: true }).expect(201);

    const scheduler = app.get(RecurrenceScheduler);
    // счётчик прохода не проверяем: база общая, и в ней могут ждать чужие расписания
    await scheduler.tick(new Date(Date.now() + 2 * DAY));

    const after = allTasks(await board(owner.accessToken, project.id));
    expect(after).toHaveLength(2);
    const copy = after.find((t: any) => String(t.id) !== String(task.id));
    expect(copy.title).toBe('Отчёт за неделю');
    expect(String(copy.assignee_id)).toBe(String(owner.user.id));
    expect(copy.deadline_at).toBeTruthy();
    expect(String(copy.recurrence_id)).toBe(String(saved.id));
    // чек-лист переезжает в копию несделанным: рутина повторяется целиком
    const checklist = (await http.get(`/api/tasks/${copy.id}/checklist`).set(H(owner.accessToken)).expect(200)).body.data;
    expect(checklist.map((i: any) => i.text)).toEqual(['Собрать цифры', 'Свести таблицу']);
    expect(checklist.every((i: any) => !i.is_done)).toBe(true);
  });

  it('НЕ ПЛОДИТ: прежняя задача не закрыта — сдвигается её срок', async () => {
    const { owner, project, task } = await setup();
    await http.put(`/api/tasks/${task.id}/recurrence`).set(H(owner.accessToken))
      .send({ freq: 'daily', atTime: '10:00', tz: 'Europe/Moscow' }).expect(200);

    const scheduler = app.get(RecurrenceScheduler);
    // образец жив и не закрыт — копии быть не должно
    await scheduler.tick(new Date(Date.now() + 2 * DAY));

    const tasks = allTasks(await board(owner.accessToken, project.id));
    expect(tasks).toHaveLength(1);
    // срок при этом наступал и виден: пропуск не прячется
    expect(tasks[0].deadline_at).toBeTruthy();

    // и в истории задачи это записано
    const history = (await http.get(`/api/tasks/${task.id}/activity`).set(H(owner.accessToken)).expect(200)).body.data;
    expect(history.some((h: any) => h.kind === 'recurrence_shifted')).toBe(true);
  });

  it('снятый повтор больше не срабатывает', async () => {
    const { owner, project, task } = await setup();
    await http.put(`/api/tasks/${task.id}/recurrence`).set(H(owner.accessToken))
      .send({ freq: 'daily', atTime: '10:00' }).expect(200);
    await http.delete(`/api/tasks/${task.id}/recurrence`).set(H(owner.accessToken)).expect(200);

    const scheduler = app.get(RecurrenceScheduler);
    await scheduler.tick(new Date(Date.now() + 5 * DAY));
    expect(allTasks(await board(owner.accessToken, project.id))).toHaveLength(1);
  });
});
