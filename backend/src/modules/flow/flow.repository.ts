import { Injectable } from '@nestjs/common';
import { DbService } from '../../database/db.service';

export interface BlockerRow {
  id: string; task_id: string; reason: string; need: string; helper_id: string | null; helper_name: string | null;
  next_step: string; due_on: string | null; created_by: string | null; created_at: Date;
}
export interface HandoffRow {
  id: string; task_id: string; version: number; author_id: string | null; author_name: string | null;
  done_text: string; where_text: string; limits_text: string; reviewer_id: string | null; created_at: Date;
  decision: string | null; decided_by: string | null; decided_at: Date | null; decision_note: string | null;
}
export interface ViewRow {
  id: string; project_id: string; owner_id: string; owner_name: string | null; name: string;
  query: Record<string, unknown>; shared: boolean; updated_at: Date;
}
export interface RuleRow {
  id: string; project_id: string; trigger: string; action: string; enabled: boolean;
  created_by: string | null; author_name: string | null; created_at: Date; runs: number; last_run_at: Date | null;
}

/** Видит ли человек проект задачи — то же правило, что у списка проектов. */
const SEES_PROJECT = (p: string, user: string, boss: string) => `(${boss} OR ${p}.visibility = 'all' OR ${p}.owner_user_id = ${user}
  OR EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id = ${p}.id AND pm.user_id = ${user}))`;

@Injectable()
export class FlowRepository {
  constructor(private readonly db: DbService) {}

  // ── доска: всё, чего нет в строке задачи ──

  /** Открытые препятствия проекта — по одному на задачу. */
  blockersByProject(tenantId: string, projectId: string): Promise<BlockerRow[]> {
    return this.db.many<BlockerRow>(
      `SELECT b.id::text, b.task_id::text, b.reason, b.need, b.helper_id::text, u.full_name AS helper_name,
              b.next_step, to_char(b.due_on, 'YYYY-MM-DD') AS due_on, b.created_by::text, b.created_at
         FROM task_blockers b JOIN tasks t ON t.id = b.task_id
         LEFT JOIN users u ON u.id = b.helper_id
        WHERE b.tenant_id = $1 AND t.project_id = $2 AND b.resolved_at IS NULL`,
      [tenantId, projectId],
    );
  }

  /** Связи «ждёт задачу» для задач проекта: с названием и состоянием той, которую ждут. */
  linksByProject(tenantId: string, projectId: string) {
    return this.db.many<{ task_id: string; depends_on_id: string; title: string; closed: boolean; deadline_at: Date | null; project_id: string }>(
      `SELECT l.task_id::text, l.depends_on_id::text, d.title, d.closed_at IS NOT NULL AS closed, d.deadline_at, d.project_id::text
         FROM task_links l JOIN tasks t ON t.id = l.task_id JOIN tasks d ON d.id = l.depends_on_id
        WHERE l.tenant_id = $1 AND t.project_id = $2 AND d.deleted_at IS NULL`,
      [tenantId, projectId],
    );
  }

  /**
   * Когда задача попала на нынешний этап и когда по ней было хоть что-то — для «В работе
   * 3 дня» и «Нет обновления 5 дней». Причину задержки отсюда не выводим.
   */
  timingByProject(tenantId: string, projectId: string) {
    return this.db.many<{ task_id: string; stage_since: Date | null; last_activity_at: Date | null; handoff_version: number | null }>(
      `SELECT t.id::text AS task_id,
              (SELECT max(s.changed_at) FROM task_status_transitions s WHERE s.task_id = t.id) AS stage_since,
              (SELECT max(a.created_at) FROM task_activity a WHERE a.task_id = t.id) AS last_activity_at,
              (SELECT max(h.version) FROM task_handoffs h WHERE h.task_id = t.id) AS handoff_version
         FROM tasks t
        WHERE t.tenant_id = $1 AND t.project_id = $2 AND t.deleted_at IS NULL`,
      [tenantId, projectId],
    );
  }

  // ── препятствия ──

