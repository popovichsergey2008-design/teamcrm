import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AddressInfo } from 'net';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { AllExceptionsFilter } from '../src/common/http/all-exceptions.filter';
import { ResponseInterceptor } from '../src/common/http/response.interceptor';
import { DbService } from '../src/database/db.service';
import { TelegramSender } from '../src/modules/telegram/telegram.sender';

/**
 * Telegram-бот QEVO для сайта (#4619): /start site → приветствие, текст → карточка
 * задачи, «Забрать» → согласие → пространство в один клик, пробный период 7 + 7,
 * заявка дежурным, вход без пароля одноразовой ссылкой. Привязанный сотрудник —
 * как раньше: его не угоняют, его текст — дейлик.
 */
describe('Telegram-бот для сайта (e2e)', () => {
  let app: INestApplication;
  let http$: any;
  let db: DbService;
  const calls: { method: string; body: any }[] = [];
  const fakeTg = {
    enabled: true,
    username: async () => 'qevo_test_bot',
    call: async (method: string, body: any) => { calls.push({ method, body }); return {}; },
    fileBuffer: async () => null,
    fileUrl: async () => null,
    deliver: async (chat: string | number, text: string) => { calls.push({ method: 'deliver', body: { chat_id: chat, text } }); return 'ok' as const; },
    sendMessage: async (chat: string | number, text: string, reply_markup?: unknown) => { calls.push({ method: 'sendMessage', body: { chat_id: chat, text, reply_markup } }); },
    sendVoice: async () => true,
  };
  const uniq = () => Math.random().toString(36).slice(2) + Date.now().toString(36);
  const tg = () => Math.floor(Math.random() * 1e9) + 10_000;
  let seq = Math.floor(Math.random() * 1e9);
  const H = (t: string) => ({ Authorization: `Bearer ${t}` });

  const text = (from: number, t: string, extra: Record<string, unknown> = {}) => http$.post('/api/telegram/webhook').send({
    update_id: seq++, message: { message_id: seq++, from: { id: from, first_name: 'Анна', username: `anna${from}` }, chat: { id: from, type: 'private' }, text: t, ...extra },
  }).expect(201);
  const press = (from: number, data: string) => http$.post('/api/telegram/webhook').send({
    update_id: seq++, callback_query: { id: `cb${seq++}`, from: { id: from, first_name: 'Анна', username: `anna${from}` }, data, message: { chat: { id: from } } },
  }).expect(201);
  /** Последнее сообщение боту в этот чат. */
  const last = (chat: number) => [...calls].reverse().find((c) => (c.method === 'sendMessage' || c.method === 'deliver') && String(c.body.chat_id) === String(chat))?.body;
  const buttons = (body: any): any[] => (body?.reply_markup?.inline_keyboard ?? []).flat();

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(TelegramSender).useValue(fakeTg)
      .compile();
    app = mod.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    app.useGlobalFilters(new AllExceptionsFilter());
    app.useGlobalInterceptors(new ResponseInterceptor());
    await app.listen(0, '0.0.0.0');
    http$ = request(`http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`);
    db = app.get(DbService);
  });
  afterAll(async () => { await app?.close(); });

  const guest = tg();
  let demoId = '';
  let tenantId = '';
  let loginLink = '';

  it('/start site → приветствие ТЗ с тремя кнопками и метка источника', async () => {
    await text(guest, '/start site');
    const m = last(guest);
    expect(m.text).toContain('Привет! Я ИИ-помощник QEVO');
    expect(buttons(m).map((b) => b.text)).toEqual([
      'Проверить на готовом примере', 'Открыть демо-доску QEVO (Mini App)', 'Перенести доски из Битрикс24 / YouGile',
    ]);
    expect(calls.some((c) => c.method === 'answerCallbackQuery')).toBe(false);
    const row = await db.one<{ first_source: string }>(`SELECT first_source FROM telegram_bot_users WHERE telegram_user_id = $1`, [guest]);
    expect(row!.first_source).toBe('site');
  });

  it('готовый пример → карточка и ответ на нажатие', async () => {
    await press(guest, 'b:ex');
    expect(calls.some((c) => c.method === 'answerCallbackQuery')).toBe(true);
    expect(last(guest).text).toContain('Исполнитель: Дмитрий');
  });

  it('текст → карточка задачи (без записи в CRM)', async () => {
    const before = await db.one<{ n: string }>(`SELECT count(*) AS n FROM tasks WHERE title = 'Подготовить отчет по рекламе'`);
    await text(guest, 'Дима, подготовь отчет по рекламе к пятнице 15:00 и добавь сравнение с прошлым месяцем');
    const m = last(guest);
    expect(m.text).toMatch(/сформирована за/);
    expect(m.text).toContain('Название:');
    expect(m.text).toContain('Чек-лист ТЗ:');
    expect(calls.some((c) => c.method === 'sendChatAction' && String(c.body.chat_id) === String(guest))).toBe(true);
    const take = buttons(m).find((b) => b.callback_data?.startsWith('b:tk:'));
    expect(take.text).toBe('Забрать задачу в свое пространство (+7 дней бесплатно)');
    demoId = take.callback_data.split(':')[2];
    const after = await db.one<{ n: string }>(`SELECT count(*) AS n FROM tasks WHERE title = 'Подготовить отчет по рекламе'`);
    expect(after!.n).toBe(before!.n);
  });

  it('«Забрать» без согласия → просьба принять политику, пространства нет', async () => {
    await press(guest, `b:tk:${demoId}`);
    const m = last(guest);
    expect(m.text).toContain('/legal/privacy');
    expect(buttons(m).map((b) => b.text)).toEqual(['Принимаю', 'Отмена']);
    expect(await db.one(`SELECT id FROM accounts WHERE email = $1`, [`tg${guest}@users.qevo.one`])).toBeNull();
  });

  it('«Принимаю» → организация, владелец, привязка, проект с задачей, пробный период, согласие', async () => {
    await press(guest, `b:ok:${demoId}`);
    expect(last(guest).text).toContain('Ваше рабочее пространство создано!');
    const acc = await db.one<{ id: string }>(`SELECT id::text FROM accounts WHERE email = $1`, [`tg${guest}@users.qevo.one`]);
    expect(acc).toBeTruthy();
    const link = await db.one<{ tenant_id: string; user_id: string }>(
      `SELECT tenant_id::text, user_id::text FROM telegram_accounts WHERE telegram_user_id = $1`, [guest]);
    tenantId = link!.tenant_id;
    const t = await db.one<{ name: string; source: string; days: string; bonus: number }>(
      `SELECT name, source, round(extract(epoch FROM trial_ends_at - trial_started_at) / 86400) AS days, trial_bonus_days AS bonus
         FROM tenants WHERE id = $1`, [tenantId]);
    expect(t!.name).toBe('Анна — команда');
    expect(t!.source).toBe('telegram_bot');
    expect(Number(t!.days)).toBe(7);
    expect(Number(t!.bonus)).toBe(0);
    const task = await db.one<{ title: string; project: string }>(
      `SELECT t.title, p.name AS project FROM tasks t JOIN projects p ON p.id = t.project_id WHERE t.tenant_id = $1`, [tenantId]);
    expect(task!.title).toBe('Подготовить отчет по рекламе');
    expect(task!.project).toBe('Маркетинг и аналитика');
    const consent = await db.one<{ context: any; policy: string }>(
      `SELECT context, policy FROM policy_consents WHERE tenant_id = $1`, [tenantId]);
    expect(consent!.policy).toBe('privacy');
    expect(consent!.context).toMatchObject({ flow: 'telegram_bot', telegramUserId: String(guest) });
    // #4680: при регистрации — весь пакет документов
    expect(consent!.context.documents).toContain('https://qevo.one/legal/offer/');
    const created = buttons(last(guest));
    expect(created.filter((b) => b.callback_data).map((b) => b.callback_data)).toEqual(['b:tm:s', 'b:tm:m', 'b:tm:l', 'b:tm:xl']);
    // задача уже в CRM — Mini App открывает её по номеру
    expect(JSON.stringify(created)).toMatch(/\/tg\/task\/\d+/);
  });

  it('размер команды → +7 дней, заявка дежурным, вход в один клик', async () => {
    await press(guest, 'b:tm:m');
    const m = last(guest);
    expect(m.text).toContain('Доступ на 14 дней для вашей команды активирован!');
    expect(m.text).toContain('осталось 14 дней');
    loginLink = buttons(m)[0].url;
    expect(loginLink).toMatch(/\?tglogin=[A-Za-z0-9_-]{20,}$/);
    const t = await db.one<{ bonus: number }>(`SELECT trial_bonus_days AS bonus FROM tenants WHERE id = $1`, [tenantId]);
    expect(Number(t!.bonus)).toBe(7);
    const lead = await db.one<{ source: string; team_size: string; contact: string }>(
      `SELECT source, team_size, contact FROM landing_leads WHERE tenant_id = $1`, [tenantId]);
    expect(lead).toEqual({ source: 'telegram', team_size: '6-15', contact: `@anna${guest}` });
    // повторный ответ — без второго бонуса и второй заявки
    await press(guest, 'b:tm:l');
    expect(Number((await db.one<{ bonus: number }>(`SELECT trial_bonus_days AS bonus FROM tenants WHERE id = $1`, [tenantId]))!.bonus)).toBe(7);
    expect((await db.many(`SELECT id FROM landing_leads WHERE tenant_id = $1`, [tenantId])).length).toBe(1);
  });

  it('код входа одноразовый, хранится хешем и истекает', async () => {
    const code = decodeURIComponent(loginLink.split('tglogin=')[1]);
    expect(await db.one(`SELECT id FROM telegram_login_codes WHERE code_hash = $1`, [code])).toBeNull();
    const s = (await http$.post('/api/auth/telegram-code').send({ code }).expect(201)).body.data;
    expect(s.accessToken).toBeTruthy();
    expect(String(s.user.tenantId)).toBe(tenantId);
    await http$.get('/api/me').set(H(s.accessToken)).expect(200);
    await http$.post('/api/auth/telegram-code').send({ code }).expect(401);

    await press(guest, 'b:op');
    const code2 = decodeURIComponent(buttons(last(guest))[0].url.split('tglogin=')[1]);
    await db.query(`UPDATE telegram_login_codes SET expires_at = now() - interval '1 second' WHERE telegram_user_id = $1 AND used_at IS NULL`, [guest]);
    await http$.post('/api/auth/telegram-code').send({ code: code2 }).expect(401);
    await http$.post('/api/auth/telegram-code').send({ code: 'short' }).expect(401);
  });

  it('повторный «Забрать» тем же Telegram — второе пространство не заводится', async () => {
    await press(guest, `b:tk:${demoId}`);
    expect(last(guest).text).toContain('У вас уже есть пространство QEVO');
    await press(guest, `b:ok:${demoId}`);
    expect(last(guest).text).toContain('У вас уже есть пространство QEVO');
    expect((await db.many(`SELECT id FROM accounts WHERE email = $1`, [`tg${guest}@users.qevo.one`])).length).toBe(1);
    expect((await db.many(`SELECT id FROM telegram_accounts WHERE telegram_user_id = $1`, [guest])).length).toBe(1);
  });

  it('переезд: выбор сервиса → заявка want=plan', async () => {
    await press(guest, 'b:mv');
    expect(buttons(last(guest)).map((b) => b.text)).toEqual(['Битрикс24', 'YouGile', 'Jira', 'Другое']);
    await press(guest, 'b:fr:jira');
    const lead = await db.one<{ want: string; move_from: string }>(
      `SELECT want, move_from FROM landing_leads WHERE telegram_user_id = $1 AND want = 'plan'`, [guest]);
    expect(lead).toEqual({ want: 'plan', move_from: 'jira' });
  });

  it('привязанный сотрудник: /start не угоняет, текст — дейлик как раньше', async () => {
    const owner = (await http$.post('/api/auth/register')
      .send({ acceptPrivacy: true, tenantName: 'Сотрудники', email: `tgb_${uniq()}@t.test`, password: 'password123', fullName: 'Борис' }).expect(201)).body.data;
    const O = H(owner.accessToken);
    const staff = tg();
    const code = (await http$.post('/api/me/telegram/link-code').set(O).expect(201)).body.data.code;
    await text(staff, `/start ${code}`);
    expect(last(staff).text).toContain('Аккаунт привязан');

    await text(staff, '/start site');
    expect(last(staff).text).toContain('С возвращением');
    await press(staff, 'b:tk:0');
    expect(last(staff).text).toContain('У вас уже есть пространство QEVO');
    await press(staff, 'b:ok:0');
    const link = await db.one<{ user_id: string }>(`SELECT user_id::text FROM telegram_accounts WHERE telegram_user_id = $1`, [staff]);
    expect(link!.user_id).toBe(String(owner.user.id));
    expect(await db.one(`SELECT id FROM accounts WHERE email = $1`, [`tg${staff}@users.qevo.one`])).toBeNull();

    const p = (await http$.post('/api/projects').set(O).send({ name: 'P' }).expect(201)).body.data;
    const t1 = (await http$.post('/api/tasks').set(O).send({ projectId: p.id, title: 'T1' }).expect(201)).body.data.id;
    await text(staff, `#${t1} сделал, 30 минут`);
    const subs = (await http$.get('/api/standup/submissions').set(O).expect(200)).body.data;
    expect(subs.length).toBe(1);
  });
});
