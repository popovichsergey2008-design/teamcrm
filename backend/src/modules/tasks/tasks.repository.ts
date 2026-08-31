import { Injectable } from '@nestjs/common';
import { DbService } from '../../database/db.service';
import { REVIEW_COLUMN_NAMES } from './task-columns';
import { GateFacts, GateRequirements } from './handoff-gate';

export interface TaskRow {
  id: string;
  tenant_id: string;
  project_id: string;
  column_id: string;
  position: number;
  title: string;
  description: string | null;
  assignee_id: string | null;
  created_by: string | null;
  status: string;
  is_blocked: boolean;
  cost_current: string;
  priority: string;
  created_at: Date;
  /** личный план: на какой день человек взял задачу (не срок) */
  focus_date: string | null;
  updated_at: Date;
  closed_at: Date | null;
  /** Нужно ли подтверждение постановщика, чтобы задача считалась завершённой. */
  requires_approval: boolean;
  /** none | pending — работа сдана и ждёт ответа постановщика. */
  approval_state: string;
  approval_requested_at: Date | null;
  approval_requested_by: string | null;
}

@Injectable()
export class TasksRepository {
  constructor(private readonly db: DbService) {}

  findById(tenantId: string, id: string): Promise<TaskRow | null> {
    return this.db.one<TaskRow>(
      `SELECT * FROM tasks WHERE tenant_id = $1 AND id = $2`,
      [tenantId, id],
    );
  }

  listByProject(tenantId: string, projectId: string): Promise<TaskRow[]> {
    return this.db.many<TaskRow>(
      `SELECT * FROM tasks WHERE tenant_id = $1 AND project_id = $2
        ORDER BY column_id, position ASC`,
      [tenantId, projectId],
    );
  }

  /**
   * Сквозная выборка задач по всем проектам организации — для вкладок «Мои» и «Порученные».
   * scope=mine — я исполнитель; scope=delegated — я руководитель, а исполнитель кто-то другой
   * (свои же задачи не дублируются между вкладками). Архивные проекты не показываем.
   */
  listForUser(
    tenantId: string,
    userId: string,
    scope: 'mine' | 'delegated' | 'review',
    includeClosed: boolean,
  ): Promise<(TaskRow & { project_name: string; column_name: string; assignee_name: string | null; manager_name: string | null })[]> {
    // review — то, что уже сдали и ждут от меня решения: я постановщик, работал кто-то
    // другой, и задача стоит в колонке проверки. Именно это считает бейдж «Фокуса дня».
    // «Мои» — это и то, что делаю сам, и то, где я соисполнитель: человек, который
    // фактически делает работу, должен видеть её у себя, а не искать по чужим доскам.
    const scopeSql = scope === 'mine'
      ? `(t.assignee_id = $2 OR EXISTS (
            SELECT 1 FROM task_participants tp
             WHERE tp.tenant_id = t.tenant_id AND tp.task_id = t.id
               AND tp.user_id = $2 AND tp.role = 'co_assignee'))`
      : scope === 'review'
        ? `t.created_by = $2 AND (t.assignee_id IS NULL OR t.assignee_id <> $2)
           AND t.closed_at IS NULL AND lower(bc.name) = ANY($4::text[])`
        : `t.created_by = $2 AND (t.assignee_id IS NULL OR t.assignee_id <> $2)`;
    return this.db.many(
      `SELECT t.*, p.name AS project_name, bc.name AS column_name,
              ua.full_name AS assignee_name, um.full_name AS manager_name
         FROM tasks t
         JOIN projects p ON p.id = t.project_id
         JOIN board_columns bc ON bc.id = t.column_id
         LEFT JOIN users ua ON ua.id = t.assignee_id
         LEFT JOIN users um ON um.id = t.created_by
        WHERE t.tenant_id = $1 AND ${scopeSql}
          AND p.status <> 'archived'
          AND ($3::boolean OR t.closed_at IS NULL)
        ORDER BY t.closed_at IS NOT NULL,
                 t.deadline_at IS NULL, t.deadline_at ASC,
                 CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
                 t.created_at DESC`,
      scope === 'review'
        ? [tenantId, userId, includeClosed, REVIEW_COLUMN_NAMES]
        : [tenantId, userId, includeClosed],
    );
  }

