import { Injectable } from '@nestjs/common';
import { DbService } from '../../database/db.service';

export interface SupportTicketRow {
  id: string;
  title: string;
  status: string;
  closed_at: Date | null;
  created_at: Date;
  project_id: string;
  assignee_name: string | null;
}

/**
 * Поддержка: проект, куда падают обращения, и сами обращения.
 *
 * Обращение — обычная задача; своей таблицы у поддержки нет и не нужно: всё,
 * что умеет задача (переписка, файлы, статусы, уведомления), достаётся даром.
 */
@Injectable()
export class SupportRepository {
  constructor(private readonly db: DbService) {}

  /** Проект поддержки компании: один, живой (не архивный). */
  project(tenantId: string): Promise<{ id: string; name: string } | null> {
    return this.db.one<{ id: string; name: string }>(
      `SELECT id, name FROM projects
        WHERE tenant_id = $1 AND is_support AND status <> 'archived'
        ORDER BY id LIMIT 1`,
      [tenantId],
    );
  }

  /** Назначить проект поддержки — единственный на компанию: с прежнего пометка снимается. */
  async setProject(tenantId: string, projectId: string): Promise<void> {
    await this.db.withTransaction(async (c) => {
      await c.query(`UPDATE projects SET is_support = false WHERE tenant_id = $1 AND is_support`, [tenantId]);
      await c.query(`UPDATE projects SET is_support = true, updated_at = now() WHERE tenant_id = $1 AND id = $2`, [tenantId, projectId]);
    });
  }

  async unsetProject(tenantId: string, projectId: string): Promise<void> {
    await this.db.query(`UPDATE projects SET is_support = false, updated_at = now() WHERE tenant_id = $1 AND id = $2`, [tenantId, projectId]);
  }

  /**
   * Кому достаются обращения: владелец компании.
   *
   * Роль лежит в таблице roles, а не в users — на этом уже обжигались. Первый
   * по номеру: если владельцев несколько, отвечает тот, кто завёл компанию.
   */
  ownerId(tenantId: string): Promise<{ id: string } | null> {
    return this.db.one<{ id: string }>(
      `SELECT u.id FROM users u JOIN roles r ON r.id = u.role_id
        WHERE u.tenant_id = $1 AND r.code = 'owner' AND u.is_active
        ORDER BY u.id LIMIT 1`,
      [tenantId],
    );
  }

  /** Мои обращения: что я писал в поддержку и в каком они состоянии. */
  mine(tenantId: string, projectId: string, userId: string): Promise<SupportTicketRow[]> {
    return this.db.many<SupportTicketRow>(
      `SELECT t.id, t.title, bc.name AS status, t.closed_at, t.created_at, t.project_id,
              a.full_name AS assignee_name
         FROM tasks t
         JOIN board_columns bc ON bc.id = t.column_id
         LEFT JOIN users a ON a.id = t.assignee_id
        WHERE t.tenant_id = $1 AND t.project_id = $2 AND t.created_by = $3
        ORDER BY t.created_at DESC
        LIMIT 100`,
      [tenantId, projectId, userId],
    );
  }
}
