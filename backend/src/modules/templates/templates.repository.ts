import { Injectable } from '@nestjs/common';
import { DbService } from '../../database/db.service';

export interface TemplateRow {
  id: string;
  name: string;
  title: string;
  description: string;
  priority: string;
  assignee_id: string | null;
  assignee_name: string | null;
  estimate_hours: string | null;
  requires_approval: boolean;
  deadline_days: number | null;
  checklist: string[];
  label_ids: string[];
  created_by: string | null;
  created_by_name: string | null;
  used_count: number;
  created_at: string;
}

export interface TemplateInput {
  name: string;
  title: string;
  description: string;
  priority: string;
  assigneeId: string | null;
  estimateHours: number | null;
  requiresApproval: boolean;
  deadlineDays: number | null;
  checklist: string[];
  labelIds: string[];
}

/**
 * Шаблоны задач (таблица task_templates, миграция 0130).
 *
 * Имя исполнителя и автора берём соединением, а не храним копией: человек меняет
 * фамилию, и шаблон не должен показывать прошлогоднюю.
 */
@Injectable()
export class TemplatesRepository {
  constructor(private readonly db: DbService) {}

  private static readonly FIELDS = `
    t.id::text, t.name, t.title, t.description, t.priority,
    t.assignee_id::text, a.full_name AS assignee_name,
    t.estimate_hours, t.requires_approval, t.deadline_days,
    t.checklist, t.label_ids,
    t.created_by::text, c.full_name AS created_by_name,
    t.used_count, t.created_at`;

  /**
   * Список шаблонов организации.
   *
   * Сначала частые, потом по алфавиту: в списке из двадцати штук нужный почти всегда
   * тот, которым уже пользовались.
   */
  list(tenantId: string): Promise<TemplateRow[]> {
    return this.db.many<TemplateRow>(
      `SELECT ${TemplatesRepository.FIELDS}
         FROM task_templates t
         LEFT JOIN users a ON a.id = t.assignee_id
         LEFT JOIN users c ON c.id = t.created_by
        WHERE t.tenant_id = $1
        ORDER BY t.used_count DESC, lower(t.name) ASC`,
      [tenantId],
    );
  }

  byId(tenantId: string, id: string): Promise<TemplateRow | null> {
    return this.db.one<TemplateRow>(
      `SELECT ${TemplatesRepository.FIELDS}
         FROM task_templates t
         LEFT JOIN users a ON a.id = t.assignee_id
         LEFT JOIN users c ON c.id = t.created_by
        WHERE t.tenant_id = $1 AND t.id = $2`,
      [tenantId, id],
    );
  }

  byName(tenantId: string, name: string): Promise<TemplateRow | null> {
    return this.db.one<TemplateRow>(
      `SELECT ${TemplatesRepository.FIELDS}
         FROM task_templates t
         LEFT JOIN users a ON a.id = t.assignee_id
         LEFT JOIN users c ON c.id = t.created_by
        WHERE t.tenant_id = $1 AND lower(t.name) = lower($2)`,
      [tenantId, name],
    );
  }

  async create(tenantId: string, input: TemplateInput, authorId: string): Promise<TemplateRow> {
    const row = await this.db.one<{ id: string }>(
      `INSERT INTO task_templates
         (tenant_id, name, title, description, priority, assignee_id, estimate_hours,
          requires_approval, deadline_days, checklist, label_ids, created_by)
       VALUES ($1, $2, $3, $4, $5, $6::bigint, $7::numeric, $8, $9::int, $10::jsonb, $11::jsonb, $12)
       RETURNING id::text`,
      [
        tenantId, input.name, input.title, input.description, input.priority,
        input.assigneeId, input.estimateHours, input.requiresApproval, input.deadlineDays,
        JSON.stringify(input.checklist), JSON.stringify(input.labelIds), authorId,
      ],
    );
    return (await this.byId(tenantId, row!.id))!;
  }

  async update(tenantId: string, id: string, input: TemplateInput): Promise<TemplateRow | null> {
    await this.db.query(
      `UPDATE task_templates
          SET name = $3, title = $4, description = $5, priority = $6, assignee_id = $7::bigint,
              estimate_hours = $8::numeric, requires_approval = $9, deadline_days = $10::int,
              checklist = $11::jsonb, label_ids = $12::jsonb, updated_at = now()
        WHERE tenant_id = $1 AND id = $2`,
      [
        tenantId, id, input.name, input.title, input.description, input.priority,
        input.assigneeId, input.estimateHours, input.requiresApproval, input.deadlineDays,
        JSON.stringify(input.checklist), JSON.stringify(input.labelIds),
      ],
    );
    return this.byId(tenantId, id);
  }

  async remove(tenantId: string, id: string): Promise<void> {
    await this.db.query('DELETE FROM task_templates WHERE tenant_id = $1 AND id = $2', [tenantId, id]);
  }

  /** Шаблоном воспользовались — по счётчику список сам расставляет частые наверх. */
  async markUsed(tenantId: string, id: string): Promise<void> {
    await this.db.query(
      'UPDATE task_templates SET used_count = used_count + 1 WHERE tenant_id = $1 AND id = $2',
      [tenantId, id],
    );
  }

  /**
   * Задача, из которой делают шаблон: поля, чек-лист и теги.
   *
   * Читаем здесь, а не просим у модуля задач: нужны три коротких запроса, а связывать
   * ради них два модуля — плата больше пользы.
   *
   * Видимость проекта проверяем ТЕМ ЖЕ правилом, что и список проектов. Без неё шаблон
   * стал бы дырой: название и описание закрытой задачи утекали бы любому, кто знает её
   * номер, — достаточно «сохранить как шаблон» и посмотреть, что получилось.
   */
  async taskForTemplate(tenantId: string, taskId: string, viewer: { userId: string; role: string }): Promise<{
    title: string; description: string | null; priority: string | null;
    assignee_id: string | null; estimate_hours: string | null; requires_approval: boolean;
    deadline_at: string | null; checklist: string[]; labelIds: string[];
  } | null> {
    const task = await this.db.one<{
      title: string; description: string | null; priority: string | null;
      assignee_id: string | null; estimate_hours: string | null;
      requires_approval: boolean; deadline_at: string | null;
    }>(
      `SELECT t.title, t.description, t.priority, t.assignee_id::text, t.estimate_hours,
              COALESCE(t.requires_approval, TRUE) AS requires_approval, t.deadline_at
         FROM tasks t
         JOIN projects p ON p.id = t.project_id
        WHERE t.tenant_id = $1 AND t.id = $2 AND t.deleted_at IS NULL
          AND ($3::boolean
               OR p.visibility = 'all'
               OR p.owner_user_id = $4::bigint
               OR EXISTS (SELECT 1 FROM project_members pm
                           WHERE pm.project_id = p.id AND pm.user_id = $4::bigint))`,
      [tenantId, taskId, viewer.role === 'owner' || viewer.role === 'manager', viewer.userId],
    );
    if (!task) return null;

    const checklist = (await this.db.many<{ text: string }>(
      `SELECT text FROM task_checklist_items
        WHERE tenant_id = $1 AND task_id = $2
        ORDER BY position, id`,
      [tenantId, taskId],
    )).map((r) => r.text);

    const labelIds = (await this.db.many<{ label_id: string }>(
      `SELECT label_id::text FROM task_labels WHERE tenant_id = $1 AND task_id = $2`,
      [tenantId, taskId],
    )).map((r) => String(r.label_id));

    return { ...task, checklist, labelIds };
  }
}
