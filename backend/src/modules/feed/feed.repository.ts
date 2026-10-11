import { Injectable } from '@nestjs/common';
import { DbService } from '../../database/db.service';

export interface PostRow {
  id: string;
  tenant_id: string;
  author_id: string | null;
  author_name: string | null;
  author_avatar: string | null;
  type: string;
  title: string | null;
  body: string;
  status: string;
  visibility: string;
  project_id: string | null;
  project_name: string | null;
  is_announcement: boolean;
  is_pinned: boolean;
  requires_ack: boolean;
  cta_label: string | null;
  cta_url: string | null;
  meta: Record<string, unknown>;
  created_by_agent: boolean;
  active_until: Date | null;
  published_at: Date;
  created_at: Date;
  edited_at: Date | null;
  dedup_key: string | null;
}

export interface FeedFile {
  fileId: string;
  name: string;
  mime: string;
  size: number;
}

export interface Viewer {
  tenantId: string;
  userId: string;
  /** Владелец видит всё: он отвечает за компанию, а не за отдел. */
  owner: boolean;
}

/**
 * Кто видит пост — ОДНО условие на весь модуль (§19, §56).
 *
 * Раньше адресатов проверял только список ленты, а по номеру поста комментарии и
 * отметки открывались кому угодно (разбор, ошибка 3). Теперь любой запрос по посту
 * идёт через это же условие.
 *
 * `$1` — организация, `$2` — человек, `$3` — владелец ли он.
 */
const VISIBLE = (p: string) => `(
  ${p}.tenant_id = $1 AND ${p}.deleted_at IS NULL
  AND (
    $3::boolean
    OR ${p}.author_id = $2::bigint
    OR ${p}.visibility = 'all'
    OR (${p}.visibility = 'department' AND EXISTS (
          SELECT 1 FROM feed_post_groups pg JOIN user_groups ug ON ug.group_id = pg.group_id AND ug.user_id = $2::bigint
           WHERE pg.post_id = ${p}.id))
    OR (${p}.visibility = 'project' AND ${p}.project_id IS NOT NULL AND EXISTS (
          SELECT 1 FROM projects pr WHERE pr.id = ${p}.project_id AND pr.tenant_id = $1
             AND (pr.visibility = 'all' OR pr.owner_user_id = $2::bigint
                  OR EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id = pr.id AND pm.user_id = $2::bigint))))
    OR (${p}.visibility = 'custom' AND EXISTS (
          SELECT 1 FROM feed_post_users fu WHERE fu.post_id = ${p}.id AND fu.user_id = $2::bigint))
  )
)`;

const POST_COLUMNS = `p.*, u.full_name AS author_name, u.avatar_file_id AS author_avatar, pr.name AS project_name`;
const POST_JOINS = `LEFT JOIN users u ON u.id = p.author_id LEFT JOIN projects pr ON pr.id = p.project_id`;

@Injectable()
export class FeedRepository {
  constructor(private readonly db: DbService) {}

  private v(v: Viewer) {
    return [v.tenantId, v.userId, v.owner];
  }

  /**
   * Лента по курсору (§71): «показать ещё» по номеру последнего, без OFFSET —
   * страницы не съезжают, когда сверху появляются новые посты.
   * Закреплённые и хайлайт дня приходят отдельно (`top`), здесь их нет.
   */
  list(v: Viewer, o: { types: string[]; before: string | null; limit: number; q: string | null; excludeIds: string[] }) {
    return this.db.many<PostRow>(
      `SELECT ${POST_COLUMNS}
         FROM feed_posts p ${POST_JOINS}
        WHERE ${VISIBLE('p')} AND p.status = 'published'
          AND p.type = ANY($4::text[])
          AND ($5::bigint IS NULL OR p.id < $5::bigint)
          AND ($6::text IS NULL OR p.title ILIKE '%' || $6 || '%' OR p.body ILIKE '%' || $6 || '%'
               OR u.full_name ILIKE '%' || $6 || '%' OR pr.name ILIKE '%' || $6 || '%')
          AND NOT (p.id = ANY($8::bigint[]))
        ORDER BY p.id DESC
        LIMIT $7`,
      [...this.v(v), o.types, o.before, o.q, Math.min(Math.max(o.limit, 1), 50), o.excludeIds],
    );
  }

  /** Закреплённые (≤ 3) — всегда сверху ленты, объявления первыми (§44). */
  pinned(v: Viewer) {
    return this.db.many<PostRow>(
      `SELECT ${POST_COLUMNS} FROM feed_posts p ${POST_JOINS}
        WHERE ${VISIBLE('p')} AND p.status = 'published' AND p.is_pinned
        ORDER BY (p.type = 'announcement') DESC, p.id DESC
        LIMIT 3`,
      this.v(v),
    );
  }

