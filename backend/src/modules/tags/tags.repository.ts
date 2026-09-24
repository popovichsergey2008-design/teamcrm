import { Injectable } from '@nestjs/common';
import { DbService } from '../../database/db.service';
import { normalizeTagName, TagCreatePolicy } from './tag-rules';

export interface TagRow {
  id: string;
  name: string;
  color: string;
  normalized_name: string | null;
  is_default: boolean;
  ai_description: string | null;
  archived_at: string | null;
  used: number;
}

export interface TagSettingsRow {
  ai_tagging: boolean;
  require_confirmation: boolean;
  who_can_create: TagCreatePolicy;
}

/**
 * Теги организации (таблицы labels/task_labels, миграция 0127).
 *
 * Имена таблиц остались от «меток»: это та же сущность, просто выросшая, и
 * переименование ради красоты сломало бы импорты из YouGile, Битрикса и Notion,
 * которые в них пишут.
 */
@Injectable()
export class TagsRepository {
  constructor(private readonly db: DbService) {}

  /** Список тегов со счётчиком задач. Архивные — отдельным признаком, а не молча спрятаны. */
  list(tenantId: string, withArchived = false): Promise<TagRow[]> {
    return this.db.many<TagRow>(
      `SELECT l.id::text, l.name, l.color, l.normalized_name, l.is_default, l.ai_description,
              l.archived_at,
              (SELECT COUNT(*)::int FROM task_labels tl WHERE tl.label_id = l.id) AS used
         FROM labels l
        WHERE l.tenant_id=$1 ${withArchived ? '' : 'AND l.archived_at IS NULL'}
        ORDER BY l.is_default DESC, l.name`,
      [tenantId],
    );
  }

  byId(tenantId: string, id: string): Promise<TagRow | null> {
    return this.db.one<TagRow>(
      `SELECT l.id::text, l.name, l.color, l.normalized_name, l.is_default, l.ai_description,
              l.archived_at, 0 AS used
         FROM labels l WHERE l.tenant_id=$1 AND l.id=$2`,
      [tenantId, id],
    );
  }

  async create(o: {
    tenantId: string; name: string; color: string; aiDescription?: string | null; createdBy: string;
  }): Promise<TagRow> {
    const row = await this.db.one<TagRow>(
      `INSERT INTO labels (tenant_id, name, color, normalized_name, ai_description, created_by)
       VALUES ($1,$2,$3,$4,$5,$6)
       RETURNING id::text, name, color, normalized_name, is_default, ai_description, archived_at, 0 AS used`,
      [o.tenantId, o.name, o.color, normalizeTagName(o.name), o.aiDescription ?? null, o.createdBy],
    );
    return row as TagRow;
  }

  update(tenantId: string, id: string, p: { name?: string; color?: string; aiDescription?: string | null }) {
    const set: string[] = [];
    const params: unknown[] = [tenantId, id];
    const add = (column: string, value: unknown) => { params.push(value); set.push(`${column} = $${params.length}`); };
    if (p.name !== undefined) { add('name', p.name); add('normalized_name', normalizeTagName(p.name)); }
    if (p.color !== undefined) add('color', p.color);
    if (p.aiDescription !== undefined) add('ai_description', p.aiDescription);
    if (!set.length) return this.byId(tenantId, id);
    return this.db.one<TagRow>(
      `UPDATE labels SET ${set.join(', ')} WHERE tenant_id=$1 AND id=$2
       RETURNING id::text, name, color, normalized_name, is_default, ai_description, archived_at, 0 AS used`,
      params,
    );
  }

  /** Архивация и возврат: историю задач не трогаем — тег остаётся там, где стоял. */
  async setArchived(tenantId: string, id: string, archived: boolean): Promise<void> {
    await this.db.query(
      `UPDATE labels SET archived_at = ${archived ? 'now()' : 'NULL'} WHERE tenant_id=$1 AND id=$2`,
      [tenantId, id],
    );
  }

  /** Настройки организации. Нет строки — значит значения по умолчанию из ТЗ. */
  async settings(tenantId: string): Promise<TagSettingsRow> {
    const row = await this.db.one<TagSettingsRow>(
      `SELECT ai_tagging, require_confirmation, who_can_create FROM tag_settings WHERE tenant_id=$1`,
      [tenantId],
    );
    return row ?? { ai_tagging: true, require_confirmation: true, who_can_create: 'all' };
  }

  async saveSettings(tenantId: string, s: TagSettingsRow): Promise<TagSettingsRow> {
    const row = await this.db.one<TagSettingsRow>(
      `INSERT INTO tag_settings (tenant_id, ai_tagging, require_confirmation, who_can_create)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (tenant_id) DO UPDATE
          SET ai_tagging=$2, require_confirmation=$3, who_can_create=$4, updated_at=now()
       RETURNING ai_tagging, require_confirmation, who_can_create`,
      [tenantId, s.ai_tagging, s.require_confirmation, s.who_can_create],
    );
    return row as TagSettingsRow;
  }

