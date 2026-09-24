import { Injectable } from '@nestjs/common';
import { DbService } from '../../database/db.service';
import { PermissionMap } from './permissions';

export interface RoleRow {
  id: string;
  code: string;
  name: string;
  is_base: boolean;
  permissions: PermissionMap;
}

export interface AuditRow {
  id: string;
  actor_user_id: string | null;
  actor_name: string | null;
  event_type: string;
  resource_type: string | null;
  resource_id: string | null;
  target_user_id: string | null;
  ip: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

/** Хранилище слоя безопасности: роли, поправки, политика, журнал, раскрытия (0129). */
@Injectable()
export class SecurityRepository {
  constructor(private readonly db: DbService) {}

  // ── роли ──
  roles(tenantId: string): Promise<RoleRow[]> {
    return this.db.many<RoleRow>(
      `SELECT id::text, code, name, is_base, permissions FROM security_roles
        WHERE tenant_id=$1 ORDER BY is_base DESC, name`,
      [tenantId],
    );
  }

  roleById(tenantId: string, id: string): Promise<RoleRow | null> {
    return this.db.one<RoleRow>(
      `SELECT id::text, code, name, is_base, permissions FROM security_roles WHERE tenant_id=$1 AND id=$2`,
      [tenantId, id],
    );
  }

  async createRole(o: { tenantId: string; code: string; name: string; permissions: PermissionMap; createdBy: string }) {
    return (await this.db.one<RoleRow>(
      `INSERT INTO security_roles (tenant_id, code, name, permissions, created_by)
       VALUES ($1,$2,$3,$4::jsonb,$5)
       RETURNING id::text, code, name, is_base, permissions`,
      [o.tenantId, o.code, o.name, JSON.stringify(o.permissions), o.createdBy],
    )) as RoleRow;
  }

  updateRole(tenantId: string, id: string, p: { name?: string; permissions?: PermissionMap }) {
    return this.db.one<RoleRow>(
      `UPDATE security_roles
          SET name = COALESCE($3, name),
              permissions = COALESCE($4::jsonb, permissions),
              updated_at = now()
        WHERE tenant_id=$1 AND id=$2
        RETURNING id::text, code, name, is_base, permissions`,
      [tenantId, id, p.name ?? null, p.permissions ? JSON.stringify(p.permissions) : null],
    );
  }

  async deleteRole(tenantId: string, id: string): Promise<void> {
    await this.db.query(`DELETE FROM security_roles WHERE tenant_id=$1 AND id=$2 AND is_base=FALSE`, [tenantId, id]);
  }

  /** Кто этот человек: базовая роль, своя роль компании и её права. */
  member(tenantId: string, userId: string) {
    return this.db.one<{
      user_id: string; full_name: string; base_role: string;
      role_id: string | null; role_name: string | null; role_permissions: PermissionMap | null;
    }>(
      `SELECT u.id::text AS user_id, u.full_name, r.code AS base_role,
              sr.id::text AS role_id, sr.name AS role_name, sr.permissions AS role_permissions
         FROM users u
         JOIN roles r ON r.id = u.role_id
         LEFT JOIN security_roles sr ON sr.id = u.security_role_id AND sr.tenant_id = u.tenant_id
        WHERE u.tenant_id=$1 AND u.id=$2 AND u.is_active = TRUE`,
      [tenantId, userId],
    );
  }

  /** Личные поправки человека — по ним ограничивают конкретного администратора. */
  async overrides(tenantId: string, userId: string): Promise<PermissionMap> {
    const rows = await this.db.many<{ permission: string; allowed: boolean; scope: string | null }>(
      `SELECT permission, allowed, scope FROM user_permission_overrides WHERE tenant_id=$1 AND user_id=$2`,
      [tenantId, userId],
    );
    const out: PermissionMap = {};
    for (const r of rows) {
      (out as Record<string, unknown>)[r.permission] = {
        allowed: r.allowed,
        ...(r.scope ? { scope: r.scope } : {}),
      };
    }
    return out;
  }

  async setOverride(o: {
    tenantId: string; userId: string; permission: string; allowed: boolean; scope: string | null; actorId: string;
  }): Promise<void> {
    await this.db.query(
      `INSERT INTO user_permission_overrides (tenant_id, user_id, permission, allowed, scope, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (user_id, permission) DO UPDATE
          SET allowed=$4, scope=$5, updated_by=$6, updated_at=now()`,
      [o.tenantId, o.userId, o.permission, o.allowed, o.scope, o.actorId],
    );
  }

  async clearOverride(tenantId: string, userId: string, permission: string): Promise<void> {
    await this.db.query(
      `DELETE FROM user_permission_overrides WHERE tenant_id=$1 AND user_id=$2 AND permission=$3`,
      [tenantId, userId, permission],
    );
  }

  async setSecurityRole(tenantId: string, userId: string, roleId: string | null): Promise<void> {
    await this.db.query(
      `UPDATE users SET security_role_id=$3::bigint WHERE tenant_id=$1 AND id=$2`,
      [tenantId, userId, roleId],
    );
  }

  // ── политика ──
  async policy(tenantId: string): Promise<unknown> {
    const row = await this.db.one<{ config: unknown }>(
      `SELECT config FROM security_policies WHERE tenant_id=$1`, [tenantId],
    );
    return row?.config ?? null;
  }

