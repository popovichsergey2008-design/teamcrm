import { Injectable } from '@nestjs/common';
import { DbService } from '../../database/db.service';
import { MailCategory } from './mail-rules';

export interface AccountRow {
  id: string; tenant_id: string; user_id: string; provider: string; email: string; username: string;
  imap_host: string; imap_port: number; smtp_host: string; smtp_port: number; secret_enc: string;
  status: string; last_error: string | null; last_sync_at: Date | null; last_uid: string; uid_validity: string | null; created_at: Date;
}

export interface MessageRow {
  id: string; account_id: string; uid: string; message_id: string | null; from_email: string | null; from_name: string | null;
  to_emails: string[]; subject: string | null; sent_at: Date | null; body_text: string | null; category: MailCategory;
  reason: string | null; client_id: string | null; client_name?: string | null; is_read: boolean; email?: string;
}

@Injectable()
export class MailboxRepository {
  constructor(private readonly db: DbService) {}

  accounts(tenantId: string, userId: string): Promise<AccountRow[]> {
    return this.db.many<AccountRow>(`SELECT * FROM mail_accounts WHERE tenant_id=$1 AND user_id=$2 ORDER BY id`, [tenantId, userId]);
  }

  account(tenantId: string, userId: string, id: string): Promise<AccountRow | null> {
    return this.db.one<AccountRow>(`SELECT * FROM mail_accounts WHERE tenant_id=$1 AND user_id=$2 AND id=$3`, [tenantId, userId, id]);
  }

  byId(id: string): Promise<AccountRow | null> {
    return this.db.one<AccountRow>(`SELECT * FROM mail_accounts WHERE id=$1`, [id]);
  }

  upsertAccount(i: {
    tenantId: string; userId: string; provider: string; email: string; username: string;
    imapHost: string; imapPort: number; smtpHost: string; smtpPort: number; secretEnc: string;
  }): Promise<AccountRow> {
    return this.db.one<AccountRow>(
      `INSERT INTO mail_accounts (tenant_id, user_id, provider, email, username, imap_host, imap_port, smtp_host, smtp_port, secret_enc)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (user_id, email) DO UPDATE SET
         provider=$3, username=$5, imap_host=$6, imap_port=$7, smtp_host=$8, smtp_port=$9, secret_enc=$10,
         status='ok', last_error=NULL
       RETURNING *`,
      [i.tenantId, i.userId, i.provider, i.email, i.username, i.imapHost, i.imapPort, i.smtpHost, i.smtpPort, i.secretEnc],
    ) as Promise<AccountRow>;
  }

  async removeAccount(tenantId: string, userId: string, id: string): Promise<boolean> {
    const r = await this.db.query(`DELETE FROM mail_accounts WHERE tenant_id=$1 AND user_id=$2 AND id=$3`, [tenantId, userId, id]);
    return (r.rowCount ?? 0) > 0;
  }

  /** Кому пора забрать почту: раз в 5 минут, сломанные — раз в час (вдруг пароль поменяли обратно). */
  dueAccounts(limit = 20): Promise<AccountRow[]> {
    return this.db.many<AccountRow>(
      `SELECT * FROM mail_accounts
        WHERE (status = 'ok' AND (last_sync_at IS NULL OR last_sync_at < now() - interval '5 minutes'))
           OR (status = 'error' AND last_sync_at < now() - interval '1 hour')
        ORDER BY last_sync_at NULLS FIRST LIMIT $1`,
      [limit],
    );
  }

  /**
   * Занять ящик на забор: метка времени ставится сразу. Синий и зелёный экземпляры
   * при выкладке иначе забирали бы один ящик одновременно.
   */
  async claim(id: string): Promise<boolean> {
    const r = await this.db.query(
      `UPDATE mail_accounts SET last_sync_at = now()
        WHERE id=$1 AND (last_sync_at IS NULL OR last_sync_at < now() - interval '4 minutes')`, [id],
    );
    return (r.rowCount ?? 0) > 0;
  }

  async syncDone(id: string, ok: boolean, error: string | null, maxUid?: number, uidValidity?: number): Promise<void> {
    await this.db.query(
      `UPDATE mail_accounts SET status=$2, last_error=$3, last_sync_at=now(),
              last_uid = COALESCE($4::bigint, last_uid), uid_validity = COALESCE($5::bigint, uid_validity)
        WHERE id=$1`,
      [id, ok ? 'ok' : 'error', error, maxUid ?? null, uidValidity ?? null],
    );
  }

  /** Новая нумерация на сервере: старые письма с прежними uid больше не сопоставить. */
  async resetMessages(accountId: string): Promise<void> {
    await this.db.query(`DELETE FROM mail_messages WHERE account_id=$1`, [accountId]);
  }

