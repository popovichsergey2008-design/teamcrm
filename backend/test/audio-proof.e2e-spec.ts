import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { execFileSync } from 'child_process';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { AddressInfo } from 'net';
import { tmpdir } from 'os';
import { join } from 'path';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { AllExceptionsFilter } from '../src/common/http/all-exceptions.filter';
import { ResponseInterceptor } from '../src/common/http/response.interceptor';
import { DbService } from '../src/database/db.service';
import { FilesService } from '../src/modules/files/files.service';

/** Есть ли ffmpeg на машине прогона: без него проверяем всё, кроме самой вырезки. */
function toneMp3(): Buffer | null {
  try {
    const dir = mkdtempSync(join(tmpdir(), 'proof-'));
    const out = join(dir, 'tone.mp3');
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=40', out]);
    const b = readFileSync(out);
    rmSync(dir, { recursive: true, force: true });
    return b;
  } catch {
    return null;
  }
}

/**
 * Аудио-доказательство задачи (ТЗ-25): задача со встречи → фрагмент записи с правами
 * задачи; тем, кто встречу не видит, — только с согласия; ссылка подписана и живёт минуты.
 */
describe('Аудио-доказательство задачи (e2e)', () => {
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

  it('фрагмент — с согласия, по правам задачи, ссылка подписана; убрать можно', async () => {
    const owner = (await http$.post('/api/auth/register')
      .send({ acceptPrivacy: true, tenantName: 'Пруф', email: `pr_${uniq()}@t.test`, password: 'Test-pass-2026', fullName: 'Борис' }).expect(201)).body.data;
    const O = H(owner.accessToken);
    const tenantId = String(owner.user.tenantId);
    const ownerId = String(owner.user.id);
    const email = `prg_${uniq()}@t.test`;
    const gleb = (await http$.post('/api/users').set(O).send({ email, fullName: 'Глеб', password: 'Test-pass-2026', role: 'member' }).expect(201)).body.data;
    const G = H((await http$.post('/api/auth/login').send({ email, password: 'Test-pass-2026' }).expect(201)).body.data.accessToken);

    // встреча — в закрытом проекте (Глеб её не видит), задачи — в открытом
    const closed = (await http$.post('/api/projects').set(O).send({ name: 'Закрытый' }).expect(201)).body.data;
    const open = (await http$.post('/api/projects').set(O).send({ name: 'Открытый' }).expect(201)).body.data;
    await db.query(`UPDATE projects SET visibility = 'members' WHERE id = $1`, [closed.id]);

    const audio = toneMp3();
    const meeting = await db.one<{ id: string }>(
      `INSERT INTO meetings (tenant_id, project_id, title, source, status, duration_sec, created_by)
       VALUES ($1, $2, 'Планёрка', 'call', 'done', 40, $3) RETURNING id::text`,
      [tenantId, closed.id, ownerId],
    );
    const file = await app.get(FilesService).upload({
      tenantId, userId: ownerId, buffer: audio ?? Buffer.from('not audio'), fileName: 'meeting.mp3', contentType: 'audio/mpeg',
      ownerKind: 'meeting_recording', ownerId: meeting!.id,
    });
    await db.query(`UPDATE meetings SET file_id = $2 WHERE id = $1`, [meeting!.id, file.id]);
    await db.query(
      `INSERT INTO meeting_segments (tenant_id, meeting_id, idx, start_sec, end_sec, speaker, speaker_user_id, text) VALUES
         ($1, $2, 0, 10, 14, 'Борис', $3, 'Кто проверит вход гостя?'),
         ($1, $2, 1, 15, 19, 'Борис', $3, 'Глеб, проверь гостевой вход к пятнице')`,
      [tenantId, meeting!.id, ownerId],
    );
    const drafts = await db.many<{ id: string }>(
      `INSERT INTO meeting_task_drafts (tenant_id, meeting_id, title, assignee_id, project_id, author_id, source_sec) VALUES
         ($1, $2, 'Проверить гостевой вход', $3, $4, $5, 15),
         ($1, $2, 'Проверить гостевой вход на Android', $3, $4, $5, 15)
       RETURNING id::text`,
      [tenantId, meeting!.id, String(gleb.id), open.id, ownerId],
    );

    // экран итогов: у черновика есть фрагмент, и он откроется Глебу, который встречу не видит
    const view = (await http$.get(`/api/meetings/${meeting!.id}/postcall`).set(O).expect(200)).body.data;
    const p = view.proofs[drafts[0].id];
    expect(p.startSec).toBe(9.5);
    expect(p.quote).toContain('Глеб, проверь');
    expect(p.consent.users).toContain('Глеб');
    expect(view.recording.url).toMatch(/^\/api\/files\/play\//);

    // без согласия — задача без аудио; с согласием — фрагмент с правами задачи
    const r = (await http$.post(`/api/meetings/${meeting!.id}/postcall/tasks/create-batch`).set(O).send({
      confirmAll: true,
      items: [{ draftId: drafts[0].id }, { draftId: drafts[1].id, audio: 'allow' }],
    }).expect(201)).body.data;
    expect(r.created).toHaveLength(2);
    const [noAudio, withAudio] = r.created.map((c: any) => c.taskId);
    expect((await http$.get(`/api/tasks/${noAudio}/audio-proof`).set(O).expect(200)).body.data).toBeNull();

    let proof: any;
    for (let i = 0; i < 60; i++) {
      proof = (await http$.get(`/api/tasks/${withAudio}/audio-proof`).set(O).expect(200)).body.data;
      if (proof?.status !== 'pending') break;
      await sleep(250);
    }
    expect(proof.quote).toContain('Кто проверит');
    expect(proof.canOpenMeeting).toBe(true);
    const row = await db.one<{ visibility_policy: string }>(`SELECT visibility_policy FROM task_audio_proofs WHERE task_id = $1`, [withAudio]);
    expect(row?.visibility_policy).toBe('task_scoped');

    if (audio) {
      expect(proof.status).toBe('ready');
      expect(proof.durationSec).toBe(15); // 9,5–24 с: вопрос перед поручением вошёл
      const play = await http$.get(proof.playback.url).set('Range', 'bytes=0-99').expect(206);
      expect(play.headers['content-type']).toMatch(/audio\/mpeg/);
      // подпись подделана — «не найден»
      await http$.get(proof.playback.url.replace(/s=[^&]+/, 's=forged')).expect(404);
      // Глеб видит задачу — слышит фрагмент, но открыть встречу не может
      const his = (await http$.get(`/api/tasks/${withAudio}/audio-proof`).set(G).expect(200)).body.data;
      expect(his.status).toBe('ready');
      expect(his.canOpenMeeting).toBe(false);
      // −5 сек — фрагмент длиннее
      const longer = (await http$.patch(`/api/tasks/${withAudio}/audio-proof`).set(O).send({ startDelta: -5 }).expect(200)).body.data;
      expect(longer.startSec).toBe(4.5);
    } else {
      expect(['ready', 'failed']).toContain(proof.status); // без ffmpeg вырезка честно падает
    }

    // фрагмент, выданный тем, кто встречу не видит, — в журнале безопасности (§55)
    const audit = await db.one<{ metadata: any }>(
      `SELECT metadata FROM security_audit WHERE tenant_id = $1 AND event_type = 'task.audio_proof.created' AND resource_id = $2`,
      [tenantId, String(withAudio)],
    );
    expect(audit?.metadata.beyondMeeting).toContain('Глеб');

    await http$.delete(`/api/tasks/${withAudio}/audio-proof`).set(O).expect(200);
    expect((await http$.get(`/api/tasks/${withAudio}/audio-proof`).set(O).expect(200)).body.data.playback).toBeNull();

    const q = (await http$.get('/api/meetings/postcall/quality').set(O).expect(200)).body.data;
    expect(q).toHaveProperty('proofPlayRate');
  });
});
