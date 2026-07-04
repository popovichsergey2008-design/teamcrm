import { Injectable } from '@nestjs/common';
import { DbService } from '../../database/db.service';

@Injectable()
export class PortalRepository {
  constructor(private readonly db: DbService) {}

  createClient(tenantId: string, name: string, contact: string | null) {
    return this.db.one<{ id: string; name: string }>(
      `INSERT INTO clients (tenant_id, name, contact) VALUES ($1,$2,$3) RETURNING id, name`,
      [tenantId, name, contact],
    );
  }

  listClients(tenantId: string) {
    return this.db.many(
      `SELECT c.id, c.name, c.contact,
              (SELECT count(*) FROM users u WHERE u.tenant_id=c.tenant_id AND u.client_id=c.id) AS portal_users,
              (SELECT count(*) FROM projects p WHERE p.tenant_id=c.tenant_id AND p.client_id=c.id) AS projects
         FROM clients c WHERE c.tenant_id=$1 ORDER BY c.created_at DESC`,
      [tenantId],
    );
  }

  clientExists(tenantId: string, clientId: string) {
    return this.db.one(`SELECT id FROM clients WHERE tenant_id=$1 AND id=$2`, [tenantId, clientId]);
  }

  async assignProjectClient(tenantId: string, projectId: string, clientId: string | null): Promise<boolean> {
    const r = await this.db.query(
      `UPDATE projects SET client_id=$3, updated_at=now() WHERE tenant_id=$1 AND id=$2`,
      [tenantId, projectId, clientId],
    );
    return (r.rowCount ?? 0) > 0;
  }

  async clientIdOfUser(tenantId: string, userId: string): Promise<string | null> {
    const r = await this.db.one<{ client_id: string | null }>(
      `SELECT client_id FROM users WHERE tenant_id=$1 AND id=$2`,
      [tenantId, userId],
    );
    return r?.client_id ?? null;
  }

  clientProjects(tenantId: string, clientId: string) {
    return this.db.many<{ id: string; name: string; status: string }>(
      `SELECT id, name, status FROM projects WHERE tenant_id=$1 AND client_id=$2 ORDER BY created_at DESC`,
      [tenantId, clientId],
    );
  }

  projectBelongsToClient(tenantId: string, projectId: string, clientId: string) {
    return this.db.one(`SELECT id FROM projects WHERE tenant_id=$1 AND id=$2 AND client_id=$3`, [tenantId, projectId, clientId]);
  }
}