  openBlocker(tenantId: string, taskId: string): Promise<BlockerRow | null> {
    return this.db.one<BlockerRow>(
      `SELECT b.id::text, b.task_id::text, b.reason, b.need, b.helper_id::text, u.full_name AS helper_name,
              b.next_step, to_char(b.due_on, 'YYYY-MM-DD') AS due_on, b.created_by::text, b.created_at
         FROM task_blockers b LEFT JOIN users u ON u.id = b.helper_id
        WHERE b.tenant_id = $1 AND b.task_id = $2 AND b.resolved_at IS NULL`,
      [tenantId, taskId],
    );
  }

  /** Поставить или обновить препятствие: открытое — одно, повторная отметка его правит. */
  async upsertBlocker(tenantId: string, taskId: string, actorId: string, b: {
    reason: string; need: string; helperId: string | null; nextStep: string; dueOn: string | null;
  }): Promise<void> {
    const upd = await this.db.query(
      `UPDATE task_blockers SET reason = $3, need = $4, helper_id = $5::bigint, next_step = $6, due_on = $7::date
        WHERE tenant_id = $1 AND task_id = $2 AND resolved_at IS NULL`,
      [tenantId, taskId, b.reason, b.need, b.helperId, b.nextStep, b.dueOn],
    );
    if (!upd.rowCount) {
      await this.db.query(
        `INSERT INTO task_blockers (tenant_id, task_id, reason, need, helper_id, next_step, due_on, created_by)
         VALUES ($1, $2, $3, $4, $5::bigint, $6, $7::date, $8)`,
        [tenantId, taskId, b.reason, b.need, b.helperId, b.nextStep, b.dueOn, actorId],
      );
    }
    await this.db.query(`UPDATE tasks SET is_blocked = TRUE WHERE tenant_id = $1 AND id = $2`, [tenantId, taskId]);
  }

  async resolveBlocker(tenantId: string, taskId: string, actorId: string, note: string | null): Promise<boolean> {
    const r = await this.db.query(
      `UPDATE task_blockers SET resolved_at = now(), resolved_by = $3, resolve_note = $4
        WHERE tenant_id = $1 AND task_id = $2 AND resolved_at IS NULL`,
      [tenantId, taskId, actorId, note],
    );
    await this.db.query(`UPDATE tasks SET is_blocked = FALSE WHERE tenant_id = $1 AND id = $2`, [tenantId, taskId]);
    return (r.rowCount ?? 0) > 0;
  }

  // ── зависимости ──

  /** Все связи компании: граф небольшой, а цикл может пройти через чужой проект. */
  allLinks(tenantId: string) {
    return this.db.many<{ task_id: string; depends_on_id: string }>(
      `SELECT task_id::text, depends_on_id::text FROM task_links WHERE tenant_id = $1`,
      [tenantId],
    );
  }

  linksOf(tenantId: string, taskId: string) {
    return this.db.many<{ dir: 'waits' | 'blocks'; id: string; title: string; closed: boolean; deadline_at: Date | null; project_id: string; assignee_name: string | null }>(
      `SELECT 'waits' AS dir, d.id::text, d.title, d.closed_at IS NOT NULL AS closed, d.deadline_at, d.project_id::text, u.full_name AS assignee_name
         FROM task_links l JOIN tasks d ON d.id = l.depends_on_id LEFT JOIN users u ON u.id = d.assignee_id
        WHERE l.tenant_id = $1 AND l.task_id = $2 AND d.deleted_at IS NULL
       UNION ALL
       SELECT 'blocks', t.id::text, t.title, t.closed_at IS NOT NULL, t.deadline_at, t.project_id::text, u.full_name
         FROM task_links l JOIN tasks t ON t.id = l.task_id LEFT JOIN users u ON u.id = t.assignee_id
        WHERE l.tenant_id = $1 AND l.depends_on_id = $2 AND t.deleted_at IS NULL`,
      [tenantId, taskId],
    );
  }

  async addLink(tenantId: string, taskId: string, dependsOn: string, actorId: string): Promise<boolean> {
    const r = await this.db.query(
      `INSERT INTO task_links (tenant_id, task_id, depends_on_id, created_by) VALUES ($1, $2, $3, $4)
       ON CONFLICT DO NOTHING`,
      [tenantId, taskId, dependsOn, actorId],
    );
    return (r.rowCount ?? 0) > 0;
  }

