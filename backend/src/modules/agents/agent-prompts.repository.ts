import { Injectable } from '@nestjs/common';
import { DbService } from '../../database/db.service';

export interface AgentPromptRow {
  id: string;
  tenant_id: string;
  created_by: string;
  name: string;
  instruction: string;
  model: string | null;
  is_shared: boolean;
  usage_count: number;
}

@Injectable()
export class AgentPromptsRepository {
  constructor(private readonly db: DbService) {}

  create(i: { tenantId: string; createdBy: string; name: string; instruction: string; model: string | null; isShared: boolean }) {
    return this.db.one<AgentPromptRow>(
      `INSERT INTO agent_prompts (tenant_id, created_by, name, instruction, model, is_shared)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [i.tenantId, i.createdBy, i.name, i.instruction, i.model, i.isShared],
    );
  }

  /** Видимые пользователю: свои (любые) + общие командные. С флагом mine и именем автора. */
  listVisible(tenantId: string, userId: string) {
    return this.db.many(
      `SELECT p.id, p.name, p.instruction, p.model, p.is_shared, p.usage_count, p.created_by, p.created_at, p.updated_at,
              (p.created_by = $2) AS mine, u.full_name AS author_name
         FROM agent_prompts p JOIN users u ON u.id = p.created_by
        WHERE p.tenant_id = $1 AND (p.created_by = $2 OR p.is_shared = TRUE)
        ORDER BY p.usage_count DESC, p.name ASC`,
      [tenantId, userId],
    );
  }

  /** Пресет, видимый пользователю (свой или общий) — для применения. */
  getVisible(tenantId: string, userId: string, id: string) {
    return this.db.one<AgentPromptRow>(
      `SELECT * FROM agent_prompts WHERE tenant_id=$1 AND id=$2 AND (created_by=$3 OR is_shared=TRUE)`,
      [tenantId, id, userId],
    );
  }

  getById(tenantId: string, id: string) {
    return this.db.one<AgentPromptRow>(`SELECT * FROM agent_prompts WHERE tenant_id=$1 AND id=$2`, [tenantId, id]);
  }

  update(tenantId: string, id: string, patch: { name?: string; instruction?: string; model?: string | null; isShared?: boolean }) {
    const sets: string[] = [];
    const vals: unknown[] = [tenantId, id];
    let i = 3;
    if (patch.name !== undefined) { sets.push(`name=$${i++}`); vals.push(patch.name); }
    if (patch.instruction !== undefined) { sets.push(`instruction=$${i++}`); vals.push(patch.instruction); }
    if (patch.model !== undefined) { sets.push(`model=$${i++}`); vals.push(patch.model); }
    if (patch.isShared !== undefined) { sets.push(`is_shared=$${i++}`); vals.push(patch.isShared); }
    if (!sets.length) return this.getById(tenantId, id);
    sets.push('updated_at=now()');
    return this.db.one<AgentPromptRow>(`UPDATE agent_prompts SET ${sets.join(', ')} WHERE tenant_id=$1 AND id=$2 RETURNING *`, vals);
  }

  async remove(tenantId: string, id: string) {
    await this.db.query(`DELETE FROM agent_prompts WHERE tenant_id=$1 AND id=$2`, [tenantId, id]);
  }

  async incrementUsage(id: string) {
    await this.db.query(`UPDATE agent_prompts SET usage_count=usage_count+1 WHERE id=$1`, [id]);
  }
}
