import { Injectable } from '@nestjs/common';
import { projectVisibleSql, ProjectViewer, viewerParams } from '../../common/access/project-visibility';
import { DbService } from '../../database/db.service';

export interface CheckTaskRow {
  id: string;
  title: string;
  description: string | null;
  project_id: string;
  created_by: string | null;
  creator_name: string | null;
  assignee_id: string | null;
  assignee_name: string | null;
  approval_state: string | null;
  closed_at: Date | null;
  created_at: Date;
}

export interface ReportRow {
  id: string;
  task_id: string;
  version: number;
  status: 'running' | 'ready' | 'failed';
  trigger: 'manual' | 'auto';
  requested_by: string | null;
  requested_by_name: string | null;
  fingerprint: string;
  items: unknown[];
  summary: Record<string, unknown>;
  mode: 'ai' | 'eyes';
  model: string | null;
  input_tokens: number;
  output_tokens: number;
  error: string | null;
  created_at: Date;
  finished_at: Date | null;
}

const TASK_COLUMNS = `t.id::text, t.title, t.description, t.project_id::text, t.created_by::text,
  um.full_name AS creator_name, t.assignee_id::text, ua.full_name AS assignee_name,
  t.approval_state, t.closed_at, t.created_at`;

const REPORT_COLUMNS = `r.id::text, r.task_id::text, r.version, r.status, r.trigger, r.requested_by::text,
  u.full_name AS requested_by_name, r.fingerprint, r.items, r.summary, r.mode, r.model,
  r.input_tokens, r.output_tokens, r.error, r.created_at, r.finished_at`;

@Injectable()
export class BeforeAfterRepository {
  constructor(private readonly db: DbService) {}

  /**
   * Задача, которую человек видит: проект виден по общему правилу, либо он сам в
   * задаче — исполнитель, постановщик или участник. Чужая — как несуществующая.
   */
  visibleTask(tenantId: string, taskId: string, viewer: ProjectViewer): Promise<CheckTaskRow | null> {
    if (!/^\d+$/.test(String(taskId))) return Promise.resolve(null);
    return this.db.one<CheckTaskRow>(
      `SELECT ${TASK_COLUMNS}
         FROM tasks t
    LEFT JOIN users ua ON ua.id = t.assignee_id
    LEFT JOIN users um ON um.id = t.created_by
        WHERE t.tenant_id = $1 AND t.id = $2 AND t.deleted_at IS NULL
          AND (${projectVisibleSql('t.project_id', { user: '$3', all: '$4', client: '$5' })}
               OR t.assignee_id = $3::bigint OR t.created_by = $3::bigint
               OR EXISTS (SELECT 1 FROM task_participants tp WHERE tp.task_id = t.id AND tp.user_id = $3::bigint))`,
      [tenantId, taskId, ...viewerParams(viewer)],
    );
  }

  /** Та же задача без проверки прав — для автозапуска, где зрителя нет. */
  task(tenantId: string, taskId: string): Promise<CheckTaskRow | null> {
    return this.db.one<CheckTaskRow>(
      `SELECT ${TASK_COLUMNS}
         FROM tasks t
    LEFT JOIN users ua ON ua.id = t.assignee_id
    LEFT JOIN users um ON um.id = t.created_by
        WHERE t.tenant_id = $1 AND t.id = $2 AND t.deleted_at IS NULL`,
      [tenantId, taskId],
    );
  }

  /** Исполнитель и соисполнители: их файлы и сообщения — результат. */
  async doers(tenantId: string, taskId: string, assigneeId: string | null): Promise<string[]> {
    const rows = await this.db.many<{ user_id: string }>(
      `SELECT user_id::text FROM task_participants WHERE tenant_id = $1 AND task_id = $2 AND role = 'co_assignee'`,
      [tenantId, taskId],
    );
    return [...new Set([...(assigneeId ? [String(assigneeId)] : []), ...rows.map((r) => r.user_id)])];
  }

  checklist(tenantId: string, taskId: string) {
    return this.db.many<{ text: string; is_done: boolean }>(
      `SELECT text, is_done FROM task_checklist_items WHERE tenant_id = $1 AND task_id = $2 ORDER BY position`,
      [tenantId, taskId],
    );
  }