  async removeLink(tenantId: string, taskId: string, dependsOn: string): Promise<boolean> {
    const r = await this.db.query(
      `DELETE FROM task_links WHERE tenant_id = $1 AND task_id = $2 AND depends_on_id = $3`,
      [tenantId, taskId, dependsOn],
    );
    return (r.rowCount ?? 0) > 0;
  }

  /**
   * Задачи, которые ждали только что закрытую, — один раз: отметка notified_at ставится
   * тем же запросом, повторное закрытие (вернули и закрыли снова) не шлёт второе «можно».
   */
  claimDependents(tenantId: string, closedId: string) {
    return this.db.many<{ task_id: string; title: string; assignee_id: string | null; open_left: number }>(
      `WITH c AS (
         UPDATE task_links SET notified_at = now()
          WHERE tenant_id = $1 AND depends_on_id = $2 AND notified_at IS NULL
          RETURNING task_id)
       SELECT t.id::text AS task_id, t.title, t.assignee_id::text,
              (SELECT count(*)::int FROM task_links l2 JOIN tasks d2 ON d2.id = l2.depends_on_id
                WHERE l2.task_id = t.id AND d2.closed_at IS NULL AND d2.id <> $2::bigint AND d2.deleted_at IS NULL) AS open_left
         FROM c JOIN tasks t ON t.id = c.task_id
        WHERE t.deleted_at IS NULL AND t.closed_at IS NULL`,
      [tenantId, closedId],
    );
  }

  /** Вернули в работу — «можно приступать» по ней придётся сказать снова, когда закроют. */
  async resetDependents(tenantId: string, taskId: string): Promise<void> {
    await this.db.query(`UPDATE task_links SET notified_at = NULL WHERE tenant_id = $1 AND depends_on_id = $2`, [tenantId, taskId]);
  }

  // ── сдача на проверку ──

  async addHandoff(tenantId: string, taskId: string, authorId: string, h: {
    done: string; where: string; limits: string; reviewerId: string | null;
  }): Promise<HandoffRow> {
    const row = await this.db.one<HandoffRow>(
      `INSERT INTO task_handoffs (tenant_id, task_id, version, author_id, done_text, where_text, limits_text, reviewer_id)
       VALUES ($1, $2, coalesce((SELECT max(version) FROM task_handoffs WHERE task_id = $2::bigint), 0) + 1, $3, $4, $5, $6, $7::bigint)
       RETURNING id::text, task_id::text, version, author_id::text, NULL::text AS author_name, done_text, where_text, limits_text,
                 reviewer_id::text, created_at, decision, decided_by::text, decided_at, decision_note`,
      [tenantId, taskId, authorId, h.done, h.where, h.limits, h.reviewerId],
    );
    if (h.reviewerId) {
      await this.db.query(`UPDATE tasks SET reviewer_id = $3::bigint WHERE tenant_id = $1 AND id = $2`, [tenantId, taskId, h.reviewerId]);
    }
    return row!;
  }

  handoffs(tenantId: string, taskId: string): Promise<HandoffRow[]> {
    return this.db.many<HandoffRow>(
      `SELECT h.id::text, h.task_id::text, h.version, h.author_id::text, u.full_name AS author_name, h.done_text, h.where_text,
              h.limits_text, h.reviewer_id::text, h.created_at, h.decision, h.decided_by::text, h.decided_at, h.decision_note
         FROM task_handoffs h LEFT JOIN users u ON u.id = h.author_id
        WHERE h.tenant_id = $1 AND h.task_id = $2 ORDER BY h.version DESC`,
      [tenantId, taskId],
    );
  }

  /** Решение по версии — один раз: второй клик и повтор запроса ничего не пишут. */
  async decideHandoff(tenantId: string, taskId: string, version: number, actorId: string, decision: 'accepted' | 'returned', note: string | null): Promise<boolean> {
    const r = await this.db.query(
      `UPDATE task_handoffs SET decision = $4, decided_by = $5, decided_at = now(), decision_note = $6
        WHERE tenant_id = $1 AND task_id = $2 AND version = $3 AND decision IS NULL`,
      [tenantId, taskId, version, decision, actorId, note],
    );
    return (r.rowCount ?? 0) > 0;
  }

