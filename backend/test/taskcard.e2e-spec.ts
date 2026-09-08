import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { AddressInfo } from 'net';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { AllExceptionsFilter } from '../src/common/http/all-exceptions.filter';
import { ResponseInterceptor } from '../src/common/http/response.interceptor';
import { RedisIoAdapter } from '../src/common/auth/redis-io.adapter';
import { AccessTokenPayload, RoleCode } from '../src/common/auth/jwt.types';

describe('Enhancements v1 — Task card (e2e)', () => {
  let app: INestApplication;
  let http: any;
  let jwt: JwtService;
  let secret: string;
  let token: string;
  let tenantId: string;
  let projectId: string;
  let taskId: string;
  const uniq = () => Math.random().toString(36).slice(2) + Date.now().toString(36);
  const A = () => ({ Authorization: `Bearer ${token}` });
  const synth = (role: RoleCode) => jwt.sign({ sub: '0', tenantId, role, email: `${role}@x.io` } as AccessTokenPayload, { secret, expiresIn: 300 });
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    app.useGlobalFilters(new AllExceptionsFilter());
    app.useGlobalInterceptors(new ResponseInterceptor());
    app.useWebSocketAdapter(new RedisIoAdapter(app));
    secret = app.get(ConfigService).getOrThrow('JWT_ACCESS_SECRET');
    jwt = app.get(JwtService);
    await app.listen(0, '0.0.0.0');
    http = request(`http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`);
    const reg = await http.post('/api/auth/register').send({ tenantName: 'Card', email: `o_${uniq()}@t.test`, password: 'password123', fullName: 'Owner' }).expect(201);
    token = reg.body.data.accessToken;
    tenantId = reg.body.data.user.tenantId;
    projectId = (await http.post('/api/projects').set(A()).send({ name: 'CardP' }).expect(201)).body.data.id;
    taskId = (await http.post('/api/tasks').set(A()).send({ projectId, title: 'Карточка' }).expect(201)).body.data.id;
  });
  afterAll(async () => app?.close());

  it('описание (markdown) + приоритет через PATCH', async () => {
    await http.patch(`/api/tasks/${taskId}`).set(A()).send({ description: '## Подробности\n- пункт', priority: 'high' }).expect(200);
  });

  it('комментарии: добавить/список; чужой не редактируется', async () => {
    const c = (await http.post(`/api/tasks/${taskId}/comments`).set(A()).send({ body: 'Первый коммент' }).expect(201)).body.data;
    const list = (await http.get(`/api/tasks/${taskId}/comments`).set(A()).expect(200)).body.data;
    expect(list.length).toBe(1);
    // синтетический member (не автор) не может править
    const m = synth('member');
    await http.patch(`/api/tasks/${taskId}/comments/${c.id}`).set({ Authorization: `Bearer ${m}` }).send({ body: 'хак' }).expect(403);
    // автор может
    await http.patch(`/api/tasks/${taskId}/comments/${c.id}`).set(A()).send({ body: 'Исправлено' }).expect(200);
  });

  it('вложения: загрузка → список → скачивание', async () => {
    const a = (await http.post(`/api/tasks/${taskId}/attachments`).set(A()).attach('file', png, { filename: 'doc.png', contentType: 'image/png' }).expect(201)).body.data;
    expect(a.fileId).toBeTruthy();
    const list = (await http.get(`/api/tasks/${taskId}/attachments`).set(A()).expect(200)).body.data;
    expect(list.length).toBe(1);
    await http.get(`/api/files/${a.fileId}`).set(A()).expect(200);
  });

  it('чеклист: добавить 2, отметить 1', async () => {
    const i1 = (await http.post(`/api/tasks/${taskId}/checklist`).set(A()).send({ text: 'шаг 1' }).expect(201)).body.data;
    await http.post(`/api/tasks/${taskId}/checklist`).set(A()).send({ text: 'шаг 2' }).expect(201);
    await http.patch(`/api/tasks/${taskId}/checklist/${i1.id}`).set(A()).send({ isDone: true }).expect(200);
    const list = (await http.get(`/api/tasks/${taskId}/checklist`).set(A()).expect(200)).body.data;
    expect(list.length).toBe(2);
    expect(list.filter((x: any) => x.is_done).length).toBe(1);
  });

  it('метки: создать справочник + назначить', async () => {
    const label = (await http.post('/api/labels').set(A()).send({ name: 'срочно', color: '#ff0000' }).expect(201)).body.data;
    await http.post(`/api/tasks/${taskId}/labels/${label.id}`).set(A()).expect(201);
    const tl = (await http.get(`/api/tasks/${taskId}/labels`).set(A()).expect(200)).body.data;
    expect(tl.some((l: any) => l.id === label.id)).toBe(true);
  });

  it('наблюдатели + история', async () => {
    await http.post(`/api/tasks/${taskId}/watchers`).set(A()).send({}).expect(201);
    const act = (await http.get(`/api/tasks/${taskId}/activity`).set(A()).expect(200)).body.data;
    const kinds = act.map((a: any) => a.kind);
    expect(kinds).toContain('created');
    expect(kinds).toContain('commented');
    expect(kinds).toContain('attached');
    expect(kinds).toContain('checklist');
    expect(kinds).toContain('updated');
  });

  it('доска обогащена: метки, счётчики, прогресс чеклиста, приоритет', async () => {
    const board = (await http.get(`/api/projects/${projectId}/board`).set(A()).expect(200)).body.data;
    const t = board.columns.flatMap((c: any) => c.tasks).find((x: any) => x.id === taskId);
    expect(t.priority).toBe('high');
    expect(t.labels.length).toBe(1);
    expect(t.commentsCount).toBe(1);
    expect(t.attachmentsCount).toBe(1);
    expect(t.checklistTotal).toBe(2);
    expect(t.checklistDone).toBe(1);
  });

  it('client-изоляция: client не видит комментарии/метки карточки (403)', async () => {
    const c = synth('client');
    expect((await http.get(`/api/tasks/${taskId}/comments`).set({ Authorization: `Bearer ${c}` })).status).toBe(403);
    expect((await http.get('/api/labels').set({ Authorization: `Bearer ${c}` })).status).toBe(403);
  });

  /**
   * Файл сообщением и ответ на выделенный кусок.
   *
   * Раньше, чтобы показать скриншот в обсуждении, надо было уйти во «Файлы», загрузить,
   * вернуться и написать «см. вложение». А ответ цитировал сообщение целиком, и под
   * простынёй текста «да, согласен» не отвечало, с чем именно согласны.
   */
  it('файл уходит сообщением и остаётся вложением; цитируется выделенный кусок', async () => {
    const before = (await http.get(`/api/tasks/${taskId}/activity`).set(A()).expect(200)).body.data.length;

    const msg = (await http.post(`/api/tasks/${taskId}/comments/file`).set(A())
      .field('body', 'вот как это выглядит')
      .attach('file', png, { filename: 'screen.png', contentType: 'image/png' })
      .expect(201)).body.data;
    expect(msg.file_id).toBeTruthy();

    const list = (await http.get(`/api/tasks/${taskId}/comments`).set(A()).expect(200)).body.data;
    const withFile = list.find((c: any) => String(c.id) === String(msg.id));
    expect(withFile.file_name).toBe('screen.png');

    // файл виден и во вкладке «Файлы»: она отвечает на вопрос «что вообще есть по задаче»
    const files = (await http.get(`/api/tasks/${taskId}/attachments`).set(A()).expect(200)).body.data;
    expect(files.some((f: any) => f.file_name === 'screen.png')).toBe(true);

    // в истории ОДНА новая запись — про сообщение, и по её commentId строится ссылка
    const after = (await http.get(`/api/tasks/${taskId}/activity`).set(A()).expect(200)).body.data;
    expect(after.length).toBe(before + 1);
    expect(after[0].kind).toBe('commented');
    expect(String(after[0].detail.commentId)).toBe(String(msg.id));

    // ответ на выделенный кусок цитирует именно его, а не всё сообщение
    const reply = (await http.post(`/api/tasks/${taskId}/comments`).set(A())
      .send({ body: 'да, согласен', replyToId: String(msg.id), replyExcerpt: 'как это выглядит' })
      .expect(201)).body.data;
    const list2 = (await http.get(`/api/tasks/${taskId}/comments`).set(A()).expect(200)).body.data;
    const shown = list2.find((c: any) => String(c.id) === String(reply.id));
    expect(shown.reply_body).toBe('как это выглядит');
  });

  /**
   * Порядок и объём переписки.
   *
   * Со своей задачей, а не с общей: тесты этого файла делят состояние, и лишний
   * комментарий в общей задаче ломает счётчики доски ниже по файлу — уже наступали.
   *
   * Проверяем то, ради чего переписка стала отдаваться хвостом: порядок остаётся
   * обычным (старое первым — это переписка, а не список «сначала последнее»), а
   * «поднять всю» отдаёт то же самое, пока сотен сообщений не набралось.
   */
  it('переписка задачи: порядок обычный, «поднять всю» отдаёт то же', async () => {
    const project = (await http.post('/api/projects').set(A())
      .send({ name: `Переписка ${Date.now()}` }).expect(201)).body.data;
    const task = (await http.post('/api/tasks').set(A())
      .send({ projectId: project.id, title: 'Обсуждаемая' }).expect(201)).body.data;

    for (const body of ['Первое', 'Второе', 'Третье']) {
      await http.post(`/api/tasks/${task.id}/comments`).set(A()).send({ body }).expect(201);
    }

    const tail = (await http.get(`/api/tasks/${task.id}/comments`).set(A()).expect(200)).body.data;
    expect(tail.map((c: any) => c.body)).toEqual(['Первое', 'Второе', 'Третье']);

    const all = (await http.get(`/api/tasks/${task.id}/comments?all=1`).set(A()).expect(200)).body.data;
    expect(all.map((c: any) => c.body)).toEqual(['Первое', 'Второе', 'Третье']);
  });
});