  async insertMessage(i: {
    tenantId: string; userId: string; accountId: string; uid: number; messageId: string | null;
    fromEmail: string | null; fromName: string | null; to: string[]; subject: string; sentAt: Date | null;
    body: string; category: MailCategory; reason: string; clientId: string | null; isRead: boolean;
  }): Promise<void> {
    await this.db.query(
      `INSERT INTO mail_messages (tenant_id, user_id, account_id, uid, message_id, from_email, from_name, to_emails, subject,
                                  sent_at, body_text, category, reason, client_id, is_read)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::text[],$9,$10,$11,$12,$13,$14,$15)
       ON CONFLICT (account_id, uid) DO NOTHING`,
      [i.tenantId, i.userId, i.accountId, i.uid, i.messageId?.slice(0, 512) ?? null, i.fromEmail?.slice(0, 255) ?? null,
        i.fromName?.slice(0, 255) ?? null, i.to.slice(0, 50), i.subject.slice(0, 2000), i.sentAt, i.body, i.category,
        i.reason.slice(0, 160), i.clientId, i.isRead],
    );
  }

  /** Клиент по адресу отправителя — из контактов клиентов (ТЗ-17). */
  async clientByEmail(tenantId: string, email: string): Promise<{ id: string; name: string } | null> {
    return this.db.one<{ id: string; name: string }>(
      `SELECT c.id, c.name FROM client_contacts cc JOIN clients c ON c.id = cc.client_id
        WHERE cc.tenant_id=$1 AND cc.email_norm=$2 AND c.archived_at IS NULL LIMIT 1`,
      [tenantId, email.toLowerCase()],
    );
  }

  /** VIP из настроек секретаря — их адреса. */
  async vipEmails(userId: string): Promise<string[]> {
    const rows = await this.db.many<{ email: string }>(
      `SELECT lower(u.email) AS email FROM secretary_prefs s JOIN users u ON u.id = ANY(s.vip_user_ids) WHERE s.user_id=$1`, [userId],
    );
    return rows.map((r) => r.email);
  }

  /** Письма человека — только его; непрочитанные сначала, свежие сверху. */
  messages(tenantId: string, userId: string, o: { unreadOnly?: boolean; q?: string | null; limit?: number; sinceDays?: number }): Promise<MessageRow[]> {
    return this.db.many<MessageRow>(
      `SELECT m.id, m.account_id, m.uid, m.message_id, m.from_email, m.from_name, m.to_emails, m.subject, m.sent_at,
              left(m.body_text, 600) AS body_text, m.category, m.reason, m.client_id, c.name AS client_name, m.is_read, a.email
         FROM mail_messages m
         JOIN mail_accounts a ON a.id = m.account_id
    LEFT JOIN clients c ON c.id = m.client_id
        WHERE m.tenant_id=$1 AND m.user_id=$2
          AND ($3::boolean IS NOT TRUE OR NOT m.is_read)
          AND ($4::text IS NULL OR m.subject ILIKE '%' || $4 || '%' OR m.body_text ILIKE '%' || $4 || '%'
               OR m.from_email ILIKE '%' || $4 || '%' OR m.from_name ILIKE '%' || $4 || '%')
          AND m.sent_at > now() - make_interval(days => $6::int)
        ORDER BY m.sent_at DESC NULLS LAST
        LIMIT $5`,
      [tenantId, userId, o.unreadOnly ?? false, o.q?.trim() || null, o.limit ?? 100, o.sinceDays ?? 14],
    );
  }

  message(tenantId: string, userId: string, id: string): Promise<MessageRow | null> {
    return this.db.one<MessageRow>(
      `SELECT m.*, c.name AS client_name, a.email FROM mail_messages m
         JOIN mail_accounts a ON a.id = m.account_id LEFT JOIN clients c ON c.id = m.client_id
        WHERE m.tenant_id=$1 AND m.user_id=$2 AND m.id=$3`,
      [tenantId, userId, id],
    );
  }

  /** Сколько непрочитанного по категориям — для утренней сводки. */
  async unreadCounts(userId: string): Promise<Partial<Record<MailCategory, number>>> {
    const rows = await this.db.many<{ category: MailCategory; n: number }>(
      `SELECT category, count(*)::int AS n FROM mail_messages
        WHERE user_id=$1 AND NOT is_read AND sent_at > now() - interval '3 days' GROUP BY category`, [userId],
    );
    return Object.fromEntries(rows.map((r) => [r.category, Number(r.n)]));
  }

  /** Старые письма не храним: секретарю нужна текущая работа, а не архив чужой переписки. */
  async prune(): Promise<void> {
    await this.db.query(`DELETE FROM mail_messages WHERE created_at < now() - interval '30 days'`);
  }
}
