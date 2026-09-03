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
  peer_avatar: string | null;
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
  /** Ответ в ветке: у корневых сообщений пусто. */
  thread_root_id?: string | null;
  /** Сколько ответов в ветке этого сообщения и когда был последний. */
  reply_count?: number;
  last_reply_at?: Date | null;
}

/** Строка раздела «Треды»: ветка, в которой человек участвует. */
export interface ThreadRow {
  root_id: string;
  chat_id: string;
  chat_kind: string;
  chat_title: string | null;
  project_name: string | null;
  root_body: string;
  root_author: string | null;
  reply_count: number;
  last_reply_at: Date | null;
  unread: number;
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
              peer.avatar_file_id AS peer_avatar,
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

  /**
   * Лента чата: страница «до» указанного id, чтобы подгружать историю вверх.
   *
   * Ответы из веток сюда НЕ попадают — ради этого треды и заводились: основная лента
   * остаётся читаемой. Исключение — сообщения, которые автор попросил продублировать
   * в канал («Также отправить в основной чат»).
   */
  messages(tenantId: string, chatId: string, beforeId: string | null, limit: number): Promise<MessageRow[]> {
    return this.db.many<MessageRow>(
      `SELECT m.id, m.chat_id, m.author_id, u.full_name AS author_name, m.body, m.file_id,
              f.file_name, f.content_type, f.size_bytes::text, m.created_at, m.edited_at,
              m.thread_root_id, m.reply_count, m.last_reply_at
         FROM chat_messages m
         LEFT JOIN users u ON u.id = m.author_id
         LEFT JOIN files f ON f.id = m.file_id
        WHERE m.tenant_id=$1 AND m.chat_id=$2 AND m.deleted_at IS NULL
          AND (m.thread_root_id IS NULL OR m.also_in_channel)
          AND ($3::bigint IS NULL OR m.id < $3::bigint)
        ORDER BY m.id DESC LIMIT $4`,
      [tenantId, chatId, beforeId, limit],
    ).then((rows) => rows.reverse()); // наружу отдаём по возрастанию: так рисует лента
  }

  /** Ветка целиком: корневое сообщение и ответы по возрастанию. */
  thread(tenantId: string, rootId: string): Promise<MessageRow[]> {
    return this.db.many<MessageRow>(
      `SELECT m.id, m.chat_id, m.author_id, u.full_name AS author_name, m.body, m.file_id,
              f.file_name, f.content_type, f.size_bytes::text, m.created_at, m.edited_at,
              m.thread_root_id, m.reply_count, m.last_reply_at
         FROM chat_messages m
         LEFT JOIN users u ON u.id = m.author_id
         LEFT JOIN files f ON f.id = m.file_id
        WHERE m.tenant_id=$1 AND m.deleted_at IS NULL
          AND (m.id = $2::bigint OR m.thread_root_id = $2::bigint)
        ORDER BY m.id`,
      [tenantId, rootId],
    );
  }

  /**
   * Мои ветки: где я начал разговор или отвечал.
   *
   * Показывать все ветки всех чатов бессмысленно — их тысячи. Человеку нужны те,
   * к которым он причастен, и в первую очередь те, где после его последнего прочтения
   * появились ЧУЖИЕ ответы: свои же реплики новостью не являются.
   */
  myThreads(tenantId: string, userId: string, limit = 50): Promise<ThreadRow[]> {
    return this.db.many<ThreadRow>(
      `SELECT r.id AS root_id, r.chat_id, c.kind AS chat_kind, c.title AS chat_title,
              p.name AS project_name, r.body AS root_body, u.full_name AS root_author,
              r.reply_count, r.last_reply_at,
              (SELECT COUNT(*)::int FROM chat_messages x
                WHERE x.thread_root_id = r.id AND x.deleted_at IS NULL
                  AND x.author_id IS DISTINCT FROM $2::bigint
                  AND (tr.last_read_at IS NULL OR x.created_at > tr.last_read_at)) AS unread
         FROM chat_messages r
         JOIN chats c ON c.id = r.chat_id
    LEFT JOIN projects p ON p.id = c.project_id
    LEFT JOIN users u ON u.id = r.author_id
    LEFT JOIN chat_thread_reads tr ON tr.root_id = r.id AND tr.user_id = $2::bigint
        WHERE r.tenant_id = $1 AND r.deleted_at IS NULL
          AND r.thread_root_id IS NULL AND r.reply_count > 0
          AND (r.author_id = $2::bigint
               OR EXISTS (SELECT 1 FROM chat_messages y
                           WHERE y.thread_root_id = r.id AND y.author_id = $2::bigint))
        ORDER BY r.last_reply_at DESC NULLS LAST
        LIMIT $3`,
      [tenantId, userId, limit],
    );
  }

  /** Ветку открыли — ответы в ней больше не новые. */
  async markThreadRead(tenantId: string, rootId: string, userId: string): Promise<void> {
    await this.db.query(
      `INSERT INTO chat_thread_reads (root_id, user_id, tenant_id, last_read_at)
            VALUES ($1,$2,$3, now())
       ON CONFLICT (root_id, user_id) DO UPDATE SET last_read_at = now()`,
      [rootId, userId, tenantId],
    );
  }