  /**
   * Поставить или снять дату фокуса.
   *
   * Планировать может только тот, кто задачу делает: это личный план, а не поручение.
   * Проверка исполнителя — в сервисе, здесь только запись.
   */
  async setFocusDate(tenantId: string, taskId: string, date: string | null): Promise<TaskRow | null> {
    return this.db.one<TaskRow>(
      `UPDATE tasks SET focus_date = $3::date, updated_at = now()
        WHERE tenant_id = $1 AND id = $2
        RETURNING *`,
      [tenantId, taskId, date],
    );
  }

  /** Незакрытые задачи, запланированные на прошедшие дни, — «хвосты» для разбора. */
  leftovers(tenantId: string, userId: string, today: string): Promise<(TaskRow & { project_name: string })[]> {
    return this.db.many(
      `SELECT t.*, p.name AS project_name
         FROM tasks t
         JOIN projects p ON p.id = t.project_id
        WHERE t.tenant_id = $1 AND t.assignee_id = $2
          AND t.closed_at IS NULL
          AND t.focus_date IS NOT NULL AND t.focus_date < $3::date
          AND p.status <> 'archived'
        ORDER BY t.focus_date, t.id`,
      [tenantId, userId, today],
    );
  }

  /** Флаг «задача передана ИИ-агенту» (виртуальный исполнитель). */
  async setAgentAssigned(tenantId: string, taskId: string, value: boolean): Promise<void> {
    await this.db.query(`UPDATE tasks SET agent_assigned=$3 WHERE tenant_id=$1 AND id=$2`, [tenantId, taskId, value]);
  }

  async create(input: {
    tenantId: string;
    projectId: string;
    columnId: string;
    status: string;
    title: string;
    description?: string | null;
    assigneeId?: string | null;
    createdBy?: string | null;
    priority?: string | null;
    deadlineAt?: string | null;
    estimateHours?: number | null;
    labelIds?: string[];
    /** Нужно ли подтверждение постановщика при завершении. Умолчание — да. */
    requiresApproval?: boolean;
  }): Promise<TaskRow> {
    return this.db.withTransaction(async (client) => {
      const posRes = await client.query<{ next: number }>(
        `SELECT COALESCE(MAX(position) + 1, 0) AS next FROM tasks
          WHERE tenant_id = $1 AND column_id = $2`,
        [input.tenantId, input.columnId],
      );
      const position = posRes.rows[0].next;
      const res = await client.query<TaskRow>(
        `INSERT INTO tasks
           (tenant_id, project_id, column_id, position, title, description, assignee_id, status, created_by,
            priority, deadline_at, estimate_hours, requires_approval)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,
                 COALESCE($10::varchar, 'normal'), $11::timestamptz, $12::numeric,
                 COALESCE($13::boolean, TRUE)) RETURNING *`,
        [
          input.tenantId,
          input.projectId,
          input.columnId,
          position,
          input.title,
          input.description ?? null,
          input.assigneeId ?? null,
          input.status,
          input.createdBy ?? null,
          input.priority ?? null,
          input.deadlineAt ?? null,
          input.estimateHours ?? null,
          input.requiresApproval ?? null,
        ],
      );
      const task = res.rows[0];

      // Метки вешаем в той же транзакции: задача с половиной заданных полей хуже,
      // чем неудача целиком. Принадлежность метки арендатору проверяет сам запрос.
      if (input.labelIds?.length) {
        await client.query(
          `INSERT INTO task_labels (tenant_id, task_id, label_id)
           SELECT $1::bigint, $2::bigint, l.id FROM labels l
            WHERE l.tenant_id = $1::bigint AND l.id = ANY($3::bigint[])
           ON CONFLICT DO NOTHING`,
          [input.tenantId, task.id, input.labelIds],
        );
      }
      return task;
    });
  }

  /** Учтённое время по задаче: удалять такую нельзя — это финансовая история проекта. */
  /**
   * Сколько по задаче реально наработано, в часах.
   *
   * Считаем время, а не количество записей: раньше здесь стоял COUNT, и случайный
   * запуск таймера на две секунды выглядел так же, как три дня работы.
   * Незакрытая запись (таймер идёт прямо сейчас) считается до текущего момента —
   * она тоже станет часами, как только человек нажмёт «стоп».
   */
  async loggedHours(tenantId: string, taskId: string): Promise<number> {
    const row = await this.db.one<{ hours: string }>(
      `SELECT COALESCE(SUM(EXTRACT(EPOCH FROM (COALESCE(timestamp_end, now()) - timestamp_start))), 0) / 3600.0 AS hours
         FROM time_logs WHERE tenant_id=$1 AND task_id=$2`,
      [tenantId, taskId],
    );
    return Number(row?.hours ?? 0);
  }

