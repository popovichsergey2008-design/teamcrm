import { Injectable } from '@nestjs/common';
import { DbService } from '../../database/db.service';

export interface InviteRow {
  id: string;
  tenant_id: string;
  email: string;
  role_code: string;
  position_id: string | null;
  client_id: string | null;
  token_hash: string;
  invited_by: string;
  expires_at: Date;
  accepted_at: Date | null;
}

export interface InviteLinkRow {
  id: string;
  tenant_id: string;
  role_code: string;
  position_id: string | null;
  token_hash: string;
  created_by: string;
  is_active: boolean;
  max_uses: number | null;
  uses: number;
  expires_at: Date | null;
}

@Injectable()
export class InvitesRepository {
  constructor(private readonly db: DbService) {}

  create(input: {
    tenantId: string;
    email: string;
    roleCode: string;
    positionId: string | null;
    clientId?: string | null;
    tokenHash: string;
    invitedBy: string;
    expiresAt: Date;
  }): Promise<InviteRow> {
    return this.db.one<InviteRow>(
      `INSERT INTO invites (tenant_id, email, role_code, position_id, client_id, token_hash, invited_by, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [input.tenantId, input.email, input.roleCode, input.positionId, input.clientId ?? null, input.tokenHash, input.invitedBy, input.expiresAt],
    ) as Promise<InviteRow>;
  }

  findValidByHash(tokenHash: string): Promise<InviteRow | null> {
    return this.db.one<InviteRow>(
      `SELECT * FROM invites WHERE token_hash=$1 AND accepted_at IS NULL AND expires_at > now()`,
      [tokenHash],
    );
  }

  async markAccepted(id: string): Promise<void> {
    await this.db.query(`UPDATE invites SET accepted_at=now() WHERE id=$1`, [id]);
  }

  listPending(tenantId: string) {
    return this.db.many(
      `SELECT id, email, role_code, position_id, expires_at, created_at
         FROM invites WHERE tenant_id=$1 AND accepted_at IS NULL ORDER BY created_at DESC`,
      [tenantId],
    );
  }

  // ── многоразовые ссылки-приглашения ──
  createLink(input: {
    tenantId: string; roleCode: string; positionId: string | null; tokenHash: string;
    createdBy: string; maxUses: number | null; expiresAt: Date | null;
  }): Promise<InviteLinkRow> {
    return this.db.one<InviteLinkRow>(
      `INSERT INTO invite_links (tenant_id, role_code, position_id, token_hash, created_by, max_uses, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [input.tenantId, input.roleCode, input.positionId, input.tokenHash, input.createdBy, input.maxUses, input.expiresAt],
    ) as Promise<InviteLinkRow>;
  }

  listLinks(tenantId: string) {
    return this.db.many(
      `SELECT id, role_code, position_id, is_active, max_uses, uses, expires_at, created_at
         FROM invite_links WHERE tenant_id=$1 ORDER BY created_at DESC`,
      [tenantId],
    );
  }

  /** Действующая ссылка по хэшу: активна, не истекла, лимит не исчерпан. С именем организации (для публичной страницы). */
  findActiveLinkByHash(tokenHash: string): Promise<(InviteLinkRow & { tenant_name: string }) | null> {
    return this.db.one<InviteLinkRow & { tenant_name: string }>(
      `SELECT l.*, t.name AS tenant_name
         FROM invite_links l JOIN tenants t ON t.id=l.tenant_id
        WHERE l.token_hash=$1 AND l.is_active
          AND (l.expires_at IS NULL OR l.expires_at > now())
          AND (l.max_uses IS NULL OR l.uses < l.max_uses)`,
      [tokenHash],
    );
  }

  async incrementLinkUses(id: string): Promise<void> {
    await this.db.query(`UPDATE invite_links SET uses=uses+1 WHERE id=$1`, [id]);
  }

  async deactivateLink(tenantId: string, id: string): Promise<void> {
    await this.db.query(`UPDATE invite_links SET is_active=FALSE WHERE tenant_id=$1 AND id=$2`, [tenantId, id]);
  }
}
