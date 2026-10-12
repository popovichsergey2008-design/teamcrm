import { Injectable } from '@nestjs/common';
import { DbService } from '../../database/db.service';

export interface BrandRow {
  tenant_id: string;
  company_name: string | null;
  logo_file_id: string | null;
  accent: string | null;
  background: string;
  welcome_text: string | null;
  footer_text: string | null;
  powered_by: boolean;
  recording_notice: boolean;
  consent_required: boolean;
  summary_days: number;
  tenant_name: string;
}

export interface SummaryRow {
  id: string;
  tenant_id: string;
  meeting_id: string;
  room_id: string | null;
  status: 'draft' | 'published';
  language: string;
  summary_text: string;
  next_meeting_title: string | null;
  next_meeting_at: Date | null;
  next_meeting_url: string | null;
  dirty: boolean;
  draft_model: string | null;
  version: number;
  published_at: Date | null;
  published_by: string | null;
  published_json: PublishedSummary | null;
  updated_at: Date;
}

export interface PublishedSummary {
  version: number;
  language: string;
  summary: string;
  agreements: { text: string; side: string; deadlineAt: string | null }[];
  files: string[];
  nextMeeting: { title: string; at: string; url: string | null } | null;
  publishedAt: string;
}

export interface AgreementRow {
  id: string;
  position: number;
  text: string;
  owner_side: string;
  deadline_at: Date | null;
  source_decision_id: string | null;
  source_draft_id: string | null;
}

export interface MeetingRow {
  id: string;
  tenant_id: string;
  title: string;
  happened_at: Date | null;
  created_at: Date;
  created_by: string | null;
  client_id: string | null;
  room_id: string | null;
  status: string;
}

/**
 * Данные гостевого портала (ТЗ-28). Всё, что уходит гостю, проходит через
 * опубликованную версию протокола (`published_json`) и явный список файлов —
 * внутренний разбор встречи гостю не виден ни одной ручкой (п. 30, 101).
 */
@Injectable()
export class GuestPortalRepository {
  constructor(private readonly db: DbService) {}

  // ── бренд ──

  brand(tenantId: string): Promise<BrandRow | null> {
    return this.db.one<BrandRow>(
      `SELECT t.id::text AS tenant_id, t.name AS tenant_name,
              b.company_name, b.logo_file_id::text, b.accent, COALESCE(b.background, 'soft') AS background,
              b.welcome_text, b.footer_text, COALESCE(b.powered_by, TRUE) AS powered_by,
              COALESCE(b.recording_notice, TRUE) AS recording_notice, COALESCE(b.consent_required, FALSE) AS consent_required,
              COALESCE(b.summary_days, 30) AS summary_days
         FROM tenants t LEFT JOIN guest_brand b ON b.tenant_id = t.id
        WHERE t.id = $1`,
      [tenantId],
    );
  }

  async saveBrand(tenantId: string, b: {
    companyName: string | null; logoFileId: string | null; accent: string | null; background: string;
    welcomeText: string | null; footerText: string | null; poweredBy: boolean; recordingNotice: boolean;
    consentRequired: boolean; summaryDays: number;
  }): Promise<void> {
    await this.db.query(
      `INSERT INTO guest_brand (tenant_id, company_name, logo_file_id, accent, background, welcome_text, footer_text,
                                powered_by, recording_notice, consent_required, summary_days, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now())
       ON CONFLICT (tenant_id) DO UPDATE SET
         company_name = EXCLUDED.company_name, logo_file_id = EXCLUDED.logo_file_id, accent = EXCLUDED.accent,
         background = EXCLUDED.background, welcome_text = EXCLUDED.welcome_text, footer_text = EXCLUDED.footer_text,
         powered_by = EXCLUDED.powered_by, recording_notice = EXCLUDED.recording_notice,
         consent_required = EXCLUDED.consent_required, summary_days = EXCLUDED.summary_days, updated_at = now()`,
      [tenantId, b.companyName, b.logoFileId, b.accent, b.background, b.welcomeText, b.footerText, b.poweredBy,
        b.recordingNotice, b.consentRequired, b.summaryDays],
    );
  }

  // ── встреча ──

  meeting(tenantId: string, meetingId: string): Promise<MeetingRow | null> {
    return this.db.one<MeetingRow>(
      `SELECT id::text, tenant_id::text, title, happened_at, created_at, created_by::text, client_id::text, room_id, status
         FROM meetings WHERE tenant_id = $1 AND id = $2`,
      [tenantId, meetingId],
    );
  }

