import { Injectable } from '@nestjs/common';
import { DbService } from '../../database/db.service';

export interface InviteRow {
  id: string;
  tenant_id: string;
  email: string;
  role_code: string;
  position_id: string | null;
  token_hash: string;
  invited_by: string;
  expires_at: Date;
  accepted_at: Date | null;
}

@Injectable()
export class InvitesRepository {
  constructor(private readonly db: DbService) {}

  create(input: {
    tenantId: string;
    email: string;
    roleCode: string;
    positionId: string | null;
    tokenHash: string;
    invitedBy: string;
    expiresAt: Date;
  }): Promise<InviteRow> {
    return this.db.one<InviteRow>(
      `INSERT INTO invites (tenant_id, email, role_code, position_id, token_hash, invited_by, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [input.tenantId, input.email, input.roleCode, input.positionId, input.tokenHash, input.invitedBy, input.expiresAt],
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
}
