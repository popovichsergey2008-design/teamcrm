import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { AddressInfo } from 'net';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { AccessTokenPayload, RoleCode } from '../src/common/auth/jwt.types';
import { AllExceptionsFilter } from '../src/common/http/all-exceptions.filter';
import { ResponseInterceptor } from '../src/common/http/response.interceptor';
import { DbService } from '../src/database/db.service';
import { AiService } from '../src/modules/ai/ai.service';

/**
 * Инфоцентр проекта и ИИ-библиотекарь (#4659).
 *
 * Границы: закрытый проект — 404 постороннему участнику компании, клиенту — 403;
 * файл Инфоцентра закрытого проекта посторонний не скачает; решения закрытого проекта
 * не уходят постороннему и через журнал решений (дыра этапа 0); правка паспорта,
 * записи, роли в команде; библиотекарь без ключа ИИ раскладывает ссылку Figma из чата
 * проекта и GitHub из комментария закрытой задачи; бейдж гаснет после просмотра;
 * повтор ссылки не плодит записей; отменённая запись ИИ не возвращается.
 */
describe('Инфоцентр проекта (e2e)', () => {
  let app: INestApplication;
  let http$: any;
  let db: DbService;
  let ai: AiService;
  let jwt: JwtService;
  let accessSecret: string;
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
    ai = app.get(AiService);
    jwt = app.get(JwtService);
    accessSecret = app.get(ConfigService).getOrThrow<string>('JWT_ACCESS_SECRET');
  });
  afterAll(async () => app?.close());

  async function setup() {
    const owner = (await http$.post('/api/auth/register')
      .send({ acceptPrivacy: true, tenantName: 'Инфоцентр', email: `hub_${uniq()}@t.test`, password: 'Test-pass-2026', fullName: 'Ольга Владелец' }).expect(201)).body.data;
    const O = H(owner.accessToken);
    const mk = async (name: string) => {
      const email = `hubm_${uniq()}@t.test`;
      const u = (await http$.post('/api/users').set(O).send({ email, fullName: name, password: 'Test-pass-2026', role: 'member' }).expect(201)).body.data;
      const tok = (await http$.post('/api/auth/login').send({ email, password: 'Test-pass-2026' }).expect(201)).body.data.accessToken;
      return { id: String(u.id), H: H(tok) };
    };
    const member = await mk('Дина Дизайнер');
    const stranger = await mk('Пётр Посторонний');
    const project = (await http$.post('/api/projects').set(O).send({ name: 'Лендинг', description: 'Сайт для продаж' }).expect(201)).body.data;
    await http$.patch(`/api/projects/${project.id}`).set(O).send({ visibility: 'members' }).expect(200);
    await http$.post(`/api/projects/${project.id}/members`).set(O).send({ userIds: [member.id] }).expect(201);
    const client = jwt.sign(
      { sub: '0', tenantId: owner.user.tenantId, role: 'client' as RoleCode, email: 'c@x.io' } as AccessTokenPayload,
      { secret: accessSecret, expiresIn: 300 },
    );
    return { owner, O, member, stranger, project, pid: String(project.id), client: H(client), tenantId: String(owner.user.tenantId) };
  }

  it('права, паспорт, записи, команда, файл и решения закрытого проекта', async () => {
    const { O, member, stranger, pid, client, tenantId } = await setup();
    const url = `/api/projects/${pid}/hub`;

    // закрытый проект: посторонний — «не найдено», клиент — 403, чужая компания — 404
    await http$.get(url).set(stranger.H).expect(404);
    await http$.get(url).set(client).expect(403);
    const alien = (await http$.post('/api/auth/register')
      .send({ acceptPrivacy: true, tenantName: 'Чужие', email: `huba_${uniq()}@t.test`, password: 'Test-pass-2026', fullName: 'Чужой' }).expect(201)).body.data;
    await http$.get(url).set(H(alien.accessToken)).expect(404);
    await http$.post(`${url}/items`).set(stranger.H)
      .send({ section: 'knowledge', kind: 'link', title: 'x', url: 'https://example.com' }).expect(404);

    const hub = (await http$.get(url).set(member.H).expect(200)).body.data;
    expect(hub.canEdit).toBe(true);
    expect(hub.canRunLibrarian).toBe(false);
    expect(hub.project.description).toBe('Сайт для продаж');
    expect(hub.passport).toEqual([]);
    expect(hub.decisions).toEqual({ items: [], total: 0 });
    expect(hub.librarian).toEqual({ lastRun: null, unseen: null });

    // паспорт правит участник; выключить библиотекаря — только руководство
    const pass = (await http$.patch(`${url}/passport`).set(member.H)
      .send({ mission: 'Продавать курсы без звонков', audience: 'Взрослые, 25–45', description: 'Лендинг курсов' }).expect(200)).body.data;
    expect(pass).toMatchObject({ mission: 'Продавать курсы без звонков', audience: 'Взрослые, 25–45', description: 'Лендинг курсов', hubLibrarian: true });
    await http$.patch(`${url}/passport`).set(member.H).send({ hubLibrarian: false }).expect(403);
    await http$.patch(`${url}/passport`).set(O).send({ mission: 'x'.repeat(301) }).expect(400);

    // записи: ссылка, повтор — 409, неверная категория — 400, правка ИИ-поля и «Убрать»
    const link = (await http$.post(`${url}/items`).set(member.H)
      .send({ section: 'passport', kind: 'link', category: 'site', title: 'Сайт', url: 'https://shop-example.ru' }).expect(201)).body.data;
    expect(link).toMatchObject({ section: 'passport', kind: 'link', category: 'site', source: 'manual', createdBy: { id: member.id } });
    await http$.post(`${url}/items`).set(O)
      .send({ section: 'passport', kind: 'link', category: 'site', title: 'Сайт ещё раз', url: 'https://shop-example.ru' }).expect(409);
    await http$.post(`${url}/items`).set(O)
      .send({ section: 'passport', kind: 'link', category: 'design', title: 'x', url: 'https://a.ru' }).expect(400);
    await http$.post(`${url}/items`).set(O)
      .send({ section: 'knowledge', kind: 'link', title: 'x', url: 'javascript:alert(1)' }).expect(400);
    const note = (await http$.post(`${url}/items`).set(O)
      .send({ section: 'knowledge', kind: 'note', title: 'Цвет кнопок', body: 'Основной #00E599' }).expect(201)).body.data;
    const pinned = (await http$.patch(`${url}/items/${note.id}`).set(member.H).send({ pinned: true }).expect(200)).body.data;
    expect(pinned.pinned).toBe(true);
    const contact = (await http$.post(`${url}/items`).set(O)
      .send({ section: 'team', kind: 'contact', category: 'contractor', title: 'Студия', contact: { name: 'Иван', phone: '+7 999 000-00-00' } }).expect(201)).body.data;
    expect(contact.contact).toEqual({ name: 'Иван', phone: '+7 999 000-00-00' });
    await http$.post(`${url}/items`).set(O)
      .send({ section: 'knowledge', kind: 'contact', title: 'не туда', contact: { name: 'Иван' } }).expect(400);
    await http$.delete(`${url}/items/${note.id}`).set(member.H).expect(200);
    await http$.delete(`${url}/items/${note.id}`).set(member.H).expect(404);

    // команда: роль и ответственность участника; не участник — 404
    const m = (await http$.patch(`${url}/members/${member.id}`).set(O)
      .send({ roleTitle: 'Дизайнер', responsibility: 'Макеты и брендбук' }).expect(200)).body.data;
    expect(m).toMatchObject({ userId: member.id, roleTitle: 'Дизайнер', responsibility: 'Макеты и брендбук' });
    await http$.patch(`${url}/members/${stranger.id}`).set(O).send({ roleTitle: 'x' }).expect(404);

    // файл Инфоцентра: участнику — да, постороннему — «не найден»; чужой файл к записи не прицепить
    const file = (await http$.post('/api/files').set(O)
      .field('ownerKind', 'project_hub').field('ownerId', pid)
      .attach('file', Buffer.from('Регламент выгрузки отчётов'), { filename: 'Регламент.txt', contentType: 'text/plain' }).expect(201)).body.data;
    const fileItem = (await http$.post(`${url}/items`).set(O)
      .send({ section: 'knowledge', kind: 'file', category: 'regulation', title: 'Регламент', fileId: String(file.id) }).expect(201)).body.data;
    expect(fileItem.fileName).toBe('Регламент.txt');
    await http$.get(`/api/files/${file.id}`).set(member.H).expect(200);
    await http$.get(`/api/files/${file.id}`).set(stranger.H).expect(404);
    const generic = (await http$.post('/api/files').set(O)
      .attach('file', Buffer.from('x'), { filename: 'x.txt', contentType: 'text/plain' }).expect(201)).body.data;
    await http$.post(`${url}/items`).set(O)
      .send({ section: 'knowledge', kind: 'file', title: 'x', fileId: String(generic.id) }).expect(400);

    // решение в чате закрытого проекта: постороннему не видно и через журнал решений (этап 0)
    const chat = (await http$.post(`/api/chats/project/${pid}`).set(O).expect(201)).body.data;
    await db.query(
      `INSERT INTO decisions (tenant_id, project_id, chat_id, text) VALUES ($1, $2, $3, 'Гостевые ссылки — без пароля')`,
      [tenantId, pid, chat.id],
    );
    const foreign = (await http$.get(`/api/chat-analysis/decisions?projectId=${pid}`).set(stranger.H).expect(200)).body.data;
    expect(foreign).toEqual([]);
    const own = (await http$.get(`/api/chat-analysis/decisions?projectId=${pid}`).set(member.H).expect(200)).body.data;
    expect(own.map((d: any) => d.text)).toEqual(['Гостевые ссылки — без пароля']);
    const chron = (await http$.get(`${url}/decisions?limit=5`).set(member.H).expect(200)).body.data;
    expect(chron.total).toBe(1);
    expect(chron.items[0]).toMatchObject({ text: 'Гостевые ссылки — без пароля', source: 'chat', chatId: String(chat.id) });

    const full = (await http$.get(url).set(member.H).expect(200)).body.data;
    expect(full.project.mission).toBe('Продавать курсы без звонков');
    expect(full.passport.map((i: any) => i.title)).toEqual(['Сайт']);
    expect(full.knowledge.map((i: any) => i.title)).toEqual(['Регламент']);
    expect(full.team.contacts.map((i: any) => i.title)).toEqual(['Студия']);
    expect(full.team.members.find((x: any) => x.userId === member.id)?.roleTitle).toBe('Дизайнер');
    expect(full.decisions.total).toBe(1);

    // поиск по проекту — через мозг, в рамках проекта
    const ans = (await http$.post(`${url}/ask`).set(member.H).send({ q: 'Какой у нас основной цвет кнопок?' }).expect(201)).body.data;
    expect(typeof ans.answer).toBe('string');
    expect(Array.isArray(ans.citations)).toBe(true);
    await http$.post(`${url}/ask`).set(stranger.H).send({ q: 'Какой цвет?' }).expect(404);
  });

  it('библиотекарь без ключа: Figma из чата, GitHub из комментария закрытой задачи, бейдж, повтор, отмена', async () => {
    const { O, owner, member, pid, tenantId } = await setup();
    const url = `/api/projects/${pid}/hub`;
    const noModel = !(await ai.hasModel(tenantId));

    const chat = (await http$.post(`/api/chats/project/${pid}`).set(O).expect(201)).body.data;
    await http$.post(`/api/chats/${chat.id}/messages`).set(member.H)
      .send({ body: 'Новый макет: https://www.figma.com/file/AbC123/Landing-v2?node-id=1 и созвон https://meet.google.com/abc-defg-hij, админка https://qevo.one/projects/1' })
      .expect(201);
    const task = (await http$.post('/api/tasks').set(O).send({ projectId: pid, assigneeId: member.id, title: 'Вёрстка' }).expect(201)).body.data;
    await http$.post(`/api/tasks/${task.id}/comments`).set(member.H).send({ body: 'Код тут: https://github.com/acme/landing' }).expect(201);
    await db.query(`UPDATE tasks SET closed_at = now() WHERE id = $1`, [task.id]);

    // «Собрать сейчас» — только руководство и ответственный
    await http$.post(`${url}/librarian/run`).set(member.H).expect(403);
    const r1 = (await http$.post(`${url}/librarian/run`).set(O).expect(201)).body.data;
    expect(r1.status).toBe('done');
    if (noModel) expect(r1.run.usedModel).toBe(false);
    const byUrl = (u: string) => r1.items.find((i: any) => i.url === u);
    expect(byUrl('https://figma.com/file/AbC123/Landing-v2?node-id=1')).toMatchObject({
      section: 'knowledge', category: 'design', source: 'ai', createdBy: null, removed: false,
      origin: { type: 'chat_message', chatId: String(chat.id) },
    });
    expect(byUrl('https://github.com/acme/landing')).toMatchObject({
      section: 'knowledge', category: 'repo', source: 'ai', origin: { type: 'comment', taskId: String(task.id) },
    });
    // созвон и ссылка на саму систему — мусор
    expect(r1.items.some((i: any) => /meet\.google|qevo\.one/.test(i.url ?? ''))).toBe(false);
    if (noModel) expect(r1.run.added).toEqual({ links: 2, files: 0, contacts: 0, notes: 0, decisions: 0 });

    // бейдж: виден участнику, гаснет после просмотра; у владельца — свой
    let hub = (await http$.get(url).set(member.H).expect(200)).body.data;
    expect(hub.librarian.unseen?.id).toBe(r1.run.id);
    expect(hub.librarian.lastRun?.id).toBe(r1.run.id);
    expect(hub.knowledge.filter((i: any) => i.source === 'ai')).toHaveLength(2);
    const detail = (await http$.get(`${url}/runs/${r1.run.id}`).set(member.H).expect(200)).body.data;
    expect(detail.items).toHaveLength(r1.items.length);
    await http$.post(`${url}/runs/${r1.run.id}/seen`).set(member.H).expect(201);
    hub = (await http$.get(url).set(member.H).expect(200)).body.data;
    expect(hub.librarian.unseen).toBeNull();
    expect((await http$.get(url).set(O).expect(200)).body.data.librarian.unseen?.id).toBe(r1.run.id);

    // повтор той же ссылки (с меткой рекламы) — новой записи нет
    await http$.post(`/api/chats/${chat.id}/messages`).set(O)
      .send({ body: 'ещё раз макет http://figma.com/file/AbC123/Landing-v2?node-id=1&utm_source=tg' }).expect(201);
    const r2 = (await http$.post(`${url}/librarian/run`).set(O).expect(201)).body.data;
    expect(r2.items).toEqual([]);
    expect(r2.run.added.links).toBe(0);
    // пустой прогон бейдж не зажигает
    expect((await http$.get(url).set(member.H).expect(200)).body.data.librarian.unseen).toBeNull();

    // отмена ИИ-записи: убрана, в «что добавил ИИ» — с пометкой, следующим прогоном не возвращается
    const figma = byUrl('https://figma.com/file/AbC123/Landing-v2?node-id=1');
    await http$.delete(`${url}/items/${figma.id}`).set(member.H).expect(200);
    const after = (await http$.get(`${url}/runs/${r1.run.id}`).set(member.H).expect(200)).body.data;
    expect(after.items.find((i: any) => i.id === figma.id)?.removed).toBe(true);
    const r3 = (await http$.post(`${url}/librarian/run`).set(O).expect(201)).body.data;
    expect(r3.items.some((i: any) => /figma/.test(i.url ?? ''))).toBe(false);
    hub = (await http$.get(url).set(O).expect(200)).body.data;
    expect(hub.knowledge.some((i: any) => /figma/.test(i.url ?? ''))).toBe(false);

    // человек поправил ИИ-запись — она становится ручной
    const gh = byUrl('https://github.com/acme/landing');
    const edited = (await http$.patch(`${url}/items/${gh.id}`).set(member.H).send({ title: 'Репозиторий лендинга' }).expect(200)).body.data;
    expect(edited.source).toBe('manual');

    // выключенный библиотекарь утром проект не берёт
    await http$.patch(`${url}/passport`).set(O).send({ hubLibrarian: false }).expect(200);
    const due = await db.many<{ project_id: string }>(
      `SELECT id::text AS project_id FROM projects WHERE id = $1 AND hub_librarian`, [pid],
    );
    expect(due).toEqual([]);
    void owner;
  });
});