  async savePolicy(tenantId: string, config: unknown, actorId: string): Promise<void> {
    await this.db.query(
      `INSERT INTO security_policies (tenant_id, config, updated_by)
       VALUES ($1,$2::jsonb,$3)
       ON CONFLICT (tenant_id) DO UPDATE SET config=$2::jsonb, updated_by=$3, updated_at=now()`,
      [tenantId, JSON.stringify(config), actorId],
    );
  }

  // ── журнал ──
  async audit(o: {
    tenantId: string; actorId: string | null; actorName?: string | null; event: string;
    resourceType?: string | null; resourceId?: string | null; targetUserId?: string | null;
    ip?: string | null; deviceId?: string | null; metadata?: Record<string, unknown>;
  }): Promise<void> {
    await this.db.query(
      `INSERT INTO security_audit
         (tenant_id, actor_user_id, actor_name, event_type, resource_type, resource_id,
          target_user_id, ip, device_id, metadata)
       VALUES ($1,$2::bigint,$3,$4,$5,$6,$7::bigint,$8,$9,$10::jsonb)`,
      [
        o.tenantId, o.actorId, o.actorName ?? null, o.event, o.resourceType ?? null, o.resourceId ?? null,
        o.targetUserId ?? null, o.ip ?? null, o.deviceId ?? null, JSON.stringify(o.metadata ?? {}),
      ],
    ).catch(() => undefined); // журнал не должен ронять само действие
  }

  auditList(tenantId: string, f: { event?: string | null; userId?: string | null; limit: number }) {
    const params: unknown[] = [tenantId, f.limit];
    let where = 'tenant_id=$1';
    if (f.event) { params.push(f.event); where += ` AND event_type = $${params.length}`; }
    if (f.userId) { params.push(f.userId); where += ` AND actor_user_id = $${params.length}::bigint`; }
    return this.db.many<AuditRow>(
      `SELECT id::text, actor_user_id::text, actor_name, event_type, resource_type, resource_id,
              target_user_id::text, ip, metadata, created_at
         FROM security_audit WHERE ${where} ORDER BY created_at DESC LIMIT $2`,
      params,
    );
  }

  // ── контакты ──
  client(tenantId: string, clientId: string) {
    return this.db.one<{ id: string; name: string; contact: string | null; phone: string | null; email: string | null; telegram: string | null }>(
      `SELECT id::text, name, contact, phone, email, telegram FROM clients WHERE tenant_id=$1 AND id=$2`,
      [tenantId, clientId],
    );
  }

  async logReveal(o: {
    tenantId: string; userId: string; clientId: string; field: string;
    reason?: string | null; ip?: string | null; deviceId?: string | null;
  }): Promise<void> {
    await this.db.query(
      `INSERT INTO contact_reveals (tenant_id, user_id, client_id, field, reason, ip, device_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [o.tenantId, o.userId, o.clientId, o.field, o.reason ?? null, o.ip ?? null, o.deviceId ?? null],
    );
  }

  /** Кто и когда смотрел контакты — отдельный отчёт (ТЗ, п. 60). */
  reveals(tenantId: string, limit: number) {
    return this.db.many<{
      id: string; user_name: string | null; client_name: string; field: string;
      reason: string | null; created_at: string;
    }>(
      `SELECT cr.id::text, u.full_name AS user_name, c.name AS client_name, cr.field, cr.reason, cr.created_at
         FROM contact_reveals cr
         LEFT JOIN users u ON u.id = cr.user_id
         LEFT JOIN clients c ON c.id = cr.client_id
        WHERE cr.tenant_id=$1 ORDER BY cr.created_at DESC LIMIT $2`,
      [tenantId, limit],
    );
  }

  /** Раскрывал ли человек это поле недавно — по сроку повторного скрытия. */
  async revealedRecently(tenantId: string, userId: string, clientId: string, field: string, ttlSeconds: number) {
    const row = await this.db.one<{ ok: boolean }>(
      `SELECT TRUE AS ok FROM contact_reveals
        WHERE tenant_id=$1 AND user_id=$2 AND client_id=$3 AND field=$4
          AND created_at > now() - make_interval(secs => $5)
        LIMIT 1`,
      [tenantId, userId, clientId, field, ttlSeconds],
    );
    return !!row?.ok;
  }

  /** Сотрудники организации — для экрана «Роли и права». */
  members(tenantId: string) {
    return this.db.many<{
      id: string; full_name: string; email: string; base_role: string;
      role_id: string | null; role_name: string | null; limited: number;
    }>(
      `SELECT u.id::text, u.full_name, u.email, r.code AS base_role,
              sr.id::text AS role_id, sr.name AS role_name,
              (SELECT COUNT(*)::int FROM user_permission_overrides o WHERE o.user_id = u.id) AS limited
         FROM users u
         JOIN roles r ON r.id = u.role_id
         LEFT JOIN security_roles sr ON sr.id = u.security_role_id
        WHERE u.tenant_id=$1 AND u.is_active = TRUE
        ORDER BY r.code, u.full_name`,
      [tenantId],
    );
  }
}