  /**
   * Вложения со всем, что нужно для решения «было или стало»: кто приложил, когда и
   * с каким сообщением (подпись картинки в обсуждении часто и есть номер пункта).
   */
  attachments(tenantId: string, taskId: string) {
    return this.db.many<{
      file_id: string; file_name: string; content_type: string; size_bytes: string;
      created_at: Date; uploaded_by: string | null; author: string | null; caption: string | null;
    }>(
      `SELECT a.file_id::text, f.file_name, f.content_type, f.size_bytes::text, a.created_at,
              f.uploaded_by::text, u.full_name AS author,
              (SELECT c.body FROM task_comments c
                 LEFT JOIN task_comment_files cf ON cf.comment_id = c.id AND cf.file_id = a.file_id
                WHERE c.tenant_id = a.tenant_id AND c.task_id = a.task_id
                  AND (c.file_id = a.file_id OR cf.file_id IS NOT NULL)
                ORDER BY c.id LIMIT 1) AS caption
         FROM task_attachments a
         JOIN files f ON f.id = a.file_id
    LEFT JOIN users u ON u.id = f.uploaded_by
        WHERE a.tenant_id = $1 AND a.task_id = $2
        ORDER BY a.created_at, a.id`,
      [tenantId, taskId],
    );
  }

  /** Сообщения людей в обсуждении (без ответов помощника и системных строк). */
  comments(tenantId: string, taskId: string) {
    return this.db.many<{ id: string; author_id: string | null; author: string | null; body: string; created_at: Date }>(
      `SELECT c.id::text, c.author_id::text, u.full_name AS author, COALESCE(c.body, '') AS body, c.created_at
         FROM task_comments c LEFT JOIN users u ON u.id = c.author_id
        WHERE c.tenant_id = $1 AND c.task_id = $2 AND NOT c.is_ai AND NOT COALESCE(c.is_system, FALSE)
        ORDER BY c.created_at, c.id`,
      [tenantId, taskId],
    );
  }

  /**
   * Результаты ИИ-агента: сообщение запуска и файлы, приложенные за время запуска
   * (агент кладёт .docx сразу после переноса на проверку — «чуть позже» входит).
   */
  async agentOutput(tenantId: string, taskId: string): Promise<{ commentIds: string[]; fileIds: string[] }> {
    const [comments, files] = await Promise.all([
      this.db.many<{ comment_id: string }>(
        `SELECT comment_id::text FROM agent_runs
          WHERE tenant_id = $1 AND task_id = $2 AND status = 'done' AND comment_id IS NOT NULL`,
        [tenantId, taskId],
      ).catch(() => []),
      this.db.many<{ file_id: string }>(
        `SELECT DISTINCT a.file_id::text
           FROM agent_runs r
           JOIN task_attachments a ON a.tenant_id = r.tenant_id AND a.task_id = r.task_id
           JOIN files f ON f.id = a.file_id AND f.uploaded_by = r.created_by
          WHERE r.tenant_id = $1 AND r.task_id = $2 AND r.status = 'done'
            AND a.created_at BETWEEN r.created_at AND COALESCE(r.finished_at, r.created_at) + interval '3 minutes'`,
        [tenantId, taskId],
      ).catch(() => []),
    ]);
    return { commentIds: comments.map((c) => c.comment_id), fileIds: files.map((f) => f.file_id) };
  }

  /** Первый переход задачи в другой этап — граница «до/после» для задачи «сам себе». */
  async firstTransition(tenantId: string, taskId: string): Promise<Date | null> {
    const r = await this.db.one<{ at: Date | null }>(
      `SELECT min(changed_at) AS at FROM task_status_transitions WHERE tenant_id = $1 AND task_id = $2`,
      [tenantId, taskId],
    ).catch(() => null);
    return r?.at ?? null;
  }

  // ───── отчёты ─────

  list(tenantId: string, taskId: string) {
    return this.db.many<ReportRow>(
      `SELECT ${REPORT_COLUMNS} FROM task_check_reports r LEFT JOIN users u ON u.id = r.requested_by
        WHERE r.tenant_id = $1 AND r.task_id = $2 ORDER BY r.version DESC LIMIT 50`,
      [tenantId, taskId],
    );
  }

  get(tenantId: string, taskId: string, id: string) {
    if (!/^\d+$/.test(String(id))) return Promise.resolve(null);
    return this.db.one<ReportRow>(
      `SELECT ${REPORT_COLUMNS} FROM task_check_reports r LEFT JOIN users u ON u.id = r.requested_by
        WHERE r.tenant_id = $1 AND r.task_id = $2 AND r.id = $3`,
      [tenantId, taskId, id],
    );
  }

