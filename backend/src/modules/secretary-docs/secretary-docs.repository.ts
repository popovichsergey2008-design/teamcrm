import { Injectable } from '@nestjs/common';
import { DbService } from '../../database/db.service';

export interface DocRow {
  id: string; tenant_id: string; user_id: string; kind: string; title: string; expires_on: string;
  remind_days: number[]; reminded: number[]; note: string | null; renewed_at: string | null; created_at: string;
}
export interface ReceiptRow {
  id: string; user_id: string; file_id: string | null; status: string; spent_on: string | null; seller: string | null; seller_inn: string | null;
  total: string | null; vat: string | null; currency: string; category: string | null; purpose: string | null; error: string | null;
  created_at: string; file_name: string | null; content_type: string | null;
}

const DOC_COLS = `id, tenant_id, user_id, kind, title, to_char(expires_on, 'YYYY-MM-DD') AS expires_on, remind_days, reminded, note, renewed_at, created_at`;
const RECEIPT_COLS = `r.id, r.user_id, r.file_id, r.status, to_char(r.spent_on, 'YYYY-MM-DD') AS spent_on, r.seller, r.seller_inn, r.total, r.vat,
  r.currency, r.category, r.purpose, r.error, r.created_at, f.file_name, f.content_type`;

/** SQL функций секретаря #1476. Всё — в пределах компании; личное (документы, чеки) — ещё и по человеку. */
@Injectable()
export class SecretaryDocsRepository {
  constructor(private readonly db: DbService) {}

  // ── сроки документов ──
  docs(tenantId: string, userId: string) {
    return this.db.many<DocRow>(
      `SELECT ${DOC_COLS} FROM doc_deadlines WHERE tenant_id=$1 AND user_id=$2 ORDER BY renewed_at IS NOT NULL, expires_on`,
      [tenantId, userId],
    );
  }
  doc(tenantId: string, userId: string, id: string) {
    return this.db.one<DocRow>(`SELECT ${DOC_COLS} FROM doc_deadlines WHERE tenant_id=$1 AND user_id=$2 AND id=$3`, [tenantId, userId, id]);
  }
  addDoc(tenantId: string, userId: string, v: { kind: string; title: string; expiresOn: string; remindDays: number[]; note: string | null }) {
    return this.db.one<DocRow>(
      `INSERT INTO doc_deadlines (tenant_id, user_id, kind, title, expires_on, remind_days, note)
       VALUES ($1,$2,$3,$4,$5::date,$6::int[],$7) RETURNING ${DOC_COLS}`,
      [tenantId, userId, v.kind, v.title, v.expiresOn, v.remindDays, v.note],
    );
  }
  /** Новая дата — напоминания заново (прежние пороги относились к старому сроку). */
  updateDoc(tenantId: string, userId: string, id: string, v: { kind?: string; title?: string; expiresOn?: string; remindDays?: number[]; note?: string | null; renewed?: boolean }) {
    return this.db.one<DocRow>(
      `UPDATE doc_deadlines SET
          kind = COALESCE($4, kind), title = COALESCE($5, title),
          reminded = CASE WHEN $6::date IS NOT NULL AND $6::date <> expires_on THEN '{}' ELSE reminded END,
          renewed_at = CASE WHEN $6::date IS NOT NULL AND $6::date <> expires_on THEN NULL
                            WHEN $9::boolean IS TRUE THEN now() WHEN $9::boolean IS FALSE THEN NULL ELSE renewed_at END,
          expires_on = COALESCE($6::date, expires_on), remind_days = COALESCE($7::int[], remind_days),
          note = CASE WHEN $8::boolean THEN $10 ELSE note END, updated_at = now()
        WHERE tenant_id=$1 AND user_id=$2 AND id=$3 RETURNING ${DOC_COLS}`,
      [tenantId, userId, id, v.kind ?? null, v.title ?? null, v.expiresOn ?? null, v.remindDays ?? null, v.note !== undefined, v.renewed ?? null, v.note ?? null],
    );
  }
  async removeDoc(tenantId: string, userId: string, id: string) {
    const r = await this.db.query(`DELETE FROM doc_deadlines WHERE tenant_id=$1 AND user_id=$2 AND id=$3`, [tenantId, userId, id]);
    return (r.rowCount ?? 0) > 0;
  }
  /** Кандидаты на напоминание: не продлённые, истёкшие не раньше 3 дней назад (порог выбирают правила — у человека он может быть и 90 дней). */
  dueDocs() {
    return this.db.many<DocRow>(
      `SELECT ${DOC_COLS} FROM doc_deadlines
        WHERE renewed_at IS NULL AND expires_on BETWEEN CURRENT_DATE - 3 AND CURRENT_DATE + 400
        ORDER BY tenant_id, user_id LIMIT 2000`,
    );
  }
  setReminded(id: string, reminded: number[]) {
    return this.db.query(`UPDATE doc_deadlines SET reminded=$2::int[] WHERE id=$1`, [id, reminded]);
  }

