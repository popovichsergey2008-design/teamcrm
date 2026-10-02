import { Injectable } from '@nestjs/common';
import { DbService } from '../../database/db.service';
import type { ReportHoursRow, ReportTaskRow } from './task-report.model';

/** Сколько задач максимум берём в отчёт: выше — это выгрузка базы, а не отчёт. */
const MAX_TASKS = 20_000;

export interface ReportFilter {
  tenantId: string;
  projectId: string | null;
  userId: string | null;
}

@Injectable()
export class ReportsRepository {
  constructor(private readonly db: DbService) {}

  company(tenantId: string) {
    return this.db.one<{ name: string; timezone: string | null; logo_file_id: string | null }>(
      `SELECT name, timezone, logo_file_id::text FROM tenants WHERE id = $1`,
      [tenantId],
    );
  }

  /**
   * Границы периода в поясе компании: «1–30 сентября» — это московские сутки, а не
   * серверные (UTC). Иначе вечерние задачи 30-го уезжали бы в октябрь.
   */
  async bounds(from: string, to: string, tz: string): Promise<{ start: Date; end: Date }> {
    const row = await this.db.one<{ start: Date; end: Date }>(
      `SELECT ($1::date)::timestamp AT TIME ZONE $3 AS start, ($2::date + 1)::timestamp AT TIME ZONE $3 AS "end"`,
      [from, to, tz],
    );
    return { start: new Date(row!.start), end: new Date(row!.end) };
  }

  projectName(tenantId: string, projectId: string) {
    return this.db.one<{ name: string }>(`SELECT name FROM projects WHERE tenant_id = $1 AND id = $2`, [tenantId, projectId]);
  }

  userName(tenantId: string, userId: string) {
    return this.db.one<{ full_name: string }>(`SELECT full_name FROM users WHERE tenant_id = $1 AND id = $2`, [tenantId, userId]);
  }

  /**
   * Задачи, которые касаются периода или прошлого периода: созданы до конца отчёта и
   * не закрыты раньше начала сравнения. Удалённые и слитые в другие не считаем —
   * их нет и в реестре. Архивные проекты — считаем: работа в них была.
   */
  tasks(f: ReportFilter, end: Date, prevStart: Date): Promise<ReportTaskRow[]> {
    return this.db.many<ReportTaskRow>(
      `SELECT t.id::text, t.title, t.project_id::text, p.name AS project_name,
              t.assignee_id::text, ua.full_name AS assignee_name, uc.full_name AS creator_name,
              t.priority, t.created_at, t.closed_at, t.deadline_at, t.status, t.approval_state,
              (SELECT array_agg(l.name ORDER BY l.name)
                 FROM task_labels tl JOIN labels l ON l.id = tl.label_id
                WHERE tl.task_id = t.id) AS tags
         FROM tasks t
         JOIN projects p ON p.id = t.project_id
         LEFT JOIN users ua ON ua.id = t.assignee_id
         LEFT JOIN users uc ON uc.id = t.created_by
        WHERE t.tenant_id = $1
          AND t.deleted_at IS NULL AND t.merged_into_id IS NULL
          AND t.created_at < $2
          AND (t.closed_at IS NULL OR t.closed_at >= $3)
          AND ($4::bigint IS NULL OR t.project_id = $4::bigint)
          AND ($5::bigint IS NULL OR t.assignee_id = $5::bigint)
        ORDER BY t.id
        LIMIT ${MAX_TASKS}`,
      [f.tenantId, end, prevStart, f.projectId, f.userId],
    );
  }

  /**
   * Часы по учёту времени, обрезанные по границам периода: таймер, запущенный 31-го
   * вечером и остановленный 1-го утром, делится между месяцами по часам, а не уходит
   * целиком в один. Идущий таймер считаем до «сейчас».
   */
  hours(f: ReportFilter, start: Date, end: Date, prevStart: Date): Promise<ReportHoursRow[]> {
    return this.db.many<ReportHoursRow>(
      `SELECT tl.task_id::text, tl.user_id::text, u.full_name AS user_name, t.project_id::text,
              SUM(GREATEST(0, EXTRACT(EPOCH FROM (LEAST(COALESCE(tl.timestamp_end, now()), $3) - GREATEST(tl.timestamp_start, $2)))) / 3600) AS cur_hours,
              SUM(GREATEST(0, EXTRACT(EPOCH FROM (LEAST(COALESCE(tl.timestamp_end, now()), $2) - GREATEST(tl.timestamp_start, $4)))) / 3600) AS prev_hours
         FROM time_logs tl
         JOIN tasks t ON t.id = tl.task_id
         LEFT JOIN users u ON u.id = tl.user_id
        WHERE tl.tenant_id = $1 AND t.deleted_at IS NULL AND t.merged_into_id IS NULL
          AND tl.timestamp_start < $3 AND COALESCE(tl.timestamp_end, now()) > $4
          AND ($5::bigint IS NULL OR t.project_id = $5::bigint)
          AND ($6::bigint IS NULL OR tl.user_id = $6::bigint)
        GROUP BY tl.task_id, tl.user_id, u.full_name, t.project_id`,
      [f.tenantId, start, end, prevStart, f.projectId, f.userId],
    );
  }

  /** Ведётся ли в компании учёт времени вообще — иначе колонка «Часы» сплошь из прочерков. */
  async tracksTime(tenantId: string): Promise<boolean> {
    const row = await this.db.one<{ ok: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM time_logs WHERE tenant_id = $1) AS ok`,
      [tenantId],
    );
    return !!row?.ok;
  }
}
