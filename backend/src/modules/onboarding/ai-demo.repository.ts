import { Injectable } from '@nestjs/common';
import { DbService } from '../../database/db.service';

export interface DemoRow {
  id: string; tenant_id: string; user_id: string; status: string; mode: string; entry_point: string; variant: string;
  input: string | null; transcript: string | null; summary: string | null; error: string | null;
  demo_project_id: string | null; draft_count: number; created_task_count: number;
  started_at: Date; ended_at: Date | null; tasks_created_at: Date | null; completed_at: Date | null;
}

export interface DemoDraftRow {
  id: string; demo_id: string; idx: number; title: string; kind: string; deadline_at: Date | null;
  assignee_hint: string | null; assignee_id: string | null; status: string; task_id: string | null; error_message: string | null;
}

/** Демо «ИИ-созвон за 30 секунд» (ТЗ-24). */
@Injectable()
export class AiDemoRepository {
  constructor(private readonly db: DbService) {}

  startedToday(tenantId: string, userId: string): Promise<number> {
    return this.db.one<{ n: number }>(
      `SELECT count(*)::int AS n FROM onboarding_ai_demos
        WHERE tenant_id = $1 AND user_id = $2 AND status <> 'skipped' AND started_at > now() - interval '24 hours'`,
      [tenantId, userId],
    ).then((r) => r?.n ?? 0);
  }