  /** Запись встречи этой комнаты — последняя: у ссылки одна комната, у комнаты — свои созвоны. */
  meetingOfRoom(tenantId: string, roomId: string): Promise<MeetingRow | null> {
    return this.db.one<MeetingRow>(
      `SELECT id::text, tenant_id::text, title, happened_at, created_at, created_by::text, client_id::text, room_id, status
         FROM meetings WHERE tenant_id = $1 AND room_id = $2
        ORDER BY COALESCE(happened_at, created_at) DESC LIMIT 1`,
      [tenantId, roomId],
    );
  }

  /** Событие календаря комнаты: тема, время, ведущий. */
  eventOfRoom(tenantId: string, roomId: string) {
    return this.db.one<{ event_id: string; public_id: string | null; title: string; starts_at: Date; ends_at: Date; organizer_id: string | null; organizer_name: string | null }>(
      `SELECT e.id::text AS event_id, l.public_id, e.title, e.starts_at, e.ends_at, e.created_by::text AS organizer_id, u.full_name AS organizer_name
         FROM meet_guest_links l JOIN calendar_events e ON e.id = l.event_id
         LEFT JOIN users u ON u.id = e.created_by
        WHERE l.tenant_id = $1 AND l.room_id = $2 AND l.kind = 'meeting'
        ORDER BY l.id DESC LIMIT 1`,
      [tenantId, roomId],
    );
  }

