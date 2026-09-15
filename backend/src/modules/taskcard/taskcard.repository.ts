import { Injectable } from '@nestjs/common';
import { DbService } from '../../database/db.service';

@Injectable()
export class TaskCardRepository {
  constructor(private readonly db: DbService) {}

  // ---- comments ----
  addComment(
    tenantId: string, taskId: string, authorId: string, body: string, clientVisible: boolean,
    replyToId?: string | null,
    extra?: { fileId?: string | null; replyExcerpt?: string | null; threadRootId?: string | null; alsoInChannel?: boolean },
  ) {
    return this.db.one(
      `INSERT INTO task_comments
         (tenant_id, task_id, author_id, body, is_client_visible, reply_to_id, file_id, reply_excerpt,
          thread_root_id, also_in_channel)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [
        tenantId, taskId, authorId, body, clientVisible, replyToId ?? null,
        extra?.fileId ?? null, extra?.replyExcerpt ?? null,
        extra?.threadRootId ?? null, extra?.alsoInChannel === true,
      ],
    );
  }

  // ---- отметки о прочтении ----
  /**
   * «Дочитал до этого сообщения».
   *
   * Отметка только ползёт вверх: человек мог прокрутить переписку назад, но уже
   * показанное отправителю «просмотрено» снимать нельзя — это выглядело бы как
   * «прочитал и передумал».
   */
  markRead(tenantId: string, taskId: string, userId: string, lastReadId: string) {
    return this.db.one<{ last_read_id: string }>(
      `INSERT INTO task_comment_reads (tenant_id, task_id, user_id, last_read_id)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (tenant_id, task_id, user_id) DO UPDATE
          SET last_read_id = GREATEST(task_comment_reads.last_read_id, EXCLUDED.last_read_id),
              updated_at = now()
       RETURNING last_read_id::text`,
      [tenantId, taskId, userId, lastReadId],
    );
  }

  /** Кто и докуда прочитал эту задачу — одной строкой на человека. */
  readers(tenantId: string, taskId: string) {
    return this.db.many<{ user_id: string; full_name: string; last_read_id: string; updated_at: Date }>(
      `SELECT r.user_id::text, u.full_name, r.last_read_id::text, r.updated_at
         FROM task_comment_reads r JOIN users u ON u.id = r.user_id
        WHERE r.tenant_id=$1 AND r.task_id=$2
        ORDER BY r.updated_at DESC`,
      [tenantId, taskId],
    );
  }

  /**
   * Корень ветки: отвечают всегда на сообщение верхнего уровня.
   *
   * Ответ на ответ уходит в ту же ветку, что и родитель, — так же, как в чатах.
   * Дерево в переписке никто не читает, а поддерживать его пришлось бы везде.
   */
  async threadRootOf(tenantId: string, commentId: string): Promise<string | null> {
    const row = await this.db.one<{ id: string; thread_root_id: string | null; task_id: string }>(
      `SELECT id, thread_root_id, task_id FROM task_comments WHERE tenant_id=$1 AND id=$2`,
      [tenantId, commentId],
    );
    if (!row) return null;
    return String(row.thread_root_id ?? row.id);
  }

  /** Ответы ветки — по порядку разговора. */
  threadReplies(tenantId: string, taskId: string, rootId: string, viewerId: string) {
    return this.db.many(
      `SELECT c.id, c.author_id, c.body, c.is_client_visible, c.is_ai, c.created_at, c.edited_at,
              c.reply_to_id, c.file_id, c.thread_root_id, c.also_in_channel, c.pinned_at, f.file_name,
              COALESCE(c.reply_excerpt, r.body) AS reply_body, ru.full_name AS reply_author,
              COALESCE((
                SELECT json_agg(json_build_object('emoji', x.emoji, 'count', x.n, 'mine', x.mine))
                  FROM (
                    SELECT emoji, COUNT(*)::int AS n, BOOL_OR(user_id = $4::bigint) AS mine
                      FROM task_comment_reactions
                     WHERE tenant_id = c.tenant_id AND comment_id = c.id
                     GROUP BY emoji
                  ) x
              ), '[]'::json) AS reactions,
              u.full_name AS author_name
         FROM task_comments c
         JOIN users u ON u.id=c.author_id
    LEFT JOIN task_comments r ON r.id = c.reply_to_id
    LEFT JOIN users ru ON ru.id = r.author_id
    LEFT JOIN files f ON f.id = c.file_id
        WHERE c.tenant_id=$1 AND c.task_id=$2 AND c.thread_root_id=$3
        ORDER BY c.created_at`,
      [tenantId, taskId, rootId, viewerId],
    );
  }

  async pinnedBy(tenantId: string, commentId: string): Promise<string | null> {
    const row = await this.db.one<{ pinned_by: string | null }>(
      `SELECT pinned_by FROM task_comments WHERE tenant_id=$1 AND id=$2`, [tenantId, commentId],
    );
    return row?.pinned_by ? String(row.pinned_by) : null;
  }

  /** Закрепить или открепить: одна ручка, потому что это одно решение с двумя исходами. */
  setPinned(tenantId: string, commentId: string, userId: string | null) {
    return this.db.one(
      `UPDATE task_comments
          SET pinned_at = CASE WHEN $3::bigint IS NULL THEN NULL ELSE now() END,
              pinned_by = $3
        WHERE tenant_id=$1 AND id=$2 RETURNING id, pinned_at, pinned_by`,
      [tenantId, commentId, userId],
    );
  }
  /**
   * Переписка задачи — ПОСЛЕДНИЕ `limit` сообщений.
   *
   * Раньше отдавались все: у импортированной из Битрикса задачи их бывает несколько
   * сотен, и карточка открывалась через паузу, отрисовывая то, что человек всё равно
   * не прочитает. Берём хвост (разговор читают с конца) и переворачиваем; поднять всю
   * переписку можно одним запросом с большим пределом — за этим ходит кнопка в чате.
   */
  listComments(tenantId: string, taskId: string, includePrivate: boolean, viewerId: string, limit = 100) {
    return this.db.many(
      // is_ai — чтобы в ленте было видно, кто говорит: ответ помощника нельзя
      // спутать с указанием постановщика
      // Цитата приезжает вместе с сообщением: без неё «да, согласен» через десять
      // реплик — согласие неизвестно с чем, и лезть за ним отдельным запросом
      // на каждое сообщение слишком дорого.
      `SELECT c.id, c.author_id, c.body, c.is_client_visible, c.is_ai, c.created_at, c.edited_at,
              c.reply_to_id, c.file_id, c.pinned_at, c.pinned_by, f.file_name,
              -- Сколько ответов в ветке и когда был последний: по ним на корневом
              -- сообщении рисуется «3 ответа · 10 минут назад», и лезть за этим
              -- отдельным запросом на каждую строку слишком дорого.
              (SELECT COUNT(*)::int FROM task_comments t
                WHERE t.thread_root_id = c.id) AS reply_count,
              (SELECT MAX(t.created_at) FROM task_comments t
                WHERE t.thread_root_id = c.id) AS last_reply_at,
              -- цитируем выделенный человеком кусок, а если его нет — начало сообщения
              COALESCE(c.reply_excerpt, r.body) AS reply_body, ru.full_name AS reply_author,
              COALESCE((
                SELECT json_agg(json_build_object('emoji', x.emoji, 'count', x.n, 'mine', x.mine))
                  FROM (
                    SELECT emoji, COUNT(*)::int AS n,
                           BOOL_OR(user_id = $4::bigint) AS mine
                      FROM task_comment_reactions
                     WHERE tenant_id = c.tenant_id AND comment_id = c.id
                     GROUP BY emoji
                  ) x
              ), '[]'::json) AS reactions,
              u.full_name AS author_name
         FROM task_comments c
         JOIN users u ON u.id=c.author_id
    LEFT JOIN task_comments r ON r.id = c.reply_to_id
    LEFT JOIN users ru ON ru.id = r.author_id
    LEFT JOIN files f ON f.id = c.file_id
        WHERE c.tenant_id=$1 AND c.task_id=$2 AND ($3 OR c.is_client_visible=TRUE)
          -- Ответы ветки в общей ленте не показываются: ради этого ветки и заводились.
          -- Исключение — «ответить и в ленту»: автор счёл ответ важным для всех.
          AND (c.thread_root_id IS NULL OR c.also_in_channel)
        ORDER BY c.created_at DESC
        LIMIT $5`,
      [tenantId, taskId, includePrivate, viewerId, Math.min(Math.max(limit, 1), 2000)],
    ).then((rows) => rows.reverse());
  }
  getComment(tenantId: string, id: string) {
    return this.db.one<{ id: string; author_id: string; task_id: string }>(
      `SELECT id, author_id, task_id FROM task_comments WHERE tenant_id=$1 AND id=$2`,
      [tenantId, id],
    );
  }
  updateComment(tenantId: string, id: string, body: string) {
    return this.db.one(`UPDATE task_comments SET body=$3, edited_at=now() WHERE tenant_id=$1 AND id=$2 RETURNING *`, [tenantId, id, body]);
  }
  async deleteComment(tenantId: string, id: string) {
    await this.db.query(`DELETE FROM task_comments WHERE tenant_id=$1 AND id=$2`, [tenantId, id]);
  }

  // ---- attachments ----
  addAttachment(tenantId: string, taskId: string, fileId: string) {
    return this.db.one(
      `INSERT INTO task_attachments (tenant_id, task_id, file_id) VALUES ($1,$2,$3)
       ON CONFLICT (task_id, file_id) DO NOTHING RETURNING *`,
      [tenantId, taskId, fileId],
    );
  }
  listAttachments(tenantId: string, taskId: string) {
    return this.db.many(
      `SELECT a.id, a.file_id, f.file_name, f.content_type, f.size_bytes, a.created_at
         FROM task_attachments a JOIN files f ON f.id=a.file_id
        WHERE a.tenant_id=$1 AND a.task_id=$2 ORDER BY a.created_at DESC`,
      [tenantId, taskId],
    );
  }
  getAttachment(tenantId: string, id: string) {
    return this.db.one<{ id: string; task_id: string; file_id: string }>(
      `SELECT id, task_id, file_id FROM task_attachments WHERE tenant_id=$1 AND id=$2`,
      [tenantId, id],
    );
  }
  async deleteAttachment(tenantId: string, id: string) {
    await this.db.query(`DELETE FROM task_attachments WHERE tenant_id=$1 AND id=$2`, [tenantId, id]);
  }

  // ---- checklist ----
  /**
   * Реакция-переключатель: повторное нажатие снимает свою.
   *
   * Реакция — способ ответить «ок», не засоряя обсуждение и не будя участников;
   * поэтому она не создаёт ни записи в истории, ни уведомления.
   */
  async toggleReaction(tenantId: string, commentId: string, userId: string, emoji: string): Promise<void> {
    const existing = await this.db.one(
      `SELECT 1 FROM task_comment_reactions
        WHERE tenant_id=$1 AND comment_id=$2 AND user_id=$3 AND emoji=$4`,
      [tenantId, commentId, userId, emoji],
    );
    if (existing) {
      await this.db.query(
        `DELETE FROM task_comment_reactions
          WHERE tenant_id=$1 AND comment_id=$2 AND user_id=$3 AND emoji=$4`,
        [tenantId, commentId, userId, emoji],
      );
      return;
    }
    await this.db.query(
      `INSERT INTO task_comment_reactions (tenant_id, comment_id, user_id, emoji)
       VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
      [tenantId, commentId, userId, emoji],
    );
  }