  /** Хайлайт дня — свежий, за последние 36 часов: вчерашний к обеду уже не новость. */
  latestHighlight(v: Viewer) {
    return this.db.one<PostRow>(
      `SELECT ${POST_COLUMNS} FROM feed_posts p ${POST_JOINS}
        WHERE ${VISIBLE('p')} AND p.status = 'published' AND p.type = 'highlight'
          AND p.published_at > now() - interval '36 hours'
        ORDER BY p.id DESC LIMIT 1`,
      this.v(v),
    );
  }

  /** Пост по номеру — только если человек его видит. Черновики — только тем, кто одобряет. */
  byIdFor(v: Viewer, id: string, withDrafts = false) {
    return this.db.one<PostRow>(
      `SELECT ${POST_COLUMNS} FROM feed_posts p ${POST_JOINS}
        WHERE ${VISIBLE('p')} AND p.id = $4::bigint
          AND (p.status = 'published' OR ($5::boolean AND p.status = 'draft'))`,
      [...this.v(v), id, withDrafts],
    );
  }

  /** Без проверки видимости — для служебных путей (планировщик, автор при правке). */
  byId(tenantId: string, id: string) {
    return this.db.one<PostRow>(
      `SELECT ${POST_COLUMNS} FROM feed_posts p ${POST_JOINS}
        WHERE p.tenant_id = $1 AND p.id = $2::bigint AND p.deleted_at IS NULL`,
      [tenantId, id],
    );
  }

  /** Черновики системы, ждущие одобрения (хайлайт при выключенной авто-публикации). */
  drafts(tenantId: string) {
    return this.db.many<PostRow>(
      `SELECT ${POST_COLUMNS} FROM feed_posts p ${POST_JOINS}
        WHERE p.tenant_id = $1 AND p.deleted_at IS NULL AND p.status = 'draft'
        ORDER BY p.id DESC LIMIT 20`,
      [tenantId],
    );
  }

  // ── то, что подтягивается к постам пачкой, а не подзапросом на каждый ──

  async extras(tenantId: string, userId: string, ids: string[]) {
    if (!ids.length) {
      return { counts: [], reactions: [], files: [], groups: [], polls: [], options: [], myVotes: [] };
    }
    const [counts, reactions, files, groups, polls, options, myVotes] = await Promise.all([
      this.db.many<{ post_id: string; comments: number; acks: number; acked: boolean }>(
        `SELECT p.id AS post_id,
                (SELECT count(*)::int FROM feed_comments c WHERE c.post_id = p.id AND c.deleted_at IS NULL) AS comments,
                (SELECT count(*)::int FROM feed_post_acks a WHERE a.post_id = p.id) AS acks,
                EXISTS (SELECT 1 FROM feed_post_acks a WHERE a.post_id = p.id AND a.user_id = $3::bigint) AS acked
           FROM feed_posts p WHERE p.tenant_id = $1 AND p.id = ANY($2::bigint[])`,
        [tenantId, ids, userId],
      ),
      this.db.many<{ post_id: string; reaction: string; n: number; mine: boolean }>(
        `SELECT post_id, reaction, count(*)::int AS n, bool_or(user_id = $3::bigint) AS mine
           FROM feed_reactions WHERE tenant_id = $1 AND post_id = ANY($2::bigint[])
          GROUP BY post_id, reaction`,
        [tenantId, ids, userId],
      ),
      this.db.many<{ post_id: string; fileId: string; name: string; mime: string; size: number }>(
        `SELECT pf.post_id, f.id::text AS "fileId", f.file_name AS name, f.content_type AS mime, f.size_bytes::int AS size
           FROM feed_post_files pf JOIN files f ON f.id = pf.file_id
          WHERE pf.tenant_id = $1 AND pf.post_id = ANY($2::bigint[]) ORDER BY f.id`,
        [tenantId, ids],
      ),
      this.db.many<{ post_id: string; name: string }>(
        `SELECT pg.post_id, g.name FROM feed_post_groups pg JOIN groups g ON g.id = pg.group_id
          WHERE pg.tenant_id = $1 AND pg.post_id = ANY($2::bigint[]) ORDER BY g.name`,
        [tenantId, ids],
      ),
      this.db.many<{ post_id: string; question: string; deadline_at: Date | null; anonymous: boolean; multiple: boolean; closed_at: Date | null; voters: number }>(
        `SELECT pl.*, (SELECT count(DISTINCT v.user_id)::int FROM feed_poll_votes v WHERE v.post_id = pl.post_id) AS voters
           FROM feed_polls pl WHERE pl.tenant_id = $1 AND pl.post_id = ANY($2::bigint[])`,
        [tenantId, ids],
      ),
      this.db.many<{ id: string; post_id: string; label: string; votes: number }>(
        `SELECT o.id, o.post_id, o.label, (SELECT count(*)::int FROM feed_poll_votes v WHERE v.option_id = o.id) AS votes
           FROM feed_poll_options o JOIN feed_polls pl ON pl.post_id = o.post_id
          WHERE pl.tenant_id = $1 AND o.post_id = ANY($2::bigint[]) ORDER BY o.post_id, o.position`,
        [tenantId, ids],
      ),
      this.db.many<{ post_id: string; option_id: string }>(
        `SELECT post_id, option_id FROM feed_poll_votes WHERE tenant_id = $1 AND post_id = ANY($2::bigint[]) AND user_id = $3::bigint`,
        [tenantId, ids, userId],
      ),
    ]);
    return { counts, reactions, files, groups, polls, options, myVotes };
  }

