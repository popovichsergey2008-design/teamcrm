import { Injectable, Logger } from '@nestjs/common';
import { meetingVisibleSql, projectVisibleSql, ProjectViewer, viewerParams } from '../../common/access/project-visibility';
import { AppException } from '../../common/http/app-exception';
import { DbService } from '../../database/db.service';
import { FilesService } from '../files/files.service';
import { RealtimeService } from '../realtime/realtime.service';
import { SecurityService } from '../security/security.service';
import { cutClips } from './audio.util';
import { guestInRange, proofDrifted, proofRange, type Segment } from './postcall-rules';

interface ProofRow {
  id: string; tenant_id: string; task_id: string; meeting_id: string | null; draft_id: string | null;
  chat_message_id: string | null; chat_id: string | null;
  source_file_id: string | null; clip_file_id: string | null; anchor_ms: number; start_ms: number; end_ms: number;
  speaker: string | null; speaker_user_id: string | null; quote_text: string | null; visibility_policy: string;
  status: string; error: string | null; play_count: number; created_by: string | null;
}

/** Что показать у черновика в итогах: фрагмент и нужно ли согласие на него. */
export interface DraftProof {
  startSec: number; endSec: number; quote: string; speaker: string | null;
  /** кому фрагмент откроется без доступа к встрече; гость-клиент во фрагменте (§28, §41) */
  consent: { users: string[]; guest: boolean } | null;
  /** формулировку переписали — подходит ли звук (§37) */
  drifted: boolean;
}

/** Правило «все, кто увидит задачу этого проекта, но не видят встречу» — текстом по колонкам пользователя. */
const AS_USER = { user: 'u.id', all: "(r.code IN ('owner','manager'))", client: "(r.code = 'client')" };

/**
 * Аудио-доказательство задачи (ТЗ-25): фрагмент созвона, где прозвучало поручение.
 *
 * Решения заказчика 11.10: фрагмент — отдельный короткий файл с правами ЗАДАЧИ (играет
 * мгновенно, не тянет часовую запись, не открывает встречу); слышат все, кто видит
 * задачу, — но если среди них есть те, кто встречу не видит, или во фрагменте говорит
 * гость, — только с явного «Разрешить фрагмент». Молча доступ не расширяем.
 */
@Injectable()
export class AudioProofService {
  private readonly log = new Logger('AudioProof');

  constructor(
    private readonly db: DbService,
    private readonly files: FilesService,
    private readonly realtime: RealtimeService,
    private readonly security: SecurityService,
  ) {}

  /** Реплики встречи с концами — для фрагментов. */
  async segments(tenantId: string, meetingId: string): Promise<Segment[]> {
    const rows = await this.db.many<{ start_sec: string; end_sec: string | null; text: string; speaker: string | null; speaker_user_id: string | null }>(
      `SELECT start_sec, end_sec, text, speaker, speaker_user_id::text FROM meeting_segments
        WHERE tenant_id = $1 AND meeting_id = $2 ORDER BY idx`,
      [tenantId, meetingId],
    );
    return rows.map((r) => ({
      start: Number(r.start_sec), end: r.end_sec == null ? null : Number(r.end_sec), text: r.text,
      speaker: r.speaker, speakerUserId: r.speaker_user_id,
    }));
  }

  /** Есть ли что слушать: запись звуком (а не только субтитры). */
  async audioSource(tenantId: string, meetingId: string) {
    return this.db.one<{ file_id: string; duration_sec: number | null; title: string; happened_at: Date | null; project_id: string | null }>(
      `SELECT file_id::text, duration_sec, title, happened_at, project_id::text FROM meetings
        WHERE tenant_id = $1 AND id = $2 AND file_id IS NOT NULL AND source <> 'transcript'`,
      [tenantId, meetingId],
    );
  }

  /** Кто увидит задачу проекта, но не видит встречу — им фрагмент откроется только с согласия. */
  async audienceGap(tenantId: string, meetingId: string, projectId: string): Promise<string[]> {
    const rows = await this.db.many<{ full_name: string }>(
      `SELECT u.full_name FROM users u JOIN roles r ON r.id = u.role_id
         JOIN meetings m ON m.id = $2 AND m.tenant_id = $1
        WHERE u.tenant_id = $1 AND u.is_active
          AND ${projectVisibleSql('$3', AS_USER)}
          AND NOT ${meetingVisibleSql('m', AS_USER)}
        ORDER BY u.full_name LIMIT 20`,
      [tenantId, meetingId, projectId],
    );
    return rows.map((r) => r.full_name);
  }

