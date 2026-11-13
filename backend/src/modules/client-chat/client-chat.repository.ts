import { Injectable } from '@nestjs/common';
import { DbService } from '../../database/db.service';
import { projectVisibleSql, ProjectViewer, viewerParams } from '../../common/access/project-visibility';
import { RawMessage, TaskRow } from './client-chat-rules';

export interface StaffChatRow {
  id: string; kind: string; title: string | null; is_external: boolean; created_by: string | null;
  project_id: string | null; linked_project_id: string | null; client_id: string | null;
  is_member: boolean; chat_role: string | null;
}

export interface LinkRow {
  id: string; tenant_id: string; chat_id: string; label: string | null; room_id: string;
  meet_link_id: string | null; meet_token_enc: string | null; created_by: string | null;
  created_at: Date; expires_at: Date; revoked_at: Date | null; uses: number; last_used_at: Date | null;
}

export interface SessionRow {
  id: string; tenant_id: string; link_id: string; chat_id: string; gid: string; name: string;
  expires_at: Date; revoked_at: Date | null;
  link_revoked_at: Date | null; link_expires_at: Date; chat_external: boolean | null;
  chat_title: string | null; org_name: string;
}

/** Те же поля сообщения, по которым решают правила, — и ничего сверх. */
const MESSAGE_COLUMNS = `
  m.id::text, m.chat_id::text, m.author_id::text, u.full_name AS author_name, m.guest_name, m.body,
  m.created_at, m.edited_at, m.deleted_at, m.thread_root_id::text, m.also_in_channel, m.is_ai,
  m.meeting_id::text, m.proposal_id::text, m.forwarded_chat_id::text, f.file_name,
  (SELECT COUNT(*)::int FROM chat_message_files mf WHERE mf.message_id = m.id) AS files_count`;

/**
 * Условие «сообщение видно гостю» на стороне базы. То же правило проверяется ещё раз
 * в коде (`guestCanSee`) — два рубежа одного правила, а не два разных правила.
 */
const GUEST_VISIBLE_SQL = `
  m.deleted_at IS NULL
  AND (m.thread_root_id IS NULL OR m.also_in_channel)
  AND COALESCE(m.is_ai, FALSE) = FALSE
  AND m.meeting_id IS NULL AND m.proposal_id IS NULL
  AND (m.forwarded_chat_id IS NULL OR m.forwarded_chat_id = m.chat_id)`;

@Injectable()
export class ClientChatRepository {
  constructor(private readonly db: DbService) {}

  // ───── сотрудник ─────

  staffChat(tenantId: string, chatId: string, userId: string): Promise<StaffChatRow | null> {
    if (!/^\d+$/.test(String(chatId))) return Promise.resolve(null);
    return this.db.one<StaffChatRow>(
      `SELECT c.id::text, c.kind, c.title, COALESCE(c.is_external, FALSE) AS is_external, c.created_by::text,
              c.project_id::text, c.linked_project_id::text, c.client_id::text,
              (cm.user_id IS NOT NULL) AS is_member, cm.role AS chat_role
         FROM chats c
    LEFT JOIN chat_members cm ON cm.chat_id = c.id AND cm.user_id = $3::bigint
        WHERE c.tenant_id = $1 AND c.id = $2::bigint`,
      [tenantId, chatId, userId],
    );
  }

  createLink(i: { tenantId: string; chatId: string; tokenHash: string; label: string | null; roomId: string; createdBy: string; expiresAt: Date }): Promise<LinkRow | null> {
    return this.db.one<LinkRow>(
      `INSERT INTO client_chat_links (tenant_id, chat_id, token_hash, label, room_id, created_by, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id::text, tenant_id::text, chat_id::text, label, room_id, meet_link_id::text,
         meet_token_enc, created_by::text, created_at, expires_at, revoked_at, uses, last_used_at`,
      [i.tenantId, i.chatId, i.tokenHash, i.label, i.roomId, i.createdBy, i.expiresAt],
    );
  }