  /**
   * Полное удаление задачи вместе с её спутниками.
   *
   * Внешние ключи на tasks почти нигде не каскадные, поэтому строки-спутники
   * (комментарии, чек-лист, метки, вложения, история) убираем явно и в одной
   * транзакции. Ссылки, где задача необязательна (алерты, рекомендации,
   * черновики со встреч, разборы стендапов), обнуляем: сами записи осмысленны
   * и без задачи, терять их незачем.
   *
   * Учтённое время НЕ УДАЛЯЕТСЯ, а переезжает в архив вместе со стоимостью задачи:
   * часы уже оплачены людям и посчитаны в себестоимости проекта, и стереть их значило
   * бы изменить P&L задним числом. Задача уходит с доски, деньги остаются на месте.
   */
  async remove(tenantId: string, taskId: string, actorId: string | null = null): Promise<void> {
    await this.db.withTransaction(async (client) => {
      await client.query(
        `INSERT INTO deleted_task_costs (tenant_id, project_id, task_id, task_title, cost, deleted_by)
         SELECT t.tenant_id, t.project_id, t.id, t.title, t.cost_current, $3
           FROM tasks t WHERE t.tenant_id=$2 AND t.id=$1`,
        [taskId, tenantId, actorId],
      );
      await client.query(
        `INSERT INTO deleted_time_logs (tenant_id, project_id, task_id, user_id, timestamp_start, timestamp_end)
         SELECT tl.tenant_id, t.project_id, tl.task_id, tl.user_id, tl.timestamp_start, tl.timestamp_end
           FROM time_logs tl JOIN tasks t ON t.id = tl.task_id
          WHERE tl.tenant_id=$2 AND tl.task_id=$1`,
        [taskId, tenantId],
      );
      await client.query(`DELETE FROM time_logs WHERE tenant_id=$2 AND task_id=$1`, [taskId, tenantId]);

      for (const sql of [
        `DELETE FROM task_labels WHERE task_id=$1`,
        `DELETE FROM task_watchers WHERE task_id=$1`,
        `DELETE FROM task_checklist_items WHERE task_id=$1`,
        `DELETE FROM task_comments WHERE task_id=$1`,
        `DELETE FROM task_attachments WHERE task_id=$1`,
        `DELETE FROM task_activity WHERE task_id=$1`,
        `DELETE FROM task_embeddings WHERE task_id=$1`,
        `DELETE FROM assignment_audit WHERE task_id=$1`,
      ]) {
        await client.query(sql, [taskId]);
      }
      for (const sql of [
        `UPDATE alerts SET task_id=NULL WHERE task_id=$1`,
        `UPDATE standup_actions SET task_id=NULL WHERE task_id=$1`,
        `UPDATE recommendations SET task_id=NULL WHERE task_id=$1`,
        `UPDATE meeting_task_drafts SET task_id=NULL WHERE task_id=$1`,
      ]) {
        await client.query(sql, [taskId]);
      }
      // след во внешних системах и в базе знаний: иначе задача «воскреснет» при
      // следующем импорте или останется цитироваться в ответах ИИ
      await client.query(
        `DELETE FROM external_refs WHERE tenant_id=$1 AND entity_type='task' AND local_id=$2`,
        [tenantId, taskId],
      );
      await client.query(
        `DELETE FROM knowledge_chunks WHERE tenant_id=$1 AND source_type='task' AND source_id=$2`,
        [tenantId, taskId],
      );
      await client.query(`DELETE FROM tasks WHERE tenant_id=$1 AND id=$2`, [tenantId, taskId]);
    });
  }

