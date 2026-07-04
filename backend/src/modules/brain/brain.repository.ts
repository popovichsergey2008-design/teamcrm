import { Injectable } from '@nestjs/common';
import { DbService } from '../../database/db.service';

@Injectable()
export class BrainRepository {
  constructor(private readonly db: DbService) {}

  createConversation(tenantId: string, userId: string) {
    return this.db.one<{ id: string }>(
      `INSERT INTO brain_conversations (tenant_id, user_id) VALUES ($1,$2) RETURNING id`,
      [tenantId, userId],
    );
  }

  /** Диалог принадлежит именно этому пользователю в этом арендаторе (изоляция). */
  conversationOwned(tenantId: string, userId: string, id: string) {
    return this.db.one(
      `SELECT id, title FROM brain_conversations WHERE tenant_id=$1 AND user_id=$2 AND id=$3`,
      [tenantId, userId, id],
    );
  }

  setTitle(id: string, title: string) {
    return this.db.query(`UPDATE brain_conversations SET title=$2 WHERE id=$1 AND title IS NULL`, [id, title.slice(0, 255)]);
  }

  addMessage(conversationId: string, role: string, content: string, citations: unknown | null) {
    return this.db.one<{ id: string; created_at: Date }>(
      `INSERT INTO brain_messages (conversation_id, role, content, citations)
       VALUES ($1,$2,$3,$4) RETURNING id, created_at`,
      [conversationId, role, content, citations ? JSON.stringify(citations) : null],
    );
  }

  listConversations(tenantId: string, userId: string) {
    return this.db.many(
      `SELECT id, title, created_at FROM brain_conversations
        WHERE tenant_id=$1 AND user_id=$2 ORDER BY created_at DESC LIMIT 50`,
      [tenantId, userId],
    );
  }

  listMessages(conversationId: string) {
    return this.db.many(
      `SELECT id, role, content, citations, created_at FROM brain_messages
        WHERE conversation_id=$1 ORDER BY created_at`,
      [conversationId],
    );
  }

  // ── семантический кэш ответов (похожий вопрос → без вызова LLM) ──
  private vec(v: number[]): string {
    return '[' + v.join(',') + ']';
  }

  async cacheLookup(tenantId: string, vec: number[]): Promise<{ answer: string; citations: any; score: number } | null> {
    const r = await this.db.one<{ answer: string; citations: any; score: number }>(
      `SELECT answer, citations, 1 - (embedding <=> $2::vector) AS score
         FROM ai_answer_cache WHERE tenant_id=$1
        ORDER BY embedding <=> $2::vector LIMIT 1`,
      [tenantId, this.vec(vec)],
    );
    return r ? { answer: r.answer, citations: r.citations, score: Number(r.score) } : null;
  }

  async cacheStore(tenantId: string, question: string, vec: number[], answer: string, citations: unknown) {
    await this.db.query(
      `INSERT INTO ai_answer_cache (tenant_id, question, answer, citations, embedding)
       VALUES ($1,$2,$3,$4,$5::vector)`,
      [tenantId, question, answer, citations ? JSON.stringify(citations) : null, this.vec(vec)],
    );
  }
}
