import { Injectable } from '@nestjs/common';
import { DbService } from '../../database/db.service';

export interface ChatRow {
  id: string; tenant_id: string; kind: string; title: string | null;
  is_private?: boolean; description?: string | null;
  /** В чате есть человек со стороны: всё сказанное здесь увидит он. */
  is_external?: boolean;
  client_id?: string | null;
  project_id: string | null; dm_key: string | null; created_by: string | null;
  created_at: Date; last_message_at: Date | null;
}

export interface ChatListItem extends ChatRow {
  /** Закреплён сверху лично этим человеком. */
  favorite: boolean;
  peer_id: string | null;        // собеседник в личном диалоге
  peer_name: string | null;
  peer_avatar: string | null;
  peer_last_seen: Date | null;
  peer_status: string | null;
  project_name: string | null;
  unread: number;
  /** Помечен непрочитанным вручную — как в Telegram; снимается открытием чата. */
  marked_unread: boolean;
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
  /** Реакции: [{emoji, count, mine}] — сводка, а не список нажавших. */
  reactions?: { emoji: string; count: number; mine: boolean }[];
  pinned_at?: Date | null;
  /** Итог созвона: сообщение разворачивается в карточку со сводкой. */
  meeting_id?: string | null;
  /** Ответ помощника: помечен, чтобы его не спутали со словами коллеги. */
  is_ai?: boolean;
  /** Имя внешнего собеседника: у гостя нет строки в users. */
  guest_name?: string | null;
  /** Задача, заведённая по этому сообщению: чтобы вторую не завели. */
  task_id?: string | null;
  task_title?: string | null;
  /** Проект задачи: без него ссылка «Задача #N» вела в список проектов, а не в саму задачу. */
  task_project_id?: string | null;
  /** Сколько собеседников уже прочитали это сообщение и сколько их всего. */
  read_by?: number;
  others?: number;
  /** Все вложения сообщения: первое дублируется в `file_id` ради старого кода. */
  files?: { fileId: string; name: string; mime: string; size: number }[];
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
              (fav.chat_id IS NOT NULL) AS favorite,
              peer.id   AS peer_id,
              peer.full_name AS peer_name,
              peer.avatar_file_id AS peer_avatar,
              -- присутствие собеседника: «был 12 минут назад», «занят» — для Chat Bar
              peer.last_seen_at AS peer_last_seen,
              peer.presence_status AS peer_status,
              p.name    AS project_name,
              -- Непрочитанное — тоже про ленту чата: ответы в ветках считаются
              -- отдельно, в разделе «Треды», и их цифра не должна висеть на чате,
              -- где открыть их нечем.
              (SELECT count(*)::int FROM chat_messages msg
                WHERE msg.chat_id = mine.id AND msg.deleted_at IS NULL
                  AND msg.author_id <> $2
                  AND (msg.thread_root_id IS NULL OR msg.also_in_channel)
                  AND (me.last_read_at IS NULL OR msg.created_at > me.last_read_at)) AS unread,
              COALESCE(me.marked_unread, false) AS marked_unread,
              last.body AS last_body,
              lu.full_name AS last_author,
              last.created_at AS last_at
         FROM mine
         LEFT JOIN chat_members me ON me.chat_id = mine.id AND me.user_id = $2
         LEFT JOIN chat_favorites fav ON fav.chat_id = mine.id AND fav.user_id = $2
         LEFT JOIN projects p ON p.id = mine.project_id
         LEFT JOIN LATERAL (
              SELECT m2.user_id FROM chat_members m2
               WHERE m2.chat_id = mine.id AND m2.user_id <> $2 AND mine.kind = 'dm' LIMIT 1
         ) other ON TRUE
         LEFT JOIN users peer ON peer.id = other.user_id
         LEFT JOIN LATERAL (
              /*
                Последнее сообщение — из тех, что ВИДНЫ в самом чате.

                Ответы из веток в общую ленту не попадают (ради этого треды и
                заводились), а в списке они показывались: человек читал в превью
                «Юрий: что-то слышно про З…», открывал чат — и не находил этой
                строки. Условие здесь то же, что и в выборке сообщений.
              */
              SELECT body, created_at, author_id FROM chat_messages
               WHERE chat_id = mine.id AND deleted_at IS NULL
                 AND (thread_root_id IS NULL OR also_in_channel)
               ORDER BY id DESC LIMIT 1
         ) last ON TRUE
         LEFT JOIN users lu ON lu.id = last.author_id
        -- избранное всегда сверху: ради этого его и отмечают
        ORDER BY (fav.chat_id IS NOT NULL) DESC, COALESCE(mine.last_message_at, mine.created_at) DESC
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
        // создатель — владелец: с него начинается порядок в чате
        await c.query(`INSERT INTO chat_members (chat_id, user_id, tenant_id, role) VALUES ($1,$2,$3,$4)
                       ON CONFLICT DO NOTHING`, [row.id, uid, tenantId, String(uid) === String(createdBy) ? 'owner' : 'member']);
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
  messages(tenantId: string, chatId: string, beforeId: string | null, limit: number, viewerId: string): Promise<MessageRow[]> {
    return this.db.many<MessageRow>(
      `SELECT m.id, m.chat_id, m.author_id, u.full_name AS author_name, m.body, m.file_id,
              f.file_name, f.content_type, f.size_bytes::text, m.created_at, m.edited_at,
              m.thread_root_id, m.reply_count, m.last_reply_at, m.pinned_at,
              m.task_id, t.title AS task_title, t.project_id AS task_project_id, m.meeting_id, m.is_ai, m.guest_name,
              -- Две галочки, как в мессенджерах: сколько СОБЕСЕДНИКОВ уже открывали
              -- чат после этого сообщения и сколько их всего. Считаем от отметки
              -- «был здесь» (last_read_at) — отдельной таблицы прочтений на каждое
              -- сообщение ради галочки заводить незачем.
              (SELECT COUNT(*)::int FROM chat_members cm
                WHERE cm.chat_id = m.chat_id AND cm.user_id <> m.author_id
                  AND cm.last_read_at IS NOT NULL AND cm.last_read_at >= m.created_at) AS read_by,
              (SELECT COUNT(*)::int FROM chat_members cm2
                WHERE cm2.chat_id = m.chat_id AND cm2.user_id <> m.author_id) AS others,
              -- Все вложения сообщения: в мессенджерах несколько снимков — это ОДНО
              -- сообщение, а не три подряд.
              COALESCE((
                SELECT json_agg(json_build_object(
                         'fileId', mf.file_id::text, 'name', ff.file_name,
                         'mime', ff.content_type, 'size', ff.size_bytes) ORDER BY mf.position, mf.file_id)
                  FROM chat_message_files mf JOIN files ff ON ff.id = mf.file_id
                 WHERE mf.message_id = m.id
              ), '[]'::json) AS files,
              COALESCE((
                SELECT json_agg(json_build_object('emoji', x.emoji, 'count', x.n, 'mine', x.mine))
                  FROM (
                    SELECT emoji, COUNT(*)::int AS n, BOOL_OR(user_id = $5::bigint) AS mine
                      FROM chat_message_reactions
                     WHERE message_id = m.id
                     GROUP BY emoji
                  ) x
              ), '[]'::json) AS reactions,
              1
         FROM chat_messages m
         LEFT JOIN users u ON u.id = m.author_id
         LEFT JOIN files f ON f.id = m.file_id
         LEFT JOIN tasks t ON t.id = m.task_id
        WHERE m.tenant_id=$1 AND m.chat_id=$2 AND m.deleted_at IS NULL
          AND (m.thread_root_id IS NULL OR m.also_in_channel)
          AND ($3::bigint IS NULL OR m.id < $3::bigint)
        ORDER BY m.id DESC LIMIT $4`,
      [tenantId, chatId, beforeId, limit, viewerId],
    ).then((rows) => rows.reverse()); // наружу отдаём по возрастанию: так рисует лента
  }