  /** Живые ссылки чата — с автором и тем, сколько раз входили. */
  links(tenantId: string, chatId: string) {
    return this.db.many<LinkRow & { author: string | null; guests: number }>(
      `SELECT l.id::text, l.label, l.created_by::text, l.created_at, l.expires_at, l.uses, l.last_used_at, u.full_name AS author,
              (SELECT COUNT(*)::int FROM client_chat_sessions s WHERE s.link_id = l.id AND s.revoked_at IS NULL) AS guests
         FROM client_chat_links l LEFT JOIN users u ON u.id = l.created_by
        WHERE l.tenant_id = $1 AND l.chat_id = $2 AND l.revoked_at IS NULL AND l.expires_at > now()
        ORDER BY l.created_at DESC`,
      [tenantId, chatId],
    );
  }

  link(tenantId: string, id: string): Promise<LinkRow | null> {
    if (!/^\d+$/.test(String(id))) return Promise.resolve(null);
    return this.db.one<LinkRow>(
      `SELECT id::text, tenant_id::text, chat_id::text, label, room_id, meet_link_id::text, meet_token_enc,
              created_by::text, created_at, expires_at, revoked_at, uses, last_used_at
         FROM client_chat_links WHERE tenant_id = $1 AND id = $2::bigint`,
      [tenantId, id],
    );
  }

  /** Отзыв: ссылка и все её сессии — одним шагом. */
  async revokeLink(tenantId: string, id: string, by: string): Promise<void> {
    await this.db.withTransaction(async (c) => {
      await c.query(`UPDATE client_chat_links SET revoked_at = now(), revoked_by = $3 WHERE tenant_id = $1 AND id = $2 AND revoked_at IS NULL`, [tenantId, id, by]);
      await c.query(`UPDATE client_chat_sessions SET revoked_at = now() WHERE tenant_id = $1 AND link_id = $2 AND revoked_at IS NULL`, [tenantId, id]);
    });
  }

  setMeet(linkId: string, meetLinkId: string, tokenEnc: string): Promise<unknown> {
    return this.db.query(`UPDATE client_chat_links SET meet_link_id = $2, meet_token_enc = $3 WHERE id = $1`, [linkId, meetLinkId, tokenEnc]);
  }

  /** Гостевая ссылка созвона ещё действует и хватит её надолго. */
  async meetLinkAlive(meetLinkId: string, minLeftMs: number): Promise<boolean> {
    const r = await this.db.one<{ ok: boolean }>(
      `SELECT (revoked_at IS NULL AND expires_at > now() + make_interval(secs => $2::int)) AS ok FROM meet_guest_links WHERE id = $1`,
      [meetLinkId, Math.round(minLeftMs / 1000)],
    );
    return !!r?.ok;
  }

  // ───── гость ─────

  linkByHash(hash: string) {
    return this.db.one<LinkRow & { chat_external: boolean | null; chat_title: string | null; org_name: string }>(
      `SELECT l.id::text, l.tenant_id::text, l.chat_id::text, l.label, l.room_id, l.meet_link_id::text, l.meet_token_enc,
              l.created_by::text, l.created_at, l.expires_at, l.revoked_at, l.uses, l.last_used_at,
              c.is_external AS chat_external, c.title AS chat_title, t.name AS org_name
         FROM client_chat_links l JOIN chats c ON c.id = l.chat_id JOIN tenants t ON t.id = l.tenant_id
        WHERE l.token_hash = $1`,
      [hash],
    );
  }

  async createSession(i: { tenantId: string; linkId: string; chatId: string; hash: string; gid: string; name: string; email: string | null; expiresAt: Date }): Promise<void> {
    await this.db.query(
      `INSERT INTO client_chat_sessions (tenant_id, link_id, chat_id, session_hash, gid, name, email, expires_at)
       VALUES ($1,$2,$3,$4,$5::uuid,$6,$7,$8)`,
      [i.tenantId, i.linkId, i.chatId, i.hash, i.gid, i.name, i.email, i.expiresAt],
    );
    await this.db.query(`UPDATE client_chat_links SET uses = uses + 1, last_used_at = now() WHERE id = $1`, [i.linkId]);
  }

