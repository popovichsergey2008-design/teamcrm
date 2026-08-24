import { Injectable } from '@nestjs/common';
import { DbService } from '../../database/db.service';

export type ApprovalRow = {
  id: string;
  tenant_id: string;
  author_id: string;
  approver_id: string;
  kind: string;
  subject: string;
  details: string | null;
  task_id: string | null;
  status: 'pending' | 'approved' | 'rejected' | 'cancelled';
  decision_note: string | null;
  decided_at: string | null;
  due_at: string | null;
  created_at: string;
};

export type ApprovalView = ApprovalRow & {
  author_name: string | null;
  approver_name: string | null;
  task_title: string | null;
  project_id: string | null;
};

const VIEW_SELECT = `
  SELECT a.*, ua.full_name AS author_name, up.full_name AS approver_name,
         t.title AS task_title, t.project_id
    FROM approvals a
    LEFT JOIN users ua ON ua.id = a.author_id
    LEFT JOIN users up ON up.id = a.approver_id
    LEFT JOIN tasks t  ON t.id = a.task_id`;

@Injectable()
export class ApprovalsRepository {
  constructor(private readonly db: DbService) {}

  create(input: {
    tenantId: string; authorId: string; approverId: string; kind: string;
    subject: string; details: string | null; taskId: string | null; dueAt: string | null;
  }): Promise<ApprovalRow | null> {
    return this.db.one<ApprovalRow>(
      `INSERT INTO approvals (tenant_id, author_id, approver_id, kind, subject, details, task_id, due_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [input.tenantId, input.authorId, input.approverId, input.kind,
        input.subject, input.details, input.taskId, input.dueAt],
    );
  }

  byId(tenantId: string, id: string): Promise<ApprovalRow | null> {
    return this.db.one<ApprovalRow>(`SELECT * FROM approvals WHERE tenant_id=$1 AND id=$2`, [tenantId, id]);
  }

  /** Что ждёт решения ЛИЧНО меня — из этого набирается первая колонка «Фокуса дня». */
  inbox(tenantId: string, userId: string): Promise<ApprovalView[]> {
    return this.db.many<ApprovalView>(
      `${VIEW_SELECT}
        WHERE a.tenant_id = $1 AND a.approver_id = $2 AND a.status = 'pending'
        ORDER BY a.due_at NULLS LAST, a.created_at`,
      [tenantId, userId],
    );
  }

  /** Что я отправил и чего жду: без этого человек не знает, у кого лежит его вопрос. */
  sent(tenantId: string, userId: string, includeDecided: boolean): Promise<ApprovalView[]> {
    return this.db.many<ApprovalView>(
      `${VIEW_SELECT}
        WHERE a.tenant_id = $1 AND a.author_id = $2
          AND ($3::boolean OR a.status = 'pending')
        ORDER BY a.status <> 'pending', a.created_at DESC
        LIMIT 50`,
      [tenantId, userId, includeDecided],
    );
  }

  /**
   * Решение по согласованию. Условие `status='pending'` в самом UPDATE — защита от
   * гонки: два человека (или два клика) не должны получить «одобрено» и «отклонено»
   * по одному вопросу.
   */
  decide(tenantId: string, id: string, status: 'approved' | 'rejected' | 'cancelled', note: string | null): Promise<ApprovalRow | null> {
    return this.db.one<ApprovalRow>(
      `UPDATE approvals
          SET status = $3, decision_note = $4, decided_at = now(), updated_at = now()
        WHERE tenant_id = $1 AND id = $2 AND status = 'pending'
        RETURNING *`,
      [tenantId, id, status, note],
    );
  }

  /** Счётчик для бейджа раздела — считается вместе с остальными в одном запросе навигации. */
  pendingCount(tenantId: string, userId: string): Promise<{ n: number } | null> {
    return this.db.one<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM approvals
        WHERE tenant_id = $1 AND approver_id = $2 AND status = 'pending'`,
      [tenantId, userId],
    );
  }
}