  async update(
    tenantId: string,
    id: string,
    patch: Partial<{
      title: string;
      description: string | null;
      assignee_id: string | null;
      created_by: string | null;
      is_blocked: boolean;
      priority: string;
    }>,
  ): Promise<TaskRow | null> {
    const fields: string[] = [];
    const values: any[] = [];
    let i = 1;
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) continue;
      fields.push(`${key} = $${i++}`);
      values.push(value);
    }
    if (fields.length === 0) return this.findById(tenantId, id);
    fields.push(`updated_at = now()`);
    values.push(tenantId, id);
    const res = await this.db.one<TaskRow>(
      `UPDATE tasks SET ${fields.join(', ')}
        WHERE tenant_id = $${i++} AND id = $${i} RETURNING *`,
      values,
    );
    return res;
  }

  /**
   * Пункты чек-листа пачкой — при создании задачи.
   *
   * Голосовая постановка и разбор встречи приносят задачу уже с шагами: заводить их
   * по одному запросу значит превратить одно действие человека в десять походов в сеть.
   */
  async addChecklist(tenantId: string, taskId: string, items: string[]): Promise<void> {
    const clean = items.map((t) => String(t ?? '').trim()).filter(Boolean).slice(0, 30);
    if (!clean.length) return;
    const values = clean.map((_, i) => `($1,$2,$${i + 3},${i})`).join(',');
    await this.db.query(
      `INSERT INTO task_checklist_items (tenant_id, task_id, text, position) VALUES ${values}`,
      [tenantId, taskId, ...clean.map((t) => t.slice(0, 500))],
    );
  }

  // ── соисполнители и наблюдатели ──

  /**
   * Кто ещё в задаче.
   *
   * Роль хранится строкой, а не двумя таблицами: это один и тот же вопрос — «кто рядом
   * с задачей», и разводить его по разным местам значит дублировать всю обвязку.
   */
  participants(tenantId: string, taskId: string): Promise<{
    user_id: string; role: string; full_name: string; avatar_url: string | null;
  }[]> {
    return this.db.many(
      `SELECT tp.user_id::text, tp.role, u.full_name, u.avatar_url
         FROM task_participants tp
         JOIN users u ON u.id = tp.user_id
        WHERE tp.tenant_id = $1 AND tp.task_id = $2
        ORDER BY tp.role, u.full_name`,
      [tenantId, taskId],
    );
  }

  /** Повторное добавление того же человека — не ошибка, а просто ничего. */
  async addParticipant(
    tenantId: string, taskId: string, userId: string, role: string, addedBy: string | null,
  ): Promise<boolean> {
    const row = await this.db.one<{ user_id: string }>(
      `INSERT INTO task_participants (tenant_id, task_id, user_id, role, added_by)
       VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING user_id::text`,
      [tenantId, taskId, userId, role, addedBy],
    );
    return !!row;
  }

  async removeParticipant(tenantId: string, taskId: string, userId: string, role: string): Promise<void> {
    await this.db.query(
      `DELETE FROM task_participants
        WHERE tenant_id=$1 AND task_id=$2 AND user_id=$3 AND role=$4`,
      [tenantId, taskId, userId, role],
    );
  }

  /**
   * Участники всех задач проекта — одним запросом для доски.
   *
   * По одному запросу на карточку доска бы легла: на большом проекте это сотни
   * обращений ради подписи «+2».
   */
  participantsByProject(tenantId: string, projectId: string): Promise<{
    task_id: string; user_id: string; role: string; full_name: string;
  }[]> {
    return this.db.many(
      `SELECT tp.task_id::text, tp.user_id::text, tp.role, u.full_name
         FROM task_participants tp
         JOIN tasks t ON t.id = tp.task_id
         JOIN users u ON u.id = tp.user_id
        WHERE tp.tenant_id = $1 AND t.project_id = $2`,
      [tenantId, projectId],
    );
  }

  async closeTask(tenantId: string, id: string): Promise<void> {
    await this.db.query(
      `UPDATE tasks SET closed_at = now(), updated_at = now()
        WHERE tenant_id = $1 AND id = $2 AND closed_at IS NULL`,
      [tenantId, id],
    );
  }

  /**
   * Работа сдана и ждёт постановщика.
   *
   * Задача НЕ закрывается: «сделал» и «принято» — разные события, и пока второго нет,
   * задача не должна попадать в отчёты как завершённая.
   */
  async requestApproval(tenantId: string, id: string, actorId: string | null): Promise<void> {
    await this.db.query(
      `UPDATE tasks
          SET approval_state='pending', approval_requested_at=now(), approval_requested_by=$3,
              updated_at=now()
        WHERE tenant_id=$1 AND id=$2`,
      [tenantId, id, actorId],
    );
  }

  /** Ответ постановщика получен — снимаем ожидание (принял он или вернул). */
  async clearApproval(tenantId: string, id: string): Promise<void> {
    await this.db.query(
      `UPDATE tasks SET approval_state='none', approval_requested_at=NULL,
              approval_requested_by=NULL, updated_at=now()
        WHERE tenant_id=$1 AND id=$2`,
      [tenantId, id],
    );
  }

  /** Переключатель согласования — им управляет постановщик, пока задача жива. */
  async setRequiresApproval(tenantId: string, id: string, value: boolean): Promise<void> {
    await this.db.query(
      `UPDATE tasks SET requires_approval=$3, updated_at=now() WHERE tenant_id=$1 AND id=$2`,
      [tenantId, id, value],
    );
  }

  async reopenTask(tenantId: string, id: string): Promise<void> {
    await this.db.query(
      `UPDATE tasks SET closed_at = NULL, updated_at = now() WHERE tenant_id = $1 AND id = $2`,
      [tenantId, id],
    );
  }

  async setBlocked(tenantId: string, id: string, blocked: boolean): Promise<TaskRow | null> {
    return this.db.one<TaskRow>(
      `UPDATE tasks SET is_blocked = $3, updated_at = now()
        WHERE tenant_id = $1 AND id = $2 RETURNING *`,
      [tenantId, id, blocked],
    );
  }

  /** Перенос задачи: новая колонка + позиция, с пересортировкой соседей. */
  async move(
    tenantId: string,
    id: string,
    targetColumnId: string,
    targetPosition: number,
    newStatus: string,
  ): Promise<TaskRow> {
    return this.db.withTransaction(async (client) => {
      const cur = await client.query<TaskRow>(
        `SELECT * FROM tasks WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
        [tenantId, id],
      );
      const task = cur.rows[0];
      const fromCol = task.column_id;
      const fromPos = task.position;

      // вынуть из старой колонки: сдвинуть вниз тех, кто был после
      await client.query(
        `UPDATE tasks SET position = position - 1
          WHERE tenant_id = $1 AND column_id = $2 AND position > $3`,
        [tenantId, fromCol, fromPos],
      );
      // освободить место в целевой колонке
      await client.query(
        `UPDATE tasks SET position = position + 1
          WHERE tenant_id = $1 AND column_id = $2 AND position >= $3`,
        [tenantId, targetColumnId, targetPosition],
      );
      const res = await client.query<TaskRow>(
        `UPDATE tasks
            SET column_id = $3, position = $4, status = $5, updated_at = now()
          WHERE tenant_id = $1 AND id = $2 RETURNING *`,
        [tenantId, id, targetColumnId, targetPosition, newStatus],
      );
      return res.rows[0];
    });
  }

  /**
   * Факты для приёмки работы — одним запросом.
   *
   * Комментарии считаем только авторства исполнителя: вопрос постановщика в карточке
   * отчётом о работе не является, а иначе гейт «есть комментарий» проходил бы сам собой.
   */
  async handoffFacts(tenantId: string, taskId: string, assigneeId: string): Promise<GateFacts> {
    const row = await this.db.one<{ cl_total: string; cl_done: string; own_comments: string; attachments: string }>(
      `SELECT (SELECT COUNT(*) FROM task_checklist_items ci WHERE ci.tenant_id=$1 AND ci.task_id=$2) AS cl_total,
              (SELECT COUNT(*) FROM task_checklist_items ci WHERE ci.tenant_id=$1 AND ci.task_id=$2 AND ci.is_done) AS cl_done,
              (SELECT COUNT(*) FROM task_comments c WHERE c.tenant_id=$1 AND c.task_id=$2 AND c.author_id=$3) AS own_comments,
              (SELECT COUNT(*) FROM task_attachments a WHERE a.tenant_id=$1 AND a.task_id=$2) AS attachments`,
      [tenantId, taskId, assigneeId],
    );
    return {
      checklistTotal: Number(row?.cl_total ?? 0),
      checklistDone: Number(row?.cl_done ?? 0),
      ownComments: Number(row?.own_comments ?? 0),
      attachments: Number(row?.attachments ?? 0),
    };
  }

  /** Условия приёмки компании. Строки нет быть не может — колонки живут в tenants. */
  async gateSettings(tenantId: string): Promise<GateRequirements> {
    const row = await this.db.one<{ c: boolean; m: boolean; a: boolean }>(
      `SELECT gate_require_checklist AS c, gate_require_comment AS m, gate_require_attachment AS a
         FROM tenants WHERE id = $1`,
      [tenantId],
    );
    return { checklist: row?.c !== false, comment: row?.m !== false, attachment: row?.a !== false };
  }

  async saveGateSettings(tenantId: string, req: GateRequirements): Promise<GateRequirements> {
    await this.db.query(
      `UPDATE tenants SET gate_require_checklist=$2, gate_require_comment=$3, gate_require_attachment=$4
        WHERE id=$1`,
      [tenantId, req.checklist, req.comment, req.attachment],
    );
    return req;
  }
}
