import { Injectable } from '@nestjs/common';
import { DbService } from '../../database/db.service';

export interface SearchHit {
  id: string;
  source_type: string;
  source_id: string;
  chunk_index: number;
  title: string | null;
  content: string;
  access_scope: string | null;
  score: number;
}

@Injectable()
export class KnowledgeRepository {
  constructor(private readonly db: DbService) {}

  private vec(v: number[]): string {
    return '[' + v.join(',') + ']';
  }

  /** Хеш источника (по любому его чанку) — для идемпотентной переиндексации. */
  async sourceHash(tenantId: string, sourceType: string, sourceId: string): Promise<string | null> {
    const r = await this.db.one<{ content_hash: string }>(
      `SELECT content_hash FROM knowledge_chunks WHERE tenant_id=$1 AND source_type=$2 AND source_id=$3 LIMIT 1`,
      [tenantId, sourceType, sourceId],
    );
    return r?.content_hash ?? null;
  }

  async deleteBySource(tenantId: string, sourceType: string, sourceId: string): Promise<void> {
    await this.db.query(
      `DELETE FROM knowledge_chunks WHERE tenant_id=$1 AND source_type=$2 AND source_id=$3`,
      [tenantId, sourceType, sourceId],
    );
  }

  /** Полная замена чанков источника (в транзакции). */
  async replaceChunks(i: {
    tenantId: string; sourceType: string; sourceId: string; accessScope: string | null;
    title: string | null; hash: string; model: string; chunks: { content: string; embedding: number[] }[];
  }): Promise<void> {
    await this.db.withTransaction(async (c) => {
      await c.query(`DELETE FROM knowledge_chunks WHERE tenant_id=$1 AND source_type=$2 AND source_id=$3`, [
        i.tenantId, i.sourceType, i.sourceId,
      ]);
      for (let idx = 0; idx < i.chunks.length; idx++) {
        await c.query(
          `INSERT INTO knowledge_chunks
             (tenant_id, source_type, source_id, chunk_index, access_scope, title, content, content_hash, embedding, model)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::vector,$10)`,
          [
            i.tenantId, i.sourceType, i.sourceId, idx, i.accessScope, i.title,
            i.chunks[idx].content, i.hash, this.vec(i.chunks[idx].embedding), i.model,
          ],
        );
      }
    });
  }

  /**
   * Семантический поиск. ВСЕГДА фильтр по tenant. Если scopeAll=false — дополнительно
   * по access_scope (проекты доступа пользователя) — инвариант «RAG не обходит RBAC».
   */
  search(tenantId: string, queryVec: number[], k: number, scope: { all: boolean; scopes: string[] }): Promise<SearchHit[]> {
    const params: any[] = [tenantId, this.vec(queryVec), k];
    let scopeSql = '';
    if (!scope.all) {
      params.push(scope.scopes.length ? scope.scopes : ['-1']);
      scopeSql = `AND (access_scope IS NULL OR access_scope = ANY($4::bigint[]))`;
    }
    return this.db.many<SearchHit>(
      `SELECT id, source_type, source_id, chunk_index, title, content, access_scope,
              1 - (embedding <=> $2::vector) AS score
         FROM knowledge_chunks
        WHERE tenant_id=$1 ${scopeSql}
        ORDER BY embedding <=> $2::vector
        LIMIT $3`,
      params,
    );
  }

  countByTenant(tenantId: string) {
    return this.db.one<{ chunks: string; sources: string }>(
      `SELECT count(*) AS chunks, count(DISTINCT (source_type, source_id)) AS sources
         FROM knowledge_chunks WHERE tenant_id=$1`,
      [tenantId],
    );
  }
}