  sessionByHash(hash: string): Promise<SessionRow | null> {
    return this.db.one<SessionRow>(
      `SELECT s.id::text, s.tenant_id::text, s.link_id::text, s.chat_id::text, s.gid::text, s.name, s.expires_at, s.revoked_at,
              l.revoked_at AS link_revoked_at, l.expires_at AS link_expires_at,
              c.is_external AS chat_external, c.title AS chat_title, t.name AS org_name
         FROM client_chat_sessions s
         JOIN client_chat_links l ON l.id = s.link_id
         JOIN chats c ON c.id = s.chat_id AND c.tenant_id = s.tenant_id
         JOIN tenants t ON t.id = s.tenant_id
        WHERE s.session_hash = $1`,
      [hash],
    );
  }

  touchSession(id: string): Promise<unknown> {
    return this.db.query(`UPDATE client_chat_sessions SET last_seen_at = now() WHERE id = $1 AND (last_seen_at IS NULL OR last_seen_at < now() - interval '1 minute')`, [id]);
  }

  /** Лента гостя: только этот чат и только то, что видно по правилу. */
  guestMessages(tenantId: string, chatId: string, afterId: string | null, limit: number): Promise<RawMessage[]> {
    return this.db.many<RawMessage>(
      `SELECT * FROM (
         SELECT ${MESSAGE_COLUMNS}
           FROM chat_messages m
      LEFT JOIN users u ON u.id = m.author_id
      LEFT JOIN files f ON f.id = m.file_id
          WHERE m.tenant_id = $1 AND m.chat_id = $2::bigint AND ${GUEST_VISIBLE_SQL}
            AND ($3::bigint IS NULL OR m.id > $3::bigint)
          ORDER BY m.id DESC LIMIT $4
       ) x ORDER BY x.id::bigint ASC`,
      [tenantId, chatId, afterId, limit],
    );
  }

  /** Открытые клиенту задачи этого чата — с типом этапа для статуса. */
  openedTasks(tenantId: string, chatId: string): Promise<(TaskRow & { project_id: string })[]> {
    return this.db.many(
      `SELECT t.id::text, t.title, bc.stage_type, t.closed_at, t.deadline_at, t.deleted_at, t.project_id::text
         FROM client_chat_tasks ct
         JOIN tasks t ON t.id = ct.task_id AND t.tenant_id = ct.tenant_id
         JOIN board_columns bc ON bc.id = t.column_id
        WHERE ct.tenant_id = $1 AND ct.chat_id = $2::bigint AND t.deleted_at IS NULL
        ORDER BY (t.closed_at IS NOT NULL), t.deadline_at NULLS LAST, t.id`,
      [tenantId, chatId],
    );
  }