  /** Последний отчёт; зависший дольше 10 минут сначала помечаем неудачным. */
  async latest(tenantId: string, taskId: string): Promise<ReportRow | null> {
    await this.db.query(
      `UPDATE task_check_reports SET status = 'failed', error = 'Проверка не завершилась — запустите ещё раз', finished_at = now()
        WHERE tenant_id = $1 AND task_id = $2 AND status = 'running' AND created_at < now() - interval '10 minutes'`,
      [tenantId, taskId],
    );
    return this.db.one<ReportRow>(
      `SELECT ${REPORT_COLUMNS} FROM task_check_reports r LEFT JOIN users u ON u.id = r.requested_by
        WHERE r.tenant_id = $1 AND r.task_id = $2 ORDER BY r.version DESC LIMIT 1`,
      [tenantId, taskId],
    );
  }

  /** Последний ГОТОВЫЙ — с ним сравниваем отпечаток. */
  latestReady(tenantId: string, taskId: string) {
    return this.db.one<{ id: string; fingerprint: string }>(
      `SELECT id::text, fingerprint FROM task_check_reports
        WHERE tenant_id = $1 AND task_id = $2 AND status = 'ready' ORDER BY version DESC LIMIT 1`,
      [tenantId, taskId],
    );
  }

  /** Сколько отчётов компания запустила за сутки — дневной предел. */
  async countToday(tenantId: string): Promise<number> {
    const r = await this.db.one<{ n: number }>(
      `SELECT count(*)::int AS n FROM task_check_reports WHERE tenant_id = $1 AND created_at > now() - interval '1 day'`,
      [tenantId],
    );
    return r?.n ?? 0;
  }

  /**
   * Новая версия. Номер — следующий по задаче; гонку двух одновременных запусков
   * ловит уникальность (task_id, version): второй получит null и покажет первый.
   */
  async create(tenantId: string, taskId: string, trigger: 'manual' | 'auto', userId: string | null, fp: string): Promise<string | null> {
    try {
      const r = await this.db.one<{ id: string }>(
        `INSERT INTO task_check_reports (tenant_id, task_id, version, trigger, requested_by, fingerprint)
         VALUES ($1, $2, COALESCE((SELECT max(version) FROM task_check_reports WHERE task_id = $2), 0) + 1, $3, $4, $5)
         RETURNING id::text`,
        [tenantId, taskId, trigger, userId, fp],
      );
      return r?.id ?? null;
    } catch (e) {
      if ((e as { code?: string }).code === '23505') return null;
      throw e;
    }
  }

  async finish(tenantId: string, id: string, r: {
    items: unknown[]; summary: Record<string, unknown>; mode: 'ai' | 'eyes'; model: string | null;
    inputTokens: number; outputTokens: number;
  }): Promise<void> {
    await this.db.query(
      `UPDATE task_check_reports
          SET status = 'ready', items = $3::jsonb, summary = $4::jsonb, mode = $5, model = $6,
              input_tokens = $7, output_tokens = $8, finished_at = now()
        WHERE tenant_id = $1 AND id = $2`,
      [tenantId, id, JSON.stringify(r.items), JSON.stringify(r.summary), r.mode, r.model, r.inputTokens, r.outputTokens],
    );
  }

  async fail(tenantId: string, id: string, error: string): Promise<void> {
    await this.db.query(
      `UPDATE task_check_reports SET status = 'failed', error = $3, finished_at = now() WHERE tenant_id = $1 AND id = $2`,
      [tenantId, id, error.slice(0, 500)],
    );
  }

  // ───── роли снимков руками ─────

  /** Роли, которые люди выбрали руками: главнее модели и правил. */
  shotRoles(tenantId: string, taskId: string) {
    return this.db.many<{ file_id: string; role: 'before' | 'example' | 'after' | 'none' }>(
      `SELECT file_id::text, role FROM task_check_shot_roles WHERE tenant_id = $1 AND task_id = $2 ORDER BY file_id`,
      [tenantId, taskId],
    );
  }

