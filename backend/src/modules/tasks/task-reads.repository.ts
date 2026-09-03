import { Injectable } from '@nestjs/common';
import { DbService } from '../../database/db.service';

/**
 * Непрочитанное по задачам.
 *
 * Считаем ровно так же, как непрочитанные сообщения в чатах: события журнала
 * (task_activity) позже отметки «я это видел». Два правила задают смысл счётчика:
 *
 * 1. Свои действия не считаются. Перенёс задачу сам — это не новость, а отчёт о
 *    собственном действии; ровно на этом мы уже обожглись с уведомлениями о своих же
 *    сообщениях в чате.
 * 2. Красным становятся ТОЛЬКО мои задачи — где я исполнитель, соисполнитель,
 *    наблюдатель или постановщик. Решение заказчика, и оно правильное: в YouGile
 *    краснеет всё подряд на доске, и на большом проекте половина карточек горит
 *    постоянно — смотреть на это перестают.
 */

/** «Моя задача» — одним условием, чтобы определение не разъехалось по запросам. */
const MINE = `(
      t.assignee_id = $2
   OR t.created_by  = $2
   OR EXISTS (SELECT 1 FROM task_participants p
               WHERE p.tenant_id = t.tenant_id AND p.task_id = t.id AND p.user_id = $2)
)`;

/** Новое событие: чужое и позже моей отметки (её нет — значит всё ново). */
const FRESH = `(
  a.actor_id IS DISTINCT FROM $2
  AND (r.last_seen_at IS NULL OR a.created_at > r.last_seen_at)
)`;

@Injectable()
export class TaskReadsRepository {
  constructor(private readonly db: DbService) {}

  /**
   * Отметить задачу просмотренной.
   *
   * Отметка ставится по открытию карточки, а не по наведению или прокрутке доски:
   * «увидел» — значит открыл и мог прочитать, иначе счётчик гасился бы сам собой.
   */
  async markRead(tenantId: string, taskId: string, userId: string): Promise<void> {
    await this.db.query(
      `INSERT INTO task_reads (tenant_id, task_id, user_id, last_seen_at)
            VALUES ($1,$2,$3, now())
       ON CONFLICT (task_id, user_id) DO UPDATE SET last_seen_at = now()`,
      [tenantId, taskId, userId],
    );
  }

  /** Непрочитанное по задачам одного проекта: доска раскрашивается одним запросом. */
  byProject(tenantId: string, userId: string, projectId: string): Promise<{ task_id: string; n: string }[]> {
    return this.db.many(
      `SELECT a.task_id, COUNT(*) AS n
         FROM task_activity a
         JOIN tasks t ON t.id = a.task_id
    LEFT JOIN task_reads r ON r.task_id = a.task_id AND r.user_id = $2
        WHERE a.tenant_id = $1 AND t.project_id = $3 AND ${MINE} AND ${FRESH}
        GROUP BY a.task_id`,
      [tenantId, userId, projectId],
    );
  }

  /** Непрочитанное по проектам: цифра рядом с проектом в панели — «где искать». */
  byProjects(tenantId: string, userId: string): Promise<{ project_id: string; n: string }[]> {
    return this.db.many(
      `SELECT t.project_id, COUNT(*) AS n
         FROM task_activity a
         JOIN tasks t ON t.id = a.task_id
    LEFT JOIN task_reads r ON r.task_id = a.task_id AND r.user_id = $2
        WHERE a.tenant_id = $1 AND ${MINE} AND ${FRESH}
        GROUP BY t.project_id`,
      [tenantId, userId],
    );
  }

  /**
   * Непрочитанное по перечисленным задачам — реестр раскрашивается одним запросом.
   *
   * Список идентификаторов приходит уже отобранной страницей: считать непрочитанное
   * по всем задачам организации ради пятидесяти строк на экране незачем.
   */
  byIds(tenantId: string, userId: string, taskIds: string[]): Promise<{ task_id: string; n: string }[]> {
    if (taskIds.length === 0) return Promise.resolve([]);
    return this.db.many(
      `SELECT a.task_id, COUNT(*) AS n
         FROM task_activity a
         JOIN tasks t ON t.id = a.task_id
    LEFT JOIN task_reads r ON r.task_id = a.task_id AND r.user_id = $2
        WHERE a.tenant_id = $1 AND a.task_id = ANY($3::bigint[]) AND ${MINE} AND ${FRESH}
        GROUP BY a.task_id`,
      [tenantId, userId, taskIds],
    );
  }

  /** Сколько всего нового — бейдж раздела «Проекты». */
  async total(tenantId: string, userId: string): Promise<number> {
    const row = await this.db.one<{ n: string }>(
      `SELECT COUNT(*) AS n
         FROM task_activity a
         JOIN tasks t ON t.id = a.task_id
    LEFT JOIN task_reads r ON r.task_id = a.task_id AND r.user_id = $2
        WHERE a.tenant_id = $1 AND ${MINE} AND ${FRESH}`,
      [tenantId, userId],
    );
    return Number(row?.n ?? 0);
  }
}