  /** Имена и аватары людей из служебных данных постов (кому спасибо, авторы релиза). */
  people(tenantId: string, ids: string[]) {
    if (!ids.length) return Promise.resolve([] as { id: string; full_name: string; avatar_file_id: string | null; is_active: boolean }[]);
    return this.db.many<{ id: string; full_name: string; avatar_file_id: string | null; is_active: boolean }>(
      `SELECT id::text, full_name, avatar_file_id, is_active FROM users WHERE tenant_id = $1 AND id = ANY($2::bigint[])`,
      [tenantId, ids],
    );
  }

  // ── создание и правка ──

  async create(input: {
    tenantId: string; authorId: string | null; type: string; title: string | null; body: string;
    status?: string; visibility: string; projectId: string | null; requiresAck: boolean;
    ctaLabel?: string | null; ctaUrl?: string | null; meta?: Record<string, unknown>; byAgent?: boolean;
    dedupKey?: string | null; activeUntil?: string | null; groupIds?: string[]; userIds?: string[]; pinned?: boolean;
  }): Promise<PostRow | null> {
    return this.db.withTransaction(async (c) => {
      const { rows } = await c.query<PostRow>(
        `INSERT INTO feed_posts (tenant_id, author_id, type, title, body, status, visibility, project_id,
                                 is_announcement, requires_ack, cta_label, cta_url, meta, created_by_agent,
                                 dedup_key, active_until, is_pinned, published_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17, now())
         ON CONFLICT (tenant_id, dedup_key) WHERE dedup_key IS NOT NULL AND deleted_at IS NULL DO NOTHING
         RETURNING *`,
        [
          input.tenantId, input.authorId, input.type, input.title, input.body, input.status ?? 'published',
          input.visibility, input.projectId, input.type === 'announcement', input.requiresAck,
          input.ctaLabel ?? null, input.ctaUrl ?? null, JSON.stringify(input.meta ?? {}), !!input.byAgent,
          input.dedupKey ?? null, input.activeUntil ?? null, !!input.pinned,
        ],
      );
      const post = rows[0];
      if (!post) return null; // такой пост уже есть (дубль релиза, второй хайлайт за день)
      if (input.groupIds?.length) {
        await c.query(
          `INSERT INTO feed_post_groups (post_id, group_id, tenant_id)
           SELECT $1, g.id, $3 FROM groups g WHERE g.tenant_id = $3 AND g.id = ANY($2::bigint[])
           ON CONFLICT DO NOTHING`,
          [post.id, input.groupIds, input.tenantId],
        );
      }
      if (input.userIds?.length) {
        await c.query(
          `INSERT INTO feed_post_users (post_id, user_id, tenant_id)
           SELECT $1, u.id, $3 FROM users u WHERE u.tenant_id = $3 AND u.id = ANY($2::bigint[])
           ON CONFLICT DO NOTHING`,
          [post.id, input.userIds, input.tenantId],
        );
      }
      return post;
    });
  }

  async update(tenantId: string, id: string, patch: { title?: string | null; body?: string; ctaLabel?: string | null; ctaUrl?: string | null; requiresAck?: boolean; activeUntil?: string | null }): Promise<void> {
    await this.db.query(
      `UPDATE feed_posts SET
          title = CASE WHEN $3::boolean THEN $4 ELSE title END,
          body = COALESCE($5, body),
          cta_label = CASE WHEN $6::boolean THEN $7 ELSE cta_label END,
          cta_url = CASE WHEN $6::boolean THEN $8 ELSE cta_url END,
          requires_ack = COALESCE($9, requires_ack),
          active_until = CASE WHEN $10::boolean THEN $11::timestamptz ELSE active_until END,
          edited_at = now()
        WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL`,
      [
        tenantId, id, patch.title !== undefined, patch.title ?? null, patch.body ?? null,
        patch.ctaLabel !== undefined || patch.ctaUrl !== undefined, patch.ctaLabel ?? null, patch.ctaUrl ?? null,
        patch.requiresAck ?? null, patch.activeUntil !== undefined, patch.activeUntil ?? null,
      ],
    );
  }

