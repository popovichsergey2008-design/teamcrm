import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AddressInfo } from 'net';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { AllExceptionsFilter } from '../src/common/http/all-exceptions.filter';
import { ResponseInterceptor } from '../src/common/http/response.interceptor';
import { DbService } from '../src/database/db.service';
import { MeetingsService } from '../src/modules/meetings/meetings.service';
import { PostcallService } from '../src/modules/meetings/postcall.service';

/**
 * Итоги встречи после звонка (ТЗ-22, этап 1): созвон закончился → разбор заведён сразу,
 * встреча находится по комнате, блоки отмечают готовность, разбор закрывает организатор.
 */
describe('Итоги встречи после звонка (e2e)', () => {
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

  async function org() {
    const owner = (await http$.post('/api/auth/register')
      .send({ tenantName: 'Итоги', email: `pc_${uniq()}@t.test`, password: 'password123', fullName: 'Борис' }).expect(201)).body.data;
    const O = H(owner.accessToken);
    const email = `pcm_${uniq()}@t.test`;
    const u = (await http$.post('/api/users').set(O).send({ email, fullName: 'Глеб', password: 'password123', role: 'member' }).expect(201)).body.data;
    const tok = (await http$.post('/api/auth/login').send({ email, password: 'password123' }).expect(201)).body.data.accessToken;
    return { O, ownerId: String(owner.user.id), tenantId: String(owner.user.tenantId), gleb: { id: String(u.id), H: H(tok) } };
  }

  /** Созвон закончился: шлюз отдаёт дорожки в конвейер встреч. Звук — не настоящий: разбор упадёт, и это тоже проверяем. */
  async function endCall(tenantId: string, ownerId: string, glebId: string, roomId: string) {
    return app.get(MeetingsService).ingestCallRecording({
      tenantId, actorId: ownerId, projectId: null, title: 'Созвон', roomId,
      tracks: [{ userId: ownerId, displayName: 'Борис', buffer: Buffer.from('not audio'), fileName: 'a.ogg', offsetSec: 0 }],
      attendees: [{ userId: ownerId, name: 'Борис' }, { userId: glebId, name: 'Глеб' }, { userId: 'guest:x', name: 'Анна' }],
      durationSec: 2520,
    });
  }

  it('разбор заводится сразу, встреча находится по комнате, сбой не крутится вечно', async () => {
    const { O, ownerId, tenantId, gleb } = await org();
    const roomId = `room-${uniq()}`;
    // экран открылся раньше, чем допишется запись — встречи ещё нет
    expect((await http$.get(`/api/meetings/postcall/by-room/${roomId}`).set(O).expect(200)).body.data.meetingId).toBeNull();

    const meetingId = await endCall(tenantId, ownerId, gleb.id, roomId);
    expect((await http$.get(`/api/meetings/postcall/by-room/${roomId}`).set(O).expect(200)).body.data.meetingId).toBe(String(meetingId));

    let view: any;
    for (let i = 0; i < 50; i++) {
      view = (await http$.get(`/api/meetings/${meetingId}/postcall`).set(O).expect(200)).body.data;
      if (view.review.status !== 'processing') break;
      await sleep(200);
    }
    expect(view.meeting.duration_sec).toBe(2520);
    expect(view.review.ownerId).toBe(ownerId);
    expect(view.review.canClose).toBe(true);
    expect(view.review.participants.map((p: any) => p.name)).toEqual(['Борис', 'Глеб', 'Анна (гость)']);
    // звук битый — расшифровка упала, остальные блоки не висят в «считается»
    expect(view.review.status).toBe('review_required');
    expect(view.review.blocks.transcript).toBe('failed');
    expect(view.review.blocks.followup).toBe('skipped');
    const opened = await db.one<{ opened_at: Date | null }>(`SELECT opened_at FROM meeting_postcall_reviews WHERE meeting_id = $1`, [meetingId]);
    expect(opened?.opened_at).toBeTruthy();

    // неразобранные итоги — у владельца, не у участника
    expect((await http$.get('/api/meetings/postcall/pending').set(O).expect(200)).body.data.map((r: any) => r.meeting_id)).toContain(String(meetingId));
    expect((await http$.get('/api/meetings/postcall/pending').set(gleb.H).expect(200)).body.data).toHaveLength(0);

    // участник видит итоги, но разбор за всех не закрывает
    const his = (await http$.get(`/api/meetings/${meetingId}/postcall`).set(gleb.H).expect(200)).body.data;
    expect(his.review.canClose).toBe(false);
    await http$.post(`/api/meetings/${meetingId}/postcall/complete`).set(gleb.H).send({}).expect(403);

    // «Разобрать позже» не убирает итоги из списка
    await http$.post(`/api/meetings/${meetingId}/postcall/snooze`).set(O).expect(201);
    expect((await http$.get('/api/meetings/postcall/pending').set(O).expect(200)).body.data).toHaveLength(1);

    // итоги участникам — один раз; участник рассылку не делает
    await http$.post(`/api/meetings/${meetingId}/postcall/recap`).set(gleb.H).expect(403);
    expect((await http$.post(`/api/meetings/${meetingId}/postcall/recap`).set(O).expect(201)).body.data.sent).toBe(1);
    await http$.post(`/api/meetings/${meetingId}/postcall/recap`).set(O).expect(409);
    const inbox = await db.many<{ path: string }>(
      `SELECT path FROM notification_inbox WHERE user_id = $1 AND event_key = 'meeting.recap'`, [gleb.id],
    );
    expect(inbox.map((i) => i.path)).toEqual([`/meetings/${meetingId}/postcall`]);

    // «отложенное» истекло — итоги возвращаются карточкой в ящик секретаря
    await db.query(`UPDATE meeting_postcall_reviews SET snoozed_until = now() - interval '1 minute' WHERE meeting_id = $1`, [meetingId]);
    await app.get(PostcallService).remindStale();
    const cards = (await http$.get('/api/assistant/proposals').set(O).expect(200)).body.data.items;
    expect(cards.map((c: any) => c.skill)).toContain('postcall');
    await app.get(PostcallService).remindStale(); // второй раз не напоминает
    expect((await http$.get('/api/assistant/proposals').set(O).expect(200)).body.data.items.filter((c: any) => c.skill === 'postcall')).toHaveLength(1);

    expect((await http$.post(`/api/meetings/${meetingId}/postcall/complete`).set(O).send({}).expect(201)).body.data.status).toBe('completed');
    expect((await http$.get('/api/meetings/postcall/pending').set(O).expect(200)).body.data).toHaveLength(0);
    // разбор закрыт — карточка «не разобраны» ушла из ящика сама
    expect((await http$.get('/api/assistant/proposals').set(O).expect(200)).body.data.items.filter((c: any) => c.skill === 'postcall')).toHaveLength(0);
    // в списке встреч — «итоги обработаны»
    const list = (await http$.get('/api/meetings').set(O).expect(200)).body.data;
    expect(list.find((m: any) => String(m.id) === String(meetingId)).review_status).toBe('completed');
  });

  it('«Создать выбранные»: упавший пункт не отменяет остальные, повтор создаёт только его', async () => {
    const { O, tenantId } = await org();
    const project = (await http$.post('/api/projects').set(O).send({ name: 'Сайт' }).expect(201)).body.data;
    const vtt = [
      'WEBVTT', '',
      '00:00:01.000 --> 00:00:05.000', 'Борис: подготовлю смету к пятнице', '',
      '00:00:06.000 --> 00:00:09.000', 'Борис: займусь макетом главной', '',
    ].join('\n');
    const m = (await http$.post('/api/meetings').set(O).field('title', 'Планёрка').field('projectId', String(project.id))
      .attach('file', Buffer.from(vtt), 'a.vtt').expect(201)).body.data;
    let drafts: any[] = [];
    for (let i = 0; i < 50 && drafts.length < 2; i++) {
      drafts = (await http$.get(`/api/meetings/${m.id}`).set(O).expect(200)).body.data.drafts;
      if (drafts.length < 2) await sleep(200);
    }
    expect(drafts).toHaveLength(2);
    // у второго черновика проекта нет — задаче некуда лечь
    await db.query(`UPDATE meeting_task_drafts SET project_id = NULL WHERE id = $1`, [drafts[1].id]);
    void tenantId;

    const first = (await http$.post(`/api/meetings/${m.id}/postcall/tasks/create-batch`).set(O)
      .send({ items: drafts.map((d) => ({ draftId: String(d.id) })) }).expect(201)).body.data;
    expect(first.created).toHaveLength(1);
    expect(first.failed).toHaveLength(1);
    const failed = (await http$.get(`/api/meetings/${m.id}`).set(O).expect(200)).body.data.drafts.find((d: any) => d.id === drafts[1].id);
    expect(failed.status).toBe('failed');
    expect(failed.error_message).toMatch(/проект/i);

    // повторяем весь пакет, поправив упавший: созданный второй раз не создаётся
    const again = (await http$.post(`/api/meetings/${m.id}/postcall/tasks/create-batch`).set(O)
      .send({ items: [{ draftId: String(drafts[0].id) }, { draftId: String(drafts[1].id), projectId: String(project.id) }] }).expect(201)).body.data;
    expect(again.created).toHaveLength(1);
    expect(again.skipped).toBe(1);
    const board = (await http$.get(`/api/projects/${project.id}/board`).set(O).expect(200)).body.data;
    expect(board.columns.flatMap((c: any) => c.tasks)).toHaveLength(2);
    // правку человека видно: проект выбирал он, а не ИИ
    const fixed = await db.one<{ edited_fields: string[] }>(`SELECT edited_fields FROM meeting_task_drafts WHERE id = $1`, [drafts[1].id]);
    expect(fixed?.edited_fields).toContain('project');
  });

  it('загруженная запись без созвона разбора не имеет; задачи со встречи по умолчанию — черновики', async () => {
    const { O, tenantId } = await org();
    const t = await db.one<{ meeting_auto_tasks: boolean }>(`SELECT meeting_auto_tasks FROM tenants WHERE id = $1`, [tenantId]);
    expect(t?.meeting_auto_tasks).toBe(false);
    const vtt = 'WEBVTT\n\n00:00:01.000 --> 00:00:04.000\n<v Борис>Начинаем\n';
    const m = (await http$.post('/api/meetings').set(O).field('title', 'Планёрка')
      .attach('file', Buffer.from(vtt), 'a.vtt').expect(201)).body.data;
    const view = (await http$.get(`/api/meetings/${m.id}/postcall`).set(O).expect(200)).body.data;
    expect(view.review).toBeNull();
  });
});