  /**
   * Очередь «Ждут моего решения»: работа сдана (этап проверки, тестирования или
   * согласования), не принята, и решать мне — я назначенный проверяющий, а если его
   * нет, постановщик. Только из проектов, которые я вижу.
   */
  reviewQueue(tenantId: string, userId: string, role: string) {
    const boss = role === 'owner' || role === 'manager' ? 'TRUE' : 'FALSE';
    return this.db.many<{
      id: string; title: string; description: string | null; project_id: string; project_name: string;
      column_name: string; assignee_id: string | null; assignee_name: string | null; created_by: string | null;
      creator_name: string | null; reviewer_id: string | null; deadline_at: Date | null; submitted_at: Date | null;
      first_submitted_at: Date | null; returned_at: Date | null; version: number; approval_state: string;
      checklist_total: number; checklist_done: number;
    }>(
      `SELECT t.id::text, t.title, t.description, t.project_id::text, p.name AS project_name, c.name AS column_name,
              t.assignee_id::text, ua.full_name AS assignee_name, t.created_by::text, uc.full_name AS creator_name,
              t.reviewer_id::text, t.deadline_at, t.submitted_at, t.first_submitted_at, t.returned_at, t.version, t.approval_state,
              (SELECT count(*)::int FROM task_checklist_items ci WHERE ci.task_id = t.id) AS checklist_total,
              (SELECT count(*)::int FROM task_checklist_items ci WHERE ci.task_id = t.id AND ci.is_done) AS checklist_done
         FROM tasks t
         JOIN board_columns c ON c.id = t.column_id
         JOIN projects p ON p.id = t.project_id
         LEFT JOIN users ua ON ua.id = t.assignee_id
         LEFT JOIN users uc ON uc.id = t.created_by
        WHERE t.tenant_id = $1 AND t.deleted_at IS NULL AND t.closed_at IS NULL AND p.status <> 'archived'
          AND (t.approval_state = 'pending' OR c.stage_type IN ('testing', 'review', 'approval'))
          AND coalesce(t.reviewer_id, t.created_by) = $2::bigint
          AND ${SEES_PROJECT('p', '$2::bigint', boss)}
        ORDER BY coalesce(t.submitted_at, t.updated_at) ASC
        LIMIT 200`,
      [tenantId, userId],
    );
  }

  checklist(tenantId: string, taskId: string) {
    return this.db.many<{ text: string; is_done: boolean }>(
      `SELECT text, is_done FROM task_checklist_items WHERE tenant_id = $1 AND task_id = $2 ORDER BY position, id`,
      [tenantId, taskId],
    );
  }

  files(tenantId: string, taskId: string) {
    return this.db.many<{ id: string; name: string; mime: string; created_at: Date }>(
      `SELECT f.id::text, f.file_name AS name, f.content_type AS mime, a.created_at
         FROM task_attachments a JOIN files f ON f.id = a.file_id
        WHERE a.tenant_id = $1 AND a.task_id = $2 ORDER BY a.created_at DESC LIMIT 30`,
      [tenantId, taskId],
    );
  }

  /** Последняя проверка ИИ — её вывод показывается рядом с результатом. */
  lastAiReview(tenantId: string, taskId: string) {
    return this.db.one<{ detail: Record<string, unknown>; created_at: Date }>(
      `SELECT detail, created_at FROM task_activity
        WHERE tenant_id = $1 AND task_id = $2 AND kind = 'ai_review' ORDER BY id DESC LIMIT 1`,
      [tenantId, taskId],
    );
  }

  /** Последний отчёт «было/стало»: итог по пунктам, без снимков. */
  lastCheckReport(tenantId: string, taskId: string) {
    return this.db.one<{ version: number; status: string; summary: Record<string, unknown>; mode: string; finished_at: Date | null }>(
      `SELECT version, status, summary, mode, finished_at FROM task_check_reports
        WHERE tenant_id = $1 AND task_id = $2 ORDER BY version DESC LIMIT 1`,
      [tenantId, taskId],
    );
  }