  /** Проект задачи: по нему событие об изменении тегов уходит тем, кто смотрит доску. */
  async projectOfTask(tenantId: string, taskId: string): Promise<string | null> {
    const row = await this.db.one<{ project_id: string }>(
      `SELECT project_id::text FROM tasks WHERE tenant_id=$1 AND id=$2`, [tenantId, taskId],
    );
    return row?.project_id ?? null;
  }

  /** Теги задачи — в том виде, в каком их рисуют плашками. */
  ofTask(tenantId: string, taskId: string) {
    return this.db.many<{ id: string; name: string; color: string; source: string }>(
      `SELECT l.id::text, l.name, l.color, tl.source
         FROM task_labels tl JOIN labels l ON l.id = tl.label_id
        WHERE tl.tenant_id=$1 AND tl.task_id=$2
        ORDER BY l.name`,
      [tenantId, taskId],
    );
  }

  /** Теги пачки задач: список и реестр рисуют плашки, не делая запрос на строку. */
  ofTasks(tenantId: string, taskIds: string[]) {
    if (!taskIds.length) return Promise.resolve([]);
    return this.db.many<{ task_id: string; id: string; name: string; color: string }>(
      `SELECT tl.task_id::text, l.id::text, l.name, l.color
         FROM task_labels tl JOIN labels l ON l.id = tl.label_id
        WHERE tl.tenant_id=$1 AND tl.task_id = ANY($2::bigint[])
        ORDER BY l.name`,
      [tenantId, taskIds],
    );
  }

  /**
   * Проставить задаче набор тегов.
   *
   * Источник и уверенность храним у связи: через месяц по задаче видно, поставил тег
   * человек или предложил ИИ и кто это подтвердил. Чужие теги (другой организации)
   * отсекает соединение с labels по tenant_id.
   */
  async setForTask(o: {
    tenantId: string; taskId: string; tags: { tagId: string; source?: string; confidence?: number | null }[];
    confirmedBy: string | null;
  }): Promise<void> {
    await this.db.query(`DELETE FROM task_labels WHERE tenant_id=$1 AND task_id=$2`, [o.tenantId, o.taskId]);
    for (const t of o.tags) {
      await this.db.query(
        `INSERT INTO task_labels (tenant_id, task_id, label_id, source, ai_confidence, confirmed_by, confirmed_at)
              SELECT $1, $2, l.id, $4, $5, $6, CASE WHEN $6 IS NULL THEN NULL ELSE now() END
                FROM labels l
               WHERE l.id = $3::bigint AND l.tenant_id = $1
         ON CONFLICT (task_id, label_id) DO NOTHING`,
        [o.tenantId, o.taskId, t.tagId, t.source ?? 'manual', t.confidence ?? null, o.confirmedBy],
      );
    }
  }

  /**
   * Базовый набор организации.
   *
   * Заводится кодом при регистрации, а не миграцией: миграция проходит один раз и
   * компанию, которая зарегистрируется завтра, не покроет. Похожий тег не трогаем —
   * компания могла завести его сама и назвать чуть иначе.
   */
  async ensureDefaults(tenantId: string, defaults: { name: string; color: string; hint: string }[]): Promise<void> {
    for (const d of defaults) {
      await this.db.query(
        `INSERT INTO labels (tenant_id, name, color, is_default, normalized_name, ai_description)
              SELECT $1, $2, $3, TRUE, $4, $5
               WHERE NOT EXISTS (
                 SELECT 1 FROM labels WHERE tenant_id=$1 AND normalized_name=$4
               )`,
        [tenantId, d.name, d.color, normalizeTagName(d.name), d.hint],
      );
    }
  }

  /**
   * Что предложил ИИ и что в итоге подтвердил человек.
   *
   * Нужно не ради отчётов, а ради качества подсказок: по расхождению видно, где
   * модель систематически ошибается. Текст задачи не храним — только номера тегов.
   */
  async recordFeedback(o: {
    tenantId: string; taskId: string; userId: string; suggested: string[]; confirmed: string[];
  }): Promise<void> {
    const corrected = JSON.stringify(o.suggested.sort()) !== JSON.stringify([...o.confirmed].sort());
    await this.db.query(
      `INSERT INTO ai_tag_feedback (tenant_id, task_id, user_id, suggested_tag_ids, confirmed_tag_ids, corrected)
       VALUES ($1,$2,$3,$4::bigint[],$5::bigint[],$6)`,
      [o.tenantId, o.taskId, o.userId, o.suggested, o.confirmed, corrected],
    ).catch(() => undefined); // журнал качества не должен ронять создание задачи
  }
}
