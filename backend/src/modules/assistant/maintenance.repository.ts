import { Injectable } from '@nestjs/common';
import { DbService } from '../../database/db.service';
import { REVIEW_COLUMN_NAMES } from '../tasks/task-columns';
import { Candidate } from './maintenance-rules';

export interface ProposalRow {
  id: string;
  kind: string;
  subject_type: string;
  subject_id: string;
  title: string;
  text: string;
  status: string;
  undo: Record<string, unknown>;
  created_at: Date;
  decided_at: Date | null;
  decided_by_name: string | null;
}

@Injectable()
export class MaintenanceRepository {
  constructor(private readonly db: DbService) {}

  /** Организации, где уборка включена и ассистент не выключен целиком. */
  activeTenants(): Promise<{ id: string }[]> {
    return this.db.many<{ id: string }>(
      `SELECT id FROM tenants WHERE maintenance_enabled AND assistant_mode <> 'off'`,
    );
  }

  async enabled(tenantId: string): Promise<boolean> {
    const row = await this.db.one<{ maintenance_enabled: boolean }>(
      `SELECT maintenance_enabled FROM tenants WHERE id = $1`, [tenantId],
    );
    return row?.maintenance_enabled !== false;
  }

  async setEnabled(tenantId: string, enabled: boolean): Promise<boolean> {
    await this.db.query(`UPDATE tenants SET maintenance_enabled = $2 WHERE id = $1`, [tenantId, enabled]);
    return enabled;
  }

  /**
   * Задачи, которые все забыли.
   *
   * Сданное на проверку не трогаем: оно ждёт человека, а не брошено — о нём напомнит
   * смарт-пинг. Задачи с исполнителем и без срока тоже брошены не всегда, но два месяца
   * без единого изменения — достаточный повод спросить.
   */
  staleTasks(tenantId: string, days: number): Promise<Candidate[]> {
    return this.db.many<Candidate>(
      `SELECT 'task_stale' AS kind, t.id::text AS "subjectId", t.title,
              EXTRACT(EPOCH FROM (now() - t.updated_at)) / 86400 AS days,
              p.name AS context
         FROM tasks t
         JOIN projects p ON p.id = t.project_id AND p.status <> 'archived'
         JOIN board_columns bc ON bc.id = t.column_id
        WHERE t.tenant_id = $1
          AND t.closed_at IS NULL
          AND lower(bc.name) <> ALL($3::text[])
          AND t.updated_at < now() - make_interval(days => $2::int)
        ORDER BY t.updated_at
        LIMIT 50`,
      [tenantId, days, REVIEW_COLUMN_NAMES],
    );
  }

  /**
   * Проекты, где всё сделано и давно тихо.
   *
   * Требуем, чтобы открытых задач НЕ БЫЛО совсем: проект с одной живой задачей —
   * это не законченный проект, а забытая работа, и архивировать его нельзя.
   * Пустые проекты (ни одной задачи) тоже берём: заведён и брошен.
   */
  idleProjects(tenantId: string, days: number): Promise<Candidate[]> {
    return this.db.many<Candidate>(
      `SELECT 'project_idle' AS kind, p.id::text AS "subjectId", p.name AS title,
              EXTRACT(EPOCH FROM (now() - GREATEST(p.updated_at, COALESCE(last.at, p.updated_at)))) / 86400 AS days,
              NULL::text AS context
         FROM projects p
         LEFT JOIN LATERAL (
           SELECT max(t.updated_at) AS at FROM tasks t WHERE t.project_id = p.id
         ) last ON TRUE
        WHERE p.tenant_id = $1
          AND p.status <> 'archived'
          AND NOT EXISTS (
            SELECT 1 FROM tasks t WHERE t.project_id = p.id AND t.closed_at IS NULL)
          AND GREATEST(p.updated_at, COALESCE(last.at, p.updated_at)) < now() - make_interval(days => $2::int)
        ORDER BY 4 DESC
        LIMIT 20`,
      [tenantId, days],
    );
  }

  /** Черновики со встреч, которые никто не подтвердил и не отклонил. */
  staleDrafts(tenantId: string, days: number): Promise<Candidate[]> {
    return this.db.many<Candidate>(
      `SELECT 'draft_stale' AS kind, d.id::text AS "subjectId", d.title,
              EXTRACT(EPOCH FROM (now() - d.created_at)) / 86400 AS days,
              m.title AS context
         FROM meeting_task_drafts d
         JOIN meetings m ON m.id = d.meeting_id
        WHERE d.tenant_id = $1 AND d.status = 'pending'
          AND d.created_at < now() - make_interval(days => $2::int)
        ORDER BY d.created_at
        LIMIT 50`,
      [tenantId, days],
    );
  }

  /** Прежнее место задачи — чтобы вернуть её ровно туда, откуда убрали. */
  taskState(tenantId: string, taskId: string) {
    return this.db.one<{ column_id: string; position: number; project_id: string; closed_at: Date | null }>(
      `SELECT column_id, position, project_id, closed_at FROM tasks WHERE tenant_id = $1 AND id = $2`,
      [tenantId, taskId],
    );
  }

  create(input: {
    tenantId: string; kind: string; subjectType: string; subjectId: string;
    title: string; text: string; undo: Record<string, unknown>; dedupKey: string;
  }): Promise<{ id: string } | null> {
    return this.db.one<{ id: string }>(
      `INSERT INTO maintenance_proposals
         (tenant_id, kind, subject_type, subject_id, title, text, undo, dedup_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8)
       ON CONFLICT (tenant_id, dedup_key) DO NOTHING
       RETURNING id`,
      [
        input.tenantId, input.kind, input.subjectType, input.subjectId,
        input.title.slice(0, 255), input.text.slice(0, 300), JSON.stringify(input.undo), input.dedupKey,
      ],
    );
  }

  /**
   * Что показать человеку: сначала то, что ждёт решения, следом недавно сделанное —
   * именно там стоит кнопка «Вернуть», и найти её должно быть легко.
   */
  list(tenantId: string): Promise<ProposalRow[]> {
    return this.db.many<ProposalRow>(
      `SELECT m.id, m.kind, m.subject_type, m.subject_id, m.title, m.text, m.status, m.undo,
              m.created_at, m.decided_at, u.full_name AS decided_by_name
         FROM maintenance_proposals m
         LEFT JOIN users u ON u.id = m.decided_by
        WHERE m.tenant_id = $1
          AND (m.status = 'pending'
               OR (m.status = 'applied' AND m.decided_at > now() - interval '30 days'))
        ORDER BY (m.status = 'pending') DESC, m.created_at DESC
        LIMIT 50`,
      [tenantId],
    );
  }

  byId(tenantId: string, id: string): Promise<ProposalRow | null> {
    return this.db.one<ProposalRow>(
      `SELECT m.id, m.kind, m.subject_type, m.subject_id, m.title, m.text, m.status, m.undo,
              m.created_at, m.decided_at, NULL::text AS decided_by_name
         FROM maintenance_proposals m WHERE m.tenant_id = $1 AND m.id = $2`,
      [tenantId, id],
    );
  }

  async setStatus(tenantId: string, id: string, status: string, actorId: string | null): Promise<void> {
    await this.db.query(
      `UPDATE maintenance_proposals
          SET status = $3::text, decided_by = $4, decided_at = now()
        WHERE tenant_id = $1 AND id = $2`,
      [tenantId, id, status, actorId],
    );
  }
}