  /** Когда последний раз просили обновление по задаче — не чаще раза в сутки. */
  async lastUpdateRequest(tenantId: string, taskId: string): Promise<Date | null> {
    const r = await this.db.one<{ at: Date }>(
      `SELECT max(created_at) AS at FROM task_activity WHERE tenant_id = $1 AND task_id = $2 AND kind = 'update_requested'`,
      [tenantId, taskId],
    );
    return r?.at ?? null;
  }

  // ── виды доски ──

  views(tenantId: string, projectId: string, userId: string): Promise<ViewRow[]> {
    return this.db.many<ViewRow>(
      `SELECT v.id::text, v.project_id::text, v.owner_id::text, u.full_name AS owner_name, v.name, v.query, v.shared, v.updated_at
         FROM board_views v LEFT JOIN users u ON u.id = v.owner_id
        WHERE v.tenant_id = $1 AND v.project_id = $2 AND (v.owner_id = $3::bigint OR v.shared)
        ORDER BY v.shared, lower(v.name)`,
      [tenantId, projectId, userId],
    );
  }

  view(tenantId: string, id: string): Promise<ViewRow | null> {
    return this.db.one<ViewRow>(
      `SELECT v.id::text, v.project_id::text, v.owner_id::text, NULL::text AS owner_name, v.name, v.query, v.shared, v.updated_at
         FROM board_views v WHERE v.tenant_id = $1 AND v.id = $2`,
      [tenantId, id],
    );
  }

  async createView(tenantId: string, projectId: string, ownerId: string, name: string, query: unknown, shared: boolean): Promise<string> {
    const r = await this.db.one<{ id: string }>(
      `INSERT INTO board_views (tenant_id, project_id, owner_id, name, query, shared) VALUES ($1, $2, $3, $4, $5::jsonb, $6)
       RETURNING id::text`,
      [tenantId, projectId, ownerId, name, JSON.stringify(query ?? {}), shared],
    );
    return r!.id;
  }

  async updateView(tenantId: string, id: string, patch: { name?: string; query?: unknown; shared?: boolean }): Promise<void> {
    await this.db.query(
      `UPDATE board_views SET name = coalesce($3, name), query = coalesce($4::jsonb, query), shared = coalesce($5, shared), updated_at = now()
        WHERE tenant_id = $1 AND id = $2`,
      [tenantId, id, patch.name ?? null, patch.query === undefined ? null : JSON.stringify(patch.query), patch.shared ?? null],
    );
  }

  async deleteView(tenantId: string, id: string): Promise<void> {
    await this.db.query(`DELETE FROM board_views WHERE tenant_id = $1 AND id = $2`, [tenantId, id]);
  }

  // ── порог «в работе» ──

  async setWipLimit(tenantId: string, projectId: string, limit: number | null): Promise<void> {
    await this.db.query(`UPDATE projects SET wip_limit = $3 WHERE tenant_id = $1 AND id = $2`, [tenantId, projectId, limit]);
  }

  // ── правила ──

  rules(tenantId: string, projectId: string): Promise<RuleRow[]> {
    return this.db.many<RuleRow>(
      `SELECT r.id::text, r.project_id::text, r.trigger, r.action, r.enabled, r.created_by::text, u.full_name AS author_name, r.created_at,
              (SELECT count(*)::int FROM board_rule_runs x WHERE x.rule_id = r.id) AS runs,
              (SELECT max(x.created_at) FROM board_rule_runs x WHERE x.rule_id = r.id) AS last_run_at
         FROM board_rules r LEFT JOIN users u ON u.id = r.created_by
        WHERE r.tenant_id = $1 AND r.project_id = $2 ORDER BY r.created_at`,
      [tenantId, projectId],
    );
  }

  enabledRules(tenantId: string, projectId: string, trigger: string) {
    return this.db.many<{ id: string; action: string }>(
      `SELECT id::text, action FROM board_rules WHERE tenant_id = $1 AND project_id = $2 AND trigger = $3 AND enabled`,
      [tenantId, projectId, trigger],
    );
  }

  async addRule(tenantId: string, projectId: string, trigger: string, action: string, actorId: string): Promise<void> {
    await this.db.query(
      `INSERT INTO board_rules (tenant_id, project_id, trigger, action, created_by) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (project_id, trigger, action) DO UPDATE SET enabled = TRUE`,
      [tenantId, projectId, trigger, action, actorId],
    );
  }

