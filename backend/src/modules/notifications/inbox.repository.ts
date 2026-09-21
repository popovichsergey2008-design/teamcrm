import { Injectable } from '@nestjs/common';
import { DbService } from '../../database/db.service';

export interface InboxRow {
  id: string;
  tenant_id: string;
  user_id: string;
  event_key: string;
  title: string;
  body: string;
  path: string | null;
  created_at: Date;
  read_at: Date | null;
}

/** Ящик уведомлений: строка на событие одному человеку, номер строки — курсор клиента. */
@Injectable()
export class InboxRepository {
  constructor(private readonly db: DbService) {}

  /** Положить событие; повтор по тому же письму — та же строка (возвращает существующую). */
  async record(i: {
    tenantId: string; userId: string; mailId: string | null; eventKey: string;
    title: string; body: string; path: string | null;
  }): Promise<InboxRow | null> {
    const inserted = await this.db.one<InboxRow>(
      `INSERT INTO notification_inbox (tenant_id, user_id, mail_id, event_key, title, body, path)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (mail_id) WHERE mail_id IS NOT NULL DO NOTHING
       RETURNING *`,
      [i.tenantId, i.userId, i.mailId, i.eventKey, i.title.slice(0, 255), i.body.slice(0, 500), i.path],
    );
    if (inserted) return inserted;
    return i.mailId ? this.db.one<InboxRow>(`SELECT * FROM notification_inbox WHERE mail_id=$1`, [i.mailId]) : null;
  }

  /** Всё после курсора, по порядку: клиент догоняет то, что push не донёс. */
  after(userId: string, afterId: string | null, limit: number) {
    return this.db.many<InboxRow>(
      `SELECT * FROM notification_inbox
        WHERE user_id=$1 AND ($2::bigint IS NULL OR id > $2)
        ORDER BY id ASC LIMIT $3`,
      [userId, afterId, limit],
    );
  }

  /** Последние N — для первого открытия, когда курсора ещё нет. */
  latest(userId: string, limit: number) {
    return this.db.many<InboxRow>(
      `SELECT * FROM notification_inbox WHERE user_id=$1 ORDER BY id DESC LIMIT $2`,
      [userId, limit],
    );
  }

  async unreadCount(userId: string): Promise<number> {
    const row = await this.db.one<{ n: string }>(
      `SELECT count(*)::text AS n FROM notification_inbox WHERE user_id=$1 AND read_at IS NULL`, [userId],
    );
    return Number(row?.n ?? 0);
  }

  markRead(userId: string, upToId: string) {
    return this.db.query(
      `UPDATE notification_inbox SET read_at=now() WHERE user_id=$1 AND id<=$2 AND read_at IS NULL`,
      [userId, upToId],
    );
  }

  /** Устройства человека с push-токеном — кого будить. */
  pushTargets(userId: string) {
    return this.db.many<{ id: string; push_token: string; platform: string }>(
      `SELECT id::text, push_token, platform FROM mobile_devices
        WHERE user_id=$1 AND revoked_at IS NULL AND push_token IS NOT NULL`,
      [userId],
    );
  }

  /** Токен протух (устройство снесло приложение) — забываем, чтобы не долбить FCM. */
  dropPushToken(deviceId: string) {
    return this.db.query(`UPDATE mobile_devices SET push_token=NULL WHERE id=$1`, [deviceId]);
  }

  async pushPrivacyOf(tenantId: string): Promise<'hide' | 'sender_only' | 'full'> {
    const row = await this.db.one<{ push_privacy: string }>(`SELECT push_privacy FROM tenants WHERE id=$1`, [tenantId]);
    const v = row?.push_privacy;
    return v === 'hide' || v === 'full' ? v : 'sender_only';
  }

  markPushSent(mailId: string) {
    return this.db.query(`UPDATE mail_outbox SET push_sent_at=now() WHERE id=$1`, [mailId]);
  }
}