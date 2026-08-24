import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AddressInfo } from 'net';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { AllExceptionsFilter } from '../src/common/http/all-exceptions.filter';
import { ResponseInterceptor } from '../src/common/http/response.interceptor';
import { RedisIoAdapter } from '../src/common/auth/redis-io.adapter';

/**
 * Поиск для командной строки (ТЗ-2, этап 2, Ш1).
 *
 * Главное здесь не «находит», а «не находит лишнего»: поиск ходит сразу по всем таблицам,
 * и одна забытая проверка доступа показывает человеку чужую переписку. Поэтому переписка
 * проверяется с двух сторон — участник видит, посторонний нет.
 */
describe('ТЗ-2 — поиск (e2e)', () => {
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

  const find = (tok: string, q: string) =>
    http.get(`/api/search?q=${encodeURIComponent(q)}`).set(H(tok)).expect(200).then((r: any) => r.body.data);

  it('находит своё и не показывает чужую переписку', async () => {
    const marker = uniq(); // уникальное слово: в общей базе тестов ничего лишнего не подцепим

    const owner = (await http.post('/api/auth/register')
      .send({ tenantName: 'Search', email: `s_${uniq()}@t.test`, password: 'password123', fullName: 'Ольга Владелец' })
      .expect(201)).body.data;
    const tok = owner.accessToken;

    // второй сотрудник — он в общий чат не входит
    const memEmail = `s_m_${uniq()}@t.test`;
    const inv = (await http.post('/api/invites').set(H(tok)).send({ email: memEmail, role: 'member' }).expect(201)).body.data;
    await http.post('/api/invites/accept').send({ token: inv.token, fullName: 'Пётр Сотрудник', password: 'memberpass1' }).expect(201);
    const mem = (await http.post('/api/auth/login').send({ email: memEmail, password: 'memberpass1' }).expect(201)).body.data;
    const memTok = mem.accessToken;

    const proj = (await http.post('/api/projects').set(H(tok)).send({ name: `Проект ${marker}` }).expect(201)).body.data;
    const task = (await http.post('/api/tasks').set(H(tok))
      .send({ projectId: proj.id, title: `Задача ${marker} про договор` }).expect(201)).body.data;

    // 1. Задача и проект находятся по слову из названия
    const mine = await find(tok, marker);
    expect(mine.tasks.map((t: any) => String(t.id))).toContain(String(task.id));
    expect(mine.projects.map((p: any) => String(p.id))).toContain(String(proj.id));

    // 2. Задача находится по номеру — так её ищут, когда обсуждали в переписке
    const byId = await find(tok, String(task.id));
    expect(byId.tasks.map((t: any) => String(t.id))).toContain(String(task.id));

    // 3. Человек находится по имени
    expect((await find(tok, 'Пётр')).people.map((p: any) => p.full_name)).toContain('Пётр Сотрудник');

    // 4. Сообщение в закрытой группе: участник его находит…
    const chat = (await http.post('/api/chats/groups').set(H(tok))
      .send({ title: `Группа ${marker}`, userIds: [] }).expect(201)).body.data;
    await http.post(`/api/chats/${chat.id}/messages`).set(H(tok))
      .send({ body: `Секретное слово ${marker} и подробности` }).expect(201);

    const found = await find(tok, marker);
    expect(found.messages.length).toBeGreaterThan(0);
    expect(found.messages[0].body).toContain(marker);

    // 5. …а посторонний — нет. Ради этой строки и написан весь тест.
    const stranger = await find(memTok, marker);
    expect(stranger.messages).toEqual([]);
    // при этом задачи организации ему видны: закрыта переписка, а не работа
    expect(stranger.tasks.map((t: any) => String(t.id))).toContain(String(task.id));
  });

  it('слишком короткий запрос ничего не ищет', async () => {
    const owner = (await http.post('/api/auth/register')
      .send({ tenantName: 'Search2', email: `s2_${uniq()}@t.test`, password: 'password123', fullName: 'К' })
      .expect(201)).body.data;
    const empty = await find(owner.accessToken, 'а');
    expect(empty).toEqual({ query: 'а', tasks: [], projects: [], chats: [], messages: [], people: [], docs: [] });
  });
});