  /** Фрагменты черновиков для экрана итогов: диапазон, текст, кому откроется (§34). */
  async forDrafts(
    tenantId: string, meetingId: string,
    drafts: { id: string; title: string; project_id: string | null; source_sec: string | null; status: string }[],
  ): Promise<Record<string, DraftProof>> {
    const src = await this.audioSource(tenantId, meetingId);
    if (!src) return {};
    const segs = await this.segments(tenantId, meetingId);
    const gaps = new Map<string, string[]>();
    const out: Record<string, DraftProof> = {};
    for (const d of drafts) {
      if (d.source_sec == null) continue;
      const r = proofRange(segs, Number(d.source_sec), src.duration_sec);
      if (!r) continue;
      let users: string[] = [];
      if (d.project_id && d.status !== 'applied') {
        if (!gaps.has(d.project_id)) gaps.set(d.project_id, await this.audienceGap(tenantId, meetingId, d.project_id).catch(() => []));
        users = gaps.get(d.project_id)!;
      }
      const guest = guestInRange(segs, r.startSec, r.endSec);
      out[d.id] = {
        startSec: r.startSec, endSec: r.endSec, quote: r.quote, speaker: r.speaker,
        consent: users.length || guest ? { users, guest } : null,
        drifted: proofDrifted(d.title, r.quote),
      };
    }
    return out;
  }

  /**
   * Задача создана из черновика — завести фрагмент. Согласия нет, а оно нужно, — без
   * аудио: молча доступ не расширяем. Вырезка — фоном: задача не ждёт звука (§44, §49).
   */
  async attach(i: {
    tenantId: string; actorId: string; taskId: string; meetingId: string; draftId: string; projectId: string;
    sourceSec: number; consent: 'allow' | 'none' | undefined;
  }): Promise<'attached' | 'needs_consent' | 'none'> {
    if (i.consent === 'none') return 'none';
    const src = await this.audioSource(i.tenantId, i.meetingId);
    if (!src) return 'none';
    const segs = await this.segments(i.tenantId, i.meetingId);
    const r = proofRange(segs, i.sourceSec, src.duration_sec);
    if (!r) return 'none';
    const gap = await this.audienceGap(i.tenantId, i.meetingId, i.projectId).catch(() => []);
    const guest = guestInRange(segs, r.startSec, r.endSec);
    const scoped = gap.length > 0 || guest;
    if (scoped && i.consent !== 'allow') return 'needs_consent';
    const row = await this.db.one<{ id: string }>(
      `INSERT INTO task_audio_proofs (tenant_id, task_id, meeting_id, draft_id, source_file_id, anchor_ms, start_ms, end_ms,
                                      speaker, speaker_user_id, quote_text, visibility_policy, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       ON CONFLICT (task_id) DO NOTHING RETURNING id::text`,
      [i.tenantId, i.taskId, i.meetingId, i.draftId, src.file_id, Math.round(r.anchorSec * 1000), Math.round(r.startSec * 1000),
        Math.round(r.endSec * 1000), r.speaker, r.speakerUserId, r.quote, scoped ? 'task_scoped' : 'meeting_acl', i.actorId],
    );
    if (row) {
      void this.security.record({
        tenantId: i.tenantId, actorId: i.actorId, event: 'task.audio_proof.created', resourceType: 'task', resourceId: i.taskId,
        // фрагмент выдан тем, кто встречу не видит, — это отдельно видно в журнале (§55)
        metadata: { meetingId: i.meetingId, scoped, beyondMeeting: gap, guest },
      }).catch(() => undefined);
    }
    return row ? 'attached' : 'none';
  }

