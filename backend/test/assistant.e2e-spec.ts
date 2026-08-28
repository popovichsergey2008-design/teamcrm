import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AddressInfo } from 'net';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { AllExceptionsFilter } from '../src/common/http/all-exceptions.filter';
import { ResponseInterceptor } from '../src/common/http/response.interceptor';
import { RedisIoAdapter } from '../src/common/auth/redis-io.adapter';
import { AssistantScheduler } from '../src/modules/assistant/assistant.scheduler';

/**
 * Смарт-пинги AI Секретаря.
 *
 * Главное здесь — не «напомнил», а границы: в «копилоте» ассистент никому не пишет
 * сам, один повод не повторяется в сутки, и чужое напоминание нельзя ни отправить,
 * ни закрыть.
 *
 * Тихие часы в тестах раздвинуты на сутки намеренно: CI запускается в любое время,
 * и тест, который проходит только с девяти до шести, — не тест. Сами тихие часы
 * проверяются отдельно (ping-rules.spec.ts), там время задаётся, а не угадывается.
 */
describe('Смарт-пинги ассистента (e2e)', () => {
  let app: INestApplication;
  let http: any;
  let scheduler: AssistantScheduler;
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
    scheduler = app.get(AssistantScheduler);
  });
  afterAll(async () => { await app?.close(); });

  /** Организация с исполнителем, просроченной задачей и круглосуточными «рабочими» часами. */
  const setup = async (name: string) => {
    const owner = (await http.post('/api/auth/register')
      .send({ tenantName: name, email: `a_${uniq()}@t.test`, password: 'password123', fullName: 'Постановщик' })
      .expect(201)).body.data;
    const email = `a_m_${uniq()}@t.test`;
    const mate = (await http.post('/api/users').set(H(owner.accessToken))
      .send({ email, fullName: 'Исполнитель', password: 'password123', role: 'member' }).expect(201)).body.data;
    const mateToken = (await http.post('/api/auth/login')
      .send({ email, password: 'password123' }).expect(201)).body.data.accessToken;

    await http.post('/api/calendar/work').set(H(owner.accessToken))
      .send({ workStart: '00:00', workEnd: '23:59', weekendDays: [], holidays: [] }).expect(201);

    const project = (await http.post('/api/projects').set(H(owner.accessToken))
      .send({ name: `Проект ${name}` }).expect(201)).body.data;
    const task = (await http.post('/api/tasks').set(H(owner.accessToken)).send({
      projectId: project.id, title: 'Просроченная задача',
      assigneeId: mate.id, deadlineAt: new Date(Date.now() - 3 * 864e5).toISOString(),
    }).expect(201)).body.data;

    return { owner, mate, mateToken, project, task };
  };

  it('копилот: ассистент предлагает постановщику, а сам никому не пишет', async () => {
    const s = await setup('Копилот');

    // режим по умолчанию — копилот: система не начинает писать людям сама
    expect((await http.get('/api/assistant/mode').set(H(s.owner.accessToken)).expect(200)).body.data.mode)
      .toBe('copilot');

    await scheduler.tick();

    // исполнителю пока ничего не пришло
    expect((await http.get('/api/assistant/pings').set(H(s.mateToken)).expect(200)).body.data).toHaveLength(0);

    // постановщик видит предложение — с текстом, который назовёт задачу
    const proposed = (await http.get('/api/assistant/pings/proposed').set(H(s.owner.accessToken)).expect(200)).body.data;
    const mine = proposed.filter((p: any) => String(p.taskId) === String(s.task.id));
    expect(mine).toHaveLength(1);
    expect(mine[0].kind).toBe('overdue');
    expect(mine[0].text).toContain('Просроченная задача');
    expect(mine[0].toName).toBe('Исполнитель');

    // повторный проход дубля не делает: один повод — раз в сутки
    await scheduler.tick();
    const again = (await http.get('/api/assistant/pings/proposed').set(H(s.owner.accessToken)).expect(200)).body.data;
    expect(again.filter((p: any) => String(p.taskId) === String(s.task.id))).toHaveLength(1);

    // отправили — напоминание дошло до исполнителя и исчезло из предложений
    await http.post(`/api/assistant/pings/${mine[0].id}/send`).set(H(s.owner.accessToken)).expect(201);
    const inbox = (await http.get('/api/assistant/pings').set(H(s.mateToken)).expect(200)).body.data;
    expect(inbox).toHaveLength(1);
    expect(inbox[0].text).toContain('Просроченная задача');
    // второй раз то же самое не отправить
    await http.post(`/api/assistant/pings/${mine[0].id}/send`).set(H(s.owner.accessToken)).expect(409);

    // исполнитель закрыл напоминание — оно уходит из списка
    await http.post(`/api/assistant/pings/${inbox[0].id}/dismiss`).set(H(s.mateToken)).expect(201);
    expect((await http.get('/api/assistant/pings').set(H(s.mateToken)).expect(200)).body.data).toHaveLength(0);
  });

  it('автопилот: напоминание уходит сразу и попадает в журнал ассистента', async () => {
    const s = await setup('Автопилот');
    await http.put('/api/assistant/mode').set(H(s.owner.accessToken)).send({ mode: 'autopilot' }).expect(200);

    await scheduler.tick();

    const inbox = (await http.get('/api/assistant/pings').set(H(s.mateToken)).expect(200)).body.data;
    expect(inbox.length).toBeGreaterThan(0);
    expect(inbox[0].text).toContain('Просроченная задача');

    // Накопившееся приходит ОДНОЙ сводкой, а не россыпью уколов: живая проверка
    // показала 190 напоминаний за четыре дня и реакцию в 14 нажатий «скрыть».
    const digest = inbox.find((p: any) => p.kind === 'digest');
    expect(digest).toBeTruthy();
    expect(digest.text).toContain('Коротко о делах');
    expect(digest.text).toContain('Просроченная задача');

    // Второй проход сводку не повторяет: одна на человека в день.
    await scheduler.tick();
    const after = (await http.get('/api/assistant/pings').set(H(s.mateToken)).expect(200)).body.data;
    expect(after.filter((p: any) => p.kind === 'digest')).toHaveLength(1);

    // журнал секретаря перестал быть пустым — счётчик показывает настоящую работу
    const log = (await http.get('/api/secretary/log').set(H(s.owner.accessToken)).expect(200)).body.data;
    expect(log.some((a: any) => a.kind === 'digest')).toBe(true);
  });

  it('выключенный ассистент молчит совсем', async () => {
    const s = await setup('Тишина');
    await http.put('/api/assistant/mode').set(H(s.owner.accessToken)).send({ mode: 'off' }).expect(200);

    await scheduler.tick();

    expect((await http.get('/api/assistant/pings').set(H(s.mateToken)).expect(200)).body.data).toHaveLength(0);
    expect((await http.get('/api/assistant/pings/proposed').set(H(s.owner.accessToken)).expect(200)).body.data)
      .toHaveLength(0);
  });

  it('режим задаёт владелец, чужое напоминание не трогает никто', async () => {
    const s = await setup('Права');
    await http.put('/api/assistant/mode').set(H(s.mateToken)).send({ mode: 'off' }).expect(403);
    await http.put('/api/assistant/mode').set(H(s.owner.accessToken)).send({ mode: 'турборежим' }).expect(400);

    await scheduler.tick();
    const proposed = (await http.get('/api/assistant/pings/proposed').set(H(s.owner.accessToken)).expect(200)).body.data;
    const ping = proposed.find((p: any) => String(p.taskId) === String(s.task.id));
    expect(ping).toBeTruthy();

    // соседняя организация о чужих напоминаниях не знает вовсе
    const stranger = await setup('Соседи');
    await http.post(`/api/assistant/pings/${ping.id}/send`).set(H(stranger.owner.accessToken)).expect(404);
    await http.post(`/api/assistant/pings/${ping.id}/dismiss`).set(H(stranger.mateToken)).expect(404);
  });
});
