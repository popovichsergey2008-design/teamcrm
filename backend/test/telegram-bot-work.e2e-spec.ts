import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AddressInfo } from 'net';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { AllExceptionsFilter } from '../src/common/http/all-exceptions.filter';
import { ResponseInterceptor } from '../src/common/http/response.interceptor';
import { DbService } from '../src/database/db.service';
import { TelegramSender } from '../src/modules/telegram/telegram.sender';
import { TelegramBotWorkService } from '../src/modules/telegram-bot/telegram-bot-work.service';

/**
 * Рабочий Telegram-бот для команды (#4619, этап 4): пересылка → задача от привязанного
 * сотрудника; голос/текст → вопрос «задача или дейлик» (дейлик — прежним путём);
 * сдача на проверку → постановщику кнопки «Принять / Вернуть» (чужому — отказ);
 * «Фокус дня» в 09:30 — раз в день; предложение переезда на 4-й день — один раз.
 */
describe('Рабочий Telegram-бот (e2e)', () => {
  let app: INestApplication;
  let http$: any;
  let db: DbService;
  let work: TelegramBotWorkService;
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
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  const text = (from: number, t: string, extra: Record<string, unknown> = {}) => http$.post('/api/telegram/webhook').send({
    update_id: seq++, message: { message_id: seq++, from: { id: from, first_name: 'Борис' }, chat: { id: from, type: 'private' }, text: t, ...extra },
  }).expect(201);
  const press = (from: number, data: string) => http$.post('/api/telegram/webhook').send({
    update_id: seq++, callback_query: { id: `cb${seq++}`, from: { id: from, first_name: 'Борис' }, data, message: { message_id: seq++, chat: { id: from } } },
  }).expect(201);
  const sent = (chat: number) => calls.filter((c) => c.method === 'sendMessage' && String(c.body.chat_id) === String(chat)).map((c) => c.body);
  const last = (chat: number) => sent(chat).at(-1);
  const buttons = (body: any): any[] => (body?.reply_markup?.inline_keyboard ?? []).flat();
  async function waitFor<T>(fn: () => Promise<T | null | undefined> | T | null | undefined, ms = 8000): Promise<T> {
    const stop = Date.now() + ms;
    for (;;) {
      const v = await fn();
      if (v) return v;
      if (Date.now() > stop) throw new Error('не дождались');
      await sleep(150);
    }
  }

  let O: Record<string, string>;
  let M: Record<string, string>;
  let tenantId = '';
  let ownerId = '';
  let memberId = '';
  let projectId = '';
  let doneColumn = '';
  const ownerTg = tg();
  const memberTg = tg();

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
    work = app.get(TelegramBotWorkService);

    const owner = (await http$.post('/api/auth/register')
      .send({ acceptPrivacy: true, tenantName: 'Рабочий бот', email: `tgw_${uniq()}@t.test`, password: 'password123', fullName: 'Борис Руководитель' })
      .expect(201)).body.data;
    O = H(owner.accessToken);
    tenantId = String(owner.user.tenantId);
    ownerId = String(owner.user.id);

    const email = `tgw_m_${uniq()}@t.test`;
    const inv = (await http$.post('/api/invites').set(O).send({ email, role: 'member' }).expect(201)).body.data;
    await http$.post('/api/invites/accept').send({ acceptPrivacy: true, token: inv.token, fullName: 'Иван Исполнитель', password: 'memberpass1' }).expect(201);
    const mem = (await http$.post('/api/auth/login').send({ email, password: 'memberpass1' }).expect(201)).body.data;
    M = H(mem.accessToken);
    memberId = String(mem.user.id);

    const p = (await http$.post('/api/projects').set(O).send({ name: 'Продажи' }).expect(201)).body.data;
    projectId = String(p.id);
    const board = (await http$.get(`/api/projects/${projectId}/board`).set(O).expect(200)).body.data;
    doneColumn = board.columns.find((c: any) => c.name === 'Готово').id;
    await http$.put('/api/handoff-gate').set(O).send({ checklist: false, comment: false, attachment: false }).expect(200);
    // проект «последней своей задачи» — туда авто-постановка ставит без подсказок
    await http$.post('/api/tasks').set(O).send({ projectId, title: 'Первая задача' }).expect(201);

    for (const [tok, id] of [[O, ownerTg], [M, memberTg]] as const) {
      const code = (await http$.post('/api/me/telegram/link-code').set(tok).expect(201)).body.data.code;
      await text(id, `/start ${code}`);
      expect(last(id).text).toContain('Аккаунт привязан');
    }
  });
  afterAll(async () => { await app?.close(); });

  const submissions = async () => (await http$.get('/api/standup/submissions').set(O).expect(200)).body.data.length;

  it('пересланное сообщение → задача от привязанного, карточка с Mini App и «Отменить»', async () => {
    await text(ownerTg, 'Пришлите, пожалуйста, счёт на оплату до пятницы', {
      forward_origin: { type: 'user', sender_user: { id: 1, first_name: 'Ольга' }, date: 1 }, forward_date: 1,
    });
    const card = last(ownerTg);
    expect(card.text).toContain('✅ Задача поставлена от вас');
    expect(card.text).toMatch(/Исполнитель: .+\nСрок: .+\nПроект: Продажи/);
    const cancel = buttons(card).find((b) => b.callback_data?.startsWith('b:ux:'));
    expect(cancel.text).toBe('Отменить');
    const taskId = cancel.callback_data.split(':')[2];
    expect(JSON.stringify(buttons(card))).toContain(`/tg/task/${taskId}`);

    const t = await db.one<{ created_by: string; description: string; title: string }>(
      `SELECT created_by::text, description, title FROM tasks WHERE tenant_id = $1 AND id = $2`, [tenantId, taskId]);
    expect(t!.created_by).toBe(ownerId);
    expect(t!.title).not.toMatch(/пересланн/i);
    expect(t!.description).toContain('Пересланное сообщение от Ольга');
    // «Задача поставлена от вас» через 30 с — существующим механизмом (#4665), источник — бот
    const ac = await db.one<{ source: string }>(`SELECT info->>'source' AS source FROM task_auto_confirm WHERE task_id = $1`, [taskId]);
    expect(ac!.source).toBe('telegram');

    // чужой «Отменить» не срабатывает
    await press(memberTg, `b:ux:${taskId}`);
    expect(last(memberTg).text).toContain('Отменить можно только свою задачу');
    expect((await db.one<{ d: string | null }>(`SELECT deleted_at AS d FROM tasks WHERE id = $1`, [taskId]))!.d).toBeNull();
    // постановщик — в первые минуты — отменяет: задача в корзине
    await press(ownerTg, `b:ux:${taskId}`);
    expect(last(ownerTg).text).toContain('Задача отменена');
    expect((await db.one<{ d: string | null }>(`SELECT deleted_at AS d FROM tasks WHERE id = $1`, [taskId]))!.d).not.toBeNull();
  });

  it('текст без выбора → вопрос; «Это мой дейлик» → прежний путь, выбор помнится', async () => {
    const before = await submissions();
    await text(ownerTg, 'Сделал макет главной страницы');
    expect(buttons(last(ownerTg)).map((b) => b.text)).toEqual(['Поставить задачу', 'Это мой дейлик']);
    expect(await submissions()).toBe(before);
    // вторая подряд — копится в ту же серию, второй раз не спрашиваем
    const asked = sent(ownerTg).length;
    await text(ownerTg, 'Созвонился с подрядчиком');
    expect(sent(ownerTg).length).toBe(asked);

    await press(ownerTg, 'b:dq');
    expect(await submissions()).toBe(before + 2);
    expect(await db.one(`SELECT id FROM tasks WHERE tenant_id = $1 AND title ILIKE '%макет главной%'`, [tenantId])).toBeNull();
    // 10 минут — следующие сообщения сразу дейлик, без вопроса
    await text(ownerTg, 'Ещё проверил тексты');
    expect(await submissions()).toBe(before + 3);
  });

  it('/task — поручение текстом становится задачей; /daily — дейлик', async () => {
    await text(ownerTg, '/task');
    expect(last(ownerTg).text).toContain('Жду поручения');
    await text(ownerTg, 'Подготовить коммерческое предложение для клиента');
    expect(last(ownerTg).text).toContain('✅ Задача поставлена от вас');
    expect(await db.one(`SELECT id FROM tasks WHERE tenant_id = $1 AND created_by = $2 AND title ILIKE '%коммерческое предложение%'`, [tenantId, ownerId])).toBeTruthy();

    const before = await submissions();
    await text(ownerTg, '/daily закрыл два бага');
    expect(await submissions()).toBe(before + 1);
  });

  const submitForReview = async (title: string) => {
    const task = (await http$.post('/api/tasks').set(O).send({ projectId, title, assigneeId: memberId }).expect(201)).body.data;
    await http$.post(`/api/tasks/${task.id}/move`).set(M).send({ columnId: doneColumn, position: 0 }).expect(201);
    const msg = await waitFor(() => sent(ownerTg).find((b) => b.text.includes(`«${title}»`) && b.text.includes('сдана на проверку')));
    return { id: String(task.id), msg };
  };

  it('сдача на проверку → постановщику кнопки; чужой — отказ; «Принять» закрывает', async () => {
    const { id, msg } = await submitForReview('Отчёт по рекламе');
    expect(buttons(msg).filter((b) => b.callback_data).map((b) => b.callback_data)).toEqual([`b:ap:${id}`, `b:rw:${id}`]);
    // копия письма о сдаче в Telegram не дублируется: строка письма уже помечена
    const mail = await waitFor(() => db.one<{ tg: Date | null }>(
      `SELECT tg_sent_at AS tg FROM mail_outbox
        WHERE tenant_id = $1 AND user_id = $2 AND event_key = 'task.status' AND subject LIKE '%' || $3::text || '%'
        ORDER BY id DESC LIMIT 1`,
      [tenantId, ownerId, 'Отчёт по рекламе']));
    expect(mail.tg).not.toBeNull();
    // исполнитель сам себе работу не принимает
    expect(sent(memberTg).some((b) => b.text.includes('сдана на проверку'))).toBe(false);

    await press(memberTg, `b:ap:${id}`);
    expect(last(memberTg).text).toContain('может постановщик задачи');
    expect((await db.one<{ s: string }>(`SELECT approval_state AS s FROM tasks WHERE id = $1`, [id]))!.s).toBe('pending');

    await press(ownerTg, `b:ap:${id}`);
    expect(last(ownerTg).text).toContain('✅ Работа принята: «Отчёт по рекламе»');
    const t = await db.one<{ s: string; closed: Date | null }>(`SELECT approval_state AS s, closed_at AS closed FROM tasks WHERE id = $1`, [id]);
    expect(t).toMatchObject({ s: 'none' });
    expect(t!.closed).not.toBeNull();
    expect(calls.some((c) => c.method === 'editMessageReplyMarkup' && String(c.body.chat_id) === String(ownerTg))).toBe(true);
  });

  it('«Вернуть» → бот просит причину ответом → возврат на доработку с причиной', async () => {
    const { id } = await submitForReview('Макет лендинга');
    await press(memberTg, `b:rw:${id}`);
    expect(last(memberTg).text).toContain('может постановщик задачи');

    await press(ownerTg, `b:rw:${id}`);
    const ask = last(ownerTg);
    expect(ask.text).toContain('что доработать');
    expect(ask.reply_markup).toMatchObject({ force_reply: true });

    await text(ownerTg, 'Добавь мобильную версию', { reply_to_message: { message_id: 1 } });
    expect(last(ownerTg).text).toContain('Вернул на доработку: «Макет лендинга»');
    const t = await db.one<{ s: string; col: string }>(`SELECT approval_state AS s, column_id::text AS col FROM tasks WHERE id = $1`, [id]);
    expect(t!.s).toBe('none');
    expect(t!.col).not.toBe(String(doneColumn));
    const log = (await http$.get(`/api/tasks/${id}/activity`).set(O).expect(200)).body.data;
    expect(log.find((a: any) => a.kind === 'approval_returned').detail.reason).toBe('Добавь мобильную версию');
  });

  /** Ближайший будний день (не позже сегодняшнего) по Москве в заданное местное время. */
  const weekdayAt = (hhmm: string): Date => {
    let msk = new Date(Date.now() + 3 * 3600_000);
    while ([0, 6].includes(msk.getUTCDay())) msk = new Date(msk.getTime() - 86_400_000);
    const [h, m] = hhmm.split(':').map(Number);
    return new Date(`${msk.toISOString().slice(0, 10)}T${String(h - 3).padStart(2, '0')}:${String(m).padStart(2, '0')}:00Z`);
  };

  it('«Фокус дня» в 09:30 — руководителю три строки, раз в день', async () => {
    await db.query(`UPDATE users SET timezone = 'Europe/Moscow' WHERE id = ANY($1::bigint[])`, [[ownerId, memberId]]);
    const at = weekdayAt('09:35');
    const day = at.toISOString().slice(0, 10);
    await http$.post('/api/tasks').set(O)
      .send({ projectId, title: 'Сверка с бухгалтерией', assigneeId: memberId, deadlineAt: `${day}T12:00:00.000Z` }).expect(201);

    await work.focusTick(new Date(at.getTime() - 10 * 60_000)); // 09:25 — рано
    expect(sent(ownerTg).some((b) => b.text.startsWith('🎯'))).toBe(false);

    await work.focusTick(at);
    const focus = sent(ownerTg).filter((b) => b.text.startsWith('🎯'));
    expect(focus).toHaveLength(1);
    const lines = focus[0].text.split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('«Сверка с бухгалтерией»');
    expect(lines[1]).toContain('Иван Исполнитель (');
    expect(lines[2]).toMatch(/^📅 Созвоны:/);
    // сотруднику — нет, повтор в тот же день — нет
    expect(sent(memberTg).some((b) => b.text.startsWith('🎯'))).toBe(false);
    await work.focusTick(new Date(at.getTime() + 20 * 60_000));
    expect(sent(ownerTg).filter((b) => b.text.startsWith('🎯'))).toHaveLength(1);
  });

  it('«Фокус дня» выключается в настройках уведомлений (только у руководителя)', async () => {
    const own = (await http$.get('/api/notifications/prefs').set(O).expect(200)).body.data;
    expect(own.find((p: any) => p.eventKey === 'telegram.focus')).toMatchObject({ enabled: true });
    const mine = (await http$.get('/api/notifications/prefs').set(M).expect(200)).body.data;
    expect(mine.some((p: any) => p.eventKey === 'telegram.focus')).toBe(false);
    await http$.put('/api/notifications/prefs').set(O).send({ eventKey: 'telegram.focus', enabled: false }).expect(200);
    const row = await db.one<{ enabled: boolean }>(
      `SELECT enabled FROM notification_prefs WHERE tenant_id = $1 AND user_id = $2 AND event_key = 'telegram.focus'`, [tenantId, ownerId]);
    expect(row!.enabled).toBe(false);
  });

  it('4-й день пробного периода: досок не переносили → одно предложение переезда', async () => {
    const at = weekdayAt('12:00');
    await db.query(
      `UPDATE tenants SET trial_started_at = $2::timestamptz - interval '3 days 1 hour', boards_imported_at = now(), move_offer_sent_at = NULL
        WHERE id = $1`, [tenantId, at]);
    const offers = () => sent(ownerTg).filter((b) => buttons(b).some((x) => x.text === 'Подключить инженера для переноса'));

    // доски уже переносили — не предлагаем
    await work.moveTick(at);
    expect(offers()).toHaveLength(0);

    await db.query(`UPDATE tenants SET boards_imported_at = NULL WHERE id = $1`, [tenantId]);
    await work.moveTick(at);
    expect(offers()).toHaveLength(1);
    expect(buttons(offers()[0])[0]).toEqual({ text: 'Подключить инженера для переноса', callback_data: 'b:mv' });
    await work.moveTick(new Date(at.getTime() + 3600_000));
    expect(offers()).toHaveLength(1);
    expect(sent(memberTg).some((b) => buttons(b).some((x) => x.callback_data === 'b:mv'))).toBe(false);

    // кнопка → тот же поток заявки, что в боте
    await press(ownerTg, 'b:mv');
    expect(buttons(last(ownerTg)).map((b) => b.text)).toEqual(['Битрикс24', 'YouGile', 'Jira', 'Другое']);
    await press(ownerTg, 'b:fr:yg');
    const lead = await db.one<{ want: string; move_from: string }>(
      `SELECT want, move_from FROM landing_leads WHERE tenant_id = $1 AND want = 'plan'`, [tenantId]);
    expect(lead).toEqual({ want: 'plan', move_from: 'yougile' });
  });
});
