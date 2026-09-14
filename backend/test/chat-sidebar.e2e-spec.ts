import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AddressInfo } from 'net';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { AllExceptionsFilter } from '../src/common/http/all-exceptions.filter';
import { ResponseInterceptor } from '../src/common/http/response.interceptor';
import { RedisIoAdapter } from '../src/common/auth/redis-io.adapter';
import { extractLinks } from '../src/modules/chats/chats.service';

/**
 * Сайдбар чата (ТЗ-5, этап 2): сведения, участники по ролям, материалы, аудит.
 */
describe('Сайдбар чата (e2e)', () => {
  let app: INestApplication;
  let http$: any;
  const uniq = () => Math.random().toString(36).slice(2) + Date.now().toString(36);
  const H = (t: string) => ({ Authorization: `Bearer ${t}` });
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5, 6, 7, 8]);

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
  });
  afterAll(async () => app?.close());

  it('ссылки вынимаются из текста без хвостовой пунктуации и без дублей', () => {
    expect(extractLinks('см. https://figma.com/x, и ещё https://figma.com/x. А тут www.site.ru/a)'))
      .toEqual(['https://figma.com/x', 'www.site.ru/a']);
    expect(extractLinks('без адресов')).toEqual([]);
  });

  it('роли: создатель — владелец; администратора назначает владелец; участник — нет', async () => {
    const owner = (await http$.post('/api/auth/register')
      .send({ tenantName: 'SB', email: `sb_${uniq()}@t.test`, password: 'password123', fullName: 'Сергей' }).expect(201)).body.data;
    const make = async (name: string) => {
      const mail = `sb_${uniq()}@t.test`;
      const u = (await http$.post('/api/users').set(H(owner.accessToken))
        .send({ email: mail, fullName: name, password: 'password123', role: 'member' }).expect(201)).body.data;
      const login = (await http$.post('/api/auth/login').send({ email: mail, password: 'password123' }).expect(201)).body.data;
      return { id: String(u.id), token: login.accessToken };
    };
    const gleb = await make('Глеб');
    const yura = await make('Юрий');
    const O = H(owner.accessToken);

    const group = (await http$.post('/api/chats/groups').set(O)
      .send({ title: 'TeamCRM Development', userIds: [gleb.id, yura.id] }).expect(201)).body.data;

    // сведения: тип, приватность, автор, участники по ролям
    const info = (await http$.get(`/api/chats/${group.id}/info`).set(H(gleb.token)).expect(200)).body.data;
    expect(info.chat.kind).toBe('group');
    expect(info.chat.title).toBe('TeamCRM Development');
    expect(String(info.chat.createdBy)).toBe(String(owner.user.id));
    expect(info.members.find((m: any) => String(m.userId) === String(owner.user.id)).role).toBe('owner');
    expect(info.members.find((m: any) => m.userId === gleb.id).role).toBe('member');
    expect(info.me.role).toBe('member');
    expect(info.me.canManage).toBe(false);

    // участник не назначает администраторов; владелец — да
    await http$.patch(`/api/chats/${group.id}/members/${yura.id}/role`).set(H(gleb.token)).send({ role: 'admin' }).expect(403);
    await http$.patch(`/api/chats/${group.id}/members/${gleb.id}/role`).set(O).send({ role: 'admin' }).expect(200);
    // владельца не разжаловать
    await http$.patch(`/api/chats/${group.id}/members/${owner.user.id}/role`).set(O).send({ role: 'member' }).expect(404);

    // администратор управляет: меняет описание, убирает участника; владельца убрать нельзя
    const asGleb = (await http$.get(`/api/chats/${group.id}/info`).set(H(gleb.token)).expect(200)).body.data;
    expect(asGleb.me.role).toBe('admin');
    expect(asGleb.me.canManage).toBe(true);
    await http$.patch(`/api/chats/${group.id}/description`).set(H(gleb.token)).send({ description: 'Регламент: отвечаем в течение часа' }).expect(200);
    await http$.delete(`/api/chats/${group.id}/members/${owner.user.id}`).set(H(gleb.token)).expect(400);
    await http$.delete(`/api/chats/${group.id}/members/${yura.id}`).set(H(gleb.token)).expect(200);

    const after = (await http$.get(`/api/chats/${group.id}/info`).set(O).expect(200)).body.data;
    expect(after.chat.description).toBe('Регламент: отвечаем в течение часа');
    expect(after.members.map((m: any) => m.userId)).not.toContain(yura.id);

    // журнал помнит всё это по порядку — новое первым
    const audit = (await http$.get(`/api/chats/${group.id}/audit`).set(O).expect(200)).body.data;
    expect(audit.map((a: any) => a.action)).toEqual(['member_removed', 'description_changed', 'admin_granted', 'created']);
    expect(audit[0].detail.name).toBe('Юрий');

    // посторонний сведений не видит
    const stranger = await make('Чужой');
    await http$.get(`/api/chats/${group.id}/info`).set(H(stranger.token)).expect(403);
  });

  it('материалы: картинка — медиа, ссылка — во вкладке ссылок, сохранённое — только своё', async () => {
    const owner = (await http$.post('/api/auth/register')
      .send({ tenantName: 'SB2', email: `sb2_${uniq()}@t.test`, password: 'password123', fullName: 'Сергей' }).expect(201)).body.data;
    const O = H(owner.accessToken);
    const mail = `sb2m_${uniq()}@t.test`;
    const mate = (await http$.post('/api/users').set(O).send({ email: mail, fullName: 'Глеб', password: 'password123', role: 'member' }).expect(201)).body.data;
    const M = H((await http$.post('/api/auth/login').send({ email: mail, password: 'password123' }).expect(201)).body.data.accessToken);

    const chat = (await http$.post('/api/chats/dm').set(O).send({ userId: mate.id }).expect(201)).body.data;
    const withLink = (await http$.post(`/api/chats/${chat.id}/messages`).set(O).send({ body: 'макет тут https://figma.com/file/abc' }).expect(201)).body.data;
    await http$.post(`/api/chats/${chat.id}/files`).set(O)
      .attach('files', png, { filename: 'shot.png', contentType: 'image/png' }).expect(201);
    await http$.post(`/api/chats/${chat.id}/files`).set(O)
      .attach('files', Buffer.from('%PDF-1.4 test'), { filename: 'brief.pdf', contentType: 'application/pdf' }).expect(201);

    const info = (await http$.get(`/api/chats/${chat.id}/info`).set(M).expect(200)).body.data;
    expect(info.counts).toMatchObject({ media: 1, docs: 1, files: 1, links: 1, voice: 0 });

    const media = (await http$.get(`/api/chats/${chat.id}/materials?kind=media`).set(M).expect(200)).body.data.items;
    expect(media.map((i: any) => i.name)).toEqual(['shot.png']);
    expect(media[0].authorName).toBe('Сергей');
    const docs = (await http$.get(`/api/chats/${chat.id}/materials?kind=docs`).set(M).expect(200)).body.data.items;
    expect(docs.map((i: any) => i.name)).toEqual(['brief.pdf']);
    const links = (await http$.get(`/api/chats/${chat.id}/materials?kind=links`).set(M).expect(200)).body.data.items;
    expect(links).toEqual([expect.objectContaining({ url: 'https://figma.com/file/abc', messageId: String(withLink.id) })]);
    await http$.get(`/api/chats/${chat.id}/materials?kind=weird`).set(M).expect(400);

    // сохранённое — личное: коллега сохранил, у меня в блоке пусто
    await http$.post(`/api/chats/${chat.id}/messages/${withLink.id}/save`).set(M).expect(201);
    expect((await http$.get(`/api/chats/${chat.id}/saved`).set(M).expect(200)).body.data.map((m: any) => String(m.id))).toEqual([String(withLink.id)]);
    expect((await http$.get(`/api/chats/${chat.id}/saved`).set(O).expect(200)).body.data).toEqual([]);
  });
});
