import { Injectable } from '@nestjs/common';
import { DbService } from '../../database/db.service';

@Injectable()
export class TaskCardRepository {
  constructor(private readonly db: DbService) {}

  // ---- comments ----
  addComment(
    tenantId: string, taskId: string, authorId: string, body: string, clientVisible: boolean,
    replyToId?: string | null,
  ) {
    return this.db.one(
      `INSERT INTO task_comments (tenant_id, task_id, author_id, body, is_client_visible, reply_to_id)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [tenantId, taskId, authorId, body, clientVisible, replyToId ?? null],
    );
  }
  listComments(tenantId: string, taskId: string, includePrivate: boolean, viewerId: string) {
    return this.db.many(
      // is_ai — чтобы в ленте было видно, кто говорит: ответ помощника нельзя
      // спутать с указанием постановщика
      // Цитата приезжает вместе с сообщением: без неё «да, согласен» через десять
      // реплик — согласие неизвестно с чем, и лезть за ним отдельным запросом
      // на каждое сообщение слишком дорого.
      `SELECT c.id, c.author_id, c.body, c.is_client_visible, c.is_ai, c.created_at, c.edited_at,
              c.reply_to_id,
              r.body AS reply_body, ru.full_name AS reply_author,
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
        WHERE c.tenant_id=$1 AND c.task_id=$2 AND ($3 OR c.is_client_visible=TRUE)
        ORDER BY c.created_at ASC`,
      [tenantId, taskId, includePrivate, viewerId],
    );
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
