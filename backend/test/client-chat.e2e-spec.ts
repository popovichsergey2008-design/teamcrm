import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AddressInfo } from 'net';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { AllExceptionsFilter } from '../src/common/http/all-exceptions.filter';
import { ResponseInterceptor } from '../src/common/http/response.interceptor';
import { RedisIoAdapter } from '../src/common/auth/redis-io.adapter';

/**
 * Клиент в чате без регистрации (#4902, п. 15).
 *
 * «Готово, когда»: клиент без регистрации пишет в чат и входит в звонок; ни одно
 * внутреннее сообщение ему не доступно. Это и проверяем — через публичные ручки,
 * без единого токена сотрудника у гостя.
 */
describe('чат с клиентом без регистрации (e2e)', () => {
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

  it('гость пишет, видит открытые задачи, входит в звонок — и не видит внутреннего', async () => {
    const owner = (await http.post('/api/auth/register')
      .send({ acceptPrivacy: true, tenantName: 'CC', email: `cc_${uniq()}@t.test`, password: 'Test-pass-2026', fullName: 'Ольга' })
      .expect(201)).body.data;
    const O = H(owner.accessToken);

    const project = (await http.post('/api/projects').set(O).send({ name: 'Сайт Вектора' }).expect(201)).body.data;
    const inner = (await http.post(`/api/chats/project/${project.id}`).set(O).expect(201)).body.data;
    await http.post(`/api/chats/${inner.id}/messages`).set(O).send({ body: 'Клиент опять поменял требования' }).expect(201);
    const outer = (await http.post('/api/chats/external').set(O).send({ title: 'ООО Вектор' }).expect(201)).body.data;
    await http.post(`/api/chats/${outer.id}/messages`).set(O).send({ body: 'Добрый день! Макет в пятницу' }).expect(201);

    // ссылка — только у внешнего чата
    await http.post(`/api/client-chat/chats/${inner.id}/links`).set(O).send({}).expect(403);
    const link = (await http.post(`/api/client-chat/chats/${outer.id}/links`).set(O).send({ label: 'Вектор', days: 30 }).expect(201)).body.data;
    const token = String(link.url).split('/cc/').pop();

    const task = (await http.post('/api/tasks').set(O).send({ projectId: project.id, title: 'Макет главной' }).expect(201)).body.data;
    await http.post(`/api/client-chat/chats/${outer.id}/tasks`).set(O).send({ taskId: String(task.id) }).expect(201);

    // гость: без учётки, по ссылке
    const info = (await http.get(`/api/client-chat/public/${token}`).expect(200)).body.data;
    expect(info).toMatchObject({ valid: true, title: 'Вектор' });
    const joined = (await http.post(`/api/client-chat/public/${token}/join`).send({ name: 'Иван Петров' }).expect(201)).body.data;
    const session = joined.session as string;

    const feed = (await http.post('/api/client-chat/public/session/messages').send({ session }).expect(201)).body.data;
    expect(feed.some((m: any) => m.body.includes('Макет в пятницу'))).toBe(true);
    expect(feed.some((m: any) => m.body.includes('поменял требования'))).toBe(false);
    expect(JSON.stringify(feed)).not.toMatch(/chat_id|task_id|author_id/);

    // пишет — сотрудник видит это обычным сообщением с именем гостя
    await http.post('/api/client-chat/public/session/send').send({ session, body: 'Как там макет главной?' }).expect(201);
    const staffFeed = (await http.get(`/api/chats/${outer.id}/messages`).set(O).expect(200)).body.data;
    expect(staffFeed.find((m: any) => m.guest_name)?.guest_name).toBe('Иван Петров');

    // статусы — только открытые задачи, без номеров
    const tasks = (await http.post('/api/client-chat/public/session/tasks').send({ session }).expect(201)).body.data;
    expect(tasks.tasks.map((t: any) => t.title)).toEqual(['Макет главной']);
    expect(Object.keys(tasks.tasks[0])).not.toContain('id');

    // подсказка сотруднику статусом задач
    const hint = (await http.post(`/api/client-chat/chats/${outer.id}/suggest`).set(O).send({}).expect(201)).body.data;
    expect(hint).toMatchObject({ done: 0, total: 1, scope: 'opened' });
    expect(hint.text.length).toBeGreaterThan(5);

    // звонок — обычный гостевой вход в созвон этого чата
    const callUrl = (await http.post('/api/client-chat/public/session/call').send({ session }).expect(201)).body.data.url as string;
    const meetToken = callUrl.split('/meet/').pop();
    const meet = (await http.get(`/api/meet/guest/${meetToken}`).expect(200)).body.data;
    expect(meet).toMatchObject({ valid: true, hasChat: true });
    const again = (await http.post('/api/client-chat/public/session/call').send({ session }).expect(201)).body.data.url;
    expect(again).toBe(callUrl); // одна ссылка созвона на ссылку чата
    const inCall = (await http.post(`/api/meet/guest/${meetToken}/join`).send({ name: 'Иван Петров' }).expect(201)).body.data;
    expect(String(inCall.chatId)).toBe(String(outer.id));

    // поддельный ключ — ничего
    await http.post('/api/client-chat/public/session/messages').send({ session: 'x'.repeat(32) }).expect(401);

    // отзыв — сразу: ни переписки, ни созвона
    const overview = (await http.get(`/api/client-chat/chats/${outer.id}`).set(O).expect(200)).body.data;
    await http.delete(`/api/client-chat/links/${overview.links[0].id}`).set(O).expect(200);
    await http.post('/api/client-chat/public/session/messages').send({ session }).expect(401);
    await http.post('/api/client-chat/public/session/send').send({ session, body: 'ещё' }).expect(401);
    expect((await http.get(`/api/meet/guest/${meetToken}`).expect(200)).body.data.valid).toBe(false);
  }, 60000);
});
