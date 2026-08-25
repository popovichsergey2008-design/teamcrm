import { Injectable } from '@nestjs/common';
import { DbService } from '../../database/db.service';

export interface PostRow {
  id: string;
  tenant_id: string;
  author_id: string;
  author_name: string | null;
  author_avatar: string | null;
  body: string;
  is_announcement: boolean;
  is_pinned: boolean;
  active_until: Date | null;
  created_at: Date;
  edited_at: Date | null;
  read_at: Date | null;
  reads: number;
  comments: number;
  group_names: string[] | null;
}

@Injectable()
export class FeedRepository {
  constructor(private readonly db: DbService) {}

  /**
   * Лента человека.
   *
   * Видно то, что адресовано всей компании, либо его подразделению, либо написано им
   * самим. Закреплённое всегда сверху — в этом и смысл закрепления: оно не должно
   * тонуть под новыми сообщениями.
   */
  list(tenantId: string, userId: string, limit: number, before?: string) {
    return this.db.many<PostRow>(
      `SELECT p.*, u.full_name AS author_name, u.avatar_file_id AS author_avatar,
              r.read_at,
              (SELECT count(*)::int FROM feed_post_reads x WHERE x.post_id = p.id) AS reads,
              (SELECT count(*)::int FROM feed_comments c WHERE c.post_id = p.id AND c.deleted_at IS NULL) AS comments,
              (SELECT array_agg(g.name ORDER BY g.name) FROM feed_post_groups pg
                 JOIN groups g ON g.id = pg.group_id WHERE pg.post_id = p.id) AS group_names
         FROM feed_posts p
         JOIN users u ON u.id = p.author_id
         LEFT JOIN feed_post_reads r ON r.post_id = p.id AND r.user_id = $2
        WHERE p.tenant_id = $1 AND p.deleted_at IS NULL
          AND ($3::bigint IS NULL OR p.id < $3::bigint)
          AND (
            p.author_id = $2
            OR NOT EXISTS (SELECT 1 FROM feed_post_groups pg WHERE pg.post_id = p.id)
            OR EXISTS (
              SELECT 1 FROM feed_post_groups pg
               JOIN user_groups ug ON ug.group_id = pg.group_id AND ug.user_id = $2
               WHERE pg.post_id = p.id)
          )
        ORDER BY p.is_pinned DESC, p.id DESC
        LIMIT $4`,
      [tenantId, userId, before ?? null, Math.min(Math.max(limit, 1), 50)],
    );
  }

  byId(tenantId: string, id: string) {
    return this.db.one<PostRow>(
      `SELECT p.*, u.full_name AS author_name, u.avatar_file_id AS author_avatar,
              NULL::timestamptz AS read_at, 0 AS reads, 0 AS comments, NULL::text[] AS group_names
         FROM feed_posts p JOIN users u ON u.id = p.author_id
        WHERE p.tenant_id = $1 AND p.id = $2 AND p.deleted_at IS NULL`,
      [tenantId, id],
    );
  }