  /** Может ли человек вести протокол: автор записи, организатор события, владелец разбора. */
  async canHost(tenantId: string, meetingId: string, userId: string): Promise<boolean> {
    const r = await this.db.one<{ ok: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM meetings m
          WHERE m.tenant_id = $1 AND m.id = $2 AND (
                m.created_by = $3::bigint
             OR EXISTS (SELECT 1 FROM meeting_postcall_reviews r WHERE r.meeting_id = m.id AND r.owner_id = $3::bigint)
             OR EXISTS (SELECT 1 FROM meet_guest_links l JOIN calendar_events e ON e.id = l.event_id
                         WHERE l.room_id = m.room_id AND l.tenant_id = m.tenant_id
                           AND (e.created_by = $3::bigint OR EXISTS (
                                SELECT 1 FROM calendar_participants p WHERE p.event_id = e.id AND p.user_id = $3::bigint AND p.is_co_organizer)))
          )) AS ok`,
      [tenantId, meetingId, userId],
    );
    return !!r?.ok;
  }

  /** Решения встречи и поручения с неё — из них черновик договорённостей (п. 93). */
  async sources(tenantId: string, meetingId: string) {
    const [decisions, drafts, summary, transcript] = await Promise.all([
      this.db.many<{ id: string; text: string }>(
        `SELECT id::text, text FROM decisions WHERE tenant_id = $1 AND meeting_id = $2 AND revoked_at IS NULL ORDER BY id`,
        [tenantId, meetingId],
      ),
      this.db.many<{ id: string; title: string; deadline_at: Date | null; status: string; assignee_id: string | null }>(
        `SELECT id::text, title, deadline_at, status, assignee_id::text FROM meeting_task_drafts
          WHERE tenant_id = $1 AND meeting_id = $2 ORDER BY id`,
        [tenantId, meetingId],
      ),
      this.db.one<{ summary: string }>(`SELECT summary FROM meeting_summaries WHERE meeting_id = $1`, [meetingId]),
      this.db.one<{ text: string }>(
        `SELECT left(string_agg(text, ' ' ORDER BY idx), 6000) AS text FROM meeting_segments WHERE meeting_id = $1`,
        [meetingId],
      ),
    ]);
    return { decisions, drafts, internalSummary: summary?.summary ?? '', transcript: transcript?.text ?? '' };
  }

  /** Ближайшая следующая встреча-созвон с теми же гостями (п. 42). */
  nextMeeting(tenantId: string, roomId: string, after: Date) {
    return this.db.one<{ title: string; starts_at: Date; public_id: string | null }>(
      `WITH emails AS (
         SELECT lower(invite_email) AS email FROM meet_guest_links WHERE tenant_id = $1 AND room_id = $2 AND invite_email IS NOT NULL
         UNION SELECT lower(email) FROM guest_sessions WHERE tenant_id = $1 AND room_id = $2 AND email IS NOT NULL
       )
       SELECT e.title, e.starts_at, ml.public_id
         FROM calendar_events e
         JOIN meet_guest_links gl ON gl.event_id = e.id AND gl.tenant_id = e.tenant_id AND lower(gl.invite_email) IN (SELECT email FROM emails)
         LEFT JOIN meet_guest_links ml ON ml.event_id = e.id AND ml.kind = 'meeting' AND ml.cancelled_at IS NULL
        WHERE e.tenant_id = $1 AND e.starts_at > $3 AND gl.room_id <> $2
        ORDER BY e.starts_at LIMIT 1`,
      [tenantId, roomId, after],
    );
  }

  /** Гости встречи: приглашённые по почте и вошедшие по ссылке — кому слать «итоги готовы». */
  guests(tenantId: string, roomId: string) {
    return this.db.many<{ kind: 'invite' | 'session'; id: string; name: string | null; email: string | null; token_enc: string | null; revoked: boolean; created_at: Date }>(
      `SELECT 'invite' AS kind, id::text, invite_name AS name, invite_email AS email, token_enc, (revoked_at IS NOT NULL) AS revoked, invited_at AS created_at
         FROM meet_guest_links WHERE tenant_id = $1 AND room_id = $2 AND invite_email IS NOT NULL
       UNION ALL
       SELECT 'session', id::text, name, email, NULL, (revoked_at IS NOT NULL), created_at
         FROM guest_sessions WHERE tenant_id = $1 AND room_id = $2
       ORDER BY created_at`,
      [tenantId, roomId],
    );
  }

  /** Персональная ссылка только на протокол — гостю, который вошёл по общей ссылке и оставил почту. */
  async summaryInvite(i: { tenantId: string; roomId: string; eventId: string | null; createdBy: string; tokenHash: string; tokenEnc: string; email: string; name: string | null }) {
    return this.db.one<{ id: string }>(
      `INSERT INTO meet_guest_links (tenant_id, room_id, label, token_hash, token_enc, created_by, expires_at, event_id, kind,
                                     invite_email, invite_name, invited_at)
       VALUES ($1, $2, $3, $4, $5, $6, now(), $7, 'guest', $8, $9, now())
       RETURNING id::text`,
      [i.tenantId, i.roomId, i.name ?? i.email, i.tokenHash, i.tokenEnc, i.createdBy, i.eventId, i.email, i.name],
    );
  }

  // ── протокол ──

  summaryOf(tenantId: string, meetingId: string): Promise<SummaryRow | null> {
    return this.db.one<SummaryRow>(
      `SELECT id::text, tenant_id::text, meeting_id::text, room_id, status, language, summary_text, next_meeting_title, next_meeting_at,
              next_meeting_url, dirty, draft_model, version, published_at, published_by::text, published_json, updated_at
         FROM guest_summaries WHERE tenant_id = $1 AND meeting_id = $2`,
      [tenantId, meetingId],
    );
  }

  /** Создать черновик; второй поток не создаст дубль (UNIQUE meeting_id). */
  async createSummary(i: {
    tenantId: string; meetingId: string; roomId: string | null; language: string; text: string; model: string | null;
    next: { title: string; at: Date; url: string | null } | null;
    agreements: { text: string; side: string; deadlineAt: string | null; sourceDecisionId: string | null; sourceDraftId: string | null }[];
  }): Promise<void> {
    await this.db.withTransaction(async (c) => {
      const r = await c.query<{ id: string }>(
        `INSERT INTO guest_summaries (tenant_id, meeting_id, room_id, language, summary_text, draft_model,
                                      next_meeting_title, next_meeting_at, next_meeting_url)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (meeting_id) DO NOTHING RETURNING id::text`,
        [i.tenantId, i.meetingId, i.roomId, i.language, i.text, i.model, i.next?.title ?? null, i.next?.at ?? null, i.next?.url ?? null],
      );
      const id = r.rows[0]?.id;
      if (!id) return;
      for (const [n, a] of i.agreements.entries()) {
        await c.query(
          `INSERT INTO guest_agreements (tenant_id, summary_id, position, text, owner_side, deadline_at, source_decision_id, source_draft_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [i.tenantId, id, n, a.text, a.side, a.deadlineAt, a.sourceDecisionId, a.sourceDraftId],
        );
      }
    });
  }

  /** Пересобрать черновик заново (кнопка «Собрать заново»): договорённости — с нуля. */
  async resetDraft(summaryId: string, tenantId: string, i: {
    language: string; text: string; model: string | null;
    agreements: { text: string; side: string; deadlineAt: string | null; sourceDecisionId: string | null; sourceDraftId: string | null }[];
  }): Promise<void> {
    await this.db.withTransaction(async (c) => {
      await c.query(
        `UPDATE guest_summaries SET language = $2, summary_text = $3, draft_model = $4,
                dirty = (status = 'published'), updated_at = now() WHERE id = $1`,
        [summaryId, i.language, i.text, i.model],
      );
      await c.query(`DELETE FROM guest_agreements WHERE summary_id = $1`, [summaryId]);
      for (const [n, a] of i.agreements.entries()) {
        await c.query(
          `INSERT INTO guest_agreements (tenant_id, summary_id, position, text, owner_side, deadline_at, source_decision_id, source_draft_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [tenantId, summaryId, n, a.text, a.side, a.deadlineAt, a.sourceDecisionId, a.sourceDraftId],
        );
      }
    });
  }

  agreements(summaryId: string): Promise<AgreementRow[]> {
    return this.db.many<AgreementRow>(
      `SELECT id::text, position, text, owner_side, deadline_at, source_decision_id::text, source_draft_id::text
         FROM guest_agreements WHERE summary_id = $1 ORDER BY position, id`,
      [summaryId],
    );
  }

  /** Правка черновика хозяином: текст, язык, следующая встреча, договорённости целиком. */
  async saveDraft(summaryId: string, tenantId: string, d: {
    language: string; text: string; next: { title: string; at: Date; url: string | null } | null;
    agreements: { text: string; side: string; deadlineAt: string | null }[];
  }): Promise<void> {
    await this.db.withTransaction(async (c) => {
      await c.query(
        `UPDATE guest_summaries
            SET language = $2, summary_text = $3, next_meeting_title = $4, next_meeting_at = $5, next_meeting_url = $6,
                dirty = (status = 'published'), updated_at = now()
          WHERE id = $1`,
        [summaryId, d.language, d.text, d.next?.title ?? null, d.next?.at ?? null, d.next?.url ?? null],
      );
      await c.query(`DELETE FROM guest_agreements WHERE summary_id = $1`, [summaryId]);
      for (const [n, a] of d.agreements.entries()) {
        await c.query(
          `INSERT INTO guest_agreements (tenant_id, summary_id, position, text, owner_side, deadline_at) VALUES ($1, $2, $3, $4, $5, $6)`,
          [tenantId, summaryId, n, a.text, a.side, a.deadlineAt],
        );
      }
    });
  }

  async publish(summaryId: string, userId: string, json: PublishedSummary): Promise<void> {
    await this.db.query(
      `UPDATE guest_summaries
          SET status = 'published', version = $3, published_at = now(), published_by = $2,
              published_json = $4::jsonb, dirty = FALSE, updated_at = now()
        WHERE id = $1`,
      [summaryId, userId, json.version, JSON.stringify(json)],
    );
  }

  // ── материалы ──

  files(summaryId: string) {
    return this.db.many<{ file_id: string; file_name: string; content_type: string; size_bytes: string; can_download: boolean }>(
      `SELECT f.id::text AS file_id, f.file_name, f.content_type, f.size_bytes::text, g.can_download
         FROM guest_shared_files g JOIN files f ON f.id = g.file_id
        WHERE g.summary_id = $1 ORDER BY g.created_at`,
      [summaryId],
    );
  }

  async addFile(tenantId: string, summaryId: string, fileId: string, userId: string): Promise<void> {
    await this.db.query(
      `INSERT INTO guest_shared_files (summary_id, file_id, tenant_id, added_by)
       SELECT $2, f.id, $1, $4 FROM files f WHERE f.tenant_id = $1 AND f.id = $3
       ON CONFLICT DO NOTHING`,
      [tenantId, summaryId, fileId, userId],
    );
  }

  async removeFile(summaryId: string, fileId: string): Promise<void> {
    await this.db.query(`DELETE FROM guest_shared_files WHERE summary_id = $1 AND file_id = $2`, [summaryId, fileId]);
  }

  async touch(summaryId: string): Promise<void> {
    await this.db.query(`UPDATE guest_summaries SET dirty = (status = 'published'), updated_at = now() WHERE id = $1`, [summaryId]);
  }

  // ── ответы гостя ──

  async addFeedback(f: { tenantId: string; summaryId: string; sessionId: string | null; linkId: string | null; name: string; kind: string; body: string | null; version: number }) {
    return this.db.one<{ id: string }>(
      `INSERT INTO guest_feedback (tenant_id, summary_id, session_id, link_id, guest_name, kind, body, version)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id::text`,
      [f.tenantId, f.summaryId, f.sessionId, f.linkId, f.name, f.kind, f.body, f.version],
    );
  }

  /** Подтвердил ли этот гость текущую версию. */
  async acknowledged(summaryId: string, version: number, who: { sessionId: string | null; linkId: string | null }): Promise<Date | null> {
    const r = await this.db.one<{ created_at: Date }>(
      `SELECT created_at FROM guest_feedback
        WHERE summary_id = $1 AND version = $2 AND kind = 'confirmed'
          AND (($3::bigint IS NOT NULL AND session_id = $3::bigint) OR ($4::bigint IS NOT NULL AND link_id = $4::bigint))
        ORDER BY id DESC LIMIT 1`,
      [summaryId, version, who.sessionId, who.linkId],
    );
    return r?.created_at ?? null;
  }

  feedbackOf(summaryId: string) {
    return this.db.many<{ id: string; guest_name: string; kind: string; body: string | null; version: number; handled_at: Date | null; created_at: Date }>(
      `SELECT id::text, guest_name, kind, body, version, handled_at, created_at FROM guest_feedback WHERE summary_id = $1 ORDER BY id DESC LIMIT 100`,
      [summaryId],
    );
  }

  async handleFeedback(summaryId: string, id: string): Promise<void> {
    await this.db.query(`UPDATE guest_feedback SET handled_at = now() WHERE summary_id = $1 AND id = $2 AND handled_at IS NULL`, [summaryId, id]);
  }

  // ── события ──

  async event(tenantId: string, e: { linkId?: string | null; sessionId?: string | null; summaryId?: string | null; event: string }): Promise<void> {
    await this.db.query(
      `INSERT INTO guest_events (tenant_id, link_id, session_id, summary_id, event) VALUES ($1, $2, $3, $4, $5)`,
      [tenantId, e.linkId ?? null, e.sessionId ?? null, e.summaryId ?? null, e.event],
    );
  }

  /** Один раз на гостя и версию — «прочитал итоги» не множится от обновления страницы. */
  async eventOnce(tenantId: string, e: { linkId: string | null; sessionId: string | null; summaryId: string; event: string }): Promise<boolean> {
    const seen = await this.db.one(
      `SELECT 1 FROM guest_events WHERE summary_id = $1 AND event = $2
          AND (($3::bigint IS NOT NULL AND session_id = $3::bigint) OR ($4::bigint IS NOT NULL AND link_id = $4::bigint))`,
      [e.summaryId, e.event, e.sessionId, e.linkId],
    );
    if (seen) return false;
    await this.event(tenantId, e);
    return true;
  }

  /** Лента клиента (п. 40): гостевые события встречи клиента. */
  async clientActivity(tenantId: string, clientId: string, title: string, meetingId: string, detail: Record<string, unknown> = {}): Promise<void> {
    await this.db.query(
      `INSERT INTO client_activity (tenant_id, client_id, actor_id, kind, title, entity_type, entity_id, detail)
       VALUES ($1, $2, NULL, 'meeting', $3, 'meeting', $4, $5::jsonb)`,
      [tenantId, clientId, title.slice(0, 300), meetingId, JSON.stringify(detail)],
    );
  }

  metrics(tenantId: string, days: number) {
    return this.db.one<Record<string, number>>(
      `WITH e AS (SELECT * FROM guest_events WHERE tenant_id = $1 AND created_at > now() - make_interval(days => $2::int))
       SELECT (SELECT count(DISTINCT link_id) FROM e WHERE event = 'opened')::int AS opened,
              (SELECT count(DISTINCT session_id) FROM e WHERE event = 'joined')::int AS joined,
              (SELECT count(*) FROM guest_summaries WHERE tenant_id = $1 AND published_at > now() - make_interval(days => $2::int))::int AS published,
              (SELECT count(*) FROM e WHERE event = 'summary_viewed')::int AS viewed,
              (SELECT count(*) FROM e WHERE event = 'acknowledged')::int AS acknowledged,
              (SELECT count(*) FROM e WHERE event = 'feedback')::int AS feedback,
              (SELECT count(*) FROM e WHERE event = 'cta_clicked')::int AS cta`,
      [tenantId, days],
    );
  }
}