  async setStatus(tenantId: string, id: string, status: 'published' | 'skipped', patch?: { title?: string | null; body?: string }): Promise<boolean> {
    const r = await this.db.query(
      `UPDATE feed_posts SET status = $3, title = COALESCE($4, title), body = COALESCE($5, body),
              published_at = CASE WHEN $3 = 'published' THEN now() ELSE published_at END
        WHERE tenant_id = $1 AND id = $2 AND status = 'draft' AND deleted_at IS NULL`,
      [tenantId, id, status, patch?.title ?? null, patch?.body ?? null],
    );
    return (r.rowCount ?? 0) > 0;
  }

  async pinnedCount(tenantId: string): Promise<number> {
    const row = await this.db.one<{ n: number }>(
      `SELECT count(*)::int AS n FROM feed_posts WHERE tenant_id = $1 AND is_pinned AND deleted_at IS NULL AND status = 'published'`,
      [tenantId],
    );
    return Number(row?.n ?? 0);
  }

  async setPinned(tenantId: string, postId: string, pinned: boolean): Promise<void> {
    await this.db.query(`UPDATE feed_posts SET is_pinned = $3 WHERE tenant_id = $1 AND id = $2`, [tenantId, postId, pinned]);
  }

  /** Удаление мягкое; упоминания удаляем, чтобы секретарь не звал к удалённому посту. */
  async softDelete(tenantId: string, postId: string): Promise<void> {
    await this.db.query(`UPDATE feed_posts SET deleted_at = now(), is_pinned = FALSE WHERE tenant_id = $1 AND id = $2`, [tenantId, postId]);
    await this.db.query(`DELETE FROM feed_mentions WHERE tenant_id = $1 AND post_id = $2`, [tenantId, postId]);
  }

  // ── прочтение: «новое с прошлого визита» и «Ознакомился» ──

  async markSeen(tenantId: string, userId: string): Promise<void> {
    await this.db.query(
      `INSERT INTO feed_seen (tenant_id, user_id, last_seen_at) VALUES ($1,$2, now())
       ON CONFLICT (tenant_id, user_id) DO UPDATE SET last_seen_at = now()`,
      [tenantId, userId],
    );
  }

  /** С какого момента посты считаются новыми: прошлый визит, а для новичка — не старше двух недель. */
  async seenAt(tenantId: string, userId: string): Promise<Date> {
    const row = await this.db.one<{ at: Date }>(
      `SELECT COALESCE(
          (SELECT last_seen_at FROM feed_seen WHERE tenant_id = $1 AND user_id = $2),
          GREATEST((SELECT created_at FROM users WHERE id = $2), now() - interval '14 days')) AS at`,
      [tenantId, userId],
    );
    return row?.at ?? new Date();
  }

  /**
   * Счётчик в меню (§48): новые значимые посты с прошлого визита + действующие
   * объявления, которые ждут «Ознакомился». Без верхней границы — раньше было не больше 5.
   */
  async unreadCount(v: Viewer): Promise<number> {
    const row = await this.db.one<{ n: number }>(
      `WITH seen AS (
         SELECT COALESCE(
           (SELECT last_seen_at FROM feed_seen WHERE tenant_id = $1 AND user_id = $2::bigint),
           GREATEST((SELECT created_at FROM users WHERE id = $2::bigint), now() - interval '14 days')) AS at)
       SELECT count(*)::int AS n FROM feed_posts p, seen
        WHERE ${VISIBLE('p')} AND p.status = 'published'
          AND p.author_id IS DISTINCT FROM $2::bigint
          AND (p.published_at > seen.at
               OR (p.requires_ack AND (p.active_until IS NULL OR p.active_until > now())
                   AND NOT EXISTS (SELECT 1 FROM feed_post_acks a WHERE a.post_id = p.id AND a.user_id = $2::bigint)))`,
      this.v(v),
    );
    return Number(row?.n ?? 0);
  }

