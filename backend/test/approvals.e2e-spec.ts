import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AddressInfo } from 'net';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { AllExceptionsFilter } from '../src/common/http/all-exceptions.filter';
import { ResponseInterceptor } from '../src/common/http/response.interceptor';
import { RedisIoAdapter } from '../src/common/auth/redis-io.adapter';

/**
 * Согласования (ТЗ-2, этап 3, Ш2).
 *
 * Проверяем не «ручка отвечает», а правила, ради которых сущность заводилась:
 * решает только тот, у кого спросили; отказ без причины не принимается; повторное
 * решение невозможно; вопрос виден в счётчике «требует решения».
 */
describe('ТЗ-2 — согласования (e2e)', () => {
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

  /** Владелец + сотрудник в одной организации. */
  const team = async () => {
    const owner = (await http.post('/api/auth/register')
      .send({ tenantName: 'Appr', email: `ap_${uniq()}@t.test`, password: 'password123', fullName: 'Ольга Владелец' })
      .expect(201)).body.data;
    const email = `ap_m_${uniq()}@t.test`;
    const inv = (await http.post('/api/invites').set(H(owner.accessToken))
      .send({ email, role: 'member' }).expect(201)).body.data;
    await http.post('/api/invites/accept')
      .send({ token: inv.token, fullName: 'Пётр Сотрудник', password: 'memberpass1' }).expect(201);
    const member = (await http.post('/api/auth/login')
      .send({ email, password: 'memberpass1' }).expect(201)).body.data;
    return { owner, member };
  };

  it('вопрос доходит до адресата, решает только он, отказ требует причины', async () => {
    const { owner, member } = await team();

    // Сотрудник просит решение у владельца
    const created = (await http.post('/api/approvals').set(H(member.accessToken)).send({
      approverId: owner.user.id,
      kind: 'budget',
      subject: 'Клиент просит скидку 10% — одобряем?',
      details: 'Объём заказа вырос вдвое, маржа остаётся 28%.',
    }).expect(201)).body.data;
    expect(created.status).toBe('pending');

    // 1. Вопрос лежит у владельца, а не у автора
    const inboxOwner = (await http.get('/api/approvals').set(H(owner.accessToken)).expect(200)).body.data;
    expect(inboxOwner.map((a: any) => String(a.id))).toContain(String(created.id));
    expect(inboxOwner[0].author_name).toBe('Пётр Сотрудник');

    const inboxMember = (await http.get('/api/approvals').set(H(member.accessToken)).expect(200)).body.data;
    expect(inboxMember).toEqual([]);

    // 2. Автор видит свой вопрос в отправленных — иначе неясно, у кого он лежит
    const sent = (await http.get('/api/approvals/sent').set(H(member.accessToken)).expect(200)).body.data;
    expect(sent.map((a: any) => String(a.id))).toContain(String(created.id));

    // 3. Вопрос попадает в счётчик «требует решения» у владельца
    const counters = (await http.get('/api/nav/counters?tz=0').set(H(owner.accessToken)).expect(200)).body.data;
    expect(counters.focus.decide).toBeGreaterThanOrEqual(1);

    // 4. Решать может только тот, у кого спросили
    await http.post(`/api/approvals/${created.id}/decide`).set(H(member.accessToken))
      .send({ approve: true }).expect(403);

    // 5. Отказ без причины не принимается: «нет» без объяснения вернётся новым вопросом
    await http.post(`/api/approvals/${created.id}/decide`).set(H(owner.accessToken))
      .send({ approve: false }).expect(400);

    // 6. Отказ с причиной проходит
    const decided = (await http.post(`/api/approvals/${created.id}/decide`).set(H(owner.accessToken))
      .send({ approve: false, note: 'Скидка выше 5% только по предоплате' }).expect(201)).body.data;
    expect(decided.status).toBe('rejected');
    expect(decided.decision_note).toContain('предоплате');

    // 7. Второй раз решить нельзя — защита от двойного клика и гонки
    await http.post(`/api/approvals/${created.id}/decide`).set(H(owner.accessToken))
      .send({ approve: true }).expect(409);

    // 8. Решённое ушло из входящих
    const after = (await http.get('/api/approvals').set(H(owner.accessToken)).expect(200)).body.data;
    expect(after.map((a: any) => String(a.id))).not.toContain(String(created.id));
  });

  it('у себя согласование не просят, чужой вопрос не отзывают', async () => {
    const { owner, member } = await team();

    await http.post('/api/approvals').set(H(owner.accessToken))
      .send({ approverId: owner.user.id, subject: 'Сам себе разрешаю' }).expect(400);

    const mine = (await http.post('/api/approvals').set(H(member.accessToken))
      .send({ approverId: owner.user.id, subject: 'Отпуск с 3 по 10 сентября', kind: 'vacation' })
      .expect(201)).body.data;

    // отозвать может только автор, даже если ты тот, у кого спросили
    await http.post(`/api/approvals/${mine.id}/cancel`).set(H(owner.accessToken)).expect(403);
    const cancelled = (await http.post(`/api/approvals/${mine.id}/cancel`).set(H(member.accessToken))
      .expect(201)).body.data;
    expect(cancelled.status).toBe('cancelled');
  });
});
