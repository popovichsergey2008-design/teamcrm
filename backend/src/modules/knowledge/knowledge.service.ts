import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { createHash } from 'crypto';
import { DbService } from '../../database/db.service';
import { RabbitMQService, Q_EMBEDDINGS } from '../../messaging/rabbitmq.service';
import { AiService } from '../ai/ai.service';
import { maskPII } from '../ai/pii';
import { KnowledgeRepository } from './knowledge.repository';

export type SourceType = 'task' | 'comment' | 'regulation' | 'gdoc' | 'meeting';
interface IndexMsg { tenantId: string; sourceType: SourceType; sourceId: string; }

const CHUNK = 1200;
const OVERLAP = 150;

@Injectable()
export class KnowledgeService implements OnModuleInit {
  private readonly log = new Logger('Knowledge');
  private readonly model: string;

  constructor(
    private readonly db: DbService,
    private readonly repo: KnowledgeRepository,
    private readonly ai: AiService,
    private readonly mq: RabbitMQService,
  ) {
    this.model = process.env.OPENAI_API_KEY ? 'text-embedding-3-small' : 'mock-embed';
  }

  async onModuleInit() {
    // воркер очереди эмбеддингов
    await this.mq.consume(Q_EMBEDDINGS, (msg: IndexMsg) => this.indexSource(msg), 4);
  }

  enqueue(tenantId: string, sourceType: SourceType, sourceId: string) {
    return this.mq.publish(Q_EMBEDDINGS, { tenantId, sourceType, sourceId });
  }

  private chunk(text: string): string[] {
    const t = text.trim();
    if (t.length <= CHUNK) return t ? [t] : [];
    const out: string[] = [];
    for (let i = 0; i < t.length; i += CHUNK - OVERLAP) out.push(t.slice(i, i + CHUNK));
    return out;
  }

  /** Загружает текст источника + метаданные (scope/title). null — источник исчез/пуст. */
  private async loadSource(msg: IndexMsg): Promise<{ text: string; accessScope: string | null; title: string | null } | null> {
    if (msg.sourceType === 'task') {
      const r = await this.db.one<any>(
        `SELECT title, description, project_id FROM tasks WHERE tenant_id=$1 AND id=$2`,
        [msg.tenantId, msg.sourceId],
      );
      if (!r) return null; // индексируем ВСЕ задачи (и открытые, и закрытые проекты)
      const files = await this.db.many<{ file_name: string }>(
        `SELECT f.file_name FROM task_attachments a JOIN files f ON f.id=a.file_id
          WHERE a.tenant_id=$1 AND a.task_id=$2`,
        [msg.tenantId, msg.sourceId],
      );
      const fileText = files.length ? `\nФайлы: ${files.map((f) => f.file_name).join(', ')}` : '';
      return { text: [r.title, r.description].filter(Boolean).join('\n') + fileText, accessScope: r.project_id, title: r.title };
    }
    if (msg.sourceType === 'comment') {
      const r = await this.db.one<any>(
        `SELECT c.body, t.project_id, t.title AS task_title
           FROM task_comments c JOIN tasks t ON t.id=c.task_id
          WHERE c.tenant_id=$1 AND c.id=$2`,
        [msg.tenantId, msg.sourceId],
      );
      if (!r || !String(r.body ?? '').trim()) return null;
      return { text: r.body, accessScope: r.project_id, title: r.task_title };
    }
    if (msg.sourceType === 'meeting') {
      // в память компании кладём сводку и стенограмму: «что мы решили по X» ищется именно там
      const m = await this.db.one<any>(
        `SELECT m.title, m.project_id, s.summary FROM meetings m
           LEFT JOIN meeting_summaries s ON s.meeting_id = m.id
          WHERE m.tenant_id=$1 AND m.id=$2`,
        [msg.tenantId, msg.sourceId],
      );
      if (!m) return null;
      const lines = await this.db.many<{ text: string; speaker: string | null }>(
        `SELECT speaker, text FROM meeting_segments WHERE tenant_id=$1 AND meeting_id=$2 ORDER BY idx`,
        [msg.tenantId, msg.sourceId],
      );
      const body = lines.map((l) => (l.speaker ? `${l.speaker}: ${l.text}` : l.text)).join('\n');
      if (!body.trim()) return null;
      return {
        text: [m.title, m.summary, body].filter(Boolean).join('\n'),
        accessScope: m.project_id,
        title: `Встреча: ${m.title}`,
      };
    }
    if (msg.sourceType === 'gdoc') {
      const r = await this.db.one<any>(
        `SELECT title, text, project_id FROM google_docs WHERE tenant_id=$1 AND id=$2 AND status='indexed'`,
        [msg.tenantId, msg.sourceId],
      );
      if (!r || !String(r.text ?? '').trim()) return null;
      return { text: [r.title, r.text].filter(Boolean).join('\n'), accessScope: r.project_id, title: r.title };
    }
    // regulation
    const r = await this.db.one<any>(`SELECT title, body FROM regulations WHERE tenant_id=$1 AND id=$2`, [msg.tenantId, msg.sourceId]);
    if (!r) return null;
    return { text: [r.title, r.body].filter(Boolean).join('\n'), accessScope: null, title: r.title };
  }