  async ack(tenantId: string, postId: string, userId: string): Promise<void> {
    await this.db.query(
      `INSERT INTO feed_post_acks (post_id, user_id, tenant_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
      [postId, userId, tenantId],
    );
  }

  /** Кто подтвердил объявление — поимённо (§41). */
  ackers(tenantId: string, postId: string) {
    return this.db.many<{ user_id: string; full_name: string; acked_at: Date }>(
      `SELECT a.user_id, u.full_name, a.acked_at FROM feed_post_acks a JOIN users u ON u.id = a.user_id
        WHERE a.tenant_id = $1 AND a.post_id = $2 ORDER BY a.acked_at`,
      [tenantId, postId],
    );
  }

  /** Кому адресован пост: все действующие сотрудники, кто его видит (без клиентов). */
  audience(tenantId: string, postId: string) {
    return this.db.many<{ user_id: string; full_name: string; email: string | null }>(
      `SELECT u.id::text AS user_id, u.full_name, u.email
         FROM users u JOIN roles ro ON ro.id = u.role_id AND ro.code <> 'client'
         JOIN feed_posts p ON p.id = $2 AND p.tenant_id = $1
        WHERE u.tenant_id = $1 AND u.is_active
          AND (
            ro.code = 'owner' OR p.author_id = u.id OR p.visibility = 'all'
            OR (p.visibility = 'department' AND EXISTS (
                  SELECT 1 FROM feed_post_groups pg JOIN user_groups ug ON ug.group_id = pg.group_id AND ug.user_id = u.id
                   WHERE pg.post_id = p.id))
            OR (p.visibility = 'project' AND EXISTS (
                  SELECT 1 FROM projects pr WHERE pr.id = p.project_id
                     AND (pr.visibility = 'all' OR pr.owner_user_id = u.id
                          OR EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id = pr.id AND pm.user_id = u.id))))
            OR (p.visibility = 'custom' AND EXISTS (SELECT 1 FROM feed_post_users fu WHERE fu.post_id = p.id AND fu.user_id = u.id))
          )
        ORDER BY u.full_name`,
      [tenantId, postId],
    );
  }

  // ── реакции ──

  /** Нажал ту же реакцию второй раз — снял (§24). Возвращает, стоит ли она теперь. */
  async toggleReaction(tenantId: string, postId: string, userId: string, reaction: string): Promise<boolean> {
    const del = await this.db.query(
      `DELETE FROM feed_reactions WHERE post_id = $1 AND user_id = $2 AND reaction = $3`,
      [postId, userId, reaction],
    );
    if ((del.rowCount ?? 0) > 0) return false;
    await this.db.query(
      `INSERT INTO feed_reactions (post_id, user_id, tenant_id, reaction) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
      [postId, userId, tenantId, reaction],
    );
    return true;
  }

  // ── опросы ──

  async createPoll(tenantId: string, postId: string, p: { question: string; options: string[]; deadlineAt: string | null; anonymous: boolean; multiple: boolean }): Promise<void> {
    await this.db.withTransaction(async (c) => {
      await c.query(
        `INSERT INTO feed_polls (post_id, tenant_id, question, deadline_at, anonymous, multiple) VALUES ($1,$2,$3,$4,$5,$6)`,
        [postId, tenantId, p.question, p.deadlineAt, p.anonymous, p.multiple],
      );
      for (let i = 0; i < p.options.length; i++) {
        await c.query(`INSERT INTO feed_poll_options (post_id, position, label) VALUES ($1,$2,$3)`, [postId, i, p.options[i]]);
      }
    });
  }

  poll(tenantId: string, postId: string) {
    return this.db.one<{ post_id: string; question: string; deadline_at: Date | null; anonymous: boolean; multiple: boolean; closed_at: Date | null }>(
      `SELECT * FROM feed_polls WHERE tenant_id = $1 AND post_id = $2`,
      [tenantId, postId],
    );
  }

  pollOptions(postId: string) {
    return this.db.many<{ id: string; label: string; votes: number }>(
      `SELECT o.id::text, o.label, (SELECT count(*)::int FROM feed_poll_votes v WHERE v.option_id = o.id) AS votes
         FROM feed_poll_options o WHERE o.post_id = $1 ORDER BY o.position`,
      [postId],
    );
  }

  /** Голос заменяет прежний: переголосовать можно, пока опрос открыт. */
  async vote(tenantId: string, postId: string, userId: string, optionIds: string[]): Promise<void> {
    await this.db.withTransaction(async (c) => {
      await c.query(`DELETE FROM feed_poll_votes WHERE post_id = $1 AND user_id = $2`, [postId, userId]);
      if (optionIds.length) {
        await c.query(
          `INSERT INTO feed_poll_votes (option_id, post_id, user_id, tenant_id)
           SELECT o.id, $1, $2, $3 FROM feed_poll_options o WHERE o.post_id = $1 AND o.id = ANY($4::bigint[])`,
          [postId, userId, tenantId, optionIds],
        );
      }
    });
  }

  /** Кто как голосовал — только для открытых опросов и только автору/руководству. */
  voters(postId: string) {
    return this.db.many<{ option_id: string; full_name: string }>(
      `SELECT v.option_id::text, u.full_name FROM feed_poll_votes v JOIN users u ON u.id = v.user_id
        WHERE v.post_id = $1 ORDER BY u.full_name`,
      [postId],
    );
  }

  async closePoll(tenantId: string, postId: string, by: string | null): Promise<boolean> {
    const r = await this.db.query(
      `UPDATE feed_polls SET closed_at = now(), closed_by = $3 WHERE tenant_id = $1 AND post_id = $2 AND closed_at IS NULL`,
      [tenantId, postId, by],
    );
    return (r.rowCount ?? 0) > 0;
  }

  /** Опросы с истёкшим сроком — их закрывает планировщик (§37, §67). */
  duePolls() {
    return this.db.many<{ tenant_id: string; post_id: string; author_id: string | null }>(
      `SELECT pl.tenant_id, pl.post_id, p.author_id FROM feed_polls pl JOIN feed_posts p ON p.id = pl.post_id
        WHERE pl.closed_at IS NULL AND pl.deadline_at IS NOT NULL AND pl.deadline_at <= now() AND p.deleted_at IS NULL
        LIMIT 200`,
    );
  }

  // ── лимиты (§79) ──

  async recentCount(tenantId: string, userId: string, kind: 'post' | 'kudos' | 'poll' | 'comment', hours: number): Promise<number> {
    const sql = kind === 'comment'
      ? `SELECT count(*)::int AS n FROM feed_comments WHERE tenant_id = $1 AND author_id = $2 AND created_at > now() - ($3 || ' hours')::interval`
      : `SELECT count(*)::int AS n FROM feed_posts WHERE tenant_id = $1 AND author_id = $2 AND created_at > now() - ($3 || ' hours')::interval
           AND ${kind === 'kudos' ? `type = 'kudos'` : kind === 'poll' ? `type = 'poll'` : `type NOT IN ('kudos','poll')`}`;
    const row = await this.db.one<{ n: number }>(sql, [tenantId, userId, String(hours)]);
    return Number(row?.n ?? 0);
  }

  // ── кандидаты (вехи и релизы) ──

  candidates(tenantId: string) {
    return this.db.many<{
      id: string; type: string; source_type: string; source_id: string; project_id: string | null; project_name: string | null;
      facts: Record<string, unknown>; suggested_title: string; suggested_body: string; visibility: string; created_at: Date;
    }>(
      `SELECT c.*, pr.name AS project_name FROM feed_candidates c LEFT JOIN projects pr ON pr.id = c.project_id
        WHERE c.tenant_id = $1 AND c.status = 'detected' AND c.created_at > now() - interval '14 days'
        ORDER BY c.id DESC LIMIT 20`,
      [tenantId],
    );
  }

  candidate(tenantId: string, id: string) {
    return this.db.one<{
      id: string; type: string; source_type: string; source_id: string; project_id: string | null;
      facts: Record<string, unknown>; suggested_title: string; suggested_body: string; visibility: string; status: string;
    }>(`SELECT * FROM feed_candidates WHERE tenant_id = $1 AND id = $2`, [tenantId, id]);
  }

  /** Решение по кандидату — атомарно: двое одобряющих не опубликуют одну веху дважды. */
  async decideCandidate(tenantId: string, id: string, status: 'published' | 'rejected', by: string, postId: string | null): Promise<boolean> {
    const r = await this.db.query(
      `UPDATE feed_candidates SET status = $3, decided_by = $4, decided_at = now(), post_id = $5
        WHERE tenant_id = $1 AND id = $2 AND status = 'detected'`,
      [tenantId, id, status, by, postId],
    );
    return (r.rowCount ?? 0) > 0;
  }

  async addCandidate(c: {
    tenantId: string; type: string; sourceType: string; sourceId: string; projectId: string | null;
    facts: Record<string, unknown>; title: string; body: string; visibility: string; confidence: number;
  }): Promise<string | null> {
    const row = await this.db.one<{ id: string }>(
      `INSERT INTO feed_candidates (tenant_id, type, source_type, source_id, project_id, facts, suggested_title, suggested_body, visibility, confidence)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (tenant_id, source_type, source_id) DO NOTHING RETURNING id`,
      [c.tenantId, c.type, c.sourceType, c.sourceId, c.projectId, JSON.stringify(c.facts), c.title, c.body, c.visibility, c.confidence],
    );
    return row?.id ?? null;
  }

  // ── настройки ──

  async settings(tenantId: string) {
    const row = await this.db.one<{
      highlights_enabled: boolean; highlights_auto: boolean; highlight_hour: number; hero_enabled: boolean;
      learnings_enabled: boolean; learnings_dow: number; learnings_hour: number;
    }>(`SELECT * FROM feed_settings WHERE tenant_id = $1`, [tenantId]);
    return row ?? {
      highlights_enabled: true, highlights_auto: true, highlight_hour: 9, hero_enabled: true,
      learnings_enabled: true, learnings_dow: 5, learnings_hour: 17,
    };
  }

  async saveSettings(tenantId: string, s: Record<string, unknown>): Promise<void> {
    const cur = await this.settings(tenantId);
    const n = { ...cur, ...s };
    await this.db.query(
      `INSERT INTO feed_settings (tenant_id, highlights_enabled, highlights_auto, highlight_hour, hero_enabled,
                                  learnings_enabled, learnings_dow, learnings_hour, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now())
       ON CONFLICT (tenant_id) DO UPDATE SET highlights_enabled = $2, highlights_auto = $3, highlight_hour = $4,
         hero_enabled = $5, learnings_enabled = $6, learnings_dow = $7, learnings_hour = $8, updated_at = now()`,
      [tenantId, n.highlights_enabled, n.highlights_auto, n.highlight_hour, n.hero_enabled, n.learnings_enabled, n.learnings_dow, n.learnings_hour],
    );
  }

  // ── прежнее: право по должности, правая колонка, комментарии, файлы, упоминания ──

  /** Должность с правом «может публиковать новости» (пресс-секретарь) — в дополнение к `news.create`. */
  async positionCanPost(tenantId: string, userId: string): Promise<boolean> {
    const row = await this.db.one<{ ok: boolean }>(
      `SELECT COALESCE(p.can_post_news, FALSE) AS ok
         FROM users u LEFT JOIN positions p ON p.id = u.position_id
        WHERE u.tenant_id = $1 AND u.id = $2`,
      [tenantId, userId],
    );
    return !!row?.ok;
  }

  sideAnnouncements(v: Viewer, limit = 5) {
    return this.db.many<{ id: string; title: string | null; body: string; created_at: Date; acked: boolean; requires_ack: boolean }>(
      `SELECT p.id, p.title, left(p.body, 140) AS body, p.created_at, p.requires_ack,
              EXISTS (SELECT 1 FROM feed_post_acks a WHERE a.post_id = p.id AND a.user_id = $2::bigint) AS acked
         FROM feed_posts p
        WHERE ${VISIBLE('p')} AND p.status = 'published' AND p.type = 'announcement'
          AND (p.active_until IS NULL OR p.active_until > now())
        ORDER BY p.id DESC
        LIMIT $4`,
      [...this.v(v), limit],
    );
  }

  /** Открытые опросы, где человек ещё не голосовал: «проголосуйте» в правой колонке. */
  sidePolls(v: Viewer, limit = 3) {
    return this.db.many<{ id: string; question: string; deadline_at: Date | null }>(
      `SELECT p.id, pl.question, pl.deadline_at
         FROM feed_posts p JOIN feed_polls pl ON pl.post_id = p.id
        WHERE ${VISIBLE('p')} AND p.status = 'published' AND pl.closed_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM feed_poll_votes x WHERE x.post_id = p.id AND x.user_id = $2::bigint)
        ORDER BY pl.deadline_at NULLS LAST, p.id DESC
        LIMIT $4`,
      [...this.v(v), limit],
    );
  }

  birthdayPeople(tenantId: string) {
    return this.db.many<{ id: string; full_name: string; avatar_file_id: string | null; birth_date: string }>(
      // Строкой, а не датой: драйвер отдаёт DATE как полночь ПО МЕСТНОМУ времени.
      `SELECT u.id, u.full_name, u.avatar_file_id, to_char(u.birth_date, 'YYYY-MM-DD') AS birth_date
         FROM users u JOIN roles r ON r.id = u.role_id
        WHERE u.tenant_id = $1 AND u.is_active AND u.birth_date IS NOT NULL AND r.code <> 'client'`,
      [tenantId],
    );
  }

  newcomers(tenantId: string, days = 30, limit = 5) {
    return this.db.many<{ id: string; full_name: string; avatar_file_id: string | null; created_at: Date; position_name: string | null }>(
      `SELECT u.id, u.full_name, u.avatar_file_id, u.created_at, p.name AS position_name
         FROM users u JOIN roles r ON r.id = u.role_id LEFT JOIN positions p ON p.id = u.position_id
        WHERE u.tenant_id = $1 AND u.is_active AND r.code <> 'client'
          AND u.created_at > now() - ($2 || ' days')::interval
        ORDER BY u.created_at DESC LIMIT $3`,
      [tenantId, String(days), limit],
    );
  }

  /** Часовой пояс организации — для «до конца дня» и дней рождения. */
  async timezone(tenantId: string): Promise<string> {
    const row = await this.db.one<{ tz: string | null }>(`SELECT timezone AS tz FROM tenants WHERE id = $1`, [tenantId]);
    return row?.tz || 'Europe/Moscow';
  }

  async comments(tenantId: string, postId: string, limit = 10, before?: string) {
    const rows = await this.db.many<{
      id: string; author_id: string; full_name: string; avatar_file_id: string | null; body: string; created_at: Date;
    }>(
      `SELECT c.id, c.author_id, u.full_name, u.avatar_file_id, c.body, c.created_at
         FROM feed_comments c JOIN users u ON u.id = c.author_id
        WHERE c.tenant_id = $1 AND c.post_id = $2 AND c.deleted_at IS NULL
          AND ($4::bigint IS NULL OR c.id < $4::bigint)
        ORDER BY c.id DESC LIMIT $3`,
      [tenantId, postId, Math.min(Math.max(limit, 1), 100), before ?? null],
    );
    return rows.reverse();
  }

  async commentsCount(tenantId: string, postId: string): Promise<number> {
    const row = await this.db.one<{ n: string }>(
      `SELECT count(*)::int AS n FROM feed_comments WHERE tenant_id = $1 AND post_id = $2 AND deleted_at IS NULL`,
      [tenantId, postId],
    );
    return Number(row?.n ?? 0);
  }

  addComment(tenantId: string, postId: string, authorId: string, body: string) {
    return this.db.one<{ id: string }>(
      `INSERT INTO feed_comments (post_id, tenant_id, author_id, body) VALUES ($1,$2,$3,$4) RETURNING id`,
      [postId, tenantId, authorId, body],
    );
  }

  comment(tenantId: string, id: string) {
    return this.db.one<{ id: string; post_id: string; author_id: string }>(
      `SELECT id, post_id, author_id FROM feed_comments WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL`,
      [tenantId, id],
    );
  }

  async deleteComment(tenantId: string, id: string): Promise<void> {
    await this.db.query(`UPDATE feed_comments SET deleted_at = now() WHERE tenant_id = $1 AND id = $2`, [tenantId, id]);
    await this.db.query(`DELETE FROM feed_mentions WHERE tenant_id = $1 AND comment_id = $2`, [tenantId, id]);
  }

  async addFile(tenantId: string, postId: string, fileId: string): Promise<void> {
    await this.db.query(
      `INSERT INTO feed_post_files (post_id, file_id, tenant_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
      [postId, fileId, tenantId],
    );
  }

  async fileCount(postId: string): Promise<number> {
    const row = await this.db.one<{ n: number }>(`SELECT count(*)::int AS n FROM feed_post_files WHERE post_id = $1`, [postId]);
    return Number(row?.n ?? 0);
  }

  /** Сотрудники этой компании из присланных id (без клиентов и уволенных). */
  tenantUserIds(tenantId: string, ids: string[]) {
    if (!ids.length) return Promise.resolve([] as { id: string; full_name: string }[]);
    return this.db.many<{ id: string; full_name: string }>(
      `SELECT u.id::text, u.full_name FROM users u
         JOIN roles ro ON ro.id = u.role_id AND ro.code <> 'client'
        WHERE u.tenant_id = $1 AND u.is_active AND u.id = ANY($2::bigint[])`,
      [tenantId, ids.map(String)],
    );
  }

  async addMentions(tenantId: string, postId: string, commentId: string | null, userIds: string[]): Promise<void> {
    if (!userIds.length) return;
    await this.db.query(
      `INSERT INTO feed_mentions (tenant_id, post_id, comment_id, user_id)
       SELECT $1, $2, $3, unnest($4::bigint[])`,
      [tenantId, postId, commentId, [...new Set(userIds.map(String))]],
    );
  }

  /** Проект виден человеку — тем же правилом, что в разделе «Проекты». */
  async projectVisible(tenantId: string, projectId: string, userId: string, owner: boolean) {
    return this.db.one<{ id: string; name: string; visibility: string }>(
      `SELECT pr.id, pr.name, pr.visibility FROM projects pr
        WHERE pr.tenant_id = $1 AND pr.id = $2
          AND ($4::boolean OR pr.visibility = 'all' OR pr.owner_user_id = $3::bigint
               OR EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id = pr.id AND pm.user_id = $3::bigint))`,
      [tenantId, projectId, userId, owner],
    );
  }
}
