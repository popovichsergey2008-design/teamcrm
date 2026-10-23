import { Injectable } from '@nestjs/common';
import { DbService } from '../../database/db.service';

/** #1562: таблица допуска qa_switch_access. Только чтение — строки ставят руками. */
@Injectable()
export class QaSwitchRepository {
  constructor(private readonly db: DbService) {}

  /** На кого этот человек может переключиться в своей организации (только активные цели). */
  targetsOf(tenantId: string, userId: string) {
    return this.db.many<{ id: string; full_name: string }>(
      `SELECT t.id::text, t.full_name
         FROM qa_switch_access a
         JOIN users t ON t.id = a.target_user_id AND t.tenant_id = a.tenant_id AND t.is_active
        WHERE a.tenant_id = $1 AND a.user_id = $2
        ORDER BY a.created_at, t.id`,
      [tenantId, userId],
    );
  }

  async hasAccess(tenantId: string, userId: string, targetId: string): Promise<boolean> {
    const row = await this.db.one<{ ok: number }>(
      `SELECT 1 AS ok FROM qa_switch_access
        WHERE tenant_id = $1 AND user_id = $2 AND target_user_id = $3`,
      [tenantId, userId, targetId],
    );
    return !!row;
  }

  /** Человек этой организации — для проверок и для подписи в журнале. */
  person(tenantId: string, id: string) {
    return this.db.one<{ id: string; tenant_id: string; is_active: boolean; full_name: string }>(
      `SELECT id::text, tenant_id::text, is_active, full_name FROM users WHERE tenant_id = $1 AND id = $2`,
      [tenantId, id],
    );
  }

  /** Мобильное устройство текущей сессии — в журнал «откуда». */
  async deviceOf(sessionId?: string): Promise<string | null> {
    if (!sessionId) return null;
    const row = await this.db.one<{ device_id: string | null }>(
      `SELECT device_id::text FROM refresh_tokens WHERE id = $1`, [sessionId],
    );
    return row?.device_id ?? null;
  }
}
