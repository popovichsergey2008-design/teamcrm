import { Injectable } from '@nestjs/common';
import { DbService } from '../../database/db.service';
import { GDocType } from './gdocs.util';

@Injectable()
export class GdocsRepository {
  constructor(private readonly db: DbService) {}

  /** Регистрирует ссылку на док (идемпотентно по tenant+doc_key+project). Возвращает id строки. */
  async upsertLink(i: { tenantId: string; projectId: string; docKey: string; docType: GDocType; url: string }): Promise<string> {
    const row = await this.db.one<{ id: string }>(
      `INSERT INTO google_docs (tenant_id, project_id, doc_key, doc_type, url)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (tenant_id, doc_key, project_id)
       DO UPDATE SET url=EXCLUDED.url, doc_type=EXCLUDED.doc_type, updated_at=now()
       RETURNING id`,
      [i.tenantId, i.projectId, i.docKey, i.docType, i.url],
    );
    return row!.id;
  }

  /** Все доки арендатора для (пере)обработки. */
  listForTenant(tenantId: string) {
    return this.db.many<{ id: string; doc_key: string; doc_type: GDocType; content_hash: string | null }>(
      `SELECT id, doc_key, doc_type, content_hash FROM google_docs WHERE tenant_id=$1 ORDER BY id`,
      [tenantId],
    );
  }

  async setResult(id: string, i: { status: string; title?: string | null; text?: string | null; hash?: string | null; error?: string | null }) {
    await this.db.query(
      `UPDATE google_docs
          SET status=$2, title=COALESCE($3,title), text=$4, content_hash=$5, error=$6, fetched_at=now(), updated_at=now()
        WHERE id=$1`,
      [id, i.status, i.title ?? null, i.text ?? null, i.hash ?? null, i.error ?? null],
    );
  }

  statusCounts(tenantId: string) {
    return this.db.many<{ status: string; n: string }>(
      `SELECT status, count(*)::int AS n FROM google_docs WHERE tenant_id=$1 GROUP BY status`,
      [tenantId],
    );
  }
}