  async setRuleEnabled(tenantId: string, projectId: string, id: string, enabled: boolean): Promise<void> {
    await this.db.query(`UPDATE board_rules SET enabled = $4 WHERE tenant_id = $1 AND project_id = $2 AND id = $3`, [tenantId, projectId, id, enabled]);
  }

  async deleteRule(tenantId: string, projectId: string, id: string): Promise<void> {
    await this.db.query(`DELETE FROM board_rules WHERE tenant_id = $1 AND project_id = $2 AND id = $3`, [tenantId, projectId, id]);
  }

  /** Записать срабатывание; false — это событие по этому правилу уже было. */
  async claimRun(tenantId: string, ruleId: string, taskId: string | null, eventKey: string): Promise<string | null> {
    const r = await this.db.one<{ id: string }>(
      `INSERT INTO board_rule_runs (tenant_id, rule_id, task_id, event_key) VALUES ($1, $2, $3, $4)
       ON CONFLICT (rule_id, event_key) DO NOTHING RETURNING id::text`,
      [tenantId, ruleId, taskId, eventKey.slice(0, 160)],
    );
    return r?.id ?? null;
  }

  async setRunRecipients(id: string, n: number): Promise<void> {
    await this.db.query(`UPDATE board_rule_runs SET recipients = $2 WHERE id = $1`, [id, n]);
  }

  ruleRuns(tenantId: string, projectId: string) {
    return this.db.many<{ id: string; rule_id: string; task_id: string | null; title: string | null; recipients: number; created_at: Date }>(
      `SELECT x.id::text, x.rule_id::text, x.task_id::text, t.title, x.recipients, x.created_at
         FROM board_rule_runs x JOIN board_rules r ON r.id = x.rule_id LEFT JOIN tasks t ON t.id = x.task_id
        WHERE x.tenant_id = $1 AND r.project_id = $2 ORDER BY x.id DESC LIMIT 50`,
      [tenantId, projectId],
    );
  }

  /** Примеры для предпросмотра правила: недавние задачи проекта, на которых оно сработало бы. */
  previewTasks(tenantId: string, projectId: string, trigger: string) {
    const where = trigger === 'handed_to_review' ? `t.submitted_at > now() - interval '30 days'`
      : trigger === 'returned' ? `t.returned_at > now() - interval '30 days'`
        : trigger === 'deadline_soon' ? `t.closed_at IS NULL AND t.deadline_at BETWEEN now() AND now() + interval '7 days'`
          : trigger === 'accepted' ? `t.closed_at > now() - interval '30 days'`
            : `t.closed_at > now() - interval '30 days' AND EXISTS (SELECT 1 FROM task_links l WHERE l.depends_on_id = t.id)`;
    return this.db.many<{ id: string; title: string; assignee_name: string | null; creator_name: string | null }>(
      `SELECT t.id::text, t.title, ua.full_name AS assignee_name, uc.full_name AS creator_name
         FROM tasks t LEFT JOIN users ua ON ua.id = t.assignee_id LEFT JOIN users uc ON uc.id = t.created_by
        WHERE t.tenant_id = $1 AND t.project_id = $2 AND t.deleted_at IS NULL AND ${where}
        ORDER BY t.updated_at DESC LIMIT 3`,
      [tenantId, projectId],
    );
  }

  /** Задачи со сроком в ближайшие сутки — для правила «приближается срок». */
  dueSoon() {
    return this.db.many<{ tenant_id: string; project_id: string; id: string; deadline_at: Date }>(
      `SELECT t.tenant_id::text, t.project_id::text, t.id::text, t.deadline_at
         FROM tasks t
        WHERE t.deleted_at IS NULL AND t.closed_at IS NULL
          AND t.deadline_at BETWEEN now() AND now() + interval '24 hours'
          AND EXISTS (SELECT 1 FROM board_rules r WHERE r.project_id = t.project_id AND r.trigger = 'deadline_soon' AND r.enabled)
        LIMIT 500`,
    );
  }