  /** Идемпотентная индексация источника: маскирование PII → чанкинг → эмбеддинги → замена чанков. */
  async indexSource(msg: IndexMsg): Promise<void> {
    const src = await this.loadSource(msg);
    if (!src) { await this.repo.deleteBySource(msg.tenantId, msg.sourceType, msg.sourceId); return; }

    const hash = createHash('sha256').update(src.text).digest('hex').slice(0, 40);
    if ((await this.repo.sourceHash(msg.tenantId, msg.sourceType, msg.sourceId)) === hash) return; // не изменилось

    const chunks: { content: string; embedding: number[] }[] = [];
    for (const raw of this.chunk(src.text)) {
      const masked = maskPII(raw).masked;
      const embedding = await this.ai.embed(msg.tenantId, masked, 'embedding');
      chunks.push({ content: masked, embedding });
    }
    if (!chunks.length) { await this.repo.deleteBySource(msg.tenantId, msg.sourceType, msg.sourceId); return; }

    await this.repo.replaceChunks({
      tenantId: msg.tenantId, sourceType: msg.sourceType, sourceId: msg.sourceId,
      accessScope: src.accessScope, title: src.title, hash, model: this.model, chunks,
    });
    this.log.log(`indexed ${msg.sourceType}#${msg.sourceId} (${chunks.length} chunk(s))`);
  }

  /** Семантический поиск. Опционально в рамках одного проекта (+ общие регламенты). */
  async search(tenantId: string, query: string, k = 8, projectId?: string) {
    const vec = await this.ai.embed(tenantId, query, 'embedding');
    return this.searchByVector(tenantId, vec, k, projectId);
  }

  /** Поиск по готовому вектору (переиспользуется в AI Brain / кэше — без повторного эмбеддинга). */
  async searchByVector(tenantId: string, vec: number[], k = 8, projectId?: string) {
    const hits = await this.repo.search(tenantId, vec, k, projectId);
    // подписи проектов для разреза «по проектам»
    const scopeIds = [...new Set(hits.map((h) => h.access_scope).filter(Boolean) as string[])];
    const names = new Map<string, string>();
    if (scopeIds.length) {
      const rows = await this.db.many<{ id: string; name: string }>(
        `SELECT id, name FROM projects WHERE tenant_id=$1 AND id = ANY($2::bigint[])`, [tenantId, scopeIds],
      );
      for (const r of rows) names.set(String(r.id), r.name);
    }
    return hits.map((h) => ({
      sourceType: h.source_type, sourceId: h.source_id, title: h.title,
      projectId: h.access_scope, projectName: h.access_scope ? names.get(String(h.access_scope)) ?? null : null,
      snippet: h.content.slice(0, 400), score: Number(h.score),
    }));
  }

