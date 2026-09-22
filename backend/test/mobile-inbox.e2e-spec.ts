import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AddressInfo } from 'net';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { AllExceptionsFilter } from '../src/common/http/all-exceptions.filter';
import { ResponseInterceptor } from '../src/common/http/response.interceptor';
import { RedisIoAdapter } from '../src/common/auth/redis-io.adapter';
import { MailWorker } from '../src/modules/notifications/mail.worker';
import { DbService } from '../src/database/db.service';

/**
 * ТЗ-9, волна 4: ящик уведомлений с курсором, конфигурация клиента, политика организации.
 * Push здесь выключен (нет ключа FCM) — проверяем, что ящик наполняется и без него.
 */
describe('Mobile — ящик уведомлений и конфиг (e2e)', () => {
  let app: INestApplication;
  let http: any;
  let worker: MailWorker;
  let db: DbService;
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
    worker = app.get(MailWorker);
    db = app.get(DbService);
  });
  afterAll(async () => app?.close());

  /*
    Письмо рождается фоном (событие → RabbitMQ → очередь писем), и на загруженном
    раннере CI это занимает больше четырёх секунд. Ждём до десяти (два ожидания
    укладываются в 30 с теста) и падаем с именем: молчаливый выход отсюда
    превращался в «items.length: 0» строкой ниже.
  */
  async function waitMail(email: string, eventKey?: string): Promise<void> {
    for (let i = 0; i < 100; i++) {
      const rows = await db.many(
        `SELECT id FROM mail_outbox WHERE to_email=$1 AND ($2::text IS NULL OR event_key=$2)`, [email, eventKey ?? null],
      );
      if (rows.length) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`не дождались письма ${eventKey ?? ''} для ${email}`);
  }

  /*
    Ждём не письма, а записи в ящике.

    С `--runInBand` все наборы живут в одном процессе, и воркеры приложений, которые
    не закрыли `app`, продолжают тикать: чужой воркер забирает письмо и висит на зеркале
    в Telegram, а наш `tick()` уже ничего не находит. Обещание продукта — «событие ляжет
    в ящик», а не «наш проход его положит», его и проверяем: тикаем и опрашиваем до 10 с.
  */
  async function waitInbox(tok: string, after: string | null, eventKey: string): Promise<any> {
    for (let i = 0; i < 100; i++) {
      await worker.tick();
      const page = (await http.get(`/api/mobile/notifications${after ? `?after=${after}` : ''}`).set(H(tok)).expect(200)).body.data;
      if (page.items.some((x: any) => x.eventKey === eventKey)) return page;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`не дождались записи ${eventKey} в ящике`);
  }

  it('событие ложится в ящик с путём внутри приложения; курсор отдаёт только новое; прочитанное считается', async () => {
    const ownerEmail = `own_${uniq()}@t.test`;
    const owner = (await http.post('/api/auth/register')
      .send({ tenantName: 'Ящик', email: ownerEmail, password: 'password123', fullName: 'Ольга' }).expect(201)).body.data;
    const execEmail = `exe_${uniq()}@t.test`;
    const exec = (await http.post('/api/users').set(H(owner.accessToken))
      .send({ email: execEmail, password: 'password123', fullName: 'Иван', role: 'member' }).expect(201)).body.data;
    const execTok = (await http.post('/api/auth/login').send({ email: execEmail, password: 'password123' }).expect(201)).body.data.accessToken;

    // до событий — пусто, курсора нет
    const empty = (await http.get('/api/mobile/notifications').set(H(execTok)).expect(200)).body.data;
    expect(empty.items).toEqual([]);
    expect(empty.unread).toBe(0);

    const proj = (await http.post('/api/projects').set(H(owner.accessToken)).send({ name: 'Проект' }).expect(201)).body.data;
    const board = (await http.get(`/api/projects/${proj.id}/board`).set(H(owner.accessToken)).expect(200)).body.data;
    const task = (await http.post('/api/tasks').set(H(owner.accessToken))
      .send({ projectId: proj.id, columnId: board.columns[0].id, title: 'Обновить прайс', assigneeId: exec.id }).expect(201)).body.data;

    await waitMail(execEmail);
    const first = await waitInbox(execTok, null, 'task.created'); // воркер: ящик + push + письмо
    expect(first.items.length).toBe(1);
    expect(first.items[0].eventKey).toBe('task.created');
    expect(first.items[0].title).toContain('Обновить прайс');
    expect(first.items[0].path).toBe(`/projects/${proj.id}/task/${task.id}`);
    expect(first.unread).toBe(1);
    const cursor = first.cursor;

    // повтор воркера не плодит вторую запись
    await worker.tick();
    const same = (await http.get('/api/mobile/notifications').set(H(execTok)).expect(200)).body.data;
    expect(same.items.length).toBe(1);

    // после курсора — пусто, пока нет нового
    const after = (await http.get(`/api/mobile/notifications?after=${cursor}`).set(H(execTok)).expect(200)).body.data;
    expect(after.items).toEqual([]);

    await http.post(`/api/tasks/${task.id}/comments`).set(H(owner.accessToken)).send({ body: 'Уточнение' }).expect(201);
    await waitMail(execEmail, 'task.commented');
    const next = await waitInbox(execTok, cursor, 'task.commented');
    expect(next.items.length).toBe(1);
    expect(next.items[0].eventKey).toBe('task.commented');
    expect(next.unread).toBe(2);

    await http.post('/api/mobile/notifications/read').set(H(execTok)).send({ upTo: next.cursor }).expect(201);
    const read = (await http.get('/api/mobile/notifications').set(H(execTok)).expect(200)).body.data;
    expect(read.unread).toBe(0);
  });

  it('конфиг клиента: флаги по умолчанию, политика организации — владелец меняет, сотрудник нет', async () => {
    const owner = (await http.post('/api/auth/register')
      .send({ tenantName: 'Конфиг', email: `c_${uniq()}@t.test`, password: 'password123', fullName: 'Ольга' }).expect(201)).body.data;
    const cfg = (await http.get('/api/mobile/config').set(H(owner.accessToken)).expect(200)).body.data;
    expect(cfg.features.mobile_tasks).toBe(true);
    expect(cfg.features.mobile_offline_v2).toBe(false);
    expect(cfg.privacy.push).toBe('sender_only');
    expect(cfg.biometrics.minLockPolicy).toBe('off');
    expect(cfg.android).toBeNull();

    const policy = (await http.post('/api/mobile/org-policy').set(H(owner.accessToken))
      .send({ pushPrivacy: 'hide', minLockPolicy: '5' }).expect(201)).body.data;
    expect(policy).toEqual({ pushPrivacy: 'hide', minLockPolicy: '5' });
    await http.post('/api/mobile/org-policy').set(H(owner.accessToken)).send({ pushPrivacy: 'loud' }).expect(400);

    const mateEmail = `mate_${uniq()}@t.test`;
    await http.post('/api/users').set(H(owner.accessToken))
      .send({ email: mateEmail, fullName: 'Глеб', password: 'password123', role: 'member' }).expect(201);
    const mate = (await http.post('/api/auth/login').send({ email: mateEmail, password: 'password123' }).expect(201)).body.data;
    await http.post('/api/mobile/org-policy').set(H(mate.accessToken)).send({ pushPrivacy: 'full' }).expect(403);
    const seen = (await http.get('/api/mobile/config').set(H(mate.accessToken)).expect(200)).body.data;
    expect(seen.privacy.push).toBe('hide');

    // выпуски публикует только техотдел платформы
    await http.post('/api/mobile/admin/features').set(H(owner.accessToken)).send({ flags: { mobile_calls: false } }).expect(403);
  });
});