  /**
   * Поставить роль снимку (null — вернуть «как решит система»). Только снимку этой
   * задачи: чужой файл — false, как несуществующий.
   */
  async setShotRole(tenantId: string, taskId: string, fileId: string, role: string | null, userId: string): Promise<boolean> {
    if (!/^\d+$/.test(String(fileId))) return false;
    const own = await this.db.one<{ ok: number }>(
      `SELECT 1 AS ok FROM task_attachments WHERE tenant_id = $1 AND task_id = $2 AND file_id = $3 LIMIT 1`,
      [tenantId, taskId, fileId],
    );
    if (!own) return false;
    if (!role) {
      await this.db.query(`DELETE FROM task_check_shot_roles WHERE tenant_id = $1 AND task_id = $2 AND file_id = $3`, [tenantId, taskId, fileId]);
      return true;
    }
    await this.db.query(
      `INSERT INTO task_check_shot_roles (tenant_id, task_id, file_id, role, set_by)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (task_id, file_id) DO UPDATE SET role = EXCLUDED.role, set_by = EXCLUDED.set_by, set_at = now()`,
      [tenantId, taskId, fileId, role, userId],
    );
    return true;
  }

  // ───── отметки по отчёту ─────

  /**
   * Отметить «попросили результат» — один раз на отчёт и не чаще раза в сутки по задаче:
   * повторное нажатие (или второй человек) сообщение исполнителю не дублирует.
   * true — отметили сейчас, можно писать исполнителю.
   */
  async markAskedResult(tenantId: string, taskId: string, reportId: string, userName: string): Promise<boolean> {
    if (!/^\d+$/.test(String(reportId))) return false;
    const r = await this.db.one<{ id: string }>(
      `UPDATE task_check_reports r
          SET summary = r.summary || jsonb_build_object('askedResult', jsonb_build_object('by', $4::text, 'at', now()))
        WHERE r.tenant_id = $1 AND r.task_id = $2 AND r.id = $3 AND r.status = 'ready'
          AND r.summary->'askedResult' IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM task_check_reports o
             WHERE o.tenant_id = $1 AND o.task_id = $2 AND o.summary->'askedResult' IS NOT NULL
               AND (o.summary->'askedResult'->>'at')::timestamptz > now() - interval '1 day')
        RETURNING r.id::text`,
      [tenantId, taskId, reportId, userName],
    );
    return !!r;
  }

  /** Сообщение не ушло — снимаем отметку, чтобы можно было попросить ещё раз. */
  async unmarkAskedResult(tenantId: string, reportId: string): Promise<void> {
    await this.db.query(
      `UPDATE task_check_reports SET summary = summary - 'askedResult' WHERE tenant_id = $1 AND id = $2`,
      [tenantId, reportId],
    );
  }

  /** «Проверено» у пункта чек-листа приёмки — отметка постановщика в самом отчёте. */
  async setChecked(tenantId: string, taskId: string, reportId: string, n: number, checked: boolean, userName: string): Promise<boolean> {
    if (!/^\d+$/.test(String(reportId))) return false;
    const r = checked
      ? await this.db.one<{ id: string }>(
        `UPDATE task_check_reports
            SET summary = jsonb_set(summary, '{checked}',
                  COALESCE(summary->'checked', '{}'::jsonb) || jsonb_build_object($4::text, jsonb_build_object('by', $5::text, 'at', now())))
          WHERE tenant_id = $1 AND task_id = $2 AND id = $3 AND status = 'ready'
          RETURNING id::text`,
        [tenantId, taskId, reportId, String(n), userName],
      )
      : await this.db.one<{ id: string }>(
        `UPDATE task_check_reports SET summary = summary #- ARRAY['checked', $4::text]
          WHERE tenant_id = $1 AND task_id = $2 AND id = $3 AND status = 'ready'
          RETURNING id::text`,
        [tenantId, taskId, reportId, String(n)],
      );
    return !!r;
  }

  /** Имя человека — для подписи отметок в отчёте. */
  async userName(tenantId: string, userId: string): Promise<string | null> {
    const r = await this.db.one<{ full_name: string | null }>(
      `SELECT full_name FROM users WHERE tenant_id = $1 AND id = $2`,
      [tenantId, userId],
    );
    return r?.full_name ?? null;
  }

  /** Сообщение помощника в обсуждение задачи — как у «Проверить ИИ». */
  async aiComment(tenantId: string, taskId: string, authorId: string, body: string): Promise<string | null> {
    const r = await this.db.one<{ id: string }>(
      `INSERT INTO task_comments (tenant_id, task_id, author_id, body, is_client_visible, is_ai)
       VALUES ($1, $2, $3, $4, false, true) RETURNING id::text`,
      [tenantId, taskId, authorId, body],
    );
    return r?.id ?? null;
  }
}