  /** Вырезать ждущие фрагменты встречи — одно скачивание записи на все задачи. */
  async cutPending(tenantId: string, meetingId: string): Promise<void> {
    const rows = await this.db.many<ProofRow>(
      `SELECT * FROM task_audio_proofs WHERE tenant_id = $1 AND meeting_id = $2 AND status = 'pending'`, [tenantId, meetingId],
    );
    if (!rows.length) return;
    try {
      const sourceId = rows[0].source_file_id;
      if (!sourceId) throw new Error('Запись встречи недоступна');
      const { file, stream } = await this.files.getForDownload(tenantId, sourceId);
      const chunks: Buffer[] = [];
      for await (const c of stream) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
      const clips = await cutClips(Buffer.concat(chunks), file.file_name, rows.map((r) => ({ startSec: r.start_ms / 1000, endSec: r.end_ms / 1000 })));
      for (const [k, r] of rows.entries()) {
        const clip = clips[k];
        if (!clip) { await this.fail(r, 'Не удалось вырезать фрагмент'); continue; }
        const stored = await this.files.upload({
          tenantId, userId: String(r.created_by ?? ''), buffer: clip, fileName: `context-${r.task_id}.mp3`,
          contentType: 'audio/mpeg', ownerKind: 'task_audio_proof', ownerId: r.task_id,
        }).catch(() => null);
        if (!stored) { await this.fail(r, 'Не удалось сохранить фрагмент'); continue; }
        if (r.clip_file_id) await this.files.removeInternal(tenantId, r.clip_file_id).catch(() => undefined);
        await this.db.query(
          `UPDATE task_audio_proofs SET clip_file_id = $2, status = 'ready', error = NULL, updated_at = now() WHERE id = $1`,
          [r.id, String(stored.id)],
        );
        this.emit(tenantId, r.task_id, 'ready');
      }
    } catch (e) {
      this.log.warn(`фрагменты встречи ${meetingId}: ${(e as Error).message}`);
      for (const r of rows) await this.fail(r, 'Запись встречи недоступна');
    }
  }

  /** Фрагмент задачи для карточки (§30–32): права задачи, ссылка на 10 минут, журнал. */
  async view(tenantId: string, viewer: ProjectViewer, taskId: string) {
    const row = await this.visibleRow(tenantId, viewer, taskId);
    if (!row) return null;
    const meeting = row.meeting_id ? await this.db.one<{ title: string; happened_at: Date | null; ok: boolean }>(
      `SELECT m.title, m.happened_at, ${meetingVisibleSql('m', { user: '$3', all: '$4', client: '$5' })} AS ok
         FROM meetings m WHERE m.tenant_id = $1 AND m.id = $2`,
      [tenantId, row.meeting_id, ...viewerParams(viewer)],
    ) : null;
    // голосовое в чате (ТЗ-26): «Открыть сообщение» — тем, кто этот чат видит
    const chat = row.chat_id ? await this.db.one<{ title: string | null; kind: string; created_at: Date; ok: boolean }>(
      `SELECT c.title, c.kind, m.created_at,
              (c.kind = 'project' OR EXISTS (SELECT 1 FROM chat_members cm WHERE cm.chat_id = c.id AND cm.user_id = $3::bigint)) AS ok
         FROM chats c JOIN chat_messages m ON m.id = $4 WHERE c.tenant_id = $1 AND c.id = $2`,
      [tenantId, row.chat_id, viewer.userId, row.chat_message_id],
    ) : null;
    const playable = row.status === 'ready' && row.clip_file_id;
    if (playable) {
      await this.db.query(`UPDATE task_audio_proofs SET play_count = play_count + 1, last_played_at = now() WHERE id = $1`, [row.id]);
      void this.security.record({
        tenantId, actorId: viewer.userId, event: 'task.audio_proof.viewed', resourceType: 'task', resourceId: taskId,
        metadata: { meetingId: row.meeting_id, scoped: row.visibility_policy === 'task_scoped' },
      }).catch(() => undefined);
    }
    return {
      status: row.status, error: row.error,
      startSec: row.start_ms / 1000, endSec: row.end_ms / 1000, anchorSec: row.anchor_ms / 1000,
      durationSec: Math.round((row.end_ms - row.start_ms) / 1000),
      quote: row.quote_text, speaker: row.speaker,
      source: row.meeting_id ? 'meeting' : 'chat',
      meeting: row.meeting_id
        ? { id: row.meeting_id, title: meeting?.title ?? 'Встреча', happenedAt: meeting?.happened_at ?? null }
        : { id: '', title: chat?.kind === 'dm' ? 'Голосовое в личной переписке' : `Голосовое в чате${chat?.title ? ` «${chat.title}»` : ''}`, happenedAt: chat?.created_at ?? null },
      // «Открыть созвон с 31:14» — только тем, кто встречу видит (§32)
      canOpenMeeting: !!meeting?.ok,
      message: row.chat_message_id && chat?.ok ? { chatId: String(row.chat_id), messageId: String(row.chat_message_id) } : null,
      playback: playable ? this.files.signPlay(tenantId, String(row.clip_file_id), 600) : null,
    };
  }

