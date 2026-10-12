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
 * ТЗ-28: Magic Client Link — бренд, гостевая сессия, клиентский протокол.
 *
 * Проверяем то, что ломается молча: гость видит только опубликованное хозяином, а не
 * внутренний разбор; итоги — только у того, кто был на встрече или приглашён; согласие
 * на запись, если его требуют; подтверждение и уточнение доходят до хозяина.
 */
describe('ТЗ-28 — гостевой портал (e2e)', () => {
  let app: INestApplication;
  let http$: any;
  let db: DbService;
  const uniq = () => Math.random().toString(36).slice(2) + Date.now().toString(36);
  const H = (t: string) => ({ Authorization: `Bearer ${t}` });
  const inMin = (m: number) => new Date(Date.now() + m * 60_000).toISOString();

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
    db = app.get(DbService);
  });
  afterAll(async () => { await app?.close(); });

  it('бренд, вход с согласием, протокол после публикации, подтверждение и уточнение', async () => {
    const owner = (await http$.post('/api/auth/register')
      .send({ tenantName: 'Агентство', email: `gp_${uniq()}@t.test`, password: 'password123', fullName: 'Борис' })
      .expect(201)).body.data;
    const mate = (await http$.post('/api/users').set(H(owner.accessToken))
      .send({ email: `gpm_${uniq()}@t.test`, fullName: 'Глеб', password: 'password123', role: 'member' })
      .expect(201)).body.data;

    // 1. Бренд: светлый цвет затемняется до читаемого; согласие на запись обязательно
    const brand = (await http$.patch('/api/settings/guest-brand').set(H(owner.accessToken))
      .send({ companyName: 'Weitera Studio', accent: '#ffd400', welcomeText: 'Рады встрече', consentRequired: true }).expect(200)).body.data;
    expect(brand.preview.companyName).toBe('Weitera Studio');
    expect(brand.preview.accent).not.toBe('#ffd400');
    await http$.patch('/api/settings/guest-brand').set(H(mate.accessToken)).send({ poweredBy: false }).expect(403);

    // 2. Встреча через 5 минут — гость открывает общую ссылку и видит бренд
    const ev = (await http$.post('/api/calendar/events').set(H(owner.accessToken)).send({
      title: 'Финальное согласование прототипа', startsAt: inMin(5), endsAt: inMin(50), participantIds: [String(mate.id)],
    }).expect(201)).body.data;
    const pid = ev.meeting.publicId;
    const pub = (await http$.get(`/api/guest/brand?publicId=${pid}`).expect(200)).body.data;
    expect(pub).toMatchObject({ companyName: 'Weitera Studio', welcomeText: 'Рады встрече', consentRequired: true });
    expect(pub).not.toHaveProperty('summaryDays');

    // 3. Без отметки согласия — не пускает; с ней — гостевая сессия
    await http$.post(`/api/meet/m/${pid}/guest`).send({ name: 'Александр' }).expect(400);
    const joined = (await http$.post(`/api/meet/m/${pid}/guest`)
      .send({ name: 'Александр', email: 'alex@client.test', company: 'Клиент', consent: true, language: 'ru-RU' }).expect(201)).body.data;
    expect(joined.sessionKey).toBeTruthy();
    expect(joined).not.toHaveProperty('tenantId');
    const session = joined.sessionKey;
    // повторный вход по сессии — без имени и согласия
    const again = (await http$.post('/api/meet/guest-session/rejoin').send({ session }).expect(201)).body.data;
    expect(again.userId).toBe(joined.userId);

    // 4. Встреча прошла, протокола ещё нет — «готовим»; чужой ключ — отказ
    const roomId = ev.meetRoomId;
    const m = await db.one<{ id: string }>(
      `INSERT INTO meetings (tenant_id, title, source, status, created_by, room_id)
       VALUES ($1, 'Финальное согласование прототипа', 'call', 'done', $2, $3) RETURNING id::text`,
      [String(owner.user.tenantId), owner.user.id, roomId],
    );
    await db.query(`INSERT INTO meeting_summaries (meeting_id, tenant_id, summary, risks) VALUES ($1, $2, 'Внутренне: бюджет клиента 2 млн, риск срыва', '["Клиент может уйти"]')`,
      [m!.id, String(owner.user.tenantId)]);
    await db.query(`INSERT INTO decisions (tenant_id, meeting_id, text, created_by) VALUES ($1, $2, 'Утвердили дизайн первой версии', $3)`,
      [String(owner.user.tenantId), m!.id, owner.user.id]);
    const waiting = (await http$.post('/api/guest/postcall').send({ session }).expect(201)).body.data;
    expect(waiting.state).toBe('processing');
    expect(waiting.summary).toBeNull();
    await http$.post('/api/guest/postcall').send({ session: 'x'.repeat(32) }).expect(401);

    // 5. Хозяин: черновик (без ключа ИИ — правилами), правка, публикация
    const host = (await http$.post(`/api/meetings/${m!.id}/guest-summary/draft`).set(H(owner.accessToken)).send({}).expect(201)).body.data;
    expect(host.eligible).toBe(true);
    expect(host.summary.status).toBe('draft');
    expect(host.summary.agreements.map((a: any) => a.text)).toContain('Утвердили дизайн первой версии');
    // черновик гостю не виден
    expect((await http$.post('/api/guest/postcall').send({ session }).expect(201)).body.data.state).toBe('processing');
    const nextAt = inMin(4 * 24 * 60);
    await http$.put(`/api/meetings/${m!.id}/guest-summary`).set(H(owner.accessToken)).send({
      language: 'ru', text: 'Утвердили дизайн. Правки — до среды.',
      agreements: [
        { text: 'Утвердили дизайн первой версии', side: 'both' },
        { text: 'Клиент присылает тексты', side: 'client', deadlineAt: inMin(2 * 24 * 60) },
      ],
      nextMeeting: { title: 'Просмотр правок', at: nextAt },
    }).expect(200);
    const published = (await http$.post(`/api/meetings/${m!.id}/guest-summary/publish`).set(H(owner.accessToken)).expect(201)).body.data;
    expect(published.summary).toMatchObject({ status: 'published', version: 1, dirty: false });
    // чужой сотрудник без роли организатора протокол не ведёт
    await http$.get(`/api/meetings/${m!.id}/guest-summary`).set(H(mate.accessToken)).expect(403);

    // 6. Гость видит опубликованное — и ничего из внутреннего разбора
    const view = (await http$.post('/api/guest/postcall').send({ session }).expect(201)).body.data;
    expect(view.state).toBe('ready');
    expect(view.summary.text).toBe('Утвердили дизайн. Правки — до среды.');
    expect(view.summary.agreements).toHaveLength(2);
    expect(view.summary.nextMeeting.google).toContain('calendar.google.com');
    expect(JSON.stringify(view)).not.toMatch(/бюджет|риск|Клиент может уйти/i);
    const ics = await http$.get(`/api/guest/postcall/next.ics?session=${session}`).expect(200);
    expect(ics.text).toContain('SUMMARY:Просмотр правок');

    // 7. Подтверждение и уточнение доходят до хозяина
    await http$.post('/api/guest/postcall/acknowledge').send({ session, version: 2 }).expect(409);
    await http$.post('/api/guest/postcall/acknowledge').send({ session, version: 1 }).expect(201);
    expect((await http$.post('/api/guest/postcall').send({ session }).expect(201)).body.data.acknowledgedAt).toBeTruthy();
    await http$.post('/api/guest/postcall/feedback').send({ session, kind: 'correction', body: 'Тексты пришлём до пятницы' }).expect(201);
    const after = (await http$.get(`/api/meetings/${m!.id}/guest-summary`).set(H(owner.accessToken)).expect(200)).body.data;
    expect(after.summary.feedback.map((f: any) => f.kind).sort()).toEqual(['confirmed', 'correction']);

    // 8. Правка после публикации: гость видит прежнюю версию, пока не опубликуют
    await http$.put(`/api/meetings/${m!.id}/guest-summary`).set(H(owner.accessToken)).send({
      language: 'ru', text: 'Обновлённые итоги.', agreements: [{ text: 'Утвердили дизайн первой версии', side: 'both' }],
    }).expect(200);
    expect((await http$.post('/api/guest/postcall').send({ session }).expect(201)).body.data.summary.text).toBe('Утвердили дизайн. Правки — до среды.');
    await http$.post(`/api/meetings/${m!.id}/guest-summary/publish`).set(H(owner.accessToken)).expect(201);
    const v2 = (await http$.post('/api/guest/postcall').send({ session }).expect(201)).body.data;
    expect(v2.summary).toMatchObject({ version: 2, updated: true, text: 'Обновлённые итоги.' });
    expect(v2.acknowledgedAt).toBeNull(); // подтверждение — на версию

    // 9. Метрики — руководству
    const metrics = (await http$.get('/api/settings/guest-brand/metrics').set(H(owner.accessToken)).expect(200)).body.data;
    expect(metrics.joined).toBeGreaterThanOrEqual(1);
    expect(metrics.acknowledged).toBeGreaterThanOrEqual(1);
  });
});
