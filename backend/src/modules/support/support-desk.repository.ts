import { Injectable } from '@nestjs/common';
import { DbService } from '../../database/db.service';

export interface ConversationRow {
  id: string;
  tenant_id: string;
  user_id: string;
  status: string;
  priority: string;
  assigned_agent_id: string | null;
  subject: string;
  ai_session_id: string | null;
  first_response_at: Date | null;
  resolved_at: Date | null;
  closed_at: Date | null;
  csat_score: number | null;
  csat_reason: string | null;
  reopens: number;
  created_at: Date;
  updated_at: Date;
}

export interface MessageRow {
  id: string;
  conversation_id: string;
  author_id: string | null;
  author_kind: string;
  body: string;
  file_id: string | null;
  file_name: string | null;
  content_type: string | null;
  size_bytes: string | null;
  author_name: string | null;
  created_at: Date;
  edited_at: Date | null;
}

/** Технический контекст обращения — ровно то, что видно на экране (ТЗ-8, разд. 15). */
export interface ContextInput {
  url?: string | null;
  route?: string | null;
  entityType?: string | null;
  entityId?: string | null;
  browser?: string | null;
  os?: string | null;
  appVersion?: string | null;
  buildId?: string | null;
  lastError?: string | null;
  requestId?: string | null;
  network?: string | null;
}

/**
 * Хранилище службы заботы.
 *
 * Разговор, его участники, сообщения, безопасный технический контекст и дежурные.
 * Всё, что можно было взять у уже работающих частей CRM (файлы, присутствие,
 * уведомления, ИИ), здесь не повторяется — см. specs/tz8-01-support.md.
 */
@Injectable()
export class SupportDeskRepository {
  constructor(private readonly db: DbService) {}

  // ── разговоры ──
  /**
   * Живой разговор человека.
   *
   * Он всегда один: открыть поддержку второй раз, пока первая проблема не закрыта, —
   * это то же обращение, а не новое. Иначе у специалиста два окна об одном и том же.
   */
  activeOf(tenantId: string, userId: string): Promise<ConversationRow | null> {
    return this.db.one<ConversationRow>(
      `SELECT * FROM support_conversations
        WHERE tenant_id=$1 AND user_id=$2 AND closed_at IS NULL
        ORDER BY created_at DESC LIMIT 1`,
      [tenantId, userId],
    );
  }

  byId(tenantId: string, id: string): Promise<ConversationRow | null> {
    return this.db.one<ConversationRow>(
      `SELECT * FROM support_conversations WHERE tenant_id=$1 AND id=$2`, [tenantId, id],
    );
  }

  create(tenantId: string, userId: string, subject: string): Promise<ConversationRow | null> {
    return this.db.one<ConversationRow>(
      `INSERT INTO support_conversations (tenant_id, user_id, subject, status)
       VALUES ($1,$2,$3,'new') RETURNING *`,
      [tenantId, userId, subject.slice(0, 200)],
    );
  }

  /** Мои прошлые разговоры — история «Моя поддержка» (разд. 22). */
  mine(tenantId: string, userId: string, limit = 30) {
    return this.db.many<ConversationRow & { agent_name: string | null; messages: number }>(
      `SELECT c.*, u.full_name AS agent_name,
              (SELECT COUNT(*)::int FROM support_messages m WHERE m.conversation_id = c.id) AS messages
         FROM support_conversations c
         LEFT JOIN users u ON u.id = c.assigned_agent_id
        WHERE c.tenant_id=$1 AND c.user_id=$2
        ORDER BY c.created_at DESC LIMIT $3`,
      [tenantId, userId, limit],
    );
  }

  /** Очередь дежурного: кто ждёт и с чем. */
  queue(tenantId: string) {
    return this.db.many<ConversationRow & { user_name: string; agent_name: string | null; last_at: Date | null }>(
      `SELECT c.*, u.full_name AS user_name, a.full_name AS agent_name,
              (SELECT MAX(m.created_at) FROM support_messages m WHERE m.conversation_id = c.id) AS last_at
         FROM support_conversations c
         JOIN users u ON u.id = c.user_id
         LEFT JOIN users a ON a.id = c.assigned_agent_id
        WHERE c.tenant_id=$1 AND c.closed_at IS NULL AND c.status <> 'ai'
        ORDER BY (c.status = 'waiting_agent') DESC, c.priority = 'critical' DESC, c.created_at`,
      [tenantId],
    );
  }