  // ── даты клиентов ──
  /** Даты, у которых праздник сегодня или завтра (с запасом на пояс), — в планировщик. */
  dueDates() {
    return this.db.many<{
      id: string; tenant_id: string; client_id: string; client: string; kind: string; title: string | null; month: number; day: number; year: number | null;
      person: string | null; to_user: string | null; client_owner: string | null;
    }>(
      `SELECT d.id, d.tenant_id, d.client_id, c.name AS client, d.kind, d.title, d.month, d.day, d.year,
              NULLIF(TRIM(concat_ws(' ', cc.first_name, cc.last_name)), '') AS person,
              COALESCE(c.owner_user_id, d.created_by) AS to_user, c.owner_user_id AS client_owner
         FROM client_dates d
         JOIN clients c ON c.id = d.client_id AND c.tenant_id = d.tenant_id AND c.archived_at IS NULL
         LEFT JOIN client_contacts cc ON cc.id = d.contact_id AND cc.archived_at IS NULL
        WHERE (d.month, d.day) IN (
          SELECT EXTRACT(MONTH FROM g)::int, EXTRACT(DAY FROM g)::int
            FROM generate_series(CURRENT_DATE - 1, CURRENT_DATE + 2, interval '1 day') g)
           OR (d.month = 2 AND d.day = 29)
        LIMIT 2000`,
    );
  }

  // ── проверка договора ──
  review(tenantId: string, fileId: string) {
    return this.db.one<{ result: any; model: string | null; created_at: string }>(
      `SELECT result, model, created_at FROM contract_reviews WHERE tenant_id=$1 AND file_id=$2`, [tenantId, fileId],
    );
  }
  saveReview(tenantId: string, fileId: string, userId: string, result: unknown, model: string | null) {
    return this.db.query(
      `INSERT INTO contract_reviews (tenant_id, file_id, result, model, created_by) VALUES ($1,$2,$3::jsonb,$4,$5)
       ON CONFLICT (tenant_id, file_id) DO UPDATE SET result=EXCLUDED.result, model=EXCLUDED.model, created_by=EXCLUDED.created_by, created_at=now()`,
      [tenantId, fileId, JSON.stringify(result), model, userId],
    );
  }

  // ── чеки ──
  receipts(tenantId: string, userId: string, from: string | null, to: string | null) {
    return this.db.many<ReceiptRow>(
      `SELECT ${RECEIPT_COLS} FROM receipts r LEFT JOIN files f ON f.id = r.file_id
        WHERE r.tenant_id=$1 AND r.user_id=$2
          AND ($3::date IS NULL OR r.spent_on IS NULL OR r.spent_on >= $3::date)
          AND ($4::date IS NULL OR r.spent_on IS NULL OR r.spent_on <= $4::date)
        ORDER BY COALESCE(r.spent_on, r.created_at::date) DESC, r.id DESC LIMIT 500`,
      [tenantId, userId, from, to],
    );
  }
  receipt(tenantId: string, userId: string, id: string) {
    return this.db.one<ReceiptRow>(
      `SELECT ${RECEIPT_COLS} FROM receipts r LEFT JOIN files f ON f.id = r.file_id WHERE r.tenant_id=$1 AND r.user_id=$2 AND r.id=$3`,
      [tenantId, userId, id],
    );
  }
  async addReceipt(tenantId: string, userId: string, fileId: string | null) {
    const row = await this.db.one<{ id: string }>(
      `INSERT INTO receipts (tenant_id, user_id, file_id, status) VALUES ($1,$2,$3,$4) RETURNING id`,
      [tenantId, userId, fileId, fileId ? 'new' : 'manual'],
    );
    return String(row!.id);
  }
  updateReceipt(tenantId: string, userId: string, id: string, v: Partial<{
    status: string; spentOn: string | null; seller: string | null; sellerInn: string | null; total: number | null; vat: number | null;
    currency: string; category: string | null; purpose: string | null; error: string | null;
  }>) {
    const cols: Record<string, string> = {
      status: 'status', spentOn: 'spent_on', seller: 'seller', sellerInn: 'seller_inn', total: 'total', vat: 'vat',
      currency: 'currency', category: 'category', purpose: 'purpose', error: 'error',
    };
    const sets: string[] = []; const args: unknown[] = [tenantId, userId, id];
    for (const [k, col] of Object.entries(cols)) {
      if (!(k in v)) continue;
      args.push((v as Record<string, unknown>)[k]);
      sets.push(`${col} = $${args.length}${col === 'spent_on' ? '::date' : ''}`);
    }
    if (!sets.length) return Promise.resolve(null);
    return this.db.one(`UPDATE receipts SET ${sets.join(', ')}, updated_at=now() WHERE tenant_id=$1 AND user_id=$2 AND id=$3 RETURNING id`, args);
  }
  async removeReceipt(tenantId: string, userId: string, id: string) {
    const r = await this.db.one<{ file_id: string | null }>(`DELETE FROM receipts WHERE tenant_id=$1 AND user_id=$2 AND id=$3 RETURNING file_id`, [tenantId, userId, id]);
    return r;
  }
  /** Карточка с таким отпечатком уже была — не зовём модель второй раз ради дубля. */
  async proposalExists(tenantId: string, userId: string, fingerprint: string) {
    const r = await this.db.one<{ ok: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM assistant_proposals WHERE tenant_id=$1 AND user_id=$2 AND fingerprint=$3) AS ok`,
      [tenantId, userId, fingerprint],
    );
    return !!r?.ok;
  }
  userName(tenantId: string, userId: string) {
    return this.db.one<{ full_name: string }>(`SELECT full_name FROM users WHERE tenant_id=$1 AND id=$2`, [tenantId, userId]);
  }
}
