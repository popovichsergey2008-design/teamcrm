import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AddressInfo } from 'net';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { AllExceptionsFilter } from '../src/common/http/all-exceptions.filter';
import { ResponseInterceptor } from '../src/common/http/response.interceptor';
import { DbService } from '../src/database/db.service';
import { FilesService } from '../src/modules/files/files.service';

/**
 * «Волшебная палочка» (ТЗ-26): сообщение и голосовое → задача. В тестах модели нет —
 * правка словами идёт правилами, расшифровка заглушкой пустая (честная ошибка).
 */
describe('Волшебная палочка в чатах (e2e)', () => {
  let app: INestApplication;
  let http$: any;
  let db: DbService;
  const uniq = () => Math.random().toString(36).slice(2) + Date.now().toString(36);
  const H = (t: string) => ({ Authorization: `Bearer ${t}` });
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
  });
  afterAll(async () => { await app?.close(); });

  async function setup() {
    const owner = (await http$.post('/api/auth/register')
      .send({ acceptPrivacy: true, tenantName: 'Палочка', email: `w_${uniq()}@t.test`, password: 'Test-pass-2026', fullName: 'Сергей' }).expect(201)).body.data;
    const O = H(owner.accessToken);
    const email = `wg_${uniq()}@t.test`;
    const gleb = (await http$.post('/api/users').set(O).send({ email, fullName: 'Глеб Орлов', password: 'Test-pass-2026', role: 'member' }).expect(201)).body.data;
    const p1 = (await http$.post('/api/projects').set(O).send({ name: 'Сайт' }).expect(201)).body.data;
    await http$.post('/api/projects').set(O).send({ name: 'Склад' }).expect(201);
    const dm = (await http$.post('/api/chats/dm').set(O).send({ userId: gleb.id }).expect(201)).body.data;
    return { O, owner, gleb, p1, dm, tenantId: String(owner.user.tenantId), ownerId: String(owner.user.id) };
  }

  /** Голосовое: сообщение с аудиофайлом. */
  async function voiceMessage(tenantId: string, ownerId: string, chatId: string) {
    const file = await app.get(FilesService).upload({
      tenantId, userId: ownerId, buffer: Buffer.from('voice-bytes'), fileName: 'voice.webm', contentType: 'audio/webm',
      ownerKind: 'chat_message', ownerId: chatId,
    });
    const msg = await db.one<{ id: string }>(
      `INSERT INTO chat_messages (tenant_id, chat_id, author_id, body, file_id) VALUES ($1, $2, $3, '', $4) RETURNING id::text`,
      [tenantId, chatId, ownerId, file.id],
    );
    return msg!.id;
  }

  it('личка: три вероятных проекта, правка словами правилами, проекты — только видимые', async () => {
    const { O, dm, p1, gleb } = await setup();
    const msg = (await http$.post(`/api/chats/${dm.id}/messages`).set(O)
      .send({ body: 'Поправь мобильную версию формы и проверь отступы' }).expect(201)).body.data;
    const s = (await http$.post(`/api/chats/${dm.id}/messages/${msg.id}/task-draft`).set(O).expect(201)).body.data;
    expect(s.context.suggested.length).toBeGreaterThan(0);
    expect(s.context.suggested.length).toBeLessThanOrEqual(3);
    const draftId = s.draft.draftId;

    const a = (await http$.post(`/api/chats/task-drafts/${draftId}/instruct`).set(O).send({ text: 'срок пятница' }).expect(201)).body.data;
    expect(a.draft.deadline).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const b = (await http$.post(`/api/chats/task-drafts/${draftId}/instruct`).set(O).send({ text: 'поставь Глеба' }).expect(201)).body.data;
    expect(String(b.draft.assigneeId)).toBe(String(gleb.id));
    await http$.post(`/api/chats/task-drafts/${draftId}/instruct`).set(O).send({ text: 'что-нибудь' }).expect(400);

    // закрытый проект нажавшему не виден — и в списке выбора его нет
    const G = H((await http$.post('/api/auth/login').send({ email: gleb.email, password: 'Test-pass-2026' }).expect(201)).body.data.accessToken);
    await db.query(`UPDATE projects SET visibility = 'members' WHERE id = $1`, [p1.id]);
    const his = (await http$.post(`/api/chats/${dm.id}/messages/${msg.id}/task-draft`).set(G).expect(201)).body.data;
    expect(his.context.projects.map((p: any) => p.name)).not.toContain('Сайт');
  });

  it('голосовое с расшифровкой → задача с «Послушать контекст»; без расшифровки — ошибка и «Повторить»', async () => {
    const { O, dm, p1, tenantId, ownerId } = await setup();
    const voiced = await voiceMessage(tenantId, ownerId, dm.id);
    await db.query(
      `UPDATE chat_messages SET transcript = 'Глеб, добавь на странице клиента фильтр по менеджеру к пятнице', transcript_status = 'ready' WHERE id = $1`,
      [voiced],
    );
    const s = (await http$.post(`/api/chats/${dm.id}/messages/${voiced}/task-draft`).set(O).expect(201)).body.data;
    expect(s.voice.transcript).toContain('фильтр по менеджеру');
    expect(s.draft.title).toBeTruthy();
    await http$.patch(`/api/chats/task-drafts/${s.draft.draftId}`).set(O).send({ projectId: String(p1.id) }).expect(200);
    const done = (await http$.post(`/api/chats/task-drafts/${s.draft.draftId}/confirm`).set(O).send({}).expect(201)).body.data;
    const proof = (await http$.get(`/api/tasks/${done.taskId}/audio-proof`).set(O).expect(200)).body.data;
    expect(proof.source).toBe('chat');
    expect(proof.status).toBe('ready');
    expect(proof.quote).toContain('фильтр по менеджеру');
    expect(proof.message.messageId).toBe(String(voiced));
    expect(proof.playback.url).toMatch(/^\/api\/files\/play\//);

    // голосовое без расшифровки: заглушка ничего не распознаёт — честная ошибка, голос цел
    const raw = await voiceMessage(tenantId, ownerId, dm.id);
    const t = (await http$.post(`/api/chats/${dm.id}/messages/${raw}/task-draft`).set(O).expect(201)).body.data;
    expect(t.draft.status).toBe('transcribing');
    let v: any;
    for (let i = 0; i < 40; i++) {
      v = (await http$.get(`/api/chats/task-drafts/${t.draft.draftId}`).set(O).expect(200)).body.data;
      if (v.draft.status !== 'transcribing') break;
      await sleep(150);
    }
    expect(v.draft.status).toBe('failed');
    expect(v.voice.error).toBe('stt');
    const again = (await http$.post(`/api/chats/task-drafts/${t.draft.draftId}/retry`).set(O).expect(201)).body.data;
    expect(again.draft.status).toBe('transcribing');
  });

  it('«3 отдельные задачи»: каждая одна, повтор не задваивает', async () => {
    const { O, dm, p1 } = await setup();
    const msg = (await http$.post(`/api/chats/${dm.id}/messages`).set(O)
      .send({ body: 'Обнови логотип и созвонись с маркетологом' }).expect(201)).body.data;
    const s = (await http$.post(`/api/chats/${dm.id}/messages/${msg.id}/task-draft`).set(O).expect(201)).body.data;
    const id = s.draft.draftId;
    await http$.patch(`/api/chats/task-drafts/${id}`).set(O).send({ projectId: String(p1.id) }).expect(200);
    await db.query(
      `UPDATE chat_task_drafts SET analysis = analysis || $2::jsonb WHERE id = $1`,
      [id, JSON.stringify({ split: [
        { title: 'Обновить логотип', description: null, assigneeId: null, deadline: null, checklist: [], priority: 'normal' },
        { title: 'Созвониться с маркетологом', description: null, assigneeId: null, deadline: null, checklist: [], priority: 'normal' },
      ] })],
    );
    const done = (await http$.post(`/api/chats/task-drafts/${id}/confirm`).set(O).send({ mode: 'split' }).expect(201)).body.data;
    expect(done.taskIds).toHaveLength(2);
    const again = (await http$.post(`/api/chats/task-drafts/${id}/confirm`).set(O).send({ mode: 'split' }).expect(201)).body.data;
    expect(again.already).toBe(true);
    const board = (await http$.get(`/api/projects/${p1.id}/board`).set(O).expect(200)).body.data;
    expect(board.columns.flatMap((c: any) => c.tasks).map((x: any) => x.title).sort()).toEqual(['Обновить логотип', 'Созвониться с маркетологом']);
  });
  it('ТЗ-31 / #1554: в личке общий проект двоих подставляется с «проверьте», выбор пишется в отзывы', async () => {
    const { O, dm, p1, gleb, tenantId } = await setup();
    // оба работают в «Сайте»: задача Глебу от владельца
    await http$.post('/api/tasks').set(O).send({ projectId: p1.id, title: 'Шапка', assigneeId: gleb.id, confirmWorkload: true }).expect(201);
    const msg = (await http$.post(`/api/chats/${dm.id}/messages`).set(O).send({ body: 'Поправь кнопку оплаты' }).expect(201)).body.data;
    const s = (await http$.post(`/api/chats/${dm.id}/messages/${msg.id}/task-draft`).set(O).expect(201)).body.data;
    expect(String(s.draft.projectId)).toBe(String(p1.id));
    expect(s.draft.analysis.projectResolution.level).toBe('MEDIUM');
    expect(s.draft.analysis.projectResolution.reasonCodes).toContain('PEOPLE_PROJECT');

    const c = (await http$.post(`/api/chats/task-drafts/${s.draft.draftId}/confirm`).set(O)
      .send({ confirmWorkload: true }).expect(201)).body.data;
    expect(String(c.projectId)).toBe(String(p1.id));
    const fb = await db.one<{ outcome: string }>(
      `SELECT outcome FROM project_resolution_feedback WHERE tenant_id = $1 AND task_id = $2`, [tenantId, c.taskId],
    );
    expect(fb?.outcome).toBe('accepted');
  });
});