  setStatus(tenantId: string, id: string, status: string): Promise<ConversationRow | null> {
    return this.db.one<ConversationRow>(
      `UPDATE support_conversations SET status=$3, updated_at=now()
        WHERE tenant_id=$1 AND id=$2 RETURNING *`,
      [tenantId, id, status],
    );
  }

  assign(tenantId: string, id: string, agentId: string): Promise<ConversationRow | null> {
    return this.db.one<ConversationRow>(
      `UPDATE support_conversations
          SET assigned_agent_id=$3, status='in_progress', updated_at=now()
        WHERE tenant_id=$1 AND id=$2 RETURNING *`,
      [tenantId, id, agentId],
    );
  }

  /** Первый ответ фиксируем один раз: это и есть измеряемая величина SLA. */
  async markFirstResponse(tenantId: string, id: string): Promise<void> {
    await this.db.query(
      `UPDATE support_conversations SET first_response_at = COALESCE(first_response_at, now())
        WHERE tenant_id=$1 AND id=$2`,
      [tenantId, id],
    );
  }

  resolve(tenantId: string, id: string): Promise<ConversationRow | null> {
    return this.db.one<ConversationRow>(
      `UPDATE support_conversations
          SET status='waiting_user', resolved_at=now(), updated_at=now()
        WHERE tenant_id=$1 AND id=$2 RETURNING *`,
      [tenantId, id],
    );
  }

  close(tenantId: string, id: string, score: number | null, reason: string | null): Promise<ConversationRow | null> {
    return this.db.one<ConversationRow>(
      `UPDATE support_conversations
          SET status='closed', closed_at=now(), csat_score=$3, csat_reason=$4, updated_at=now()
        WHERE tenant_id=$1 AND id=$2 RETURNING *`,
      [tenantId, id, score, reason],
    );
  }

  /** «Проблема снова появилась» (разд. 23): разговор оживает, счётчик растёт. */
  reopen(tenantId: string, id: string): Promise<ConversationRow | null> {
    return this.db.one<ConversationRow>(
      `UPDATE support_conversations
          SET status = CASE WHEN assigned_agent_id IS NULL THEN 'waiting_agent' ELSE 'in_progress' END,
              resolved_at = NULL, closed_at = NULL, reopens = reopens + 1, updated_at = now()
        WHERE tenant_id=$1 AND id=$2 RETURNING *`,
      [tenantId, id],
    );
  }

  async setAiSession(id: string, sessionId: string): Promise<void> {
    await this.db.query(`UPDATE support_conversations SET ai_session_id=$2 WHERE id=$1`, [id, sessionId]);
  }