  /** Сообщение по id: нужно, чтобы проверить, что отвечают в том же чате. */
  findMessage(tenantId: string, id: string) {
    return this.db.one<{ id: string; chat_id: string; thread_root_id: string | null }>(
      `SELECT id, chat_id, thread_root_id FROM chat_messages WHERE tenant_id=$1 AND id=$2 AND deleted_at IS NULL`,
      [tenantId, id],
    );
  }

  async addMessage(i: {
    tenantId: string; chatId: string; authorId: string; body: string; fileId: string | null;
    threadRootId?: string | null; alsoInChannel?: boolean;
  }): Promise<MessageRow> {
    const row = await this.db.one<{ id: string }>(
      `INSERT INTO chat_messages (tenant_id, chat_id, author_id, body, file_id, thread_root_id, also_in_channel)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [i.tenantId, i.chatId, i.authorId, i.body, i.fileId, i.threadRootId ?? null, i.alsoInChannel === true],
    );
    await this.db.query(`UPDATE chats SET last_message_at=now() WHERE id=$1`, [i.chatId]);
    // Счётчик ответов держим на корне: считать его подзапросом на каждое сообщение
    // ленты — тысячи подсчётов ради строчки «7 ответов».
    if (i.threadRootId) {
      await this.db.query(
        `UPDATE chat_messages SET reply_count = reply_count + 1, last_reply_at = now() WHERE id=$1`,
        [i.threadRootId],
      );
    }
    const full = await this.db.one<MessageRow>(
      `SELECT m.id, m.chat_id, m.author_id, u.full_name AS author_name, m.body, m.file_id,
              f.file_name, f.content_type, f.size_bytes::text, m.created_at, m.edited_at,
              m.thread_root_id, m.reply_count, m.last_reply_at
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

  /** Состав группы с именами — для окна управления участниками. */
  members(tenantId: string, chatId: string) {
    return this.db.many<{ user_id: string; full_name: string; avatar_file_id: string | null; joined_at: Date }>(
      `SELECT m.user_id, u.full_name, u.avatar_file_id, m.joined_at
         FROM chat_members m JOIN users u ON u.id = m.user_id
        WHERE m.tenant_id=$1 AND m.chat_id=$2 ORDER BY m.joined_at`,
      [tenantId, chatId],
    );
  }

  async addMembers(tenantId: string, chatId: string, userIds: string[]): Promise<string[]> {
    const added: string[] = [];
    for (const userId of new Set(userIds.map(String))) {
      // сотрудник должен быть из этой же организации — иначе можно втащить чужого по id
      const ok = await this.db.one(`SELECT 1 AS ok FROM users WHERE id=$1 AND tenant_id=$2 AND is_active`, [userId, tenantId]);
      if (!ok) continue;
      const res = await this.db.query(
        `INSERT INTO chat_members (chat_id, user_id, tenant_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
        [chatId, userId, tenantId],
      );
      if (res.rowCount) added.push(userId);
    }
    return added;
  }

  async removeMember(chatId: string, userId: string): Promise<boolean> {
    const res = await this.db.query(`DELETE FROM chat_members WHERE chat_id=$1 AND user_id=$2`, [chatId, userId]);
    return (res.rowCount ?? 0) > 0;
  }

  async rename(tenantId: string, chatId: string, title: string): Promise<void> {
    await this.db.query(`UPDATE chats SET title=$3 WHERE tenant_id=$1 AND id=$2`, [tenantId, chatId, title]);
  }

  /**
   * Служебная запись в ленту («добавлен», «вышел», «переименована»).
   * author_id = NULL — по нему интерфейс отличает системную строку от реплики человека.
   */
  async addSystemMessage(tenantId: string, chatId: string, body: string): Promise<MessageRow> {
    const row = await this.db.one<{ id: string }>(
      `INSERT INTO chat_messages (tenant_id, chat_id, author_id, body) VALUES ($1,$2,NULL,$3) RETURNING id`,
      [tenantId, chatId, body],
    );
    await this.db.query(`UPDATE chats SET last_message_at=now() WHERE id=$1`, [chatId]);
    return (await this.db.one<MessageRow>(
      `SELECT id, chat_id, author_id, NULL::varchar AS author_name, body, file_id,
              NULL::varchar AS file_name, NULL::varchar AS content_type, NULL::text AS size_bytes,
              created_at, edited_at
         FROM chat_messages WHERE id=$1`,
      [row!.id],
    ))!;
  }

  message(tenantId: string, id: string) {
    return this.db.one<{ id: string; chat_id: string; author_id: string | null }>(
      `SELECT id, chat_id, author_id FROM chat_messages WHERE tenant_id=$1 AND id=$2`, [tenantId, id]);
  }

  async softDelete(id: string): Promise<void> {
    await this.db.query(`UPDATE chat_messages SET deleted_at=now(), body='' WHERE id=$1`, [id]);
  }
}
