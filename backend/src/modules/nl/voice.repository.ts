import { Injectable } from '@nestjs/common';
import { DbService } from '../../database/db.service';

export type VoiceStatus = 'queued' | 'transcribing' | 'parsing' | 'ready' | 'error';

export interface VoiceJobRow {
  id: string;
  tenant_id: string;
  user_id: string;
  file_id: string | null;
  status: VoiceStatus;
  transcript: string | null;
  drafts: unknown[];
  error: string | null;
  duration_sec: number | null;
  created_at: Date;
  updated_at: Date;
}

@Injectable()
export class VoiceRepository {
  constructor(private readonly db: DbService) {}

  create(tenantId: string, userId: string, fileId: string | null): Promise<VoiceJobRow> {
    return this.db.one<VoiceJobRow>(
      `INSERT INTO voice_jobs (tenant_id, user_id, file_id) VALUES ($1,$2,$3) RETURNING *`,
      [tenantId, userId, fileId],
    ) as Promise<VoiceJobRow>;
  }

  /** Своя запись и только своя: чужая надиктовка — это чужой разговор. */
  find(tenantId: string, userId: string, id: string): Promise<VoiceJobRow | null> {
    return this.db.one<VoiceJobRow>(
      `SELECT * FROM voice_jobs WHERE tenant_id=$1 AND user_id=$2 AND id=$3`,
      [tenantId, userId, id],
    );
  }

  async setStatus(id: string, status: VoiceStatus, error?: string | null): Promise<void> {
    await this.db.query(
      `UPDATE voice_jobs SET status=$2, error=$3, updated_at=now() WHERE id=$1`,
      [id, status, error ? String(error).slice(0, 500) : null],
    );
  }

  async setTranscript(id: string, transcript: string, durationSec: number | null): Promise<void> {
    await this.db.query(
      `UPDATE voice_jobs SET transcript=$2, duration_sec=$3, updated_at=now() WHERE id=$1`,
      [id, transcript, durationSec],
    );
  }

  async setDrafts(id: string, drafts: unknown[]): Promise<void> {
    await this.db.query(
      `UPDATE voice_jobs SET drafts=$2::jsonb, status='ready', error=NULL, updated_at=now() WHERE id=$1`,
      [id, JSON.stringify(drafts)],
    );
  }
}