  // ── сообщения ──
  addMessage(i: {
    tenantId: string; conversationId: string; authorId: string | null; kind: string;
    body: string; fileId?: string | null;
  }): Promise<MessageRow | null> {
    return this.db.one<MessageRow>(
      `INSERT INTO support_messages (tenant_id, conversation_id, author_id, author_kind, body, file_id)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [i.tenantId, i.conversationId, i.authorId, i.kind, i.body.slice(0, 8000), i.fileId ?? null],
    );
  }

  messages(conversationId: string) {
    return this.db.many<MessageRow>(
      `SELECT m.*, u.full_name AS author_name,
              f.file_name, f.content_type, f.size_bytes::text
         FROM support_messages m
         LEFT JOIN users u ON u.id = m.author_id
         LEFT JOIN files f ON f.id = m.file_id
        WHERE m.conversation_id=$1
        ORDER BY m.created_at`,
      [conversationId],
    );
  }

  // ── участники ──
  async addParticipant(conversationId: string, userId: string, role: string): Promise<void> {
    await this.db.query(
      `INSERT INTO support_participants (conversation_id, user_id, role)
       VALUES ($1,$2,$3) ON CONFLICT (conversation_id, user_id) DO UPDATE SET left_at = NULL`,
      [conversationId, userId, role],
    );
  }

  participants(conversationId: string) {
    return this.db.many<{ user_id: string; role: string; full_name: string; joined_at: Date }>(
      `SELECT p.user_id::text, p.role, u.full_name, p.joined_at
         FROM support_participants p JOIN users u ON u.id = p.user_id
        WHERE p.conversation_id=$1 AND p.left_at IS NULL
        ORDER BY p.joined_at`,
      [conversationId],
    );
  }

  // ── контекст ──
  /**
   * Технический контекст.
   *
   * Пишем по одному разговору, перезаписывая: важно, где человек был в МОМЕНТ
   * обращения, а не вся его прогулка по системе.
   */
  async saveContext(conversationId: string, c: ContextInput): Promise<void> {
    await this.db.query(
      `INSERT INTO support_context
         (conversation_id, url, route, entity_type, entity_id, browser, os, app_version, build_id,
          last_error, request_id, network, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, now())
       ON CONFLICT (conversation_id) DO UPDATE SET
         url=EXCLUDED.url, route=EXCLUDED.route, entity_type=EXCLUDED.entity_type,
         entity_id=EXCLUDED.entity_id, browser=EXCLUDED.browser, os=EXCLUDED.os,
         app_version=EXCLUDED.app_version, build_id=EXCLUDED.build_id,
         last_error=EXCLUDED.last_error, request_id=EXCLUDED.request_id,
         network=EXCLUDED.network, updated_at=now()`,
      [
        conversationId, c.url ?? null, c.route ?? null, c.entityType ?? null, c.entityId ?? null,
        c.browser ?? null, c.os ?? null, c.appVersion ?? null, c.buildId ?? null,
        c.lastError ?? null, c.requestId ?? null, c.network ?? null,
      ],
    );
  }

  context(conversationId: string) {
    return this.db.one<Record<string, unknown>>(
      `SELECT * FROM support_context WHERE conversation_id=$1`, [conversationId],
    );
  }

  // ── дежурные ──
  agents(tenantId: string) {
    return this.db.many<{ user_id: string; full_name: string; skills: string[]; last_seen_at: Date | null; presence_status: string | null }>(
      `SELECT a.user_id::text, u.full_name, a.skills, u.last_seen_at, u.presence_status
         FROM support_agents a JOIN users u ON u.id = a.user_id
        WHERE a.tenant_id=$1 AND a.active AND u.is_active
        ORDER BY u.full_name`,
      [tenantId],
    );
  }

  async setAgent(tenantId: string, userId: string, active: boolean, skills: string[]): Promise<void> {
    await this.db.query(
      `INSERT INTO support_agents (tenant_id, user_id, active, skills)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (tenant_id, user_id) DO UPDATE SET active=EXCLUDED.active, skills=EXCLUDED.skills`,
      [tenantId, userId, active, skills],
    );
  }

  /** Владелец компании — дежурный по умолчанию, пока список пуст. */
  owner(tenantId: string) {
    return this.db.one<{ id: string; full_name: string }>(
      `SELECT u.id::text, u.full_name FROM users u
         JOIN roles r ON r.id = u.role_id
        WHERE u.tenant_id=$1 AND r.code='owner' AND u.is_active
        ORDER BY u.id LIMIT 1`,
      [tenantId],
    );
  }

  /**
   * Честное время первого ответа (разд. 6).
   *
   * Медиана за две недели: среднее задирает один ночной разговор, а обещать по нему
   * нельзя — человек ждёт «двадцать секунд» и злится на третьей минуте.
   */
  async medianFirstResponse(tenantId: string): Promise<number | null> {
    const row = await this.db.one<{ sec: string | null }>(
      `SELECT percentile_cont(0.5) WITHIN GROUP (
                ORDER BY EXTRACT(EPOCH FROM (first_response_at - created_at))
              )::text AS sec
         FROM support_conversations
        WHERE tenant_id=$1 AND first_response_at IS NOT NULL
          AND created_at > now() - interval '14 days'`,
      [tenantId],
    );
    const sec = Number(row?.sec ?? NaN);
    return Number.isFinite(sec) && sec > 0 ? Math.round(sec) : null;
  }
}
