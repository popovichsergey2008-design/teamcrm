import { Injectable } from '@nestjs/common';
import { PoolClient } from 'pg';
import { DbService } from '../../database/db.service';

export interface PromptTemplateRow {
  id: string;
  tenant_id: string | null;
  key: string;
  title: string;
  description: string | null;
  created_at: string;
}

export interface PromptVersionRow {
  id: string;
  template_id: string;
  version: number;
  body: string;
  model: string | null;
  params: Record<string, unknown>;
  variables: unknown[];
  status: 'draft' | 'testing' | 'active' | 'deprecated';
  ab_split: number | null;
  note: string | null;
  created_by: string | null;
  created_at: string;
}

/** Хранилище шаблонов/версий промптов. Приоритет: tenant-override > глобальный дефолт (tenant_id IS NULL). */
@Injectable()
export class PromptRepository {
  constructor(private readonly db: DbService) {}

  /** Шаблон арендатора по ключу (переопределение). */
  findTenantTemplate(tenantId: string, key: string) {
    return this.db.one<PromptTemplateRow>(
      `SELECT * FROM prompt_templates WHERE tenant_id=$1 AND key=$2`,
      [tenantId, key],
    );
  }

  /** Глобальный системный дефолт по ключу. */
  findGlobalTemplate(key: string) {
    return this.db.one<PromptTemplateRow>(
      `SELECT * FROM prompt_templates WHERE tenant_id IS NULL AND key=$1`,
      [key],
    );
  }

  /** Действующий шаблон для арендатора: его override, иначе глобальный дефолт. */
  async effectiveTemplate(tenantId: string, key: string) {
    return (await this.findTenantTemplate(tenantId, key)) ?? (await this.findGlobalTemplate(key));
  }

  activeVersion(templateId: string) {
    return this.db.one<PromptVersionRow>(
      `SELECT * FROM prompt_versions WHERE template_id=$1 AND status='active'
        ORDER BY version DESC LIMIT 1`,
      [templateId],
    );
  }

  listVersions(templateId: string) {
    return this.db.many<PromptVersionRow>(
      `SELECT * FROM prompt_versions WHERE template_id=$1 ORDER BY version DESC`,
      [templateId],
    );
  }

  getVersion(templateId: string, version: number) {
    return this.db.one<PromptVersionRow>(
      `SELECT * FROM prompt_versions WHERE template_id=$1 AND version=$2`,
      [templateId, version],
    );
  }

  /** Все ключи (глобальные дефолты определяют полный набор фич). */
  listGlobalKeys() {
    return this.db.many<PromptTemplateRow>(
      `SELECT * FROM prompt_templates WHERE tenant_id IS NULL ORDER BY key`,
    );
  }

  /** Клонирует глобальный дефолт в override арендатора (клон-он-райт) + сид базовой версии. */
  async cloneToTenant(tenantId: string, global: PromptTemplateRow): Promise<PromptTemplateRow> {
    return this.db.withTransaction(async (c: PoolClient) => {
      const t = (await c.query<PromptTemplateRow>(
        `INSERT INTO prompt_templates (tenant_id, key, title, description)
         VALUES ($1,$2,$3,$4) RETURNING *`,
        [tenantId, global.key, global.title, global.description],
      )).rows[0];
      // базовая версия = текущий глобальный active (даёт цель для отката к исходнику)
      const g = (await c.query<PromptVersionRow>(
        `SELECT * FROM prompt_versions WHERE template_id=$1 AND status='active' ORDER BY version DESC LIMIT 1`,
        [global.id],
      )).rows[0];
      if (g) {
        await c.query(
          `INSERT INTO prompt_versions (template_id, version, body, model, params, variables, status, note)
           VALUES ($1,1,$2,$3,$4,$5,'active',$6)`,
          [t.id, g.body, g.model, g.params, JSON.stringify(g.variables), 'Импортировано из системного дефолта'],
        );
      }
      return t;
    });
  }

  async nextVersion(templateId: string): Promise<number> {
    const r = await this.db.one<{ max: number | null }>(
      `SELECT max(version) AS max FROM prompt_versions WHERE template_id=$1`,
      [templateId],
    );
    return (r?.max ?? 0) + 1;
  }

  insertVersion(v: {
    templateId: string; version: number; body: string; model: string | null;
    params: Record<string, unknown>; variables: unknown[]; status: string; note: string | null; createdBy: string | null;
  }) {
    return this.db.one<PromptVersionRow>(
      `INSERT INTO prompt_versions (template_id, version, body, model, params, variables, status, note, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [v.templateId, v.version, v.body, v.model, JSON.stringify(v.params), JSON.stringify(v.variables), v.status, v.note, v.createdBy],
    );
  }

  /** Активация версии с инвариантом «одна active»: прочие active→deprecated. */
  async activateVersion(templateId: string, version: number): Promise<void> {
    await this.db.withTransaction(async (c) => {
      await c.query(
        `UPDATE prompt_versions SET status='deprecated'
          WHERE template_id=$1 AND status='active' AND version<>$2`,
        [templateId, version],
      );
      await c.query(
        `UPDATE prompt_versions SET status='active' WHERE template_id=$1 AND version=$2`,
        [templateId, version],
      );
    });
  }

  setStatus(templateId: string, version: number, status: string) {
    return this.db.query(
      `UPDATE prompt_versions SET status=$3 WHERE template_id=$1 AND version=$2`,
      [templateId, version, status],
    );
  }

  /** Метрики по версиям шаблона: вызовы, токены (из ai_usage, привязанного к версии). */
  metricsByVersion(templateId: string, days: number) {
    return this.db.many<any>(
      `SELECT v.version, v.status,
              count(u.id)::int AS calls,
              coalesce(sum(u.input_tokens),0)::int AS input_tokens,
              coalesce(sum(u.output_tokens),0)::int AS output_tokens,
              coalesce(sum((u.cache_hit)::int),0)::int AS cache_hits
         FROM prompt_versions v
         LEFT JOIN ai_usage u
           ON u.prompt_version_id = v.id
          AND u.created_at > now() - ($2 || ' days')::interval
        WHERE v.template_id=$1
        GROUP BY v.version, v.status
        ORDER BY v.version DESC`,
      [templateId, days],
    );
  }
}
