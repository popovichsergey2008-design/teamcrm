import { Injectable } from '@nestjs/common';
import { DbService } from '../../database/db.service';
import { RecurrenceRule } from './recurrence';

export interface RecurrenceRow {
  id: string;
  tenant_id: string;
  task_id: string;
  freq: string;
  weekdays: number[];
  monthday: number | null;
  interval_days: number | null;
  at_time: string;
  tz: string;
  next_run_at: string;
  last_run_at: string | null;
  active: boolean;
  created_by: string | null;
}

/**
 * Расписания повторов.
 *
 * Хранилище намеренно тупое: вся календарная арифметика живёт в `recurrence.ts` и
 * проверяется тестами, а сюда попадают уже посчитанные моменты. Считать «следующий
 * понедельник» в SQL — верный способ получить его по часовому поясу сервера.
 */
@Injectable()
export class TaskRecurrenceRepository {
  constructor(private readonly db: DbService) {}

  async byTask(tenantId: string, taskId: string): Promise<RecurrenceRow | null> {
    return this.db.one<RecurrenceRow>(
      `SELECT * FROM task_recurrences WHERE tenant_id = $1 AND task_id = $2`,
      [tenantId, taskId],
    );
  }

  /**
   * Завести или переписать расписание задачи.
   *
   * Одна задача — одно расписание (уникальный индекс), поэтому UPSERT: человек правит
   * повтор в той же карточке, где его завёл, и второй строки появиться не должно.
   */
  async upsert(
    tenantId: string,
    taskId: string,
    rule: RecurrenceRule,
    nextRunAt: Date,
    actorId: string | null,
  ): Promise<RecurrenceRow> {
    const row = (await this.db.one<RecurrenceRow>(
      `INSERT INTO task_recurrences
         (tenant_id, task_id, freq, weekdays, monthday, interval_days, at_time, tz, next_run_at, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (task_id) DO UPDATE SET
         freq = EXCLUDED.freq,
         weekdays = EXCLUDED.weekdays,
         monthday = EXCLUDED.monthday,
         interval_days = EXCLUDED.interval_days,
         at_time = EXCLUDED.at_time,
         tz = EXCLUDED.tz,
         next_run_at = EXCLUDED.next_run_at,
         active = TRUE,
         updated_at = now()
       RETURNING *`,
      [
        tenantId, taskId, rule.freq, rule.weekdays, rule.monthday,
        rule.intervalDays, rule.atTime, rule.tz, nextRunAt, actorId,
      ],
    ))!;
    // Образец тоже помечаем: значок повтора должен быть виден на той карточке,
    // в которой расписание и заводили, а не только на будущих копиях.
    await this.db.query(
      `UPDATE tasks SET recurrence_id = $3 WHERE tenant_id = $1 AND id = $2`,
      [tenantId, taskId, row.id],
    );
    return row;
  }

  /** Снять повтор. Уже созданные копии остаются: это сделанная работа, а не мусор. */
  async remove(tenantId: string, taskId: string): Promise<void> {
    await this.db.query(
      `DELETE FROM task_recurrences WHERE tenant_id = $1 AND task_id = $2`,
      [tenantId, taskId],
    );
  }

  /** Что уже пора выполнить. Порция ограничена: проход не должен идти час. */
  async due(now: Date, limit = 100): Promise<RecurrenceRow[]> {
    return this.db.many<RecurrenceRow>(
      `SELECT * FROM task_recurrences
        WHERE active AND next_run_at <= $1
        ORDER BY next_run_at
        LIMIT $2`,
      [now, limit],
    );
  }

  async markRun(id: string, ranAt: Date, nextRunAt: Date): Promise<void> {
    await this.db.query(
      `UPDATE task_recurrences SET last_run_at = $2, next_run_at = $3, updated_at = now() WHERE id = $1`,
      [id, ranAt, nextRunAt],
    );
  }

  /**
   * Последняя задача этого повтора — образец или последняя копия.
   *
   * По ней решается главное: плодить новую или сдвинуть срок у незакрытой. Берём
   * самую свежую по номеру: копии создаются по порядку, и номер здесь надёжнее даты.
   */
  async lastInstance(tenantId: string, recurrenceId: string): Promise<
    { id: string; closed_at: string | null; title: string; project_id: string } | null
  > {
    return this.db.one(
      `SELECT id, closed_at, title, project_id
         FROM tasks
        WHERE tenant_id = $1 AND recurrence_id = $2
        ORDER BY id DESC
        LIMIT 1`,
      [tenantId, recurrenceId],
    );
  }

  /** Образец со всем, что копируется в новую задачу. */
  async template(tenantId: string, taskId: string): Promise<{
    id: string; project_id: string; title: string; description: string | null;
    assignee_id: string | null; created_by: string | null; priority: string | null;
    estimate_hours: string | null; requires_approval: boolean;
  } | null> {
    return this.db.one(
      `SELECT id, project_id, title, description, assignee_id, created_by,
              priority, estimate_hours, COALESCE(requires_approval, TRUE) AS requires_approval
         FROM tasks WHERE tenant_id = $1 AND id = $2`,
      [tenantId, taskId],
    );
  }

  /** Метки образца: копия без меток теряет и цвет, и место в отборах. */
  async templateLabels(tenantId: string, taskId: string): Promise<string[]> {
    const rows = await this.db.many<{ label_id: string }>(
      `SELECT label_id FROM task_labels WHERE tenant_id = $1 AND task_id = $2`,
      [tenantId, taskId],
    );
    return rows.map((r) => String(r.label_id));
  }

  /** Чек-лист образца — в копию он уезжает пустым (несделанным). */
  async templateChecklist(tenantId: string, taskId: string): Promise<string[]> {
    const rows = await this.db.many<{ text: string }>(
      `SELECT text FROM task_checklist_items
        WHERE tenant_id = $1 AND task_id = $2
        ORDER BY position, id`,
      [tenantId, taskId],
    );
    return rows.map((r) => r.text);
  }

  /** Пометить копию принадлежащей повтору и поставить ей срок. */
  async attachCopy(tenantId: string, taskId: string, recurrenceId: string): Promise<void> {
    await this.db.query(
      `UPDATE tasks SET recurrence_id = $3 WHERE tenant_id = $1 AND id = $2`,
      [tenantId, taskId, recurrenceId],
    );
  }

  /** Сдвинуть срок незакрытой задачи — вместо создания её же копии. */
  async pushDeadline(tenantId: string, taskId: string, deadlineAt: Date): Promise<void> {
    await this.db.query(
      `UPDATE tasks SET deadline_at = $3, updated_at = now() WHERE tenant_id = $1 AND id = $2`,
      [tenantId, taskId, deadlineAt],
    );
  }
}

/**
 * Строка базы → правило повтора.
 *
 * Живёт рядом с хранилищем, а не в планировщике: правило нужно и сервису (ответить
 * клиенту подписью), и планировщику (посчитать следующий день). Класть общее в
 * планировщик значит завести кольцо импортов — сервис↔планировщик.
 */
export function ruleOf(row: RecurrenceRow): RecurrenceRule {
  return {
    freq: row.freq as RecurrenceRule['freq'],
    weekdays: (row.weekdays ?? []).map(Number),
    monthday: row.monthday === null ? null : Number(row.monthday),
    intervalDays: row.interval_days === null ? null : Number(row.interval_days),
    atTime: row.at_time,
    tz: row.tz,
  };
}
