import { Injectable } from '@nestjs/common';
import { DbService } from '../../database/db.service';
import { AppException } from '../../common/http/app-exception';
import { KnowledgeService } from './knowledge.service';
import { KnowledgeRepository } from './knowledge.repository';

@Injectable()
export class RegulationsService {
  constructor(
    private readonly db: DbService,
    private readonly knowledge: KnowledgeService,
    private readonly kRepo: KnowledgeRepository,
  ) {}

  list(tenantId: string) {
    return this.db.many(
      `SELECT id, title, left(body, 200) AS excerpt, updated_at FROM regulations WHERE tenant_id=$1 ORDER BY updated_at DESC`,
      [tenantId],
    );
  }

  get(tenantId: string, id: string) {
    return this.db.one(`SELECT * FROM regulations WHERE tenant_id=$1 AND id=$2`, [tenantId, id]);
  }

  async create(tenantId: string, userId: string, title: string, body: string) {
    const row = await this.db.one<{ id: string }>(
      `INSERT INTO regulations (tenant_id, title, body, created_by) VALUES ($1,$2,$3,$4) RETURNING id`,
      [tenantId, title.trim(), body, userId],
    );
    this.knowledge.enqueue(tenantId, 'regulation', row!.id);
    return { id: row!.id, title: title.trim() };
  }

  async update(tenantId: string, id: string, title: string, body: string) {
    const row = await this.db.one(
      `UPDATE regulations SET title=$3, body=$4, updated_at=now() WHERE tenant_id=$1 AND id=$2 RETURNING id`,
      [tenantId, id, title.trim(), body],
    );
    if (!row) throw AppException.notFound('Регламент не найден');
    this.knowledge.enqueue(tenantId, 'regulation', id);
    return { id, title: title.trim() };
  }

  async remove(tenantId: string, id: string) {
    const row = await this.db.one(`SELECT id FROM regulations WHERE tenant_id=$1 AND id=$2`, [tenantId, id]);
    if (!row) throw AppException.notFound('Регламент не найден');
    await this.kRepo.deleteBySource(tenantId, 'regulation', id);
    await this.db.query(`DELETE FROM regulations WHERE tenant_id=$1 AND id=$2`, [tenantId, id]);
    return { deleted: true };
  }
}
