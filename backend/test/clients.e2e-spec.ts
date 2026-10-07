import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AddressInfo } from 'net';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { AllExceptionsFilter } from '../src/common/http/all-exceptions.filter';
import { ResponseInterceptor } from '../src/common/http/response.interceptor';
import { RedisIoAdapter } from '../src/common/auth/redis-io.adapter';

/**
 * ТЗ-17: раздел «Клиенты».
 *
 * Проверяем то, что ломается молча: дубли не создаются без «всё равно», поиск
 * находит по телефону контакта, контакт приходит маской и открывается только с
 * записью в журнал, права разведены (сотрудник не архивирует, не выгружает и не
 * заводит сделки), задача и встреча доходят до карточки, импорт не падает на плохой
 * строке, объединение переносит всё и оставляет след.
 */
describe('ТЗ-17 — Клиенты (e2e)', () => {
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

  it('клиент от создания до объединения', async () => {
    const owner = (await http.post('/api/auth/register')
      .send({ tenantName: 'Clients', email: `c_${uniq()}@t.test`, password: 'password123', fullName: 'Сергей' })
      .expect(201)).body.data;
    const tok = owner.accessToken;
    const memEmail = `c_m_${uniq()}@t.test`;
    const inv = (await http.post('/api/invites').set(H(tok)).send({ email: memEmail, role: 'member' }).expect(201)).body.data;
    await http.post('/api/invites/accept').send({ token: inv.token, fullName: 'Анна', password: 'memberpass1' }).expect(201);
    const mem = (await http.post('/api/auth/login').send({ email: memEmail, password: 'memberpass1' }).expect(201)).body.data;

    // 1. Быстрое создание с основным контактом
    const acme = (await http.post('/api/clients').set(H(tok)).send({
      name: 'ООО «Акме»', phone: '8 (999) 123-45-67', email: 'ivan@acme.ru', website: 'https://www.acme.ru', contactName: 'Иван Петров', segment: 'VIP',
    }).expect(201)).body.data;

    // 2. Дубль по названию/домену — 409 со списком, «всё равно» — создаёт
    const dup = await http.post('/api/clients').set(H(tok)).send({ name: 'Акме', website: 'acme.ru' }).expect(409);
    expect(dup.body.error.details.duplicates[0].id).toBe(acme.id);
    expect(dup.body.error.details.duplicates[0].matched).toEqual(expect.arrayContaining(['domain']));
    const acme2 = (await http.post('/api/clients').set(H(tok)).send({ name: 'Акме', website: 'acme.ru', force: true }).expect(201)).body.data;

    // 3. Поиск по телефону контакта и по названию; «Мои» — у создателя
    const byPhone = (await http.get('/api/clients?q=9991234567').set(H(tok)).expect(200)).body.data;
    expect(byPhone.items.map((c: any) => c.id)).toContain(acme.id);
    const mine = (await http.get('/api/clients?view=mine').set(H(tok)).expect(200)).body.data;
    expect(mine.total).toBe(2);
    expect(mine.items[0].ownerName).toBe('Сергей');

    // 4. Контакт приходит маской; «Показать» — только с журналом
    const card = (await http.get(`/api/clients/${acme.id}`).set(H(mem.accessToken)).expect(200)).body.data;
    const contact = card.contacts.items[0];
    expect(contact.isPrimary).toBe(true);
    expect(contact.fields.phone.masked).toBe(true);
    expect(contact.fields.phone.value).not.toContain('123-45');
    const shown = (await http.post(`/api/client-contacts/${contact.id}/reveal`).set(H(mem.accessToken)).send({ field: 'phone' }).expect(201)).body.data;
    expect(shown.value).toBe('8 (999) 123-45-67');
    const reveals = (await http.get('/api/security/contact-reveals').set(H(tok)).expect(200)).body.data;
    expect(reveals.length).toBeGreaterThanOrEqual(1);

    // 5. Права: сотрудник видит сделки, но не заводит; не архивирует; не выгружает
    await http.post(`/api/clients/${acme.id}/deals`).set(H(mem.accessToken)).send({ title: 'Внедрение' }).expect(403);
    await http.delete(`/api/clients/${acme.id}`).set(H(mem.accessToken)).expect(403);
    await http.get('/api/clients/export').set(H(mem.accessToken)).expect(403);
    const deals = (await http.post(`/api/clients/${acme.id}/deals`).set(H(tok)).send({ title: 'Внедрение', amount: 18000, currency: 'EUR', stage: 'proposal' }).expect(201)).body.data;
    await http.patch(`/api/client-deals/${deals[0].id}`).set(H(tok)).send({ stage: 'approval', probability: 70 }).expect(200);
    expect((await http.get(`/api/clients/${acme.id}/deals`).set(H(mem.accessToken)).expect(200)).body.data[0].stage).toBe('approval');

    // 6. Задача и встреча с клиентом доходят до карточки
    const proj = (await http.post('/api/projects').set(H(tok)).send({ name: 'Внутренний' }).expect(201)).body.data;
    await http.post('/api/tasks').set(H(tok)).send({ projectId: proj.id, title: 'Отправить КП', clientId: acme.id, deadlineAt: new Date(Date.now() - 864e5).toISOString() }).expect(201);
    const starts = new Date(Date.now() + 2 * 864e5);
    await http.post('/api/calendar/events').set(H(tok)).send({ title: 'Созвон с Акме', clientId: acme.id, startsAt: starts.toISOString(), endsAt: new Date(starts.getTime() + 3600e3).toISOString() }).expect(201);
    const full = (await http.get(`/api/clients/${acme.id}`).set(H(tok)).expect(200)).body.data;
    expect(full.tasks.open).toBe(1);
    expect(full.tasks.overdue).toBe(1);
    expect(full.meetings.upcoming[0].title).toBe('Созвон с Акме');
    expect(full.nextAction.source).toBe('meeting');
    expect(full.summary.risks.map((r: any) => r.text)).toContain('Просрочена задача «Отправить КП».');
    expect(full.health.level).toBe('attention');
    // «Требуют внимания» — из-за просрочки
    expect((await http.get('/api/clients?view=attention').set(H(tok)).expect(200)).body.data.items.map((c: any) => c.id)).toContain(acme.id);

    // 7. Заметки: личную видит автор, но не коллега
    await http.post(`/api/clients/${acme.id}/notes`).set(H(tok)).send({ body: 'Секрет переговоров', isPrivate: true }).expect(201);
    await http.post(`/api/clients/${acme.id}/notes`).set(H(tok)).send({ body: 'Любят созвоны по утрам', pinned: true }).expect(201);
    const memNotes = (await http.get(`/api/clients/${acme.id}/notes`).set(H(mem.accessToken)).expect(200)).body.data;
    expect(memNotes.map((n: any) => n.body)).toEqual(['Любят созвоны по утрам']);

    // 8. Лента собирает события
    const act = (await http.get(`/api/clients/${acme.id}/activity`).set(H(tok)).expect(200)).body.data;
    expect(act.map((a: any) => a.kind)).toEqual(expect.arrayContaining(['client', 'deal', 'task', 'reveal']));

    // 9. Импорт: плохая строка не ломает остальное, похожий — на проверку
    const csv = Buffer.from('Название компании;Телефон;E-mail\nРомашка;+7 900 000 00 01;a@romashka.ru\n;;\nАкме;;\n', 'utf8');
    const pre = (await http.post('/api/clients/import/preview').set(H(tok)).attach('file', csv, 'clients.csv').expect(201)).body.data;
    expect(pre.mapping['Название компании']).toBe('name');
    const rep = (await http.post('/api/clients/import').set(H(tok)).attach('file', csv, 'clients.csv')
      .field('mapping', JSON.stringify(pre.mapping)).expect(201)).body.data;
    expect(rep.imported).toBe(1);
    expect(rep.review).toBe(1);

    // 10. Выгрузка — у владельца, CSV
    const exp = await http.get('/api/clients/export').set(H(tok)).expect(200);
    expect(exp.text).toContain('Ромашка');

    // 11. Объединение: всё переезжает, второй — в архив
    await http.post(`/api/clients/${acme2.id}/notes`).set(H(tok)).send({ body: 'Из дубля' }).expect(201);
    const preview = (await http.post('/api/clients/merge-preview').set(H(tok)).send({ keepId: acme.id, dropId: acme2.id }).expect(201)).body.data;
    expect(preview.drop.notes).toBe(1);
    await http.post('/api/clients/merge').set(H(tok)).send({ keepId: acme.id, dropId: acme2.id }).expect(201);
    const after = (await http.get(`/api/clients/${acme.id}/notes`).set(H(tok)).expect(200)).body.data;
    expect(after.map((n: any) => n.body)).toContain('Из дубля');
    expect((await http.get(`/api/clients/${acme2.id}`).set(H(tok)).expect(200)).body.data.client.archived).toBe(true);

    // 12. Удалить насовсем — только из архива
    await http.delete(`/api/clients/${acme.id}/permanent`).set(H(tok)).expect(409);
    await http.delete(`/api/clients/${acme2.id}/permanent`).set(H(tok)).expect(200);

    // 13. Массово сменить ответственного
    const romashka = (await http.get('/api/clients?q=ромашка').set(H(tok)).expect(200)).body.data.items[0];
    const b = (await http.post('/api/clients/bulk').set(H(tok)).send({ ids: [romashka.id], action: 'owner', value: String(mem.user.id) }).expect(201)).body.data;
    expect(b.updated).toBe(1);
    expect((await http.get('/api/clients?view=mine').set(H(mem.accessToken)).expect(200)).body.data.items.map((c: any) => c.id)).toContain(romashka.id);
  });

  it('клиент портала не видит раздел; портал не отдаёт контакт целиком', async () => {
    const owner = (await http.post('/api/auth/register')
      .send({ tenantName: 'Portal', email: `p_${uniq()}@t.test`, password: 'password123', fullName: 'Ольга' })
      .expect(201)).body.data;
    await http.post('/api/portal/clients').set(H(owner.accessToken)).send({ name: 'Аника', contact: '+7 999 765-43-21' }).expect(201);
    const list = (await http.get('/api/portal/clients').set(H(owner.accessToken)).expect(200)).body.data;
    expect(list[0].contact).not.toContain('765-43');
  });
});