  /** «−5 сек / +10 сек» (§35): сдвинуть края и вырезать заново. */
  async adjust(tenantId: string, viewer: ProjectViewer, taskId: string, d: { startDelta?: number; endDelta?: number }) {
    const row = await this.visibleRow(tenantId, viewer, taskId);
    if (!row || row.status === 'revoked') throw AppException.notFound('У задачи нет фрагмента');
    if (!row.meeting_id) throw AppException.validation('У голосового из чата фрагмент — вся запись');
    const start = Math.max(0, row.start_ms + Math.round((d.startDelta ?? 0) * 1000));
    let end = row.end_ms + Math.round((d.endDelta ?? 0) * 1000);
    if (end - start < 5000) end = start + 5000;
    if (end - start > 60_000) end = start + 60_000;
    const segs = await this.segments(tenantId, row.meeting_id);
    const quote = segs.filter((s) => s.start < end / 1000 && (s.end ?? s.start) > start / 1000)
      .map((s) => `${s.speaker ? `${s.speaker}: ` : ''}${s.text}`).join('\n').slice(0, 1500);
    await this.db.query(
      `UPDATE task_audio_proofs SET start_ms = $2, end_ms = $3, quote_text = $4, status = 'pending', updated_at = now() WHERE id = $1`,
      [row.id, start, end, quote],
    );
    await this.cutPending(tenantId, row.meeting_id);
    return this.view(tenantId, viewer, taskId);
  }

  async reprocess(tenantId: string, viewer: ProjectViewer, taskId: string) {
    const row = await this.visibleRow(tenantId, viewer, taskId);
    if (!row || row.status === 'revoked') throw AppException.notFound('У задачи нет фрагмента');
    if (!row.meeting_id) return this.view(tenantId, viewer, taskId);
    await this.db.query(`UPDATE task_audio_proofs SET status = 'pending', error = NULL WHERE id = $1`, [row.id]);
    await this.cutPending(tenantId, row.meeting_id);
    return this.view(tenantId, viewer, taskId);
  }

  /** «Убрать аудио» (§36): файл удаляется, запись остаётся отозванной — видно, что был. */
  async revoke(tenantId: string, viewer: ProjectViewer, taskId: string) {
    const row = await this.visibleRow(tenantId, viewer, taskId);
    if (!row) throw AppException.notFound('У задачи нет фрагмента');
    // у голосового без копии «фрагмент» — сам файл сообщения: его не удаляем, только отвязываем
    if (row.clip_file_id && row.clip_file_id !== row.source_file_id) await this.files.removeInternal(tenantId, row.clip_file_id).catch(() => undefined);
    await this.db.query(`UPDATE task_audio_proofs SET status = 'revoked', clip_file_id = NULL, updated_at = now() WHERE id = $1`, [row.id]);
    void this.security.record({
      tenantId, actorId: viewer.userId, event: 'task.audio_proof.revoked', resourceType: 'task', resourceId: taskId, metadata: {},
    }).catch(() => undefined);
    this.emit(tenantId, taskId, 'revoked');
    return { revoked: true };
  }

  /** Фрагмент задачи, которую человек видит; чужая или закрытая — «нет фрагмента». */
  private visibleRow(tenantId: string, viewer: ProjectViewer, taskId: string) {
    return this.db.one<ProofRow>(
      `SELECT a.* FROM task_audio_proofs a JOIN tasks t ON t.id = a.task_id
        WHERE a.tenant_id = $1 AND a.task_id = $2 AND t.deleted_at IS NULL
          AND ${projectVisibleSql('t.project_id', { user: '$3', all: '$4', client: '$5' })}`,
      [tenantId, taskId, ...viewerParams(viewer)],
    );
  }

  private async fail(r: ProofRow, message: string) {
    await this.db.query(`UPDATE task_audio_proofs SET status = 'failed', error = $2, updated_at = now() WHERE id = $1`, [r.id, message]);
    this.emit(r.tenant_id, r.task_id, 'failed');
  }

  /** Открытая карточка задачи узнаёт, что фрагмент готов, — без перезагрузки. */
  private emit(tenantId: string, taskId: string, status: string) {
    void this.db.one<{ project_id: string }>(`SELECT project_id::text FROM tasks WHERE id = $1`, [taskId])
      .then((t) => { if (t) this.realtime.emit(tenantId, t.project_id, 'task.audio_proof', { taskId, status }); })
      .catch(() => undefined);
  }
}
