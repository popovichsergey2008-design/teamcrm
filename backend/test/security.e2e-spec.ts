import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AddressInfo } from 'net';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { AllExceptionsFilter } from '../src/common/http/all-exceptions.filter';
import { ResponseInterceptor } from '../src/common/http/response.interceptor';
import { RedisIoAdapter } from '../src/common/auth/redis-io.adapter';

/**
 * Централизованная безопасность (ТЗ «Central Security System»).
 *
 * Проверяем то, ради чего слой затевался и что ломается молча: владелец ограничивает
 * конкретного человека, ограниченный не может обойти запрет через API, контакты
 * приходят замаскированными и раскрываются только с правом и с записью в журнал, а
 * удалённая задача уходит в корзину, а не исчезает навсегда.
 */
describe('слой безопасности (e2e)', () => {
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
  afterAll(async () => { await app?.close(); });

  it('права, ограничение сотрудника, контакты и корзина', async () => {
    const owner = (await http.post('/api/auth/register')
      .send({ tenantName: 'Сейф', email: `sec_${uniq()}@t.test`, password: 'password123', fullName: 'Ольга Владелец' })
      .expect(201)).body.data;
    const O = H(owner.accessToken);

    const mateEmail = `sec_m_${uniq()}@t.test`;
    const mate = (await http.post('/api/users').set(O)
      .send({ email: mateEmail, fullName: 'Пётр Руководитель', password: 'password123', role: 'manager' })
      .expect(201)).body.data;
    const M = H((await http.post('/api/auth/login')
      .send({ email: mateEmail, password: 'password123' }).expect(201)).body.data.accessToken);

    // Права видны самому человеку — по ним интерфейс решает, что показывать.
    const mine = (await http.get('/api/security/me').set(M).expect(200)).body.data;
    expect(mine.permissions['contact.reveal'].allowed).toBe(true);
    expect(mine.permissions['security.manage']?.allowed ?? false).toBe(false);
    expect(mine.policy.contacts.defaultAccess).toBe('masked');

    // Руководитель не лезет в Центр безопасности — это право владельца.
    await http.get('/api/security/roles').set(M).expect(403);

    /*
      Главное: владелец ограничивает КОНКРЕТНОГО человека. «Всё, кроме контактов».
    */
    await http.post(`/api/security/users/${mate.id}/permissions`).set(O)
      .send({ 'contact.reveal': { allowed: false }, 'contact.export': { allowed: false } })
      .expect(201);
    const after = (await http.get('/api/security/me').set(M).expect(200)).body.data;
    expect(after.permissions['contact.reveal'].allowed).toBe(false);

    // Клиент с контактами.
    const client = (await http.post('/api/portal/clients').set(O)
      .send({ name: 'ООО «Ромашка»', contact: '+79990001122' }).expect(201)).body.data;

    // Владельцу контакт приходит замаскированным: полного значения нет даже в ответе.
    const view = (await http.get(`/api/security/clients/${client.id}/contacts`).set(O).expect(200)).body.data;
    expect(view.fields.contact.masked).toBe(true);
    expect(String(view.fields.contact.value)).toContain('•');
    expect(String(view.fields.contact.value)).not.toContain('0001');

    // Ограниченный сотрудник раскрыть не может — и это решает сервер, а не экран.
    await http.post(`/api/security/clients/${client.id}/reveal`).set(M).send({ field: 'contact' }).expect(403);

    // Владелец раскрывает — значение приходит, и остаётся след.
    const revealed = (await http.post(`/api/security/clients/${client.id}/reveal`).set(O)
      .send({ field: 'contact', reason: 'Связаться с клиентом' }).expect(201)).body.data;
    expect(revealed.value).toBe('+79990001122');
    const report = (await http.get('/api/security/contact-reveals').set(O).expect(200)).body.data;
    expect(report.items[0].field).toBe('contact');
    expect(report.items[0].reason).toBe('Связаться с клиентом');

    // Политика может требовать причину — тогда без неё отказ.
    await http.post('/api/security/policy').set(O)
      .send({ contacts: { defaultAccess: 'masked', requireReason: true, revealTtlSeconds: 300 } }).expect(201);
    await http.post(`/api/security/clients/${client.id}/reveal`).set(O).send({ field: 'contact' }).expect(400);

    /*
      Удаление задачи: в корзину, а не насовсем. Стереть окончательно вправе владелец.
    */
    const project = (await http.post('/api/projects').set(O).send({ name: 'Сайт' }).expect(201)).body.data;
    const task = (await http.post('/api/tasks').set(O)
      .send({ projectId: String(project.id), title: 'Удалить меня', confirmedWithoutTags: true }).expect(201)).body.data;

    await http.delete(`/api/tasks/${task.id}`).set(M).expect(200);
    // С доски пропала…
    const board = (await http.get(`/api/projects/${project.id}/board`).set(O).expect(200)).body.data;
    const onBoard = board.columns.flatMap((c: any) => c.tasks).map((t: any) => String(t.id));
    expect(onBoard).not.toContain(String(task.id));
    // …но лежит в корзине и возвращается.
    const trash = (await http.get('/api/tasks/trash').set(O).expect(200)).body.data;
    expect(trash.items.map((t: any) => String(t.id))).toContain(String(task.id));
    await http.post(`/api/tasks/${task.id}/restore`).set(O).expect(201);
    const board2 = (await http.get(`/api/projects/${project.id}/board`).set(O).expect(200)).body.data;
    expect(board2.columns.flatMap((c: any) => c.tasks).map((t: any) => String(t.id))).toContain(String(task.id));

    // Стереть насовсем руководителю нельзя — только владельцу.
    await http.delete(`/api/tasks/${task.id}?permanent=1`).set(M).expect(403);
    await http.delete(`/api/tasks/${task.id}?permanent=1`).set(O).expect(200);

    // Журнал безопасности помнит всё это и не редактируется.
    const audit = (await http.get('/api/security/audit').set(O).expect(200)).body.data;
    const events = audit.items.map((a: any) => a.event_type);
    expect(events).toEqual(expect.arrayContaining([
      'permission.changed', 'contact.revealed', 'task.deleted', 'task.restored', 'task.permanently_deleted',
      'security.policy.changed',
    ]));
  }, 120000);
});
