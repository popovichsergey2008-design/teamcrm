import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AddressInfo } from 'net';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { AllExceptionsFilter } from '../src/common/http/all-exceptions.filter';
import { ResponseInterceptor } from '../src/common/http/response.interceptor';
import { RedisIoAdapter } from '../src/common/auth/redis-io.adapter';
import { DbService } from '../src/database/db.service';

/**
 * ТЗ-29: консьерж-поддержка поверх службы заботы.
 *
 * Проверяем обещания: честный статус (никого — так и пишем), обратный звонок,
 * запись звонка только с согласия, неудачные запросы без параметров, «пожелание»
 * рядом с багом, итог помощи с «всё работает», доступ инженера на 15 минут —
 * только с разрешения пользователя и только к тому, что он сам видит.
 */
describe('ТЗ-29 — консьерж-поддержка (e2e)', () => {
  let app: INestApplication;
  let http: any;
  let db: DbService;
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
    db = app.get(DbService);
  });
  afterAll(async () => { await app?.close(); });

  it('статус, обратный звонок, запись, пожелание, итог, доступ на 15 минут', async () => {
    const owner = (await http.post('/api/auth/register')
      .send({ acceptPrivacy: true, tenantName: 'Concierge', email: `cg_${uniq()}@t.test`, password: 'password123', fullName: 'Ольга Владелец' })
      .expect(201)).body.data;
    const O = H(owner.accessToken);
    const email = `cg_m_${uniq()}@t.test`;
    await http.post('/api/users').set(O).send({ email, fullName: 'Дмитрий', password: 'password123', role: 'member' }).expect(201);
    const M = H((await http.post('/api/auth/login').send({ email, password: 'password123' }).expect(201)).body.data.accessToken);

    // 1. Честный статус: без назначенной платформы инженеров нет — так и пишем
    const av = (await http.get('/api/support/desk/concierge').set(M).expect(200)).body.data;
    expect(av.estimate.text).toBeTruthy();
    expect(['now', 'queue', 'offline']).toContain(av.estimate.kind);

    // 2. Обратный звонок: встать и выйти
    expect((await http.post('/api/support/desk/concierge/callback').set(M).expect(201)).body.data.waiting).toBe(true);
    expect((await http.get('/api/support/desk/concierge/callback').set(M).expect(200)).body.data.waiting).toBe(true);
    await http.delete('/api/support/desk/concierge/callback').set(M).expect(200);
    expect((await http.get('/api/support/desk/concierge/callback').set(M).expect(200)).body.data.waiting).toBe(false);

    // 3. Обращение с неудачными запросами — в контексте без параметров и токенов
    const conv = (await http.post('/api/support/desk/messages').set(M).send({
      text: 'Не понимаю, куда привязать ИИ-протокол',
      context: {
        route: 'projects', browser: 'Chrome 141',
        failedRequests: [{ method: 'POST', path: '/api/projects/130/settings?token=secret', status: 403, requestId: 'req_abc123', at: new Date().toISOString() }],
      },
    }).expect(201)).body.data;
    await http.post(`/api/support/desk/${conv.id}/join`).set(O).expect(201);
    const diag = (await http.get(`/api/support/desk/${conv.id}/diagnostics`).set(O).expect(200)).body.data;
    expect(diag.context.metadata.failedRequests[0]).toMatchObject({ method: 'POST', path: '/api/projects/130/settings', status: 403, requestId: 'req_abc123' });
    expect(JSON.stringify(diag.context)).not.toContain('secret');
    // кто смотрел диагностику — в журнале организации клиента
    const audit = await db.one<{ n: number }>(
      `SELECT count(*)::int AS n FROM security_audit WHERE tenant_id = $1 AND event_type = 'support.diagnostics.viewed'`,
      [String(owner.user.tenantId)],
    );
    expect(audit!.n).toBeGreaterThanOrEqual(1);

    // 4. Пожелание к продукту — рядом с багом, видно с первого взгляда
    const fb = (await http.post(`/api/support/desk/${conv.id}/bug`).set(O).send({ title: 'Подсказка у ИИ-протокола', kind: 'feedback' }).expect(201)).body.data;
    const board = (await http.get(`/api/projects/${fb.projectId}/board`).set(O).expect(200)).body.data;
    const task = board.columns.flatMap((c: any) => c.tasks).find((t: any) => String(t.id) === String(fb.taskId));
    expect(task.title).toMatch(/^Пожелание: /);

    // 5. Запись звонка — только с согласия обратившегося; специалист за него не решает
    await http.post(`/api/support/desk/${conv.id}/recording`).set(O).send({ allow: true }).expect(404);
    const consent = (await http.post(`/api/support/desk/${conv.id}/recording`).set(M).send({ allow: false }).expect(201)).body.data;
    expect(consent.recordingConsent).toBe(false);

    // 6. 10-секундный тест предлагает специалист, пользователь — нет
    await http.post(`/api/support/desk/${conv.id}/offer-test`).set(M).expect(404);
    expect((await http.post(`/api/support/desk/${conv.id}/offer-test`).set(O).expect(201)).body.data.testOfferedAt).toBeTruthy();

    // 7. Итог помощи → «Всё работает»
    await db.query(`UPDATE support_conversations SET resolution_json = $2::jsonb, resolution_at = now() WHERE id = $1`,
      [conv.id, JSON.stringify({ problem: 'Не видно ИИ-протокол', fixed: 'Привязали к проекту', checked: '', next: '' })]);
    const res = (await http.post(`/api/support/desk/${conv.id}/resolution`).set(M).send({ works: true }).expect(201)).body.data;
    expect(res.resolution).toMatchObject({ fixed: 'Привязали к проекту', feedback: 'works' });

    // 8. Доступ на 15 минут: просит специалист, разрешает пользователь — по своему проекту
    const proj = (await http.post('/api/projects').set(O).send({ name: 'Заказчик А' }).expect(201)).body.data;
    const hidden = (await http.post('/api/projects').set(O).send({ name: 'Закрытый' }).expect(201)).body.data;
    await http.patch(`/api/projects/${hidden.id}`).set(O).send({ visibility: 'members' }).expect(200);
    const asked = (await http.post(`/api/support/desk/${conv.id}/access`).set(O).send({ reason: 'Проверить привязку протокола' }).expect(201)).body.data;
    expect(asked[0].status).toBe('requested');
    const grantId = asked[0].id;
    // специалист сам себе не разрешает; закрытый от пользователя проект разрешить нельзя
    await http.post(`/api/support/desk/${conv.id}/access/${grantId}/decide`).set(O).send({ allow: true, projectId: String(proj.id) }).expect(404);
    await http.post(`/api/support/desk/${conv.id}/access/${grantId}/decide`).set(M).send({ allow: true, projectId: String(hidden.id) }).expect(400);
    // до разрешения — ничего не видно
    await http.get(`/api/support/desk/${conv.id}/access/${grantId}/view`).set(O).expect(403);
    // #4675: без согласия с Политикой удалённой поддержки доступ не выдаётся
    const noConsent = await http.post(`/api/support/desk/${conv.id}/access/${grantId}/decide`).set(M).send({ allow: true, projectId: String(proj.id) }).expect(403);
    expect(noConsent.body.error.message).toMatch(/Политикой удалённой поддержки/);
    expect((await http.get(`/api/support/desk/${conv.id}/remote-consent`).set(M).expect(200)).body.data.active).toBe(false);
    // согласие даёт только сам обратившийся — специалист за него не может
    await http.post(`/api/support/desk/${conv.id}/remote-consent`).set(O).send({ via: 'access', grantId }).expect(404);
    await http.post(`/api/support/desk/${conv.id}/remote-consent`).set(M).send({ via: 'nowhere' }).expect(400);
    const given = (await http.post(`/api/support/desk/${conv.id}/remote-consent`).set(M).set('User-Agent', 'e2e-agent').send({ via: 'access', grantId }).expect(201)).body.data;
    expect(given).toMatchObject({ active: true, version: 'v1' });
    const row = await db.one<{ version: string; user_agent: string; ip: string | null; context: any }>(
      `SELECT version, user_agent, ip, context FROM policy_consents WHERE policy = 'remote_support' AND context->>'conversationId' = $1::text ORDER BY id DESC LIMIT 1`,
      [String(conv.id)],
    );
    expect(row).toMatchObject({ version: 'v1', user_agent: 'e2e-agent' });
    expect(row!.ip).toBeTruthy();
    expect(row!.context).toMatchObject({ via: 'access', grantId: String(grantId) });
    const granted =(await http.post(`/api/support/desk/${conv.id}/access/${grantId}/decide`).set(M).send({ allow: true, projectId: String(proj.id) }).expect(201)).body.data;
    expect(granted[0].status).toBe('granted');
    const snap = (await http.get(`/api/support/desk/${conv.id}/access/${grantId}/view`).set(O).expect(200)).body.data;
    expect(snap.project.name).toBe('Заказчик А');
    expect(snap.columns.length).toBeGreaterThan(0);
    expect(snap).not.toHaveProperty('tasks');
    // закрыл — и сразу нет доступа
    await http.post(`/api/support/desk/${conv.id}/access/${grantId}/revoke`).set(M).expect(201);
    await http.get(`/api/support/desk/${conv.id}/access/${grantId}/view`).set(O).expect(403);
  }, 60000);
});
