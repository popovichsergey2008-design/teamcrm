import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AddressInfo } from 'net';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { AllExceptionsFilter } from '../src/common/http/all-exceptions.filter';
import { ResponseInterceptor } from '../src/common/http/response.interceptor';
import { RedisIoAdapter } from '../src/common/auth/redis-io.adapter';

/**
 * #1476 — функции секретаря: сроки документов, поздравления клиентам, проверка договора, чеки.
 *
 * Проверяем то, что ломается молча: чужие документы и чеки не видны и не правятся,
 * близкий срок сразу даёт карточку «Ждут решения» и «Продлил» её закрывает, фото чека
 * не скачать никому, кроме загрузившего, без ключа ИИ договор проверяется правилами
 * и результат кэшируется, авансовый отчёт — настоящий xlsx.
 */
describe('#1476 — функции секретаря (e2e)', () => {
  let app: INestApplication;
  let http: any;
  const uniq = () => Math.random().toString(36).slice(2) + Date.now().toString(36);
  const H = (t: string) => ({ Authorization: `Bearer ${t}` });
  const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

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

  it('сроки документов, чеки, договор и даты клиента', async () => {
    const owner = (await http.post('/api/auth/register')
      .send({ acceptPrivacy: true, tenantName: 'Docs', email: `d_${uniq()}@t.test`, password: 'Test-pass-2026', fullName: 'Сергей' })
      .expect(201)).body.data;
    const tok = owner.accessToken;
    const memEmail = `d_m_${uniq()}@t.test`;
    const inv = (await http.post('/api/invites').set(H(tok)).send({ email: memEmail, role: 'member' }).expect(201)).body.data;
    await http.post('/api/invites/accept').send({ acceptPrivacy: true, token: inv.token, fullName: 'Анна', password: 'memberpass1' }).expect(201);
    const mem = (await http.post('/api/auth/login').send({ email: memEmail, password: 'memberpass1' }).expect(201)).body.data;

    // ── F20: срок через 3 дня → сразу карточка «Ждут решения» ──
    const doc = (await http.post('/api/doc-deadlines').set(H(tok)).send({ kind: 'visa', title: 'Шенген', expiresOn: inDays(3) }).expect(201)).body.data;
    expect(doc.remindDays).toEqual([30, 7, 1]);
    await http.post('/api/doc-deadlines').set(H(tok)).send({ kind: 'visa', title: 'без даты' }).expect(400);
    // чужие документы: не видно, не правится
    expect((await http.get('/api/doc-deadlines').set(H(mem.accessToken)).expect(200)).body.data).toEqual([]);
    await http.patch(`/api/doc-deadlines/${doc.id}`).set(H(mem.accessToken)).send({ title: 'x' }).expect(404);

    let card: any = null;
    for (let i = 0; i < 25 && !card; i++) {
      const list = (await http.get('/api/assistant/proposals').set(H(tok)).expect(200)).body.data.items;
      card = list.find((p: any) => p.skill === 'docs');
      if (!card) await new Promise((r) => setTimeout(r, 200));
    }
    expect(card).toBeTruthy();
    expect(card.title).toBe('Через 3 дня заканчивается: Шенген');
    const done = (await http.post(`/api/assistant/proposals/${card.id}/confirm`).set(H(tok)).send({ action: 'renewed' }).expect(201)).body.data;
    expect(done.text).toContain('продлён');
    const after = (await http.get('/api/doc-deadlines').set(H(tok)).expect(200)).body.data;
    expect(after[0].renewedAt).toBeTruthy();
    // новая дата — напоминания заново
    const moved = (await http.patch(`/api/doc-deadlines/${doc.id}`).set(H(tok)).send({ expiresOn: inDays(400) }).expect(200)).body.data;
    expect(moved.renewedAt).toBeNull();
    await http.delete(`/api/doc-deadlines/${doc.id}`).set(H(tok)).expect(200);

    // ── F24: чеки ──
    const photo = (await http.post('/api/files').set(H(tok))
      .field('ownerKind', 'receipt').attach('file', Buffer.from('fake-jpeg'), { filename: 'chek.jpg', contentType: 'image/jpeg' }).expect(201)).body.data;
    // фото чека — личное: сотруднику «не найден»
    await http.get(`/api/files/${photo.id}`).set(H(mem.accessToken)).expect(404);
    await http.post('/api/receipts').set(H(mem.accessToken)).send({ fileId: String(photo.id) }).expect(404);
    const rec = (await http.post('/api/receipts').set(H(tok)).send({ fileId: String(photo.id) }).expect(201)).body.data;
    // в тестах ключа ИИ нет — честно «не распознан», поля можно заполнить руками
    expect(rec.status).toBe('failed');
    expect(rec.error).toBeTruthy();
    const fixed = (await http.patch(`/api/receipts/${rec.id}`).set(H(tok))
      .send({ spentOn: inDays(-1), seller: 'Такси', total: '1 250,50', vat: '208,42', category: 'taxi', purpose: 'на встречу' }).expect(200)).body.data;
    expect(fixed).toMatchObject({ status: 'manual', total: 1250.5, vat: 208.42, category: 'taxi' });
    await http.patch(`/api/receipts/${rec.id}`).set(H(tok)).send({ total: 'много' }).expect(400);
    const manual = (await http.post('/api/receipts').set(H(tok)).send({}).expect(201)).body.data;
    await http.patch(`/api/receipts/${manual.id}`).set(H(tok)).send({ spentOn: inDays(-2), seller: 'Отель', total: 3000 }).expect(200);
    expect((await http.get('/api/receipts').set(H(mem.accessToken)).expect(200)).body.data).toEqual([]);
    const list = (await http.get(`/api/receipts?from=${inDays(-10)}&to=${inDays(0)}`).set(H(tok)).expect(200)).body.data;
    expect(list).toHaveLength(2);
    const xlsx = await http.get(`/api/receipts/export?from=${inDays(-10)}`).set(H(tok)).buffer(true)
      .parse((res: any, cb: any) => { const c: Buffer[] = []; res.on('data', (d: Buffer) => c.push(d)); res.on('end', () => cb(null, Buffer.concat(c))); })
      .expect(200);
    expect(xlsx.headers['content-type']).toContain('spreadsheetml');
    expect((xlsx.body as Buffer).subarray(0, 2).toString()).toBe('PK');
    await http.delete(`/api/receipts/${rec.id}`).set(H(mem.accessToken)).expect(404);
    await http.delete(`/api/receipts/${rec.id}`).set(H(tok)).expect(200);

    // ── F21: проверка договора без ключа ИИ — по правилам, результат кэшируется ──
    const text = 'Договор оказания услуг № 5. Исполнитель вправе в одностороннем порядке изменить стоимость услуг, уведомив Заказчика. '
      + 'За просрочку оплаты Заказчик уплачивает неустойку в размере 1% от суммы за каждый день просрочки. '
      + 'Договор автоматически продлевается на следующий год, если ни одна из сторон не заявит о расторжении. '
      + 'Акт считается подписанным, если Заказчик не направил мотивированные возражения в течение двух дней.';
    const f = (await http.post('/api/files').set(H(tok))
      .attach('file', Buffer.from(text, 'utf8'), { filename: 'dogovor.txt', contentType: 'text/plain' }).expect(201)).body.data;
    const review = (await http.post(`/api/contract-review/${f.id}`).set(H(tok)).expect(201)).body.data;
    expect(review.rulesOnly).toBe(true);
    expect(review.risks.map((r: any) => r.topic)).toEqual(expect.arrayContaining(['Одностороннее изменение или отказ', 'Неустойка и штрафы', 'Молчаливая приёмка']));
    expect(review.risks[0].level).toBe('high');
    const again = (await http.post(`/api/contract-review/${f.id}`).set(H(tok)).expect(201)).body.data;
    expect(again.cached).toBe(true);
    const short = (await http.post('/api/files').set(H(tok))
      .attach('file', Buffer.from('скан', 'utf8'), { filename: 'scan.txt', contentType: 'text/plain' }).expect(201)).body.data;
    await http.post(`/api/contract-review/${short.id}`).set(H(tok)).expect(400);

    // ── F11: важные даты клиента ──
    const client = (await http.post('/api/clients').set(H(tok)).send({ name: `Ромашка ${uniq()}`, contactName: 'Иван Петров' }).expect(201)).body.data;
    const cardC = (await http.get(`/api/clients/${client.id}`).set(H(tok)).expect(200)).body.data;
    const contactId = cardC.contacts.items[0]?.id;
    const now = new Date();
    const dates = (await http.post(`/api/clients/${client.id}/dates`).set(H(tok))
      .send({ kind: 'birthday', contactId, month: now.getMonth() + 1, day: now.getDate() }).expect(201)).body.data;
    expect(dates[0]).toMatchObject({ kind: 'birthday', person: 'Иван Петров' });
    await http.post(`/api/clients/${client.id}/dates`).set(H(tok)).send({ kind: 'birthday', month: 2, day: 31 }).expect(400);
    await http.post(`/api/clients/${client.id}/dates`).set(H(tok)).send({ kind: 'other', month: 3, day: 1 }).expect(400);
    const two = (await http.post(`/api/clients/${client.id}/dates`).set(H(tok)).send({ kind: 'partnership', month: 3, day: 1, year: 2020 }).expect(201)).body.data;
    expect(two).toHaveLength(2);
    const left = (await http.delete(`/api/client-dates/${two.find((d: any) => d.kind === 'partnership').id}`).set(H(tok)).expect(200)).body.data;
    expect(left).toHaveLength(1);
  });
});
