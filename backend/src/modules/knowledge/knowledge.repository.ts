import { projectVisibleSql, ProjectViewer, seesAllProjects, viewerParams } from '../../common/access/project-visibility';
import { createHash } from 'crypto';
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
  chat_id?: string | null;
  anchor?: Record<string, unknown> | null;
  source_at?: Date | null;
  author_id?: string | null;
}

export interface MemoryFilters {
  types?: string[];
  projectId?: string | null;
  from?: Date | null;
  to?: Date | null;
  authorId?: string | null;
}

/**
 * Кто что видит в памяти — до поиска (ТЗ-21 §39): проект виден, переписка — только
 * участникам чата (руководителю чужая личка тоже не видна), заметки о клиентах и внешние
 * чаты — только сотрудникам. Без `viewer` — служебный вызов: переписку не отдаём вовсе.
 */
function accessSql(params: unknown[], viewer?: ProjectViewer): string {
  if (!viewer) return ' AND chat_id IS NULL';
  const [u, all, client] = viewerParams(viewer);
  params.push(u, all, client);
  const n = params.length;
  return ` AND (access_scope IS NULL OR ${projectVisibleSql('access_scope', { user: `$${n - 2}`, all: `$${n - 1}`, client: `$${n}` })})`
    + ` AND (chat_id IS NULL OR EXISTS (SELECT 1 FROM chat_members cm WHERE cm.chat_id = knowledge_chunks.chat_id AND cm.user_id = $${n - 2}::bigint))`
    + ` AND (NOT staff_only OR NOT $${n}::boolean)`;
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
    title: string | null; hash: string; model: string;
    chunks: { content: string; embedding: number[]; anchor?: object | null; sourceAt?: Date | string | null; authorId?: string | null }[];
    chatId?: string | null; staffOnly?: boolean;
  }): Promise<void> {
    await this.db.withTransaction(async (c) => {
      // индексатор и правка могут прийти одновременно: без замка обе удалят и обе вставят — дубль ключа
      await c.query(`SELECT pg_advisory_xact_lock(hashtext($1 || ':' || $2 || ':' || $3))`, [i.tenantId, i.sourceType, i.sourceId]);
      await c.query(`DELETE FROM knowledge_chunks WHERE tenant_id=$1 AND source_type=$2 AND source_id=$3`, [
        i.tenantId, i.sourceType, i.sourceId,
      ]);
      for (let idx = 0; idx < i.chunks.length; idx++) {
        await c.query(
          `INSERT INTO knowledge_chunks
             (tenant_id, source_type, source_id, chunk_index, access_scope, title, content, content_hash, embedding, model,
              chat_id, staff_only, anchor, source_at, author_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::vector,$10,$11,$12,$13::jsonb,$14,$15)`,
          [
            i.tenantId, i.sourceType, i.sourceId, idx, i.accessScope, i.title,
            i.chunks[idx].content, i.hash, this.vec(i.chunks[idx].embedding), i.model,
            i.chatId ?? null, i.staffOnly === true, i.chunks[idx].anchor ? JSON.stringify(i.chunks[idx].anchor) : null,
            i.chunks[idx].sourceAt ?? null, i.chunks[idx].authorId ?? null,
          ],
        );
      }
    });
  }

  /**
   * Семантический поиск. ВСЕГДА фильтр по tenant. Если задан projectId — только
   * фрагменты этого проекта + общие регламенты (access_scope IS NULL).
   */
  /**
   * Поиск по смыслу.
   *
   * `types` сужает поиск до нужного рода источников — например, только до документов.
   * Без него вопрос «как ставятся задачи» тонет в самих задачах со словом «задача»:
   * их в базе тысячи, справочника — десяток, и он не попадает даже в первую сотню.
   */
  search(tenantId: string, queryVec: number[], k: number, projectId?: string, types?: string[], viewer?: ProjectViewer): Promise<SearchHit[]> {
    const params: any[] = [tenantId, this.vec(queryVec), k];
    let scopeSql = '';
    // Права — ДО поиска (ТЗ-21 §39): фрагмент закрытого проекта не попадает ни в выдачу,
    // ни в контекст модели. Без `viewer` — служебный вызов (уже ограничен проектом).
    scopeSql += accessSql(params, viewer);
    if (projectId) {
      params.push(projectId);
      scopeSql += ` AND (access_scope = $${params.length} OR access_scope IS NULL)`;
    }
    if (types?.length) {
      params.push(types);
      scopeSql += ` AND source_type = ANY($${params.length}::text[])`;
    }
    return this.db.many<SearchHit>(
      `SELECT id, source_type, source_id, chunk_index, title, content, access_scope, chat_id::text, anchor, source_at, author_id::text,
              1 - (embedding <=> $2::vector) AS score
         FROM knowledge_chunks
        WHERE tenant_id=$1 ${scopeSql}
        ORDER BY embedding <=> $2::vector
        LIMIT $3`,
      params,
    );
  }

  /**
   * Поиск памяти: по смыслу и по словам вместе (ТЗ-21 §37). Смысловой находит «как мы
   * договорились про оплату» без слова «оплата», словарный — номер договора, фамилию,
   * название. Итог сводится взаимным рангом (RRF): фрагмент, найденный обоими путями,
   * выше любого найденного одним. Без настоящей модели эмбеддингов — только по словам.
   */
  hybrid(tenantId: string, vec: number[] | null, fts: string | null, k: number, f: MemoryFilters, viewer?: ProjectViewer): Promise<SearchHit[]> {
    if (!vec && !fts) return Promise.resolve([]);
    const params: unknown[] = [tenantId];
    let where = `tenant_id = $1` + accessSql(params, viewer);
    if (f.projectId) { params.push(f.projectId); where += ` AND (access_scope = $${params.length} OR access_scope IS NULL)`; }
    if (f.types?.length) { params.push(f.types); where += ` AND source_type = ANY($${params.length}::text[])`; }
    if (f.from) { params.push(f.from); where += ` AND COALESCE(source_at, created_at) >= $${params.length}`; }
    if (f.to) { params.push(f.to); where += ` AND COALESCE(source_at, created_at) < $${params.length}`; }
    if (f.authorId) { params.push(f.authorId); where += ` AND author_id = $${params.length}::bigint`; }
    let vecCte = `SELECT NULL::bigint AS id, NULL::bigint AS r WHERE FALSE`;
    if (vec) {
      params.push(this.vec(vec));
      const v = params.length;
      vecCte = `SELECT id, row_number() OVER (ORDER BY embedding <=> $${v}::vector) AS r
                  FROM (SELECT id, embedding FROM knowledge_chunks WHERE ${where} ORDER BY embedding <=> $${v}::vector LIMIT 40) x`;
    }
    let ftsCte = `SELECT NULL::bigint AS id, NULL::bigint AS r WHERE FALSE`;
    if (fts) {
      params.push(fts);
      const q = params.length;
      ftsCte = `SELECT id, row_number() OVER (ORDER BY rank DESC) AS r
                  FROM (SELECT id, ts_rank_cd(tsv, to_tsquery('russian', $${q})) AS rank
                          FROM knowledge_chunks WHERE ${where} AND tsv @@ to_tsquery('russian', $${q})
                         ORDER BY rank DESC LIMIT 40) y`;
    }
    params.push(k);
    return this.db.many<SearchHit>(
      `WITH v AS (${vecCte}), f AS (${ftsCte})
       SELECT k.id, k.source_type, k.source_id, k.chunk_index, k.title, k.content, k.access_scope, k.chat_id::text,
              k.anchor, k.source_at, k.author_id::text,
              COALESCE(1.0 / (60 + v.r), 0) + COALESCE(1.0 / (60 + f.r), 0) AS score
         FROM knowledge_chunks k
         LEFT JOIN v ON v.id = k.id
         LEFT JOIN f ON f.id = k.id
        WHERE k.id IN (SELECT id FROM v UNION SELECT id FROM f)
        ORDER BY score DESC, k.source_at DESC NULLS LAST
        LIMIT $${params.length}`,
      params,
    );
  }

  /** Проект источника в базе знаний (NULL — общий: регламенты, справочник). */
  async scopeOf(tenantId: string, type: string, id: string): Promise<string | null | undefined> {
    const row = await this.db.one<{ access_scope: string | null }>(
      `SELECT access_scope FROM knowledge_chunks WHERE tenant_id=$1 AND source_type=$2 AND source_id=$3 LIMIT 1`,
      [tenantId, type, id],
    );
    return row ? row.access_scope : undefined;
  }

  /** Виден ли человеку проект — тем же правилом, что во всех путях поиска. */
  async projectVisible(tenantId: string, projectId: string, viewer: ProjectViewer): Promise<boolean> {
    const row = await this.db.one<{ ok: boolean }>(
      `SELECT ${projectVisibleSql('$2', { user: '$3', all: '$4', client: '$5' })} AS ok
         FROM tenants WHERE id = $1`,
      [tenantId, projectId, ...viewerParams(viewer)],
    );
    return !!row?.ok;
  }

  /**
   * Ключ доступа для кэшей ответов ИИ (ТЗ-21, этап 0). Раньше кэш был общим на компанию,
   * и ответ, собранный из закрытого проекта, получал любой. Теперь ответ делят только
   * люди с одинаковым набором видимых закрытых проектов.
   */
  async accessKey(tenantId: string, viewer: ProjectViewer): Promise<string> {
    if (seesAllProjects(viewer)) return 'all';
    const rows = await this.db.many<{ id: string }>(
      `SELECT p.id::text FROM projects p
        WHERE p.tenant_id = $1 AND p.visibility <> 'all'
          AND (p.owner_user_id = $2::bigint
               OR EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id = p.id AND pm.user_id = $2::bigint))
        ORDER BY p.id`,
      [tenantId, viewer.userId],
    );
    const base = viewer.role === 'client' ? `client:${viewer.userId}` : rows.map((r) => r.id).join(',');
    if (!base) return 'public';
    return `r${createHash('sha1').update(base).digest('hex').slice(0, 20)}`;
  }

  /** Список проиндексированных источников (для просмотра содержимого базы). */
  listSources(tenantId: string, opts: { projectId?: string; type?: string; q?: string; limit: number; offset: number; viewer?: ProjectViewer }) {
    const params: any[] = [tenantId];
    const where: string[] = ['tenant_id=$1'];
    where[0] += accessSql(params, opts.viewer);
    if (opts.projectId) { params.push(opts.projectId); where.push(`(access_scope=$${params.length} OR access_scope IS NULL)`); }
    if (opts.type) { params.push(opts.type); where.push(`source_type=$${params.length}`); }
    if (opts.q) { params.push(`%${opts.q}%`); where.push(`title ILIKE $${params.length}`); }
    params.push(opts.limit); const limIdx = params.length;
    params.push(opts.offset); const offIdx = params.length;
    return this.db.many<{ source_type: string; source_id: string; title: string | null; access_scope: string | null; chunks: number; snippet: string }>(
      `SELECT source_type, source_id, max(title) AS title, max(access_scope) AS access_scope, count(*)::int AS chunks,
              substring((array_agg(content ORDER BY chunk_index))[1] for 220) AS snippet
         FROM knowledge_chunks
        WHERE ${where.join(' AND ')}
        GROUP BY source_type, source_id
        ORDER BY max(title) NULLS LAST, source_type
        LIMIT $${limIdx} OFFSET $${offIdx}`,
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
