import { Injectable } from '@nestjs/common';
import { DbService } from '../../database/db.service';

export interface ChatRow {
  id: string; tenant_id: string; kind: string; title: string | null;
  project_id: string | null; dm_key: string | null; created_by: string | null;
  created_at: Date; last_message_at: Date | null;
}

export interface ChatListItem extends ChatRow {
  peer_id: string | null;        // собеседник в личном диалоге
  peer_name: string | null;
  project_name: string | null;
  unread: number;
  last_body: string | null;
  last_author: string | null;
  last_at: Date | null;
}

export interface MessageRow {
  id: string; chat_id: string; author_id: string | null; author_name: string | null;
  body: string; file_id: string | null; file_name: string | null; content_type: string | null;
  size_bytes: string | null; created_at: Date; edited_at: Date | null;
}

@Injectable()
export class ChatsRepository {
  constructor(private readonly db: DbService) {}

  /** Ключ диалога: пара id по возрастанию — один диалог на двоих, кто бы его ни начал. */
  static dmKey(a: string, b: string): string {
    return [a, b].map(Number).sort((x, y) => x - y).join(':');
  }

  /**
   * Список чатов человека: личные и групповые, где он участник, плюс ВСЕ чаты проектов
   * (доступ к проектам в CRM общий для команды, отдельного членства не заводим).
   * Непрочитанное считается от last_read_at; нет строки участия — считаем всё непрочитанным.
   */
  listForUser(tenantId: string, userId: string): Promise<ChatListItem[]> {
    return this.db.many<ChatListItem>(
      `WITH mine AS (
         SELECT c.* FROM chats c
          WHERE c.tenant_id = $1
            AND (c.kind = 'project' OR EXISTS (
                  SELECT 1 FROM chat_members m WHERE m.chat_id = c.id AND m.user_id = $2))
       )
       SELECT mine.*,
              peer.id   AS peer_id,
              peer.full_name AS peer_name,
              p.name    AS project_name,
              (SELECT count(*)::int FROM chat_messages msg
                WHERE msg.chat_id = mine.id AND msg.deleted_at IS NULL
                  AND msg.author_id <> $2
                  AND (me.last_read_at IS NULL OR msg.created_at > me.last_read_at)) AS unread,
              last.body AS last_body,
              lu.full_name AS last_author,
              last.created_at AS last_at
         FROM mine
         LEFT JOIN chat_members me ON me.chat_id = mine.id AND me.user_id = $2
         LEFT JOIN projects p ON p.id = mine.project_id
         LEFT JOIN LATERAL (
              SELECT m2.user_id FROM chat_members m2
               WHERE m2.chat_id = mine.id AND m2.user_id <> $2 AND mine.kind = 'dm' LIMIT 1
         ) other ON TRUE
         LEFT JOIN users peer ON peer.id = other.user_id
         LEFT JOIN LATERAL (
              SELECT body, created_at, author_id FROM chat_messages
               WHERE chat_id = mine.id AND deleted_at IS NULL
               ORDER BY id DESC LIMIT 1
         ) last ON TRUE
         LEFT JOIN users lu ON lu.id = last.author_id
        ORDER BY COALESCE(mine.last_message_at, mine.created_at) DESC
        LIMIT 200`,
      [tenantId, userId],
    );
  }

  get(tenantId: string, chatId: string): Promise<ChatRow | null> {
    return this.db.one<ChatRow>(`SELECT * FROM chats WHERE tenant_id=$1 AND id=$2`, [tenantId, chatId]);
  }

  isMember(chatId: string, userId: string) {
    return this.db.one(`SELECT 1 AS ok FROM chat_members WHERE chat_id=$1 AND user_id=$2`, [chatId, userId]);
  }

  memberIds(chatId: string): Promise<string[]> {
    return this.db.many<{ user_id: string }>(`SELECT user_id FROM chat_members WHERE chat_id=$1`, [chatId])
      .then((rows) => rows.map((r) => String(r.user_id)));
  }

  /** Все сотрудники организации — адресаты событий в чате проекта. */
  teamIds(tenantId: string): Promise<string[]> {
    return this.db.many<{ id: string }>(
      `SELECT id FROM users WHERE tenant_id=$1 AND is_active AND role_id <> (SELECT id FROM roles WHERE code='client')`,
      [tenantId],
    ).then((rows) => rows.map((r) => String(r.id)));
  }

  async findDm(tenantId: string, key: string): Promise<ChatRow | null> {
    return this.db.one<ChatRow>(`SELECT * FROM chats WHERE tenant_id=$1 AND dm_key=$2`, [tenantId, key]);
  }