  /** Ветка целиком: корневое сообщение и ответы по возрастанию. */
  thread(tenantId: string, rootId: string, viewerId: string): Promise<MessageRow[]> {
    return this.db.many<MessageRow>(
      `SELECT m.id, m.chat_id, m.author_id, u.full_name AS author_name, m.body, m.file_id,
              f.file_name, f.content_type, f.size_bytes::text, m.created_at, m.edited_at,
              m.thread_root_id, m.reply_count, m.last_reply_at, m.pinned_at,
              m.task_id, t.title AS task_title, t.project_id AS task_project_id, m.meeting_id, m.is_ai, m.guest_name,
              -- Две галочки, как в мессенджерах: сколько СОБЕСЕДНИКОВ уже открывали
              -- чат после этого сообщения и сколько их всего. Считаем от отметки
              -- «был здесь» (last_read_at) — отдельной таблицы прочтений на каждое
              -- сообщение ради галочки заводить незачем.
              (SELECT COUNT(*)::int FROM chat_members cm
                WHERE cm.chat_id = m.chat_id AND cm.user_id <> m.author_id
                  AND cm.last_read_at IS NOT NULL AND cm.last_read_at >= m.created_at) AS read_by,
              (SELECT COUNT(*)::int FROM chat_members cm2
                WHERE cm2.chat_id = m.chat_id AND cm2.user_id <> m.author_id) AS others,
              -- Все вложения сообщения: в мессенджерах несколько снимков — это ОДНО
              -- сообщение, а не три подряд.
              COALESCE((
                SELECT json_agg(json_build_object(
                         'fileId', mf.file_id::text, 'name', ff.file_name,
                         'mime', ff.content_type, 'size', ff.size_bytes) ORDER BY mf.position, mf.file_id)
                  FROM chat_message_files mf JOIN files ff ON ff.id = mf.file_id
                 WHERE mf.message_id = m.id
              ), '[]'::json) AS files,
              COALESCE((
                SELECT json_agg(json_build_object('emoji', x.emoji, 'count', x.n, 'mine', x.mine))
                  FROM (
                    SELECT emoji, COUNT(*)::int AS n, BOOL_OR(user_id = $3::bigint) AS mine
                      FROM chat_message_reactions
                     WHERE message_id = m.id
                     GROUP BY emoji
                  ) x
              ), '[]'::json) AS reactions,
              1
         FROM chat_messages m
         LEFT JOIN users u ON u.id = m.author_id
         LEFT JOIN files f ON f.id = m.file_id
         LEFT JOIN tasks t ON t.id = m.task_id
        WHERE m.tenant_id=$1 AND m.deleted_at IS NULL
          AND (m.id = $2::bigint OR m.thread_root_id = $2::bigint)
        ORDER BY m.id`,
      [tenantId, rootId, viewerId],
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
          AND (
            -- Ветки, к которым я причастен: начал сам или отвечал в них.
            r.author_id = $2::bigint
            OR EXISTS (SELECT 1 FROM chat_messages y
                        WHERE y.thread_root_id = r.id AND y.author_id = $2::bigint)
            /*
              ...и СВЕЖИЕ ветки моих чатов, даже если я в них ещё не писал.

              Раньше сюда попадали только «мои» ветки, и разговор, начатый коллегами
              под чужим сообщением, не появлялся вовсе — со стороны это выглядело как
              «треды работают не всегда». Показывать все ветки всех чатов по-прежнему
              нельзя (их тысячи), поэтому берём только последние две недели и только
              там, где я состою: это ровно то, что человек ещё может догнать.
            */
            OR (
              r.last_reply_at > now() - interval '14 days'
              AND (c.kind = 'project' OR EXISTS (
                    SELECT 1 FROM chat_members cm WHERE cm.chat_id = c.id AND cm.user_id = $2::bigint))
            )
          )
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
    return this.db.one<{ id: string; chat_id: string; thread_root_id: string | null; author_id: string | null }>(
      `SELECT id, chat_id, thread_root_id, author_id FROM chat_messages WHERE tenant_id=$1 AND id=$2 AND deleted_at IS NULL`,
      [tenantId, id],
    );
  }

  async addMessage(i: {
    tenantId: string; chatId: string; authorId: string; body: string; fileId: string | null;
    /** Остальные файлы сообщения: в `fileId` лежит первый — на него завязан старый код. */
    fileIds?: string[];
    threadRootId?: string | null; alsoInChannel?: boolean;
    /** Ответ помощника: в ленте он помечен, чтобы его не спутали со словами коллеги. */
    isAi?: boolean;
  }): Promise<MessageRow> {
    const row = await this.db.one<{ id: string }>(
      `INSERT INTO chat_messages (tenant_id, chat_id, author_id, body, file_id, thread_root_id, also_in_channel, is_ai)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [
        i.tenantId, i.chatId, i.authorId, i.body, i.fileId,
        i.threadRootId ?? null, i.alsoInChannel === true, i.isAi === true,
      ],
    );
    // Все вложения сообщения — отдельной таблицей, с сохранением порядка.
    const files = i.fileIds?.length ? i.fileIds : (i.fileId ? [i.fileId] : []);
    if (files.length) {
      await this.db.query(
        `INSERT INTO chat_message_files (message_id, file_id, tenant_id, position)
              SELECT $1, x.id, $2, x.pos
                FROM unnest($3::bigint[]) WITH ORDINALITY AS x(id, pos)
         ON CONFLICT DO NOTHING`,
        [row!.id, i.tenantId, files],
      );
    }
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

  /**
   * Реакция-переключатель: повторное нажатие снимает свою.
   *
   * Тем же способом, что и в чате задачи: две разные механики на одно и то же
   * действие разошлись бы на первой правке.
   */
  async toggleReaction(tenantId: string, messageId: string, userId: string, emoji: string): Promise<void> {
    const del = await this.db.query(
      `DELETE FROM chat_message_reactions WHERE message_id=$1 AND user_id=$2 AND emoji=$3`,
      [messageId, userId, emoji],
    );
    if ((del as { rowCount?: number })?.rowCount) return;
    await this.db.query(
      `INSERT INTO chat_message_reactions (message_id, user_id, tenant_id, emoji) VALUES ($1,$2,$3,$4)
       ON CONFLICT DO NOTHING`,
      [messageId, userId, tenantId, emoji],
    );
  }

  /** Закрепить или открепить. Кто закрепил — видно в списке закреплённого. */
  async setPinned(tenantId: string, messageId: string, userId: string, pinned: boolean): Promise<void> {
    await this.db.query(
      `UPDATE chat_messages SET pinned_at = $3, pinned_by = $4 WHERE tenant_id=$1 AND id=$2`,
      [tenantId, messageId, pinned ? new Date() : null, pinned ? userId : null],
    );
  }

  /** Закреплённое чата — свежее сверху. */
  pinned(tenantId: string, chatId: string): Promise<MessageRow[]> {
    return this.db.many<MessageRow>(
      `SELECT m.id, m.chat_id, m.author_id, u.full_name AS author_name, m.body, m.file_id,
              f.file_name, f.content_type, f.size_bytes::text, m.created_at, m.edited_at,
              m.thread_root_id, m.reply_count, m.last_reply_at, m.pinned_at
         FROM chat_messages m
         LEFT JOIN users u ON u.id = m.author_id
         LEFT JOIN files f ON f.id = m.file_id
        WHERE m.tenant_id=$1 AND m.chat_id=$2 AND m.deleted_at IS NULL AND m.pinned_at IS NOT NULL
        ORDER BY m.pinned_at DESC`,
      [tenantId, chatId],
    );
  }

  // ───── сохранённое, напоминания, упоминания (слой 2) ─────

  /** Сохранить сообщение себе или снять сохранение. Переключатель, как реакция. */
  async toggleSaved(tenantId: string, messageId: string, userId: string): Promise<boolean> {
    const del = await this.db.query(
      `DELETE FROM saved_messages WHERE message_id=$1 AND user_id=$2`, [messageId, userId],
    );
    if ((del as { rowCount?: number })?.rowCount) return false;
    await this.db.query(
      `INSERT INTO saved_messages (user_id, message_id, tenant_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
      [userId, messageId, tenantId],
    );
    return true;
  }

  /** Сохранённое человека — свежее сверху, с указанием, откуда оно. */
  savedList(tenantId: string, userId: string) {
    return this.db.many(
      `SELECT m.id, m.chat_id, m.body, m.file_id, f.file_name, m.created_at,
              u.full_name AS author_name, s.saved_at,
              c.kind AS chat_kind, c.title AS chat_title, p.name AS project_name
         FROM saved_messages s
         JOIN chat_messages m ON m.id = s.message_id AND m.deleted_at IS NULL
         JOIN chats c ON c.id = m.chat_id
    LEFT JOIN projects p ON p.id = c.project_id
    LEFT JOIN users u ON u.id = m.author_id
    LEFT JOIN files f ON f.id = m.file_id
        WHERE s.tenant_id=$1 AND s.user_id=$2
        ORDER BY s.saved_at DESC LIMIT 200`,
      [tenantId, userId],
    );
  }

  /** Какие из показанных сообщений человек сохранил — чтобы кнопка знала своё состояние. */
  savedIds(tenantId: string, userId: string, chatId: string): Promise<{ message_id: string }[]> {
    return this.db.many(
      `SELECT s.message_id FROM saved_messages s
         JOIN chat_messages m ON m.id = s.message_id
        WHERE s.tenant_id=$1 AND s.user_id=$2 AND m.chat_id=$3`,
      [tenantId, userId, chatId],
    );
  }

  /** Напоминание о сообщении. Прежнее на то же сообщение заменяем: их не копят. */
  async setReminder(tenantId: string, userId: string, messageId: string, remindAt: Date): Promise<void> {
    await this.db.query(
      `UPDATE message_reminders SET done_at = now()
        WHERE tenant_id=$1 AND user_id=$2 AND message_id=$3 AND done_at IS NULL`,
      [tenantId, userId, messageId],
    );
    await this.db.query(
      `INSERT INTO message_reminders (tenant_id, user_id, message_id, remind_at) VALUES ($1,$2,$3,$4)`,
      [tenantId, userId, messageId, remindAt],
    );
  }

  /** Что уже пора напомнить. Забираем пачкой — планировщик ходит раз в минуту. */
  dueReminders(now: Date, limit = 100) {
    return this.db.many<{
      id: string; tenant_id: string; user_id: string; message_id: string;
      chat_id: string; body: string; author_name: string | null;
    }>(
      `SELECT r.id, r.tenant_id, r.user_id, r.message_id, m.chat_id, m.body, u.full_name AS author_name
         FROM message_reminders r
         JOIN chat_messages m ON m.id = r.message_id AND m.deleted_at IS NULL
    LEFT JOIN users u ON u.id = m.author_id
        WHERE r.done_at IS NULL AND r.remind_at <= $1
        ORDER BY r.remind_at LIMIT $2`,
      [now, limit],
    );
  }

  async closeReminders(ids: string[]): Promise<void> {
    if (!ids.length) return;
    await this.db.query(`UPDATE message_reminders SET done_at = now() WHERE id = ANY($1::bigint[])`, [ids]);
  }

  /** Упоминания: список приходит от подсказки, здесь только запись. */
  async addMentions(tenantId: string, messageId: string, userIds: string[]): Promise<void> {
    if (!userIds.length) return;
    await this.db.query(
      `INSERT INTO chat_mentions (message_id, user_id, tenant_id)
       SELECT $1, x, $3 FROM UNNEST($2::bigint[]) AS x
       ON CONFLICT DO NOTHING`,
      [messageId, userIds, tenantId],
    );
  }

  /**
   * Поиск по всей переписке — как в мессенджерах.
   *
   * Ищем только там, куда человеку можно: личные и групповые чаты, где он участник,
   * плюс чаты проектов (доступ к проектам в CRM общий). Без этого условия поиск стал
   * бы дырой в приватность личных диалогов.
   *
   * ILIKE, а не полнотекстовый индекс: у поиска по переписке две особенности —
   * ищут обрывок («смет», «пиликалка») и ищут редко. Полнотекстовый словарь такие
   * куски не находит вовсе, а стоимость ILIKE на десятках тысяч строк ещё незаметна.
   * Когда станет заметной, здесь появится trigram-индекс, и запрос не изменится.
   */
  searchMessages(tenantId: string, userId: string, query: string, limit = 40) {
    return this.db.many<{
      id: string; chat_id: string; body: string; created_at: Date;
      author_id: string | null; author_name: string | null;
      thread_root_id: string | null;
      chat_kind: string; chat_title: string | null;
      project_name: string | null; peer_name: string | null;
    }>(
      `SELECT m.id, m.chat_id, m.body, m.created_at, m.author_id, u.full_name AS author_name,
              m.thread_root_id, c.kind AS chat_kind, c.title AS chat_title,
              p.name AS project_name, peer.full_name AS peer_name
         FROM chat_messages m
         JOIN chats c ON c.id = m.chat_id
    LEFT JOIN users u ON u.id = m.author_id
    LEFT JOIN projects p ON p.id = c.project_id
    LEFT JOIN LATERAL (
           SELECT pu.full_name FROM chat_members cm
             JOIN users pu ON pu.id = cm.user_id
            WHERE cm.chat_id = c.id AND cm.user_id <> $2 AND c.kind = 'dm' LIMIT 1
         ) peer ON TRUE
        WHERE m.tenant_id = $1 AND m.deleted_at IS NULL
          AND m.body ILIKE $3
          AND (c.kind = 'project' OR EXISTS (
                SELECT 1 FROM chat_members mm WHERE mm.chat_id = c.id AND mm.user_id = $2))
        ORDER BY m.id DESC
        LIMIT $4`,
      [tenantId, userId, `%${query}%`, limit],
    );
  }

  /**
   * Окно сообщений ВОКРУГ найденного.
   *
   * По ссылке из поиска человек должен увидеть сообщение в разговоре, а не в
   * пустоте: без соседних реплик непонятно, о чём вообще речь. Берём то же, что
   * показывает лента (ответы из веток в неё не попадают), и по полсотни с каждой
   * стороны.
   */
  messagesAround(tenantId: string, chatId: string, messageId: string, viewerId: string): Promise<MessageRow[]> {
    return this.db.many<MessageRow>(
      `WITH win AS (
         (SELECT id FROM chat_messages
           WHERE tenant_id=$1 AND chat_id=$2 AND deleted_at IS NULL
             AND (thread_root_id IS NULL OR also_in_channel) AND id <= $3::bigint
           ORDER BY id DESC LIMIT 50)
         UNION
         (SELECT id FROM chat_messages
           WHERE tenant_id=$1 AND chat_id=$2 AND deleted_at IS NULL
             AND (thread_root_id IS NULL OR also_in_channel) AND id > $3::bigint
           ORDER BY id LIMIT 20)
       )
       SELECT m.id, m.chat_id, m.author_id, u.full_name AS author_name, m.body, m.file_id,
              f.file_name, f.content_type, f.size_bytes::text, m.created_at, m.edited_at,
              m.thread_root_id, m.reply_count, m.last_reply_at, m.pinned_at,
              m.task_id, t.title AS task_title, t.project_id AS task_project_id,
              m.meeting_id, m.is_ai, m.guest_name,
              (SELECT COUNT(*)::int FROM chat_members cm
                WHERE cm.chat_id = m.chat_id AND cm.user_id <> m.author_id
                  AND cm.last_read_at IS NOT NULL AND cm.last_read_at >= m.created_at) AS read_by,
              (SELECT COUNT(*)::int FROM chat_members cm2
                WHERE cm2.chat_id = m.chat_id AND cm2.user_id <> m.author_id) AS others,
              -- Все вложения сообщения: в мессенджерах несколько снимков — это ОДНО
              -- сообщение, а не три подряд.
              COALESCE((
                SELECT json_agg(json_build_object(
                         'fileId', mf.file_id::text, 'name', ff.file_name,
                         'mime', ff.content_type, 'size', ff.size_bytes) ORDER BY mf.position, mf.file_id)
                  FROM chat_message_files mf JOIN files ff ON ff.id = mf.file_id
                 WHERE mf.message_id = m.id
              ), '[]'::json) AS files,
              COALESCE((
                SELECT json_agg(json_build_object('emoji', x.emoji, 'count', x.n, 'mine', x.mine))
                  FROM (
                    SELECT emoji, COUNT(*)::int AS n, BOOL_OR(user_id = $4::bigint) AS mine
                      FROM chat_message_reactions
                     WHERE message_id = m.id
                     GROUP BY emoji
                  ) x
              ), '[]'::json) AS reactions,
              1
         FROM chat_messages m
         JOIN win ON win.id = m.id
    LEFT JOIN users u ON u.id = m.author_id
    LEFT JOIN files f ON f.id = m.file_id
    LEFT JOIN tasks t ON t.id = m.task_id
        ORDER BY m.id`,
      [tenantId, chatId, messageId, viewerId],
    );
  }

  /** Кого позвали по имени в конкретном сообщении. */
  messageMentions(tenantId: string, messageId: string): Promise<{ user_id: string }[]> {
    return this.db.many<{ user_id: string }>(
      `SELECT user_id::text FROM chat_mentions WHERE tenant_id=$1 AND message_id=$2 ORDER BY user_id`,
      [tenantId, messageId],
    );
  }

  /** Собеседник в личной переписке: тот из двоих, кто НЕ писал это сообщение. */
  dmPeer(tenantId: string, chatId: string, authorId: string): Promise<{ user_id: string } | null> {
    return this.db.one<{ user_id: string }>(
      `SELECT user_id::text FROM chat_members
        WHERE tenant_id=$1 AND chat_id=$2 AND user_id <> $3::bigint
        LIMIT 1`,
      [tenantId, chatId, authorId],
    );
  }

  /** Сотрудники этой компании из присланных id: чужие и выдуманные отсеиваются. */
  tenantUserIds(tenantId: string, ids: string[]): Promise<{ id: string }[]> {
    return this.db.many<{ id: string }>(
      `SELECT id::text FROM users WHERE tenant_id=$1 AND id = ANY($2::bigint[])`,
      [tenantId, ids],
    );
  }

  /** Где меня звали по имени. Непрочитанные — сверху, они и есть повод открыть раздел. */
  mentionsList(tenantId: string, userId: string, limit = 50) {
    return this.db.many(
      `SELECT m.id, m.chat_id, m.body, m.created_at, u.full_name AS author_name,
              n.seen_at, c.kind AS chat_kind, c.title AS chat_title, p.name AS project_name
         FROM chat_mentions n
         JOIN chat_messages m ON m.id = n.message_id AND m.deleted_at IS NULL
         JOIN chats c ON c.id = m.chat_id
    LEFT JOIN projects p ON p.id = c.project_id
    LEFT JOIN users u ON u.id = m.author_id
        WHERE n.tenant_id=$1 AND n.user_id=$2
        ORDER BY (n.seen_at IS NULL) DESC, m.created_at DESC
        LIMIT $3`,
      [tenantId, userId, limit],
    );
  }

  async markMentionsSeen(tenantId: string, userId: string): Promise<void> {
    await this.db.query(
      `UPDATE chat_mentions SET seen_at = now() WHERE tenant_id=$1 AND user_id=$2 AND seen_at IS NULL`,
      [tenantId, userId],
    );
  }

  async unseenMentions(tenantId: string, userId: string): Promise<number> {
    const row = await this.db.one<{ n: string }>(
      `SELECT COUNT(*) AS n FROM chat_mentions WHERE tenant_id=$1 AND user_id=$2 AND seen_at IS NULL`,
      [tenantId, userId],
    );
    return Number(row?.n ?? 0);
  }

  // ───── каналы, избранное, чат с собой (слой 4) ─────

  /**
   * Внешний чат: разговор с человеком со стороны.
   *
   * Отдельный чат, а не режим существующего: «клиент опять поменял требования» должно
   * быть сказано во внутреннем чате проекта и не может уехать клиенту, потому что это
   * разные разговоры, а не один с фильтром видимости.
   */
  async createExternal(i: {
    tenantId: string; userId: string; title: string; clientId: string | null; userIds: string[];
  }): Promise<ChatRow> {
    return this.db.withTransaction(async (c) => {
      const chat = (await c.query(
        `INSERT INTO chats (tenant_id, kind, title, created_by, is_external, is_private, client_id)
         VALUES ($1,'external',$2,$3,TRUE,TRUE,$4) RETURNING *`,
        [i.tenantId, i.title, i.userId, i.clientId],
      )).rows[0] as ChatRow;
      for (const uid of Array.from(new Set([String(i.userId), ...i.userIds.map(String)]))) {
        await c.query(
          `INSERT INTO chat_members (chat_id, user_id, tenant_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
          [chat.id, uid, i.tenantId],
        );
      }
      return chat;
    });
  }

  /** Сообщение от внешнего участника: автора-пользователя у него нет, есть имя. */
  async addGuestMessage(tenantId: string, chatId: string, guestName: string, body: string): Promise<MessageRow> {
    const row = await this.db.one<{ id: string }>(
      `INSERT INTO chat_messages (tenant_id, chat_id, author_id, guest_name, body)
       VALUES ($1,$2,NULL,$3,$4) RETURNING id`,
      [tenantId, chatId, guestName.slice(0, 60), body.slice(0, 8000)],
    );
    await this.db.query(`UPDATE chats SET last_message_at=now() WHERE id=$1`, [chatId]);
    return (await this.db.one<MessageRow>(
      `SELECT m.id, m.chat_id, m.author_id, NULL::text AS author_name, m.body, m.file_id,
              NULL::text AS file_name, NULL::text AS content_type, NULL::text AS size_bytes,
              m.created_at, m.edited_at, m.thread_root_id, m.reply_count, m.last_reply_at,
              m.pinned_at, m.guest_name, m.is_ai
         FROM chat_messages m WHERE m.id=$1`,
      [row!.id],
    ))!;
  }

  /**
   * Канал: тема, которая переживёт состав участников.
   *
   * Создатель сразу становится участником — канал без единого человека внутри
   * выглядел бы чужим даже для того, кто его завёл.
   */
  async createChannel(i: {
    tenantId: string; userId: string; title: string; description: string | null;
    isPrivate: boolean; userIds: string[];
  }): Promise<ChatRow> {
    return this.db.withTransaction(async (c) => {
      const chat = (await c.query(
        `INSERT INTO chats (tenant_id, kind, title, description, is_private, created_by)
         VALUES ($1,'channel',$2,$3,$4,$5) RETURNING *`,
        [i.tenantId, i.title, i.description, i.isPrivate, i.userId],
      )).rows[0] as ChatRow;
      const ids = Array.from(new Set([String(i.userId), ...i.userIds.map(String)]));
      for (const uid of ids) {
        await c.query(
          `INSERT INTO chat_members (chat_id, user_id, tenant_id, role) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
          [chat.id, uid, i.tenantId, uid === String(i.userId) ? 'owner' : 'member'],
        );
      }
      return chat;
    });
  }

  /**
   * Витрина «Все каналы»: публичные каналы компании.
   *
   * Приватных здесь нет вовсе — не «скрыты кнопкой», а не приходят с сервера:
   * закрытый канал не должен даже упоминаться в поиске у того, кому он не открыт.
   */
  publicChannels(tenantId: string, userId: string) {
    return this.db.many<{
      id: string; title: string | null; description: string | null;
      members: number; joined: boolean; last_message_at: Date | null;
    }>(
      `SELECT c.id, c.title, c.description, c.last_message_at,
              (SELECT COUNT(*)::int FROM chat_members m WHERE m.chat_id = c.id) AS members,
              EXISTS (SELECT 1 FROM chat_members m WHERE m.chat_id = c.id AND m.user_id = $2) AS joined
         FROM chats c
        WHERE c.tenant_id = $1 AND c.kind = 'channel' AND c.is_private = FALSE
        ORDER BY c.last_message_at DESC NULLS LAST, c.id DESC
        LIMIT 200`,
      [tenantId, userId],
    );
  }

  /** Вступить в канал: строка участия и есть вступление. */
  async join(tenantId: string, chatId: string, userId: string): Promise<void> {
    await this.db.query(
      `INSERT INTO chat_members (chat_id, user_id, tenant_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
      [chatId, userId, tenantId],
    );
  }

  /** Закрепить чат сверху или снять — порядок личный, у каждого свои четыре. */
  async toggleFavorite(tenantId: string, chatId: string, userId: string): Promise<boolean> {
    const del = await this.db.query(
      `DELETE FROM chat_favorites WHERE chat_id=$1 AND user_id=$2`, [chatId, userId],
    );
    if ((del as { rowCount?: number })?.rowCount) return false;
    await this.db.query(
      `INSERT INTO chat_favorites (user_id, chat_id, tenant_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
      [userId, chatId, tenantId],
    );
    return true;
  }

  /**
   * Чат с собой — «Заметки».
   *
   * Тот же личный диалог, только собеседник — ты сам. Ключ `self:<id>` попадает
   * в тот же уникальный индекс, что и обычные диалоги, поэтому второй такой чат
   * не заведётся даже при двойном нажатии.
   */
  async ensureSelfChat(tenantId: string, userId: string): Promise<ChatRow> {
    const key = `self:${userId}`;
    const found = await this.db.one<ChatRow>(
      `SELECT * FROM chats WHERE tenant_id=$1 AND dm_key=$2`, [tenantId, key],
    );
    if (found) return found;
    return this.db.withTransaction(async (c) => {
      const chat = (await c.query(
        `INSERT INTO chats (tenant_id, kind, title, dm_key, created_by)
         VALUES ($1,'self','Заметки',$2,$3) RETURNING *`,
        [tenantId, key, userId],
      )).rows[0] as ChatRow;
      await c.query(
        `INSERT INTO chat_members (chat_id, user_id, tenant_id) VALUES ($1,$2,$3)`,
        [chat.id, userId, tenantId],
      );
      return chat;
    });
  }

  /**
   * Сообщение целиком — для создания задачи из чата.
   *
   * Кроме текста нужны автор (он становится исполнителем по умолчанию) и файл:
   * скриншот едет в задачу вложением, иначе половина постановки остаётся в чате.
   */
  messageBody(tenantId: string, id: string) {
    return this.db.one<{
      id: string; chat_id: string; body: string; task_id: string | null;
      author_id: string | null; author_name: string | null;
      file_id: string | null; file_name: string | null;
    }>(
      `SELECT m.id, m.chat_id, m.body, m.task_id, m.author_id, u.full_name AS author_name,
              m.file_id, f.file_name
         FROM chat_messages m
         LEFT JOIN users u ON u.id = m.author_id
         LEFT JOIN files f ON f.id = m.file_id
        WHERE m.tenant_id=$1 AND m.id=$2 AND m.deleted_at IS NULL`,
      [tenantId, id],
    );
  }

  /**
   * Привязать файл сообщения к задаче.
   *
   * Вставка в общую таблицу вложений напрямую: тащить сюда сервис карточки ради
   * одной строки значит связать чаты с карточкой в обе стороны. Повторный клик
   * ничего не портит — та же пара задача-файл просто не добавится второй раз.
   */
  async attachFileToTask(tenantId: string, taskId: string, fileId: string): Promise<void> {
    await this.db.query(
      `INSERT INTO task_attachments (tenant_id, task_id, file_id) VALUES ($1,$2,$3)
       ON CONFLICT (task_id, file_id) DO NOTHING`,
      [tenantId, taskId, fileId],
    );
  }

  /**
   * Правка своего сообщения.
   *
   * Помечаем `edited_at`: молча подменённый текст — худшее, что можно сделать с
   * перепиской, на которую потом ссылаются. Собеседник должен видеть, что правили.
   */
  async editMessage(tenantId: string, id: string, body: string): Promise<void> {
    await this.db.query(
      `UPDATE chat_messages SET body=$3, edited_at=now()
        WHERE tenant_id=$1 AND id=$2 AND deleted_at IS NULL`,
      [tenantId, id, body],
    );
  }

  /** Связать сообщение с задачей — в обе стороны сразу, чтобы связь не осталась однобокой. */
  async linkTask(tenantId: string, messageId: string, taskId: string): Promise<void> {
    await this.db.query(`UPDATE chat_messages SET task_id=$3 WHERE tenant_id=$1 AND id=$2`, [tenantId, messageId, taskId]);
    await this.db.query(
      `UPDATE tasks SET source_chat_message_id=$3 WHERE tenant_id=$1 AND id=$2`,
      [tenantId, taskId, messageId],
    );
  }

  /**
   * Откуда взялась задача.
   *
   * «А это вообще откуда?» через неделю после постановки — самый частый вопрос на
   * разборах. Здесь ответ: чат, автор и сама фраза.
   */
  sourceMessage(tenantId: string, taskId: string) {
    return this.db.one<{
      message_id: string; chat_id: string; body: string; created_at: Date;
      author_name: string | null; chat_kind: string; chat_title: string | null; project_name: string | null;
    }>(
      `SELECT m.id AS message_id, m.chat_id, m.body, m.created_at, u.full_name AS author_name,
              c.kind AS chat_kind, c.title AS chat_title, p.name AS project_name
         FROM tasks t
         JOIN chat_messages m ON m.id = t.source_chat_message_id AND m.deleted_at IS NULL
         JOIN chats c ON c.id = m.chat_id
    LEFT JOIN projects p ON p.id = c.project_id
    LEFT JOIN users u ON u.id = m.author_id
        WHERE t.tenant_id=$1 AND t.id=$2`,
      [tenantId, taskId],
    );
  }

  /**
   * Что за сущность стоит за чатом — для шапки.
   *
   * Открыв чат проекта, человек не должен идти в карточку проекта, чтобы понять,
   * о чём этот чат: статус, число задач и сколько из них просрочено видно сразу.
   */
  chatContext(tenantId: string, chatId: string) {
    return this.db.one<{
      project_id: string | null; project_name: string | null; status: string | null;
      open_tasks: number; overdue: number; nearest_deadline: Date | null; client_name: string | null;
    }>(
      `SELECT p.id AS project_id, p.name AS project_name, p.status,
              (SELECT COUNT(*)::int FROM tasks t WHERE t.project_id = p.id AND t.closed_at IS NULL) AS open_tasks,
              (SELECT COUNT(*)::int FROM tasks t
                WHERE t.project_id = p.id AND t.closed_at IS NULL AND t.deadline_at < now()) AS overdue,
              -- ближайший срок среди живых задач: у проекта своего дедлайна нет,
              -- а вопрос «когда ближайшее» в шапке чата задают именно так
              (SELECT MIN(t.deadline_at) FROM tasks t
                WHERE t.project_id = p.id AND t.closed_at IS NULL AND t.deadline_at >= now()) AS nearest_deadline,
              cl.name AS client_name
         FROM chats c
         JOIN projects p ON p.id = c.project_id
    LEFT JOIN clients cl ON cl.id = p.client_id
        WHERE c.tenant_id=$1 AND c.id=$2`,
      [tenantId, chatId],
    );
  }

  /**
   * Отметка прочтения. Для чатов проектов строка участия создаётся здесь же.
   * Снимает и ручную пометку «непрочитанное»: открыл чат — вернулся к нему.
   */
  async markRead(tenantId: string, chatId: string, userId: string): Promise<void> {
    await this.db.query(
      `INSERT INTO chat_members (chat_id, user_id, tenant_id, last_read_at) VALUES ($1,$2,$3, now())
       ON CONFLICT (chat_id, user_id) DO UPDATE SET last_read_at = now(), marked_unread = false`,
      [chatId, userId, tenantId],
    );
  }

  /**
   * «Пометить как непрочитанное».
   *
   * Личный флаг, а не сдвиг last_read_at назад: собеседнику его галочки
   * «прочитано» трогать нельзя — он видел, что прочитали. У чата проекта строки
   * участия может ещё не быть — заводим её с отметкой «был здесь сейчас»: без
   * этого весь чат посчитался бы непрочитанным целиком, а просили одну пометку.
   */
  /**
   * «Пометить как непрочитанное» С ЭТОГО сообщения.
   *
   * Отметка «был здесь» откатывается на миг раньше сообщения: оно и всё после
   * него снова считаются новыми, и чат показывает их число. Это честная
   * пометка, а не флаг: человек действительно ещё не дочитал отсюда — и автору
   * тоже видно, что дочитано не всё.
   */
  async markUnreadFrom(tenantId: string, chatId: string, userId: string, messageId: string): Promise<boolean> {
    const res = await this.db.query(
      `INSERT INTO chat_members (chat_id, user_id, tenant_id, last_read_at, marked_unread)
       SELECT $1, $2, $3, m.created_at - interval '1 microsecond', true
         FROM chat_messages m
        WHERE m.id = $4 AND m.chat_id = $1 AND m.tenant_id = $3 AND m.deleted_at IS NULL
       ON CONFLICT (chat_id, user_id) DO UPDATE
         SET last_read_at = EXCLUDED.last_read_at, marked_unread = true`,
      [chatId, userId, tenantId, messageId],
    );
    return (res.rowCount ?? 0) > 0;
  }

  async markUnread(tenantId: string, chatId: string, userId: string): Promise<void> {
    await this.db.query(
      `INSERT INTO chat_members (chat_id, user_id, tenant_id, last_read_at, marked_unread)
       VALUES ($1,$2,$3, now(), true)
       ON CONFLICT (chat_id, user_id) DO UPDATE SET marked_unread = true`,
      [chatId, userId, tenantId],
    );
  }

  /** Состав группы с именами — для окна управления участниками. */
  members(tenantId: string, chatId: string) {
    return this.db.many<{
      user_id: string; full_name: string; avatar_file_id: string | null; joined_at: Date;
      role: string; last_seen_at: Date | null; presence_status: string | null;
    }>(
      `SELECT m.user_id, u.full_name, u.avatar_file_id, m.joined_at, m.role,
              u.last_seen_at, u.presence_status
         FROM chat_members m JOIN users u ON u.id = m.user_id
        WHERE m.tenant_id=$1 AND m.chat_id=$2
        -- владелец первым, потом администраторы, остальные по имени
        ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 WHEN 'member' THEN 2 ELSE 3 END, u.full_name`,
      [tenantId, chatId],
    );
  }

  memberRole(chatId: string, userId: string): Promise<{ role: string } | null> {
    return this.db.one<{ role: string }>(`SELECT role FROM chat_members WHERE chat_id=$1 AND user_id=$2`, [chatId, userId]);
  }

  /** Роль участника: владелец один и не меняется — его роль здесь не трогаем. */
  async setMemberRole(chatId: string, userId: string, role: 'admin' | 'member'): Promise<boolean> {
    const res = await this.db.query(
      `UPDATE chat_members SET role=$3 WHERE chat_id=$1 AND user_id=$2 AND role <> 'owner'`,
      [chatId, userId, role],
    );
    return (res.rowCount ?? 0) > 0;
  }

  async setDescription(tenantId: string, chatId: string, description: string | null): Promise<void> {
    await this.db.query(`UPDATE chats SET description=$3 WHERE tenant_id=$1 AND id=$2`, [tenantId, chatId, description]);
  }

  /** Сведения для сайдбара: чат вместе с именами проекта и клиента. */
  info(tenantId: string, chatId: string) {
    return this.db.one<ChatRow & { project_name: string | null; client_name: string | null; created_by_name: string | null }>(
      `SELECT c.*, p.name AS project_name, cl.name AS client_name, u.full_name AS created_by_name
         FROM chats c
    LEFT JOIN projects p ON p.id = c.project_id
    LEFT JOIN clients cl ON cl.id = c.client_id
    LEFT JOIN users u ON u.id = c.created_by
        WHERE c.tenant_id=$1 AND c.id=$2`,
      [tenantId, chatId],
    );
  }

  /**
   * Материалы чата — вложения по виду.
   *
   * Вид определяется по типу файла, а не по отдельной колонке: картинки и видео —
   * медиа, звук — голосовые (клипы из чата именно так и хранятся), pdf и офисные —
   * документы, всё остальное — файлы. Одним запросом с фильтром по маске: ходить
   * в базу четыре раза ради четырёх вкладок незачем.
   */
  materials(tenantId: string, chatId: string, kind: 'media' | 'voice' | 'docs' | 'files', limit = 60, before?: string) {
    const mask: Record<string, string> = {
      media: `(f.content_type LIKE 'image/%' OR f.content_type LIKE 'video/%')`,
      voice: `f.content_type LIKE 'audio/%'`,
      docs: `(f.content_type IN ('application/pdf', 'text/plain', 'text/csv')
              OR f.content_type LIKE 'application/vnd.openxmlformats%'
              OR f.content_type LIKE 'application/msword%'
              OR f.content_type LIKE 'application/vnd.ms-%')`,
      files: `f.content_type NOT LIKE 'image/%' AND f.content_type NOT LIKE 'video/%' AND f.content_type NOT LIKE 'audio/%'`,
    };
    return this.db.many<{
      message_id: string; file_id: string; file_name: string; content_type: string; size_bytes: string;
      created_at: Date; author_name: string | null;
    }>(
      `SELECT mf.message_id, f.id AS file_id, f.file_name, f.content_type, f.size_bytes::text, m.created_at,
              u.full_name AS author_name
         FROM chat_message_files mf
         JOIN chat_messages m ON m.id = mf.message_id AND m.deleted_at IS NULL
         JOIN files f ON f.id = mf.file_id
    LEFT JOIN users u ON u.id = m.author_id
        WHERE m.tenant_id=$1 AND m.chat_id=$2 AND ${mask[kind]}
          AND ($4::bigint IS NULL OR mf.message_id < $4::bigint)
        ORDER BY mf.message_id DESC, mf.position
        LIMIT $3`,
      [tenantId, chatId, limit, before ?? null],
    );
  }

  /** Сообщения со ссылками: сами адреса вынимает сервис — в SQL это нечитаемо. */
  linkMessages(tenantId: string, chatId: string, limit = 200) {
    return this.db.many<{ id: string; body: string; created_at: Date; author_name: string | null }>(
      `SELECT m.id, m.body, m.created_at, u.full_name AS author_name
         FROM chat_messages m LEFT JOIN users u ON u.id = m.author_id
        WHERE m.tenant_id=$1 AND m.chat_id=$2 AND m.deleted_at IS NULL
          AND (m.body ~* 'https?://' OR m.body ~* 'www\.')
        ORDER BY m.id DESC LIMIT $3`,
      [tenantId, chatId, limit],
    );
  }

  /** Сколько чего в чате — цифры на вкладках сайдбара, чтобы пустые не открывать. */
  materialCounts(tenantId: string, chatId: string) {
    return this.db.one<{ media: string; voice: string; docs: string; files: string; links: string; pinned: string }>(
      `SELECT
         COUNT(*) FILTER (WHERE f.content_type LIKE 'image/%' OR f.content_type LIKE 'video/%') AS media,
         COUNT(*) FILTER (WHERE f.content_type LIKE 'audio/%') AS voice,
         COUNT(*) FILTER (WHERE f.content_type IN ('application/pdf','text/plain','text/csv')
                           OR f.content_type LIKE 'application/vnd.openxmlformats%'
                           OR f.content_type LIKE 'application/msword%'
                           OR f.content_type LIKE 'application/vnd.ms-%') AS docs,
         COUNT(*) FILTER (WHERE f.content_type NOT LIKE 'image/%' AND f.content_type NOT LIKE 'video/%'
                           AND f.content_type NOT LIKE 'audio/%') AS files,
         (SELECT COUNT(*) FROM chat_messages x WHERE x.chat_id=$2 AND x.deleted_at IS NULL
            AND (x.body ~* 'https?://' OR x.body ~* 'www\.')) AS links,
         (SELECT COUNT(*) FROM chat_messages x WHERE x.chat_id=$2 AND x.deleted_at IS NULL AND x.pinned_at IS NOT NULL) AS pinned
       FROM chat_message_files mf
       JOIN chat_messages m ON m.id = mf.message_id AND m.deleted_at IS NULL
       JOIN files f ON f.id = mf.file_id
      WHERE m.tenant_id=$1 AND m.chat_id=$2`,
      [tenantId, chatId],
    );
  }

  /** Сохранённое этим человеком — только из этого чата, для блока в сайдбаре. */
  savedInChat(tenantId: string, chatId: string, userId: string) {
    return this.db.many<{ id: string; body: string; file_id: string | null; file_name: string | null; created_at: Date; author_name: string | null; saved_at: Date }>(
      `SELECT m.id, m.body, m.file_id, f.file_name, m.created_at, u.full_name AS author_name, s.saved_at
         FROM saved_messages s
         JOIN chat_messages m ON m.id = s.message_id AND m.deleted_at IS NULL
    LEFT JOIN users u ON u.id = m.author_id
    LEFT JOIN files f ON f.id = m.file_id
        WHERE s.tenant_id=$1 AND s.user_id=$3 AND m.chat_id=$2
        ORDER BY s.saved_at DESC LIMIT 100`,
      [tenantId, chatId, userId],
    );
  }

  // ── связи с CRM (conversation_links) ──

  async link(i: { tenantId: string; chatId: string; entityType: string; entityId: string; relation: string; actorId: string | null }): Promise<void> {
    await this.db.query(
      `INSERT INTO conversation_links (tenant_id, chat_id, entity_type, entity_id, relation_type, created_by)
       VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
      [i.tenantId, i.chatId, i.entityType, i.entityId, i.relation, i.actorId],
    );
  }

  /**
   * Задачи чата: созданные из его сообщений и отправленные в него карточкой.
   * Живые первыми, потом закрытые; у каждой — как она сюда попала.
   */
  chatTasks(tenantId: string, chatId: string, limit = 50) {
    return this.db.many<{
      id: string; title: string; status: string; closed_at: Date | null; deadline_at: Date | null;
      project_id: string; assignee_name: string | null; relation: string; updated_at: Date;
    }>(
      `SELECT DISTINCT ON (t.id) t.id, t.title, bc.name AS status, t.closed_at, t.deadline_at, t.project_id,
              a.full_name AS assignee_name, l.relation_type AS relation, t.updated_at
         FROM conversation_links l
         JOIN tasks t ON t.id = l.entity_id
         JOIN board_columns bc ON bc.id = t.column_id
    LEFT JOIN users a ON a.id = t.assignee_id
        WHERE l.tenant_id=$1 AND l.chat_id=$2 AND l.entity_type='task'
        ORDER BY t.id, CASE l.relation_type WHEN 'created_from' THEN 0 ELSE 1 END`,
      [tenantId, chatId],
    ).then((rows) => rows
      .sort((x, y) => (x.closed_at ? 1 : 0) - (y.closed_at ? 1 : 0) || y.updated_at.getTime() - x.updated_at.getTime())
      .slice(0, limit));
  }

  countChatTasks(tenantId: string, chatId: string): Promise<{ n: string } | null> {
    return this.db.one<{ n: string }>(
      `SELECT COUNT(DISTINCT entity_id) AS n FROM conversation_links WHERE tenant_id=$1 AND chat_id=$2 AND entity_type='task'`,
      [tenantId, chatId],
    );
  }

  taskCard(tenantId: string, taskId: string) {
    return this.db.one<{ id: string; title: string; project_id: string; status: string; assignee_name: string | null; deadline_at: Date | null }>(
      `SELECT t.id, t.title, t.project_id, bc.name AS status, a.full_name AS assignee_name, t.deadline_at
         FROM tasks t JOIN board_columns bc ON bc.id = t.column_id LEFT JOIN users a ON a.id = t.assignee_id
        WHERE t.tenant_id=$1 AND t.id=$2`,
      [tenantId, taskId],
    );
  }

  projectCard(tenantId: string, projectId: string) {
    return this.db.one<{ id: string; name: string; status: string; open_tasks: number }>(
      `SELECT p.id, p.name, p.status,
              (SELECT COUNT(*)::int FROM tasks t WHERE t.project_id = p.id AND t.closed_at IS NULL) AS open_tasks
         FROM projects p WHERE p.tenant_id=$1 AND p.id=$2`,
      [tenantId, projectId],
    );
  }

  /** Сообщение со ссылкой на задачу — карточка задачи в ленте. */
  async addTaskMessage(tenantId: string, chatId: string, authorId: string, body: string, taskId: string): Promise<MessageRow> {
    const message = await this.addMessage({ tenantId, chatId, authorId, body, fileId: null });
    await this.db.query(`UPDATE chat_messages SET task_id=$3 WHERE tenant_id=$1 AND id=$2`, [tenantId, message.id, taskId]);
    return { ...message, task_id: taskId } as MessageRow;
  }

  /**
   * Миты чата — блок в сайдбаре (ТЗ-5, этап 4): созвоны, начатые из этого чата, и
   * встречи, связанные с ним. Сводка — из разбора; участники — кто говорил в
   * стенограмме; задачи — черновики, которые человек подтвердил.
   */
  chatMeetings(tenantId: string, chatId: string, limit = 20) {
    return this.db.many<{
      id: string; title: string; happened_at: Date | null; created_at: Date; duration_sec: number | null;
      status: string; summary: string | null; tasks_created: number; participants: string[]; project_id: string | null;
    }>(
      `SELECT m.id, m.title, m.happened_at, m.created_at, m.duration_sec, m.status, m.project_id,
              s.summary,
              (SELECT COUNT(*)::int FROM meeting_task_drafts d WHERE d.meeting_id = m.id AND d.task_id IS NOT NULL) AS tasks_created,
              -- кто говорил: сотрудник по сопоставлению, а если сопоставить не удалось —
              -- имя из субтитров как есть; безымянные реплики не в счёт
              COALESCE((
                SELECT array_agg(DISTINCT COALESCE(u.full_name, sg.speaker)) FROM meeting_segments sg
                  LEFT JOIN users u ON u.id = sg.speaker_user_id
                 WHERE sg.meeting_id = m.id AND COALESCE(u.full_name, sg.speaker) IS NOT NULL
              ), '{}') AS participants
         FROM meetings m
    LEFT JOIN meeting_summaries s ON s.meeting_id = m.id
        WHERE m.tenant_id = $1
          AND (m.chat_id = $2 OR EXISTS (
                SELECT 1 FROM conversation_links l
                 WHERE l.chat_id = $2 AND l.entity_type = 'meeting' AND l.entity_id = m.id))
        ORDER BY COALESCE(m.happened_at, m.created_at) DESC
        LIMIT $3`,
      [tenantId, chatId, limit],
    );
  }

  /** Живые задачи проекта — контекст для помощника в чате проекта. */
  projectTasksBrief(tenantId: string, projectId: string, limit = 25) {
    return this.db.many<{ id: string; title: string; status: string; assignee_name: string | null; deadline_at: Date | null }>(
      `SELECT t.id, t.title, bc.name AS status, a.full_name AS assignee_name, t.deadline_at
         FROM tasks t JOIN board_columns bc ON bc.id = t.column_id LEFT JOIN users a ON a.id = t.assignee_id
        WHERE t.tenant_id = $1 AND t.project_id = $2 AND t.closed_at IS NULL
        ORDER BY t.deadline_at NULLS LAST, t.updated_at DESC LIMIT $3`,
      [tenantId, projectId, limit],
    );
  }

  // ── журнал действий с чатом ──
  async audit(i: { tenantId: string; chatId: string; actorId: string | null; action: string; detail?: Record<string, unknown> }): Promise<void> {
    await this.db.query(
      `INSERT INTO chat_audit (tenant_id, chat_id, actor_id, action, detail) VALUES ($1,$2,$3,$4,$5::jsonb)`,
      [i.tenantId, i.chatId, i.actorId, i.action, JSON.stringify(i.detail ?? {})],
    );
  }

  auditList(tenantId: string, chatId: string, limit = 50) {
    return this.db.many<{ id: string; action: string; detail: Record<string, unknown>; created_at: Date; actor_name: string | null }>(
      `SELECT a.id, a.action, a.detail, a.created_at, u.full_name AS actor_name
         FROM chat_audit a LEFT JOIN users u ON u.id = a.actor_id
        WHERE a.tenant_id=$1 AND a.chat_id=$2 ORDER BY a.id DESC LIMIT $3`,
      [tenantId, chatId, limit],
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
    // file_id нужен правке: сообщение из одного вложения без подписи — законное,
    // и стереть в нём текст можно, а вот пустое текстовое сообщение — нет.
    return this.db.one<{ id: string; chat_id: string; author_id: string | null; file_id: string | null }>(
      `SELECT id, chat_id, author_id, file_id FROM chat_messages WHERE tenant_id=$1 AND id=$2`, [tenantId, id]);
  }

  async softDelete(id: string): Promise<void> {
    await this.db.query(`UPDATE chat_messages SET deleted_at=now(), body='' WHERE id=$1`, [id]);
  }
}
