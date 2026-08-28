import { Injectable } from '@nestjs/common';
import { DbService } from '../../database/db.service';
import { REVIEW_COLUMN_NAMES } from '../tasks/task-columns';
import { SecretaryService } from '../secretary/secretary.service';
import {
  classifyAsk, hotAnswer, loadAnswer, projectAnswer, unknownAnswer,
} from './ask-rules';

/**
 * Вопрос секретарю о текущих делах.
 *
 * Это не поиск по базе знаний (он есть отдельно и отвечает по документам), а взгляд
 * на то, что происходит прямо сейчас: сколько задач в проекте, кто свободен, что
 * горит. Такие вопросы человек задаёт вслух коллеге по десять раз в неделю, и каждый
 * раз кто-то идёт смотреть доски.
 *
 * Ответ собирается запросами, а не моделью: он состоит из цифр, которые надо
 * посчитать, а не сочинить.
 */
@Injectable()
export class AskService {
  constructor(
    private readonly db: DbService,
    private readonly secretary: SecretaryService,
  ) {}

  async ask(tenantId: string, userId: string, question: string): Promise<{ kind: string; answer: string }> {
    const projects = await this.db.many<{ id: string; name: string }>(
      `SELECT id::text, name FROM projects WHERE tenant_id=$1 AND status <> 'archived'`, [tenantId],
    );
    const intent = classifyAsk(question, projects);

    const answer = intent.kind === 'project' && intent.projectId
      ? await this.aboutProject(tenantId, intent.projectId)
      : intent.kind === 'who_free' ? await this.aboutLoad(tenantId)
        : intent.kind === 'hot' ? await this.aboutHot(tenantId, null)
          : intent.kind === 'mine' ? await this.aboutHot(tenantId, userId)
            : unknownAnswer();

    // В журнал пишем только разобранные вопросы: «не понял» — не работа за человека.
    if (intent.kind !== 'unknown') {
      void this.secretary.record({
        tenantId, userId, kind: 'ask', summary: `Ответ на вопрос: «${question.slice(0, 80)}»`,
      });
    }
    return { kind: intent.kind, answer };
  }

  private async aboutProject(tenantId: string, projectId: string): Promise<string> {
    const [stats, workers, atRisk, meeting] = await Promise.all([
      this.db.one<{ name: string; open: string; closed_week: string; overdue: string; hours: string }>(
        `SELECT p.name,
                COUNT(*) FILTER (WHERE t.closed_at IS NULL) AS open,
                COUNT(*) FILTER (WHERE t.closed_at > now() - interval '7 days') AS closed_week,
                COUNT(*) FILTER (WHERE t.closed_at IS NULL AND t.deadline_at < now()) AS overdue,
                COALESCE((SELECT SUM(EXTRACT(EPOCH FROM (COALESCE(tl.timestamp_end, now()) - tl.timestamp_start)) / 3600)
                            FROM time_logs tl JOIN tasks tt ON tt.id = tl.task_id
                           WHERE tt.project_id = p.id), 0) AS hours
           FROM projects p LEFT JOIN tasks t ON t.project_id = p.id
          WHERE p.tenant_id=$1 AND p.id=$2
          GROUP BY p.id, p.name`,
        [tenantId, projectId],
      ),
      this.db.many<{ full_name: string; open: string }>(
        `SELECT u.full_name, COUNT(*) AS open
           FROM tasks t JOIN users u ON u.id = t.assignee_id
          WHERE t.tenant_id=$1 AND t.project_id=$2 AND t.closed_at IS NULL
          GROUP BY u.full_name ORDER BY COUNT(*) DESC LIMIT 3`,
        [tenantId, projectId],
      ),
      this.db.many<{ title: string; assignee_name: string | null }>(
        `SELECT t.title, u.full_name AS assignee_name
           FROM tasks t LEFT JOIN users u ON u.id = t.assignee_id
          WHERE t.tenant_id=$1 AND t.project_id=$2 AND t.closed_at IS NULL
            AND t.risk_level IN ('red','yellow')
          ORDER BY t.deadline_at NULLS LAST LIMIT 5`,
        [tenantId, projectId],
      ),
      this.db.one<{ title: string; started_at: Date }>(
        `SELECT COALESCE(title, 'Встреча') AS title, started_at
           FROM meetings
          WHERE tenant_id=$1 AND project_id=$2 AND started_at IS NOT NULL
          ORDER BY started_at DESC LIMIT 1`,
        [tenantId, projectId],
      ).catch(() => null),
    ]);
    if (!stats) return 'Такого проекта нет или он в архиве.';

    return projectAnswer({
      name: stats.name,
      open: Number(stats.open),
      closedWeek: Number(stats.closed_week),
      overdue: Number(stats.overdue),
      hours: Number(stats.hours),
      topWorkers: workers.map((w) => ({ fullName: w.full_name, open: Number(w.open) })),
      atRisk: atRisk.map((r) => ({ title: r.title, assigneeName: r.assignee_name })),
      lastMeeting: meeting ? { title: meeting.title, when: meeting.started_at } : null,
    });
  }

  private async aboutLoad(tenantId: string): Promise<string> {
    const rows = await this.db.many<{ full_name: string; open: string; overdue: string; hours: string }>(
      `SELECT u.full_name,
              COUNT(t.id) FILTER (WHERE t.closed_at IS NULL) AS open,
              COUNT(t.id) FILTER (WHERE t.closed_at IS NULL AND t.deadline_at < now()) AS overdue,
              COALESCE(SUM(t.estimate_hours) FILTER (WHERE t.closed_at IS NULL), 0) AS hours
         FROM users u
         JOIN roles r ON r.id = u.role_id
    LEFT JOIN tasks t ON t.assignee_id = u.id AND t.tenant_id = u.tenant_id
        WHERE u.tenant_id=$1 AND u.is_active AND r.code <> 'client'
        GROUP BY u.id, u.full_name`,
      [tenantId],
    );
    return loadAnswer(rows.map((r) => ({
      fullName: r.full_name, open: Number(r.open), overdue: Number(r.overdue), hoursPlanned: Number(r.hours),
    })));
  }

  /** Что горит: просроченное и то, чему прогноз не верит. `userId` — только своё. */
  private async aboutHot(tenantId: string, userId: string | null): Promise<string> {
    const rows = await this.db.many<{
      title: string; assignee_name: string | null; project_name: string; overdue_hours: string;
    }>(
      `SELECT t.title, u.full_name AS assignee_name, p.name AS project_name,
              GREATEST(0, EXTRACT(EPOCH FROM (now() - t.deadline_at)) / 3600) AS overdue_hours
         FROM tasks t
         JOIN projects p ON p.id = t.project_id AND p.status <> 'archived'
         JOIN board_columns c ON c.id = t.column_id
    LEFT JOIN users u ON u.id = t.assignee_id
        WHERE t.tenant_id=$1 AND t.closed_at IS NULL
          AND lower(c.name) <> ALL($2::text[])
          AND (t.deadline_at < now() OR t.risk_level IN ('red','yellow'))
          AND ($3::bigint IS NULL OR t.assignee_id = $3::bigint)
        ORDER BY t.deadline_at NULLS LAST
        LIMIT 30`,
      [tenantId, REVIEW_COLUMN_NAMES, userId],
    );
    return hotAnswer(rows.map((r) => ({
      title: r.title,
      assigneeName: r.assignee_name,
      projectName: r.project_name,
      overdueHours: Number(r.overdue_hours),
    })));
  }
}