  async createDm(tenantId: string, a: string, b: string): Promise<ChatRow> {
    return this.db.withTransaction(async (c) => {
      const key = ChatsRepository.dmKey(a, b);
      const existing = await c.query<ChatRow>(`SELECT * FROM chats WHERE tenant_id=$1 AND dm_key=$2`, [tenantId, key]);
      if (existing.rows[0]) return existing.rows[0];
      const row = (await c.query<ChatRow>(
        `INSERT INTO chats (tenant_id, kind, dm_key, created_by) VALUES ($1,'dm',$2,$3) RETURNING *`,
        [tenantId, key, a],
      )).rows[0];
      for (const uid of [a, b]) {
        await c.query(`INSERT INTO chat_members (chat_id, user_id, tenant_id) VALUES ($1,$2,$3)
                       ON CONFLICT DO NOTHING`, [row.id, uid, tenantId]);
      }
      return row;
    });
  }

  async createGroup(tenantId: string, createdBy: string, title: string, userIds: string[]): Promise<ChatRow> {
    return this.db.withTransaction(async (c) => {
      const row = (await c.query<ChatRow>(
        `INSERT INTO chats (tenant_id, kind, title, created_by) VALUES ($1,'group',$2,$3) RETURNING *`,
        [tenantId, title, createdBy],
      )).rows[0];
      for (const uid of new Set([createdBy, ...userIds])) {
        await c.query(`INSERT INTO chat_members (chat_id, user_id, tenant_id) VALUES ($1,$2,$3)
                       ON CONFLICT DO NOTHING`, [row.id, uid, tenantId]);
      }
      return row;
    });
  }

  /** Чат проекта заводится при первом обращении, а не для всех проектов сразу. */
  async ensureProjectChat(tenantId: string, projectId: string): Promise<ChatRow> {
    const existing = await this.db.one<ChatRow>(`SELECT * FROM chats WHERE project_id=$1`, [projectId]);
    if (existing) return existing;
    const row = await this.db.one<ChatRow>(
      `INSERT INTO chats (tenant_id, kind, project_id) VALUES ($1,'project',$2)
       ON CONFLICT (project_id) WHERE project_id IS NOT NULL DO NOTHING RETURNING *`,
      [tenantId, projectId],
    );
    return row ?? (await this.db.one<ChatRow>(`SELECT * FROM chats WHERE project_id=$1`, [projectId]))!;
  }

  /** Лента чата: страница «до» указанного id, чтобы подгружать историю вверх. */
  messages(tenantId: string, chatId: string, beforeId: string | null, limit: number): Promise<MessageRow[]> {
    return this.db.many<MessageRow>(
      `SELECT m.id, m.chat_id, m.author_id, u.full_name AS author_name, m.body, m.file_id,
              f.file_name, f.content_type, f.size_bytes::text, m.created_at, m.edited_at
         FROM chat_messages m
         LEFT JOIN users u ON u.id = m.author_id
         LEFT JOIN files f ON f.id = m.file_id
        WHERE m.tenant_id=$1 AND m.chat_id=$2 AND m.deleted_at IS NULL
          AND ($3::bigint IS NULL OR m.id < $3::bigint)
        ORDER BY m.id DESC LIMIT $4`,
      [tenantId, chatId, beforeId, limit],
    ).then((rows) => rows.reverse()); // наружу отдаём по возрастанию: так рисует лента
  }

  async addMessage(i: { tenantId: string; chatId: string; authorId: string; body: string; fileId: string | null }): Promise<MessageRow> {
    const row = await this.db.one<{ id: string }>(
      `INSERT INTO chat_messages (tenant_id, chat_id, author_id, body, file_id) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [i.tenantId, i.chatId, i.authorId, i.body, i.fileId],
    );
    await this.db.query(`UPDATE chats SET last_message_at=now() WHERE id=$1`, [i.chatId]);
    const full = await this.db.one<MessageRow>(
      `SELECT m.id, m.chat_id, m.author_id, u.full_name AS author_name, m.body, m.file_id,
              f.file_name, f.content_type, f.size_bytes::text, m.created_at, m.edited_at
         FROM chat_messages m
         LEFT JOIN users u ON u.id = m.author_id
         LEFT JOIN files f ON f.id = m.file_id
        WHERE m.id=$1`,
      [row!.id],
    );
    return full!;
  }

  /** Отметка прочтения. Для чатов проектов строка участия создаётся здесь же. */
  async markRead(tenantId: string, chatId: string, userId: string): Promise<void> {
    await this.db.query(
      `INSERT INTO chat_members (chat_id, user_id, tenant_id, last_read_at) VALUES ($1,$2,$3, now())
       ON CONFLICT (chat_id, user_id) DO UPDATE SET last_read_at = now()`,
      [chatId, userId, tenantId],
    );
  }

  message(tenantId: string, id: string) {
    return this.db.one<{ id: string; chat_id: string; author_id: string | null }>(
      `SELECT id, chat_id, author_id FROM chat_messages WHERE tenant_id=$1 AND id=$2`, [tenantId, id]);
  }

  async softDelete(id: string): Promise<void> {
    await this.db.query(`UPDATE chat_messages SET deleted_at=now(), body='' WHERE id=$1`, [id]);
  }
}
