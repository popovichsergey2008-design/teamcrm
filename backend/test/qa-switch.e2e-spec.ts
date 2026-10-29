import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AddressInfo } from 'net';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { AllExceptionsFilter } from '../src/common/http/all-exceptions.filter';
import { ResponseInterceptor } from '../src/common/http/response.interceptor';
import { DbService } from '../src/database/db.service';

/**
 * #1562 «Войти как qa test»: только по строке в qa_switch_access, без цепочек,
 * возврат по actorId, который переживает обновление токена; всё — в журнал безопасности.
 */
describe('Вход как тестовый сотрудник (e2e)', () => {
  let app: INestApplication;
  let http$: any;
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
    await app.listen(0, '0.0.0.0');
    http$ = request(`http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`);
    db = app.get(DbService);
  });
  afterAll(async () => { await app?.close(); });

  const register = async (tenantName: string, fullName: string) =>
    (await http$.post('/api/auth/register')
      .send({ acceptPrivacy: true, tenantName, email: `qa_${uniq()}@t.test`, password: 'Test-pass-2026', fullName }).expect(201)).body.data;
  const staff = async (token: string, fullName: string) =>
    (await http$.post('/api/users').set(H(token))
      .send({ email: `qas_${uniq()}@t.test`, fullName, password: 'Test-pass-2026', role: 'member' }).expect(201)).body.data;
  const allow = (tenantId: string, userId: string, targetId: string) =>
    db.query(`INSERT INTO qa_switch_access (tenant_id, user_id, target_user_id) VALUES ($1,$2,$3)`, [tenantId, userId, targetId]);

  it('без строки — ничего нет; со строкой — вход как цель, refresh хранит actorId, возврат к себе', async () => {
    const owner = await register('QA-компания', 'Сергей Владелец');
    const tenantId = String(owner.user.tenantId);
    const qa = await staff(owner.accessToken, 'qa test');
    const colleague = await staff(owner.accessToken, 'Коллега');

    // строки нет — кнопки нет, ручка отказывает
    expect((await http$.get('/api/auth/qa-switch').set(H(owner.accessToken)).expect(200)).body.data).toEqual({ canSwitch: false });
    expect((await http$.get('/api/me').set(H(owner.accessToken)).expect(200)).body.data.qaSwitch).toEqual({ canSwitch: false });
    await http$.post('/api/auth/qa-switch').set(H(owner.accessToken)).send({}).expect(403);
    await http$.post('/api/auth/qa-switch').set(H(owner.accessToken)).send({ targetUserId: qa.id }).expect(403);

    await allow(tenantId, owner.user.id, qa.id);

    // у коллеги строки нет — у него по-прежнему ничего
    const col = (await http$.post('/api/auth/login').send({ email: colleague.email, password: 'Test-pass-2026' }).expect(201)).body.data;
    expect((await http$.get('/api/me').set(H(col.accessToken)).expect(200)).body.data.qaSwitch.canSwitch).toBe(false);
    await http$.post('/api/auth/qa-switch').set(H(col.accessToken)).send({ targetUserId: qa.id }).expect(403);

    const st = (await http$.get('/api/me').set(H(owner.accessToken)).expect(200)).body.data.qaSwitch;
    expect(st).toMatchObject({ canSwitch: true, targetName: 'qa test', targetId: String(qa.id) });

    // вход как qa test
    const as = (await http$.post('/api/auth/qa-switch').set(H(owner.accessToken)).send({}).expect(201)).body.data;
    expect(String(as.user.id)).toBe(String(qa.id));
    const meQa = (await http$.get('/api/me').set(H(as.accessToken)).expect(200)).body.data;
    expect(String(meQa.id)).toBe(String(qa.id));
    expect(meQa.qaSwitch).toEqual({ canSwitch: false, actingAs: { actorName: 'Сергей Владелец' } });

    // сессия, из которой переключились, закрыта: её refresh больше не работает
    await http$.post('/api/auth/refresh').send({ refreshToken: owner.refreshToken }).expect(401);

    // цепочек нет; пространства, пароль и входы тестовому отсюда не меняют
    await http$.post('/api/auth/qa-switch').set(H(as.accessToken)).send({ targetUserId: colleague.id }).expect(403);
    await http$.post('/api/auth/switch-org').set(H(as.accessToken)).send({ tenantId }).expect(403);
    await http$.post('/api/auth/organizations').set(H(as.accessToken)).send({ name: 'Побег' }).expect(403);
    await http$.post('/api/me/password').set(H(as.accessToken))
      .send({ currentPassword: 'Test-pass-2026', newPassword: 'password456' }).expect(403);

    // обновление токена сохраняет пометку «кто на самом деле»
    const r = (await http$.post('/api/auth/refresh').send({ refreshToken: as.refreshToken }).expect(201)).body.data;
    expect((await http$.get('/api/me').set(H(r.accessToken)).expect(200)).body.data.qaSwitch.actingAs.actorName).toBe('Сергей Владелец');

    // возврат — уже после обновления токена
    const back = (await http$.post('/api/auth/qa-switch/back').set(H(r.accessToken)).send({}).expect(201)).body.data;
    expect(String(back.user.id)).toBe(String(owner.user.id));
    const meBack = (await http$.get('/api/me').set(H(back.accessToken)).expect(200)).body.data;
    expect(String(meBack.id)).toBe(String(owner.user.id));
    expect(meBack.qaSwitch.canSwitch).toBe(true);
    expect(meBack.qaSwitch.actingAs).toBeUndefined();
    // обновлённая пара после возврата — обычная, без пометки
    const r2 = (await http$.post('/api/auth/refresh').send({ refreshToken: back.refreshToken }).expect(201)).body.data;
    expect((await http$.get('/api/me').set(H(r2.accessToken)).expect(200)).body.data.qaSwitch.actingAs).toBeUndefined();
    // старая сессия тестового закрыта
    await http$.post('/api/auth/refresh').send({ refreshToken: r.refreshToken }).expect(401);

    // «вернуться» из своей сессии нельзя
    await http$.post('/api/auth/qa-switch/back').set(H(r2.accessToken)).send({}).expect(403);

    // журнал безопасности: кто, в кого, откуда
    const audit = await db.many<{ event_type: string; actor_user_id: string; target_user_id: string; ip: string | null }>(
      `SELECT event_type, actor_user_id::text, target_user_id::text, ip FROM security_audit
        WHERE tenant_id=$1 AND event_type LIKE 'qa.switch%' ORDER BY id`, [tenantId],
    );
    expect(audit.map((a) => a.event_type)).toEqual(['qa.switch', 'qa.switch.back']);
    expect(audit.every((a) => a.actor_user_id === String(owner.user.id) && a.target_user_id === String(qa.id))).toBe(true);
    expect(audit[0].ip).toBeTruthy();
  });

  it('строку убрали — сессия тестового не обновляется и вернуться нельзя', async () => {
    const owner = await register('QA-2', 'Борис');
    const tenantId = String(owner.user.tenantId);
    const qa = await staff(owner.accessToken, 'qa test');
    await allow(tenantId, owner.user.id, qa.id);
    const as = (await http$.post('/api/auth/qa-switch').set(H(owner.accessToken)).send({}).expect(201)).body.data;

    await db.query(`DELETE FROM qa_switch_access WHERE tenant_id=$1`, [tenantId]);
    await http$.post('/api/auth/qa-switch/back').set(H(as.accessToken)).send({}).expect(403);
    await http$.post('/api/auth/refresh').send({ refreshToken: as.refreshToken }).expect(401);
  });

  it('цель из чужой компании и отключённая цель — отказ', async () => {
    const owner = await register('QA-3', 'Владелец 3');
    const tenantId = String(owner.user.tenantId);
    const other = await register('Чужая', 'Чужой владелец');
    const foreign = await staff(other.accessToken, 'qa test чужой');

    // строка указывает на человека другой компании — всё равно нельзя
    await allow(tenantId, owner.user.id, foreign.id);
    expect((await http$.get('/api/auth/qa-switch').set(H(owner.accessToken)).expect(200)).body.data.canSwitch).toBe(false);
    await http$.post('/api/auth/qa-switch').set(H(owner.accessToken)).send({ targetUserId: foreign.id }).expect(403);
    // и чужой владелец ничего не видит
    expect((await http$.get('/api/me').set(H(other.accessToken)).expect(200)).body.data.qaSwitch).toEqual({ canSwitch: false });

    // отключённый тестовый сотрудник
    const qa = await staff(owner.accessToken, 'qa test');
    await allow(tenantId, owner.user.id, qa.id);
    await http$.patch(`/api/users/${qa.id}`).set(H(owner.accessToken)).send({ isActive: false }).expect(200);
    expect((await http$.get('/api/auth/qa-switch').set(H(owner.accessToken)).expect(200)).body.data.canSwitch).toBe(false);
    await http$.post('/api/auth/qa-switch').set(H(owner.accessToken)).send({ targetUserId: qa.id }).expect(403);
  });
});
