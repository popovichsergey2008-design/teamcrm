import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AddressInfo } from 'net';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { AllExceptionsFilter } from '../src/common/http/all-exceptions.filter';
import { ResponseInterceptor } from '../src/common/http/response.interceptor';
import { RedisIoAdapter } from '../src/common/auth/redis-io.adapter';

/**
 * ТЗ-27: персональный брифинг «Фокуса дня».
 *
 * Проверяем то, что ломается молча: брифинг объясняет ту же тройку, что на экране,
 * чужое в него не попадает, «Обновить» не трогает принятый план, «Взять в работу»
 * двигает задачу в «В работе» без таймера, а голос без синтеза не роняет экран.
 */
describe('ТЗ-27 — брифинг «Фокуса дня» (e2e)', () => {
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

  it('снимок, тройка, источники, права, «Взять в работу», настройки', async () => {
    const owner = (await http.post('/api/auth/register')
      .send({ tenantName: 'Brief', email: `b_${uniq()}@t.test`, password: 'password123', fullName: 'Борис Петров' })
      .expect(201)).body.data;
    const tok = owner.accessToken;
    const me = owner.user.id;
    const memEmail = `b_m_${uniq()}@t.test`;
    const inv = (await http.post('/api/invites').set(H(tok)).send({ email: memEmail, role: 'member' }).expect(201)).body.data;
    await http.post('/api/invites/accept').send({ token: inv.token, fullName: 'Анна', password: 'memberpass1' }).expect(201);
    const mem = (await http.post('/api/auth/login').send({ email: memEmail, password: 'memberpass1' }).expect(201)).body.data;

    const proj = (await http.post('/api/projects').set(H(tok)).send({ name: 'Секретный' }).expect(201)).body.data;
    const hot = (await http.post('/api/tasks').set(H(tok)).send({
      projectId: proj.id, title: 'Проверить мобильный вход', assigneeId: me, priority: 'urgent',
      deadlineAt: new Date(Date.now() - 864e5).toISOString(),
    }).expect(201)).body.data;

    // 1. Новый фокус включён по умолчанию; снимок собирается
    const first = (await http.get('/api/focus/today').set(H(tok)).expect(200)).body.data;
    expect(first.enabled).toBe(true);
    expect(first.brief.enabled).toBe(true);
    const gen = (await http.post('/api/focus/today/brief/generate').set(H(tok)).expect(201)).body.data;
    expect(gen.status).toBe('ready');
    // 2. Брифинг говорит о той же задаче, что стоит в тройке, — со ссылкой-источником
    expect(gen.text).toContain('Проверить мобильный вход');
    expect(gen.sources.some((s: any) => s.link === `/projects/${proj.id}/task/${hot.id}`)).toBe(true);
    const day = (await http.get('/api/focus/today').set(H(tok)).expect(200)).body.data;
    expect(day.top[0].taskId).toBe(String(hot.id));
    expect(day.brief.id).toBe(gen.id);

    // 3. Чужое не попадает: у Анны в брифинге нет задачи Бориса
    await http.post('/api/focus/today/brief/generate').set(H(mem.accessToken)).expect(201);
    const hers = (await http.get('/api/focus/today/brief').set(H(mem.accessToken)).expect(200)).body.data;
    expect(hers.status).toBe('ready');
    expect(hers.text).not.toContain('Проверить мобильный вход');
    expect(JSON.stringify(hers.sources)).not.toContain(`/task/${hot.id}`);

    // 4. «Обновить» не трогает принятый план
    await http.post('/api/focus/today/accept').set(H(tok)).expect(201);
    const refreshed = (await http.post('/api/focus/today/brief/refresh').set(H(tok)).expect(201)).body.data;
    expect(refreshed.status).toBe('ready');
    const after = (await http.get('/api/focus/today').set(H(tok)).expect(200)).body.data;
    expect(after.plan.status).toBe('accepted');
    expect(after.top.map((i: any) => i.id)).toEqual(day.top.map((i: any) => i.id));

    // 5. Голос: без синтеза — честный статус, экран живёт; ссылка — только подписанная
    const audio = (await http.get('/api/focus/today/brief/audio').set(H(tok)).expect(200)).body.data;
    expect(['none', 'pending', 'off', 'failed', 'ready']).toContain(audio.status);
    if (audio.status === 'ready') expect(audio.playbackUrl).toMatch(/[?&]e=\d+/);

    // 6. «Взять в работу» — задача в «В работе», пункт начат, таймера нет
    const item = after.top.find((i: any) => i.taskId === String(hot.id));
    const started = (await http.post(`/api/focus/today/items/${item.id}/start`).set(H(tok)).expect(201)).body.data;
    expect(started.started.column).toBe('В работе');
    expect(started.top.find((i: any) => i.id === item.id).startedAt).toBeTruthy();
    expect(started.plan.status).toBe('in_progress');
    const session = (await http.get('/api/focus/sessions/current').set(H(tok)).expect(200)).body.data;
    expect(session).toBeFalsy();
    // чужой пункт не взять
    await http.post(`/api/focus/today/items/${item.id}/start`).set(H(mem.accessToken)).expect(404);

    // 7. Оценка, события, настройки, метрики — руководству
    await http.post('/api/focus/today/brief/feedback').set(H(tok)).send({ value: -1, reason: 'missed_task' }).expect(201);
    await http.post('/api/focus/today/brief/event').set(H(tok)).send({ event: 'audio_played' }).expect(201);
    await http.post('/api/focus/today/brief/event').set(H(tok)).send({ event: 'выдумка' }).expect(400);
    const st = (await http.patch('/api/focus/today/brief/settings').set(H(tok)).send({ length: 'short', audio: false }).expect(200)).body.data;
    expect(st.length).toBe('short');
    expect(st.effective.teamSignals).toBe(true);
    const memSt = (await http.get('/api/focus/today/brief/settings').set(H(mem.accessToken)).expect(200)).body.data;
    expect(memSt.effective.teamSignals).toBe(false);
    const m = (await http.get('/api/focus/today/brief/metrics').set(H(tok)).expect(200)).body.data;
    expect(m.briefs).toBeGreaterThanOrEqual(1);
    expect(m.thumbsDown).toBe(1);
    await http.get('/api/focus/today/brief/metrics').set(H(mem.accessToken)).expect(403);

    // 8. Брифинг выключен — экран фокуса жив, брифинга нет
    await http.patch('/api/focus/today/brief/settings').set(H(mem.accessToken)).send({ enabled: false }).expect(200);
    const off = (await http.get('/api/focus/today').set(H(mem.accessToken)).expect(200)).body.data;
    expect(off.enabled).toBe(true);
    expect(off.brief).toEqual({ enabled: false });
  });
});