  async addChecklistItem(tenantId: string, taskId: string, text: string) {
    const pos = await this.db.one<{ next: number }>(
      `SELECT COALESCE(MAX(position)+1,0) AS next FROM task_checklist_items WHERE tenant_id=$1 AND task_id=$2`,
      [tenantId, taskId],
    );
    return this.db.one(
      `INSERT INTO task_checklist_items (tenant_id, task_id, text, position) VALUES ($1,$2,$3,$4) RETURNING *`,
      [tenantId, taskId, text, pos!.next],
    );
  }
  listChecklist(tenantId: string, taskId: string) {
    return this.db.many(`SELECT * FROM task_checklist_items WHERE tenant_id=$1 AND task_id=$2 ORDER BY position`, [tenantId, taskId]);
  }
  updateChecklistItem(tenantId: string, id: string, patch: { text?: string; isDone?: boolean }) {
    const sets: string[] = []; const vals: any[] = []; let i = 1;
    if (patch.text !== undefined) { sets.push(`text=$${i++}`); vals.push(patch.text); }
    if (patch.isDone !== undefined) { sets.push(`is_done=$${i++}`); vals.push(patch.isDone); }
    if (!sets.length) return this.db.one(`SELECT * FROM task_checklist_items WHERE tenant_id=$1 AND id=$2`, [tenantId, id]);
    vals.push(tenantId, id);
    return this.db.one(`UPDATE task_checklist_items SET ${sets.join(', ')} WHERE tenant_id=$${i++} AND id=$${i} RETURNING *`, vals);
  }
  async deleteChecklistItem(tenantId: string, id: string) {
    await this.db.query(`DELETE FROM task_checklist_items WHERE tenant_id=$1 AND id=$2`, [tenantId, id]);
  }