  /** Постановка всех знаний арендатора в очередь индексации (в т.ч. импортированных из Битрикса). */
  async backfill(tenantId: string): Promise<{ queued: number }> {
    let queued = 0;
    const tasks = await this.db.many<{ id: string }>(`SELECT id FROM tasks WHERE tenant_id=$1`, [tenantId]);
    for (const t of tasks) { this.enqueue(tenantId, 'task', t.id); queued++; }
    const comments = await this.db.many<{ id: string }>(`SELECT id FROM task_comments WHERE tenant_id=$1`, [tenantId]);
    for (const c of comments) { this.enqueue(tenantId, 'comment', c.id); queued++; }
    const regs = await this.db.many<{ id: string }>(`SELECT id FROM regulations WHERE tenant_id=$1`, [tenantId]);
    for (const r of regs) { this.enqueue(tenantId, 'regulation', r.id); queued++; }
    return { queued };
  }

  stats(tenantId: string) {
    return this.repo.countByTenant(tenantId);
  }

  /** Список источников базы знаний (для ручного просмотра содержимого) + имена проектов. */
  async listSources(tenantId: string, opts: { projectId?: string; type?: string; q?: string; limit?: number; offset?: number }) {
    const limit = Math.min(Math.max(opts.limit ?? 30, 1), 100);
    const offset = Math.max(opts.offset ?? 0, 0);
    const rows = await this.repo.listSources(tenantId, { projectId: opts.projectId, type: opts.type, q: opts.q, limit, offset });
    const scopeIds = [...new Set(rows.map((r) => r.access_scope).filter(Boolean) as string[])];
    const names = new Map<string, string>();
    if (scopeIds.length) {
      const prj = await this.db.many<{ id: string; name: string }>(
        `SELECT id, name FROM projects WHERE tenant_id=$1 AND id = ANY($2::bigint[])`, [tenantId, scopeIds],
      );
      for (const p of prj) names.set(String(p.id), p.name);
    }
    return {
      items: rows.map((r) => ({
        sourceType: r.source_type, sourceId: r.source_id, title: r.title, chunks: r.chunks, snippet: r.snippet,
        projectId: r.access_scope, projectName: r.access_scope ? names.get(String(r.access_scope)) ?? null : null,
      })),
      limit, offset, hasMore: rows.length === limit,
    };
  }

  /** Полное содержимое одного источника из исходной таблицы (для просмотра в базе знаний). */
  async sourceContent(tenantId: string, type: string, id: string): Promise<{ sourceType: string; title: string | null; text: string; url?: string | null; projectName?: string | null } | null> {
    const projName = async (projectId: string | null) =>
      projectId ? (await this.db.one<{ name: string }>(`SELECT name FROM projects WHERE tenant_id=$1 AND id=$2`, [tenantId, projectId]))?.name ?? null : null;

    if (type === 'task') {
      const r = await this.db.one<any>(`SELECT title, description, project_id FROM tasks WHERE tenant_id=$1 AND id=$2`, [tenantId, id]);
      if (!r) return null;
      return { sourceType: type, title: r.title, text: String(r.description ?? ''), projectName: await projName(r.project_id) };
    }
    if (type === 'comment') {
      const r = await this.db.one<any>(
        `SELECT c.body, t.title AS task_title, t.project_id FROM task_comments c JOIN tasks t ON t.id=c.task_id WHERE c.tenant_id=$1 AND c.id=$2`, [tenantId, id]);
      if (!r) return null;
      return { sourceType: type, title: r.task_title, text: String(r.body ?? ''), projectName: await projName(r.project_id) };
    }
    if (type === 'gdoc') {
      const r = await this.db.one<any>(`SELECT title, text, url, project_id FROM google_docs WHERE tenant_id=$1 AND id=$2`, [tenantId, id]);
      if (!r) return null;
      return { sourceType: type, title: r.title, text: String(r.text ?? ''), url: r.url, projectName: await projName(r.project_id) };
    }
    if (type === 'regulation') {
      const r = await this.db.one<any>(`SELECT title, body FROM regulations WHERE tenant_id=$1 AND id=$2`, [tenantId, id]);
      if (!r) return null;
      return { sourceType: type, title: r.title, text: String(r.body ?? '') };
    }
    return null;
  }
}
