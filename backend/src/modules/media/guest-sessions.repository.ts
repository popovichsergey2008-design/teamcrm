import { Injectable } from '@nestjs/common';
import { createHash, randomBytes } from 'crypto';
import { DbService } from '../../database/db.service';

export interface GuestSessionRow {
  id: string;
  tenant_id: string;
  link_id: string;
  room_id: string;
  guest_id: string;
  name: string;
  email: string | null;
  company: string | null;
  language: string | null;
  recording_consent: boolean | null;
  created_at: Date;
  expires_at: Date;
  revoked_at: Date | null;
}

/** Сколько живёт гостевая сессия: столько же, сколько по умолчанию виден протокол. */
const SESSION_DAYS = 30;

export const sessionHash = (key: string) => createHash('sha256').update(key).digest('hex');

/**
 * Гостевые сессии (ТЗ-28, п. 57–58): кто реально заходил на встречу. Ключ уходит гостю
 * один раз, в базе — только хэш. По ключу гость входит повторно без имени и видит
 * протокол; пересланная общая ссылка без ключа протокола не покажет.
 */
@Injectable()
export class GuestSessionsRepository {
  constructor(private readonly db: DbService) {}

  async create(i: {
    tenantId: string; linkId: string; roomId: string; guestId: string; name: string;
    email: string | null; company: string | null; language: string | null; consent: boolean | null; policyVersion: string | null;
  }): Promise<{ id: string; key: string }> {
    const key = randomBytes(24).toString('base64url');
    const row = await this.db.one<{ id: string }>(
      `INSERT INTO guest_sessions (tenant_id, link_id, room_id, session_hash, guest_id, name, email, company, language,
                                   recording_consent, consented_at, policy_version, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::boolean, CASE WHEN $10::boolean THEN now() END, $11,
               now() + make_interval(days => $12::int))
       RETURNING id::text`,
      [i.tenantId, i.linkId, i.roomId, sessionHash(key), i.guestId, i.name, i.email, i.company, i.language,
        i.consent, i.policyVersion, SESSION_DAYS],
    );
    return { id: row!.id, key };
  }

  /** Живая сессия по ключу: не отозвана, не истекла, ссылка не отозвана. */
  async byKey(key: string): Promise<GuestSessionRow | null> {
    if (!key || key.length < 16 || key.length > 64) return null;
    const r = await this.db.one<GuestSessionRow>(
      `SELECT s.id::text, s.tenant_id::text, s.link_id::text, s.room_id, s.guest_id, s.name, s.email, s.company, s.language,
              s.recording_consent, s.created_at, s.expires_at, s.revoked_at
         FROM guest_sessions s JOIN meet_guest_links l ON l.id = s.link_id
        WHERE s.session_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now() AND l.revoked_at IS NULL`,
      [sessionHash(key)],
    );
    if (r) await this.db.query(`UPDATE guest_sessions SET last_seen_at = now() WHERE id = $1`, [r.id]);
    return r;
  }

  /** Требует ли организация отметку согласия на запись перед входом (п. 26). */
  async consentPolicy(tenantId: string): Promise<{ notice: boolean; required: boolean }> {
    const r = await this.db.one<{ recording_notice: boolean; consent_required: boolean }>(
      `SELECT recording_notice, consent_required FROM guest_brand WHERE tenant_id = $1`,
      [tenantId],
    );
    return { notice: r ? r.recording_notice : true, required: !!r?.consent_required };
  }

  async event(tenantId: string, e: { linkId?: string | null; sessionId?: string | null; summaryId?: string | null; event: string }): Promise<void> {
    await this.db.query(
      `INSERT INTO guest_events (tenant_id, link_id, session_id, summary_id, event) VALUES ($1, $2, $3, $4, $5)`,
      [tenantId, e.linkId ?? null, e.sessionId ?? null, e.summaryId ?? null, e.event],
    );
  }
}