  // ---- labels dict ----
  listLabels(tenantId: string) { return this.db.many(`SELECT * FROM labels WHERE tenant_id=$1 ORDER BY name`, [tenantId]); }
  createLabel(tenantId: string, name: string, color: string) {
    return this.db.one(`INSERT INTO labels (tenant_id, name, color) VALUES ($1,$2,$3) RETURNING *`, [tenantId, name, color]);
  }
  async deleteLabel(tenantId: string, id: string) { await this.db.query(`DELETE FROM labels WHERE tenant_id=$1 AND id=$2`, [tenantId, id]); }
  async assignLabel(tenantId: string, taskId: string, labelId: string) {
    await this.db.query(
      `INSERT INTO task_labels (tenant_id, task_id, label_id)
       SELECT $1,$2,$3 WHERE EXISTS (SELECT 1 FROM labels WHERE id=$3 AND tenant_id=$1)
       ON CONFLICT DO NOTHING`,
      [tenantId, taskId, labelId],
    );
  }
  async unassignLabel(taskId: string, labelId: string) {
    await this.db.query(`DELETE FROM task_labels WHERE task_id=$1 AND label_id=$2`, [taskId, labelId]);
  }
  labelsForTask(tenantId: string, taskId: string) {
    return this.db.many(
      `SELECT l.id, l.name, l.color FROM task_labels tl JOIN labels l ON l.id=tl.label_id
        WHERE tl.tenant_id=$1 AND tl.task_id=$2 ORDER BY l.name`,
      [tenantId, taskId],
    );
  }

