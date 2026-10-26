import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AddressInfo } from 'net';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { AllExceptionsFilter } from '../src/common/http/all-exceptions.filter';
import { ResponseInterceptor } from '../src/common/http/response.interceptor';
import { DbService } from '../src/database/db.service';
import { ClientFollowupService } from '../src/modules/secretary-skills/client-followup.service';
import { EXPIRED_TEXT } from '../src/modules/secretary-skills/followup-rules';
import { StandupService } from '../src/modules/standup/standup.service';
import { TelegramSender } from '../src/modules/telegram/telegram.sender';

/**
 * Итоги клиенту в Telegram (#1525, фича 5): итог встречи готов → карточка с кнопкой
 * «Отправить в Telegram»; клиент не привязан — одноразовая ссылка t.me/бот?start=c_…,
 * по ней бот сразу присылает итоги и запоминает чат; дальше — одной кнопкой.
 */
describe('Итоги клиенту в Telegram (e2e)', () => {
  let app: INestApplication;
  let http$: any;
  let db: DbService;
  const sent: { chat: string; text: string }[] = [];
  const fakeTg = {
    enabled: true,
    username: async () => 'qevo_test_bot',
    deliver: async (chat: string | number, text: string) => { sent.push({ chat: String(chat), text }); return 'ok' as const; },
    sendMessage: async (chat: string | number, text: string) => { sent.push({ chat: String(chat), text }); },
    sendVoice: async () => true,
    fileUrl: async () => null,
  };
  const uniq = () => Math.random().toString(36).slice(2) + Date.now().toString(36);
  const H = (t: string) => ({ Authorization: `Bearer ${t}` });

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

  async function org() {
    const owner = (await http$.post('/api/auth/register')
      .send({ acceptPrivacy: true, tenantName: 'Студия Луч', email: `ctg_${uniq()}@t.test`, password: 'password123', fullName: 'Борис Петров' }).expect(201)).body.data;
    const O = H(owner.accessToken);
    const email = `ctgm_${uniq()}@t.test`;
    await http$.post('/api/users').set(O).send({ email, fullName: 'Глеб', password: 'password123', role: 'member' }).expect(201);
    const tok = (await http$.post('/api/auth/login').send({ email, password: 'password123' }).expect(201)).body.data.accessToken;
    const tenantId = String(owner.user.tenantId);
    const client = await db.one<{ id: string }>(`INSERT INTO clients (tenant_id, name) VALUES ($1, 'Банк Север') RETURNING id::text`, [tenantId]);
    await db.query(`INSERT INTO client_contacts (tenant_id, client_id, first_name, email, is_primary) VALUES ($1, $2, 'Ирина', 'irina@bank.test', TRUE)`,
      [tenantId, client!.id]);
    return { O, ownerId: String(owner.user.id), tenantId, clientId: client!.id, gleb: H(tok) };
  }

  async function meeting(tenantId: string, ownerId: string, clientId: string) {
    const m = await db.one<{ id: string }>(
      `INSERT INTO meetings (tenant_id, title, source, status, created_by, client_id, happened_at)
       VALUES ($1, 'Дизайн сайта', 'transcript', 'done', $2, $3, '2026-10-06T09:00:00Z') RETURNING id::text`,
      [tenantId, ownerId, clientId],
    );
    await db.query(`INSERT INTO meeting_summaries (meeting_id, tenant_id, summary, decisions) VALUES ($1, $2, 'Обсудили дизайн.', $3::jsonb)`,
      [m!.id, tenantId, JSON.stringify(['Утвердили дизайн.', 'Правки до среды'])]);
    return m!.id;
  }

  const card = async (O: any, meetingId: string) => {
    const items = (await http$.get('/api/assistant/proposals').set(O).expect(200)).body.data.items;
    return items.find((p: any) => p.skill === 'followup' && p.source.id === meetingId);
  };
  const tgStart = (chatId: number, text: string) => app.get(StandupService).handleTelegramUpdate({
    message: { message_id: Date.now(), from: { id: chatId, first_name: 'Ирина' }, chat: { id: chatId, type: 'private' }, text },
  });

  it('ссылка → клиент запустил бота → итоги доставлены, ссылка погасла; дальше — одной кнопкой', async () => {
    const { O, ownerId, tenantId, clientId, gleb } = await org();
    const m1 = await meeting(tenantId, ownerId, clientId);
    expect(await app.get(ClientFollowupService).prepareNow(tenantId, m1)).toBe(true);

    const p = await card(O, m1);
    expect(p.actions.map((a: any) => a.key)).toEqual(['send_tg', 'copy']);
    expect(p.actions[0]).toMatchObject({ label: 'Отправить в Telegram', primary: true });
    expect(p.payload.subject).toBe('Итоги встречи 06.10');
    expect(p.payload.agreements).toBe('утвердили дизайн, правки до среды.');
    expect(p.payload.tgLinked).toBe(false);

    // отправляет только тот, кому подготовлено
    await http$.post(`/api/assistant/proposals/${p.id}/confirm`).set(gleb).send({ action: 'send_tg' }).expect(404);

    // клиент не привязан — ссылка с кодом; карточка остаётся открытой
    const r = (await http$.post(`/api/assistant/proposals/${p.id}/confirm`).set(O)
      .send({ action: 'send_tg', params: { body: 'Ирина, добрый день! Утвердили дизайн.' } }).expect(201)).body.data;
    const url = /https:\/\/t\.me\/qevo_test_bot\?start=(c_[A-Za-z0-9_-]+)/.exec(r.text);
    expect(url).toBeTruthy();
    const code = url![1];
    expect(r.text).toContain('действует 14 дней');
    expect(r.proposal.status).toBe('new');
    // в базе — только хеш
    const stored = await db.one<{ code_hash: string; message: string }>(`SELECT code_hash, message FROM client_telegram_codes WHERE proposal_id = $1`, [p.id]);
    expect(stored!.code_hash).not.toContain(code);
    expect(stored!.message).toContain('Ирина, добрый день! Утвердили дизайн.');

    // та же ссылка во внешний чат: чата нет — понятный отказ
    const noChat = await http$.post(`/api/assistant/proposals/${p.id}/confirm`).set(O).send({ action: 'send_tg', params: { via: 'chat', code } }).expect(409);
    expect(noChat.body.error.message).toContain('нет внешнего чата');

    // клиент нажал «Запустить»
    sent.length = 0;
    await tgStart(555001, `/start ${code}`);
    expect(sent[0].chat).toBe('555001');
    expect(sent[0].text.startsWith('Итоги встречи 06.10\nОт: Борис Петров, Студия Луч')).toBe(true);
    expect(sent[0].text).toContain('Ирина, добрый день! Утвердили дизайн.');
    expect(sent[0].text).toContain('от имени компании «Студия Луч»');
    const after = (await http$.get(`/api/assistant/proposals/${p.id}`).set(O).expect(200)).body.data;
    expect(after.status).toBe('executed');
    const log = await db.many<{ title: string }>(`SELECT title FROM client_activity WHERE client_id = $1 ORDER BY id`, [clientId]);
    expect(log.map((x) => x.title)).toContain('Итоги встречи отправлены: в Telegram (клиент открыл ссылку)');

    // одноразовая: второй запуск ничего не присылает
    sent.length = 0;
    await tgStart(555002, `/start ${code}`);
    expect(sent).toEqual([{ chat: '555002', text: EXPIRED_TEXT }]);

    // следующая встреча — клиент уже привязан: одной кнопкой, сразу
    const m2 = await meeting(tenantId, ownerId, clientId);
    await app.get(ClientFollowupService).prepareNow(tenantId, m2);
    const p2 = await card(O, m2);
    expect(p2.payload.tgLinked).toBe(true);
    sent.length = 0;
    const r2 = (await http$.post(`/api/assistant/proposals/${p2.id}/confirm`).set(O).send({ action: 'send_tg' }).expect(201)).body.data;
    expect(r2.text).toBe('Итоги отправлены клиенту в Telegram');
    expect(r2.proposal.status).toBe('executed');
    expect(sent.map((x) => x.chat)).toEqual(['555001']);

    // клиент отключился — бот туда больше не пишет
    await tgStart(555001, '/stop');
    expect((await db.many(`SELECT 1 FROM client_telegram_links WHERE client_id = $1 AND revoked_at IS NULL`, [clientId]))).toHaveLength(0);
  });

  it('истёкшая ссылка не работает', async () => {
    const { O, ownerId, tenantId, clientId } = await org();
    const m = await meeting(tenantId, ownerId, clientId);
    await app.get(ClientFollowupService).prepareNow(tenantId, m);
    const p = await card(O, m);
    const r = (await http$.post(`/api/assistant/proposals/${p.id}/confirm`).set(O).send({ action: 'send_tg' }).expect(201)).body.data;
    const code = /start=(c_[A-Za-z0-9_-]+)/.exec(r.text)![1];
    await db.query(`UPDATE client_telegram_codes SET expires_at = now() - interval '1 minute' WHERE proposal_id = $1`, [p.id]);
    sent.length = 0;
    await tgStart(555100, `/start ${code}`);
    expect(sent).toEqual([{ chat: '555100', text: EXPIRED_TEXT }]);
    expect((await http$.get(`/api/assistant/proposals/${p.id}`).set(O).expect(200)).body.data.status).toBe('new');
  });
});