  people(tenantId: string, taskId: string) {
    return this.db.one<{ project_id: string; title: string; assignee_id: string | null; created_by: string | null; reviewer_id: string | null; watchers: string[] }>(
      `SELECT t.project_id::text, t.title, t.assignee_id::text, t.created_by::text, t.reviewer_id::text,
              coalesce((SELECT array_agg(p.user_id::text) FROM task_participants p WHERE p.task_id = t.id AND p.role = 'watcher'), '{}') AS watchers
         FROM tasks t WHERE t.tenant_id = $1 AND t.id = $2`,
      [tenantId, taskId],
    );
  }

  // ── согласование клиентом ──

  async createShare(tenantId: string, taskId: string, actorId: string, token: string, s: { summary: string; result: string; fileIds: string[] }): Promise<string> {
    const r = await this.db.one<{ id: string }>(
      `INSERT INTO task_share_links (tenant_id, task_id, token, created_by, summary, result_text, file_ids)
       VALUES ($1, $2, $3, $4, $5, $6, $7::bigint[]) RETURNING id::text`,
      [tenantId, taskId, token, actorId, s.summary, s.result, s.fileIds],
    );
    return r!.id;
  }

  shares(tenantId: string, taskId: string) {
    return this.db.many<{ id: string; token: string; created_at: Date; revoked_at: Date | null; decision: string | null; decision_note: string | null; decided_at: Date | null; guest_name: string | null; file_ids: string[] }>(
      `SELECT id::text, token, created_at, revoked_at, decision, decision_note, decided_at, guest_name, file_ids::text[]
         FROM task_share_links WHERE tenant_id = $1 AND task_id = $2 ORDER BY id DESC`,
      [tenantId, taskId],
    );
  }

  async revokeShare(tenantId: string, taskId: string, id: string): Promise<boolean> {
    const r = await this.db.query(
      `UPDATE task_share_links SET revoked_at = now() WHERE tenant_id = $1 AND task_id = $2 AND id = $3 AND revoked_at IS NULL`,
      [tenantId, taskId, id],
    );
    return (r.rowCount ?? 0) > 0;
  }

  /** Ссылка гостя: только живая (не отозвана) и только у неудалённой задачи. */
  shareByToken(token: string) {
    return this.db.one<{
      id: string; tenant_id: string; task_id: string; title: string; project_id: string; summary: string; result_text: string;
      file_ids: string[]; decision: string | null; decision_note: string | null; decided_at: Date | null; created_by: string | null;
      company: string | null; author_name: string | null;
    }>(
      `SELECT s.id::text, s.tenant_id::text, s.task_id::text, t.title, t.project_id::text, s.summary, s.result_text, s.file_ids::text[],
              s.decision, s.decision_note, s.decided_at, s.created_by::text, tn.name AS company, u.full_name AS author_name
         FROM task_share_links s JOIN tasks t ON t.id = s.task_id JOIN tenants tn ON tn.id = s.tenant_id
         LEFT JOIN users u ON u.id = s.created_by
        WHERE s.token = $1 AND s.revoked_at IS NULL AND t.deleted_at IS NULL`,
      [token],
    );
  }

  shareFiles(tenantId: string, taskId: string, ids: string[]) {
    if (!ids.length) return Promise.resolve([] as { id: string; name: string; mime: string; object_key: string }[]);
    return this.db.many<{ id: string; name: string; mime: string; object_key: string }>(
      `SELECT f.id::text, f.file_name AS name, f.content_type AS mime, f.object_key
         FROM task_attachments a JOIN files f ON f.id = a.file_id
        WHERE a.tenant_id = $1 AND a.task_id = $2 AND f.id = ANY($3::bigint[])`,
      [tenantId, taskId, ids],
    );
  }

  /** Решение гостя — одно: повторная отправка ничего не меняет. */
  async decideShare(id: string, decision: 'approved' | 'changes', note: string, guestName: string): Promise<boolean> {
    const r = await this.db.query(
      `UPDATE task_share_links SET decision = $2, decision_note = $3, guest_name = $4, decided_at = now()
        WHERE id = $1 AND decision IS NULL AND revoked_at IS NULL`,
      [id, decision, note, guestName],
    );
    return (r.rowCount ?? 0) > 0;
  }
}
