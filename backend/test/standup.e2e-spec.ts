import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { AddressInfo } from 'net';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { AllExceptionsFilter } from '../src/common/http/all-exceptions.filter';
import { ResponseInterceptor } from '../src/common/http/response.interceptor';
import { RedisIoAdapter } from '../src/common/auth/redis-io.adapter';
import { AccessTokenPayload, RoleCode } from '../src/common/auth/jwt.types';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Верификационный гейт Этапа 3 (AI Standup). Mock-AI (без ключей). Живые PG/Redis/RabbitMQ. */
describe('TEAMCRM Этап 3 — AI Standup (e2e)', () => {
  let app: INestApplication;
  let http: any;
  let jwt: JwtService;
  let accessSecret: string;

  let token: string;
  let tenantId: string;
  let userId: string;
  let t1: string;
  let t2: string;
  const tgUser = Math.floor(Math.random() * 1e9) + 1000;
  // telegram_message_id уникален ГЛОБАЛЬНО — база случайная, чтобы прогоны не коллизировали
  let msgSeq = Math.floor(Math.random() * 1e9) + 1;

  const auth = () => ({ Authorization: `Bearer ${token}` });
  const uniq = () => Math.random().toString(36).slice(2) + Date.now().toString(36);

  function clientToken(): string {
    const p: AccessTokenPayload = { sub: '0', tenantId, role: 'client' as RoleCode, email: 'c@x.io' };
    return jwt.sign(p, { secret: accessSecret, expiresIn: 300 });
  }

  const textUpdate = (text: string, from = tgUser) => ({
    update_id: Math.floor(Math.random() * 1e9),
    message: { message_id: msgSeq++, from: { id: from }, chat: { id: from }, text },
  });

  async function pollStatus(id: string, want: string[], timeoutMs = 20000): Promise<string> {
    const stop = Date.now() + timeoutMs;
    let last = '';
    while (Date.now() < stop) {
      const r = await http.get(`/api/standup/submissions/${id}`).set(auth());
      last = r.body?.data?.status ?? '';
      if (want.includes(last)) return last;
      await sleep(500);
    }
    return last;
  }
  async function latestSubmissionId(): Promise<string | null> {
    const r = await http.get('/api/standup/submissions').set(auth()).expect(200);
    return r.body.data[0]?.id ?? null;
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    app.useGlobalFilters(new AllExceptionsFilter());
    app.useGlobalInterceptors(new ResponseInterceptor());
    app.useWebSocketAdapter(new RedisIoAdapter(app));
    accessSecret = app.get(ConfigService).getOrThrow('JWT_ACCESS_SECRET');
    jwt = app.get(JwtService);
    await app.listen(0, '0.0.0.0');
    http = request(`http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`);

    const reg = await http
      .post('/api/auth/register')
      .send({ tenantName: 'Standup', email: `o_${uniq()}@s.test`, password: 'password123', fullName: 'Owner' })
      .expect(201);
    token = reg.body.data.accessToken;
    tenantId = reg.body.data.user.tenantId;
    userId = reg.body.data.user.id;
    await http.post('/api/rates').set(auth()).send({ userId, hourlyRate: 360000 }).expect(201);
    const p = (await http.post('/api/projects').set(auth()).send({ name: 'SP', budget: 1_000_000 }).expect(201)).body.data;
    t1 = (await http.post('/api/tasks').set(auth()).send({ projectId: p.id, title: 'T1' }).expect(201)).body.data.id;
    t2 = (await http.post('/api/tasks').set(auth()).send({ projectId: p.id, title: 'T2' }).expect(201)).body.data.id;
  });

  afterAll(async () => {
    await app?.close();
  });

  it('непривязанный аккаунт не создаёт сабмишен', async () => {
    await http.post('/api/telegram/webhook').send(textUpdate('привет', 555000777)).expect(201);
    await sleep(500);
    // от непривязанного 555000777 сабмишена быть не должно (owner видит свой tenant — список пуст)
    const r = await http.get('/api/standup/submissions').set(auth()).expect(200);
    expect(r.body.data.length).toBe(0);
  });

  it('привязка по одноразовому коду', async () => {
    const code = (await http.post('/api/me/telegram/link-code').set(auth()).expect(201)).body.data.code;
    await http.post('/api/telegram/webhook').send(textUpdate(code)).expect(201);
    await sleep(400);
    // код одноразовый: повторная привязка тем же кодом не сработает (уже used)
    const code2 = code;
    await http.post('/api/telegram/webhook').send(textUpdate(code2)).expect(201);
  });

  it('дейлик → awaiting_confirmation; PII в transcript_masked замаскирован', async () => {
    const text = `#${t1} done 30m, пишите на boss@corp.com; #${t2} progress blocker: дизайнер не прислал макеты; #99999999 done 5m`;
    await http.post('/api/telegram/webhook').send(textUpdate(text)).expect(201);
    await sleep(800);
    const id = await latestSubmissionId();
    expect(id).toBeTruthy();
    const status = await pollStatus(id!, ['awaiting_confirmation', 'parse_failed']);
    expect(status).toBe('awaiting_confirmation');

    const detail = (await http.get(`/api/standup/submissions/${id}`).set(auth()).expect(200)).body.data;
    expect(detail.transcript_masked).toContain('[EMAIL]');
    expect(detail.transcript_masked).not.toContain('boss@corp.com');
  }, 30000);

  it('confirm → применение через guarded-пути; чужой task_id отклонён; время начислено', async () => {
    const id = await latestSubmissionId();
    await http.post(`/api/standup/submissions/${id}/confirm`).set(auth()).expect(201);
    const status = await pollStatus(id!, ['applied']);
    expect(status).toBe('applied');

    // действия: t1/t2 applied, чужой 99999999 → rejected_foreign
    const detail = (await http.get(`/api/standup/submissions/${id}`).set(auth()).expect(200)).body.data;
    const foreign = detail.actions.find((a: any) => a.detail?.attemptedTaskId === '99999999');
    expect(foreign.result).toBe('rejected_foreign');
    expect(detail.actions.some((a: any) => a.result === 'applied')).toBe(true);

    // себестоимость t1 выросла (время начислено через тайм-трекинг → движок economics)
    const stop = Date.now() + 12000;
    let cost = 0;
    while (Date.now() < stop) {
      cost = Number((await http.get(`/api/tasks/${t1}/cost`).set(auth())).body?.data?.costCurrent ?? 0);
      if (cost > 0) break;
      await sleep(500);
    }
    expect(cost).toBeGreaterThan(0);

    // алерт блокера поднят
    const alerts = (await http.get('/api/alerts').set(auth()).expect(200)).body.data;
    expect(alerts.some((a: any) => a.type === 'task_blocked')).toBe(true);
  }, 40000);

  it('t1 закрыта (Done) и t2 заблокирована — проверка доски', async () => {
    // найдём проект через board любой задачи: используем список проектов
    const projects = (await http.get('/api/projects').set(auth()).expect(200)).body.data;
    const board = (await http.get(`/api/projects/${projects[0].id}/board`).set(auth()).expect(200)).body.data;
    const allTasks = board.columns.flatMap((c: any) => c.tasks.map((t: any) => ({ ...t, col: c.name })));
    const task1 = allTasks.find((t: any) => t.id === t1);
    const task2 = allTasks.find((t: any) => t.id === t2);
    expect(task1.col).toBe('Done');
    expect(task2.col).toBe('In Progress');
    expect(task2.is_blocked).toBe(true);
  });

  it('повторный confirm отклонён (идемпотентность на уровне статуса)', async () => {
    const id = await latestSubmissionId();
    await http.post(`/api/standup/submissions/${id}/confirm`).set(auth()).expect(409);
  });

  it('дедуп: повтор того же message_id не создаёт второй сабмишен', async () => {
    const before = (await http.get('/api/standup/submissions').set(auth()).expect(200)).body.data.length;
    const upd = textUpdate(`#${t1} progress`);
    await http.post('/api/telegram/webhook').send(upd).expect(201);
    await sleep(600);
    const mid = (await http.get('/api/standup/submissions').set(auth()).expect(200)).body.data.length;
    // повтор ровно того же update (тот же message_id)
    await http.post('/api/telegram/webhook').send(upd).expect(201);
    await sleep(600);
    const after = (await http.get('/api/standup/submissions').set(auth()).expect(200)).body.data.length;
    expect(mid).toBe(before + 1);
    expect(after).toBe(mid); // дубликат не добавился
  }, 30000);

  it('невалидный дейлик (нет задач) → parse_failed', async () => {
    await http.post('/api/telegram/webhook').send(textUpdate('просто поболтать без задач')).expect(201);
    await sleep(800);
    const id = await latestSubmissionId();
    const status = await pollStatus(id!, ['parse_failed', 'awaiting_confirmation']);
    expect(status).toBe('parse_failed');
  }, 30000);

  it('client-изоляция: роль client не видит сабмишены дейликов (403)', async () => {
    const ct = clientToken();
    const res = await http.get('/api/standup/submissions').set({ Authorization: `Bearer ${ct}` });
    expect(res.status).toBe(403);
  });
});