  // ---- watchers ----
  async addWatcher(tenantId: string, taskId: string, userId: string) {
    await this.db.query(
      `INSERT INTO task_watchers (tenant_id, task_id, user_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
      [tenantId, taskId, userId],
    );
  }
  async removeWatcher(taskId: string, userId: string) {
    await this.db.query(`DELETE FROM task_watchers WHERE task_id=$1 AND user_id=$2`, [taskId, userId]);
  }
  watchers(tenantId: string, taskId: string): Promise<Array<{ user_id: string }>> {
    return this.db.many(`SELECT user_id FROM task_watchers WHERE tenant_id=$1 AND task_id=$2`, [tenantId, taskId]);
  }

  // ---- board enrichment (метки + счётчики + прогресс чеклиста по проекту) ----
  async boardMeta(tenantId: string, projectId: string) {
    const labels = await this.db.many<{ task_id: string; id: string; name: string; color: string }>(
      `SELECT tl.task_id, l.id, l.name, l.color FROM task_labels tl JOIN labels l ON l.id=tl.label_id
        WHERE tl.tenant_id=$1 AND tl.task_id IN (SELECT id FROM tasks WHERE tenant_id=$1 AND project_id=$2)`,
      [tenantId, projectId],
    );
    const counts = await this.db.many<{ task_id: string; comments: string; attachments: string; cl_total: string; cl_done: string }>(
      `SELECT t.id AS task_id,
              (SELECT COUNT(*) FROM task_comments c WHERE c.task_id=t.id) AS comments,
              (SELECT COUNT(*) FROM task_attachments a WHERE a.task_id=t.id) AS attachments,
              (SELECT COUNT(*) FROM task_checklist_items ci WHERE ci.task_id=t.id) AS cl_total,
              (SELECT COUNT(*) FROM task_checklist_items ci WHERE ci.task_id=t.id AND ci.is_done) AS cl_done
         FROM tasks t WHERE t.tenant_id=$1 AND t.project_id=$2`,
      [tenantId, projectId],
    );
    return { labels, counts };
  }
}