  async openTask(tenantId: string, chatId: string, taskId: string, by: string): Promise<void> {
    await this.db.query(
      `INSERT INTO client_chat_tasks (tenant_id, chat_id, task_id, opened_by) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
      [tenantId, chatId, taskId, by],
    );
  }

  async closeTask(tenantId: string, chatId: string, taskId: string): Promise<boolean> {
    const r = await this.db.query(`DELETE FROM client_chat_tasks WHERE tenant_id = $1 AND chat_id = $2 AND task_id = $3`, [tenantId, chatId, taskId]);
    return (r.rowCount ?? 0) > 0;
  }

  /** Задача, которую видит сотрудник (та же видимость, что везде: проект, исполнитель, участник). */
  visibleTask(tenantId: string, taskId: string, viewer: ProjectViewer) {
    if (!/^\d+$/.test(String(taskId))) return Promise.resolve(null);
    return this.db.one<{ id: string; title: string }>(
      `SELECT t.id::text, t.title FROM tasks t
        WHERE t.tenant_id = $1 AND t.id = $2::bigint AND t.deleted_at IS NULL
          AND (${projectVisibleSql('t.project_id', { user: '$3', all: '$4', client: '$5' })}
               OR t.assignee_id = $3::bigint OR t.created_by = $3::bigint
               OR EXISTS (SELECT 1 FROM task_participants tp WHERE tp.task_id = t.id AND tp.user_id = $3::bigint))`,
      [tenantId, taskId, ...viewerParams(viewer)],
    );
  }

  /**
   * Что можно открыть клиенту: задачи этого чата, проекта чата и проектов его клиента —
   * только видимые самому сотруднику. С `q` — поиск по названию или номеру.
   */
  candidates(tenantId: string, chat: StaffChatRow, viewer: ProjectViewer, q: string | null) {
    const query = (q ?? '').trim().slice(0, 80);
    const byId = /^#?\d+$/.test(query) ? query.replace('#', '') : null;
    return this.db.many<TaskRow & { project_name: string | null }>(
      `SELECT t.id::text, t.title, bc.stage_type, t.closed_at, t.deadline_at, p.name AS project_name
         FROM tasks t
         JOIN board_columns bc ON bc.id = t.column_id
         JOIN projects p ON p.id = t.project_id
        WHERE t.tenant_id = $1 AND t.deleted_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM client_chat_tasks ct WHERE ct.chat_id = $6::bigint AND ct.task_id = t.id)
          AND (${projectVisibleSql('t.project_id', { user: '$2', all: '$3', client: '$4' })}
               OR t.assignee_id = $2::bigint OR t.created_by = $2::bigint)
          AND (
            $5::text <> '' AND ($7::bigint IS NOT NULL AND t.id = $7::bigint OR t.title ILIKE '%' || $5 || '%')
            OR $5::text = '' AND (
              EXISTS (SELECT 1 FROM conversation_links cl WHERE cl.chat_id = $6::bigint AND cl.entity_type = 'task' AND cl.entity_id = t.id)
              OR t.project_id = COALESCE($8::bigint, $9::bigint)
              OR ($10::bigint IS NOT NULL AND p.client_id = $10::bigint)
            )
          )
        ORDER BY (t.closed_at IS NOT NULL), t.updated_at DESC
        LIMIT 40`,
      [tenantId, ...viewerParams(viewer), query, chat.id, byId, chat.project_id, chat.linked_project_id, chat.client_id],
    );
  }

  /** Задачи проекта чата — для подсказки, если клиенту ещё ничего не открыли. */
  projectTasks(tenantId: string, projectId: string, viewer: ProjectViewer): Promise<TaskRow[]> {
    return this.db.many<TaskRow>(
      `SELECT t.id::text, t.title, bc.stage_type, t.closed_at, t.deadline_at
         FROM tasks t JOIN board_columns bc ON bc.id = t.column_id
        WHERE t.tenant_id = $1 AND t.project_id = $2::bigint AND t.deleted_at IS NULL
          AND ${projectVisibleSql('t.project_id', { user: '$3', all: '$4', client: '$5' })}
        LIMIT 500`,
      [tenantId, projectId, ...viewerParams(viewer)],
    );
  }

  /** Последний вопрос клиента в чате — на него и отвечаем. */
  lastGuestMessage(tenantId: string, chatId: string): Promise<{ body: string; guest_name: string } | null> {
    return this.db.one(
      `SELECT body, guest_name FROM chat_messages
        WHERE tenant_id = $1 AND chat_id = $2::bigint AND guest_name IS NOT NULL AND deleted_at IS NULL
        ORDER BY id DESC LIMIT 1`,
      [tenantId, chatId],
    );
  }

  timezone(userId: string): Promise<{ tz: string | null } | null> {
    return this.db.one(`SELECT timezone AS tz FROM users WHERE id = $1`, [userId]);
  }
}