  async create(input: {
    tenantId: string; authorId: string; body: string; isAnnouncement: boolean;
    activeUntil: string | null; groupIds: string[];
  }): Promise<PostRow> {
    return this.db.withTransaction(async (c) => {
      const { rows } = await c.query<PostRow>(
        `INSERT INTO feed_posts (tenant_id, author_id, body, is_announcement, active_until)
         VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [input.tenantId, input.authorId, input.body, input.isAnnouncement, input.activeUntil],
      );
      const post = rows[0];
      for (const gid of new Set(input.groupIds.map(String))) {
        await c.query(
          `INSERT INTO feed_post_groups (post_id, group_id, tenant_id)
           SELECT $1,$2,$3 WHERE EXISTS (SELECT 1 FROM groups WHERE id = $2 AND tenant_id = $3)`,
          [post.id, gid, input.tenantId],
        );
      }
      // автор своё объявление читать не должен: он его и написал
      await c.query(
        `INSERT INTO feed_post_reads (post_id, user_id, tenant_id) VALUES ($1,$2,$3)
         ON CONFLICT DO NOTHING`,
        [post.id, input.authorId, input.tenantId],
      );
      return post;
    });
  }

  async markRead(tenantId: string, postId: string, userId: string): Promise<void> {
    await this.db.query(
      `INSERT INTO feed_post_reads (post_id, user_id, tenant_id) VALUES ($1,$2,$3)
       ON CONFLICT DO NOTHING`,
      [postId, userId, tenantId],
    );
  }

  /** Кто прочитал объявление — поимённо: число без имён ничего не даёт автору. */
  readers(tenantId: string, postId: string) {
    return this.db.many<{ user_id: string; full_name: string; read_at: Date }>(
      `SELECT r.user_id, u.full_name, r.read_at
         FROM feed_post_reads r JOIN users u ON u.id = r.user_id
        WHERE r.tenant_id = $1 AND r.post_id = $2
        ORDER BY r.read_at`,
      [tenantId, postId],
    );
  }

  /** Кто ещё не прочитал: те, кому объявление адресовано, минус прочитавшие. */
  pendingReaders(tenantId: string, postId: string) {
    return this.db.many<{ user_id: string; full_name: string }>(
      `SELECT u.id AS user_id, u.full_name
         FROM users u
         JOIN roles ro ON ro.id = u.role_id AND ro.code <> 'client'
        WHERE u.tenant_id = $1 AND u.is_active
          AND (
            NOT EXISTS (SELECT 1 FROM feed_post_groups pg WHERE pg.post_id = $2)
            OR EXISTS (
              SELECT 1 FROM feed_post_groups pg
               JOIN user_groups ug ON ug.group_id = pg.group_id AND ug.user_id = u.id
               WHERE pg.post_id = $2)
          )
          AND NOT EXISTS (
            SELECT 1 FROM feed_post_reads r WHERE r.post_id = $2 AND r.user_id = u.id)
        ORDER BY u.full_name`,
      [tenantId, postId],
    );
  }

  /**
   * Непрочитанные действующие объявления — те, что висят плашкой сверху.
   *
   * Просроченные не показываем: объявление про вчерашний субботник сегодня
   * не требует ничего, кроме раздражения.
   */
  unreadAnnouncements(tenantId: string, userId: string) {
    return this.db.many<PostRow>(
      `SELECT p.*, u.full_name AS author_name, u.avatar_file_id AS author_avatar,
              NULL::timestamptz AS read_at, 0 AS reads, 0 AS comments, NULL::text[] AS group_names
         FROM feed_posts p JOIN users u ON u.id = p.author_id
        WHERE p.tenant_id = $1 AND p.deleted_at IS NULL AND p.is_announcement
          AND (p.active_until IS NULL OR p.active_until > now())
          AND NOT EXISTS (SELECT 1 FROM feed_post_reads r WHERE r.post_id = p.id AND r.user_id = $2)
          AND (
            NOT EXISTS (SELECT 1 FROM feed_post_groups pg WHERE pg.post_id = p.id)
            OR EXISTS (
              SELECT 1 FROM feed_post_groups pg
               JOIN user_groups ug ON ug.group_id = pg.group_id AND ug.user_id = $2
               WHERE pg.post_id = p.id)
          )
        ORDER BY p.created_at DESC
        LIMIT 5`,
      [tenantId, userId],
    );
  }

  comments(tenantId: string, postId: string) {
    return this.db.many<{ id: string; author_id: string; full_name: string; avatar_file_id: string | null; body: string; created_at: Date }>(
      `SELECT c.id, c.author_id, u.full_name, u.avatar_file_id, c.body, c.created_at
         FROM feed_comments c JOIN users u ON u.id = c.author_id
        WHERE c.tenant_id = $1 AND c.post_id = $2 AND c.deleted_at IS NULL
        ORDER BY c.id`,
      [tenantId, postId],
    );
  }

  addComment(tenantId: string, postId: string, authorId: string, body: string) {
    return this.db.one<{ id: string }>(
      `INSERT INTO feed_comments (post_id, tenant_id, author_id, body) VALUES ($1,$2,$3,$4) RETURNING id`,
      [postId, tenantId, authorId, body],
    );
  }

  async setPinned(tenantId: string, postId: string, pinned: boolean): Promise<void> {
    await this.db.query(
      `UPDATE feed_posts SET is_pinned = $3 WHERE tenant_id = $1 AND id = $2`,
      [tenantId, postId, pinned],
    );
  }

  /** Удаление мягкое: комментарии и отметки о прочтении остаются историей. */
  async softDelete(tenantId: string, postId: string): Promise<void> {
    await this.db.query(
      `UPDATE feed_posts SET deleted_at = now() WHERE tenant_id = $1 AND id = $2`,
      [tenantId, postId],
    );
  }
}