  async create(i: { tenantId: string; userId: string; mode: string; entryPoint: string; status?: string }): Promise<DemoRow> {
    const row = await this.db.one<DemoRow>(
      `INSERT INTO onboarding_ai_demos (tenant_id, user_id, mode, entry_point, status)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [i.tenantId, i.userId, i.mode, i.entryPoint, i.status ?? 'started'],
    );
    return row!;
  }

  get(tenantId: string, userId: string, id: string): Promise<DemoRow | null> {
    return this.db.one<DemoRow>(
      `SELECT * FROM onboarding_ai_demos WHERE tenant_id = $1 AND user_id = $2 AND id = $3`, [tenantId, userId, id],
    );
  }

  latest(tenantId: string, userId: string): Promise<DemoRow | null> {
    return this.db.one<DemoRow>(
      `SELECT * FROM onboarding_ai_demos WHERE tenant_id = $1 AND user_id = $2 ORDER BY id DESC LIMIT 1`, [tenantId, userId],
    );
  }

  /** Новичок: учётной записи меньше двух недель. */
  isNewcomer(tenantId: string, userId: string): Promise<boolean> {
    return this.db.one<{ ok: boolean }>(
      `SELECT created_at > now() - interval '14 days' AS ok FROM users WHERE tenant_id = $1 AND id = $2`, [tenantId, userId],
    ).then((r) => !!r?.ok);
  }

  /** Принять запись: из «начато», «не вышло» или «итоги без задач» — «Сказать ещё раз» тем же демо. */
  async claimFinish(id: string, input: string): Promise<boolean> {
    const r = await this.db.query(
      `UPDATE onboarding_ai_demos SET status = 'processing', input = $2, error = NULL, ended_at = now(), updated_at = now()
        WHERE id = $1 AND (status IN ('started','failed') OR (status = 'review' AND created_task_count = 0)
                           -- разбор оборвался (перезапуск сервера посреди него) — можно повторить
                           OR (status = 'processing' AND updated_at < now() - interval '60 seconds'))`,
      [id, input],
    );
    return (r.rowCount ?? 0) > 0;
  }

  async setStatus(id: string, status: string, patch: { error?: string | null; transcript?: string | null; summary?: string | null; audioSeconds?: number | null } = {}) {
    await this.db.query(
      `UPDATE onboarding_ai_demos
          SET status = $2::text,
              error = $3,
              transcript = COALESCE($4, transcript),
              summary = COALESCE($5, summary),
              audio_seconds = COALESCE($6, audio_seconds),
              completed_at = CASE WHEN $2::text = 'completed' THEN now() ELSE completed_at END,
              updated_at = now()
        WHERE id = $1`,
      [id, status, patch.error ?? null, patch.transcript ?? null, patch.summary ?? null, patch.audioSeconds ?? null],
    );
  }

  async replaceDrafts(demoId: string, drafts: { title: string; kind: string; deadlineAt: string | null; assigneeHint: string | null; assigneeId: string | null }[]) {
    await this.db.withTransaction(async (c) => {
      await c.query(`DELETE FROM onboarding_ai_demo_drafts WHERE demo_id = $1 AND task_id IS NULL`, [demoId]);
      const base = await c.query<{ n: number }>(`SELECT COALESCE(max(idx), -1)::int + 1 AS n FROM onboarding_ai_demo_drafts WHERE demo_id = $1`, [demoId]);
      let idx = base.rows[0]?.n ?? 0;
      for (const d of drafts) {
        await c.query(
          `INSERT INTO onboarding_ai_demo_drafts (demo_id, idx, title, kind, deadline_at, assignee_hint, assignee_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [demoId, idx++, d.title, d.kind, d.deadlineAt, d.assigneeHint, d.assigneeId],
        );
      }
      await c.query(`UPDATE onboarding_ai_demos SET draft_count = $2 WHERE id = $1`, [demoId, drafts.length]);
    });
  }

  drafts(demoId: string) {
    return this.db.many<DemoDraftRow>(`SELECT * FROM onboarding_ai_demo_drafts WHERE demo_id = $1 ORDER BY idx`, [demoId]);
  }

  /** Повторный «Создать» не даёт второй задачи: черновик занимается атомарно (§52). */
  async claimDraft(id: string): Promise<boolean> {
    const r = await this.db.query(
      `UPDATE onboarding_ai_demo_drafts SET status = 'applying' WHERE id = $1 AND status IN ('pending','failed')`, [id],
    );
    return (r.rowCount ?? 0) > 0;
  }

  async draftDone(id: string, taskId: string) {
    await this.db.query(`UPDATE onboarding_ai_demo_drafts SET status = 'created', task_id = $2, error_message = NULL WHERE id = $1`, [id, taskId]);
  }

  async draftFailed(id: string, message: string) {
    await this.db.query(`UPDATE onboarding_ai_demo_drafts SET status = 'failed', error_message = $2 WHERE id = $1 AND status = 'applying'`, [id, message.slice(0, 300)]);
  }

  async dismissRest(demoId: string, keep: string[]) {
    await this.db.query(
      `UPDATE onboarding_ai_demo_drafts SET status = 'dismissed' WHERE demo_id = $1 AND status = 'pending' AND NOT (id::text = ANY($2::text[]))`,
      [demoId, keep],
    );
  }

  async tasksCreated(id: string, projectId: string) {
    await this.db.query(
      `UPDATE onboarding_ai_demos
          SET demo_project_id = $2, status = 'tasks_created', tasks_created_at = COALESCE(tasks_created_at, now()),
              created_task_count = (SELECT count(*)::int FROM onboarding_ai_demo_drafts d WHERE d.demo_id = $1 AND d.task_id IS NOT NULL),
              updated_at = now()
        WHERE id = $1`,
      [id, projectId],
    );
  }

  /** Демо-проект человека — тот же при повторных демо: второй «Мой первый AI-проект» не нужен. */
  demoProject(tenantId: string, userId: string) {
    return this.db.one<{ id: string }>(
      `SELECT p.id::text FROM onboarding_ai_demos d JOIN projects p ON p.id = d.demo_project_id
        WHERE d.tenant_id = $1 AND d.user_id = $2 AND p.is_demo AND p.status <> 'archived'
        ORDER BY d.id DESC LIMIT 1`,
      [tenantId, userId],
    );
  }

  async markDemoProject(projectId: string) {
    await this.db.query(`UPDATE projects SET is_demo = TRUE WHERE id = $1`, [projectId]);
  }

  /** «Сделать проект рабочим» (§29, §37): с этой минуты он — обычный проект. */
  async convertProject(tenantId: string, projectId: string, name: string | null): Promise<boolean> {
    const r = await this.db.query(
      `UPDATE projects SET is_demo = FALSE, name = COALESCE(NULLIF(btrim($3), ''), name), updated_at = now()
        WHERE tenant_id = $1 AND id = $2 AND is_demo`,
      [tenantId, projectId, name],
    );
    return (r.rowCount ?? 0) > 0;
  }

  team(tenantId: string) {
    return this.db.many<{ id: string; full_name: string }>(
      `SELECT u.id::text, u.full_name FROM users u JOIN roles r ON r.id = u.role_id
        WHERE u.tenant_id = $1 AND u.is_active AND r.code <> 'client' ORDER BY u.id LIMIT 200`,
      [tenantId],
    );
  }

  /**
   * Воронка демо за период (§53–57) — по фактам, без таблицы событий: начали, сказали,
   * дошли до итогов, приняли задачи, довели до конца; время до первой ценности.
   */
  funnel(days: number, vendorTenantId: string | null) {
    return this.db.one<{
      started: number; spoke: number; reviewed: number; accepted: number; completed: number; skipped: number;
      failed: number; by_text: number; median_ttfv_sec: number | null; converted: number;
    }>(
      `WITH d AS (SELECT * FROM onboarding_ai_demos
                   WHERE started_at > now() - make_interval(days => $1::int) AND tenant_id IS DISTINCT FROM $2::bigint)
       SELECT
         (SELECT count(*)::int FROM d WHERE status <> 'skipped') AS started,
         (SELECT count(*)::int FROM d WHERE transcript IS NOT NULL) AS spoke,
         (SELECT count(*)::int FROM d WHERE status IN ('review','tasks_created','completed')) AS reviewed,
         (SELECT count(*)::int FROM d WHERE created_task_count > 0) AS accepted,
         (SELECT count(*)::int FROM d WHERE status = 'completed') AS completed,
         (SELECT count(*)::int FROM d WHERE status = 'skipped') AS skipped,
         (SELECT count(*)::int FROM d WHERE status = 'failed') AS failed,
         (SELECT count(*)::int FROM d WHERE input = 'text') AS by_text,
         -- время до первой ценности: от регистрации человека до первой задачи из демо
         (SELECT round(percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM d.tasks_created_at - u.created_at)))::int
            FROM d JOIN users u ON u.id = d.user_id WHERE d.tasks_created_at IS NOT NULL) AS median_ttfv_sec,
         (SELECT count(DISTINCT d.demo_project_id)::int FROM d JOIN projects p ON p.id = d.demo_project_id WHERE NOT p.is_demo) AS converted`,
      [days, vendorTenantId],
    );
  }
}
