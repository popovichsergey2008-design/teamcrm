import { Injectable } from '@nestjs/common';
import { PoolClient } from 'pg';
import { DbService } from '../../database/db.service';

export interface ProjectRow {
  id: string;
  tenant_id: string;
  client_id: string | null;
  deal_id: string | null;
  name: string;
  budget: string | null;
  status: string;
  created_at: Date;
  updated_at: Date;
  /** all — видят все сотрудники; members — только участники, ответственный и руководство. */
  visibility?: string;
  owner_user_id?: string | null;
}

export interface ColumnRow {
  id: string;
  tenant_id: string;
  project_id: string;
  name: string;
  position: number;
}

const DEFAULT_COLUMNS = ['Новые', 'В работе', 'На тестировании', 'Готово'];

@Injectable()
export class ProjectsRepository {
  constructor(private readonly db: DbService) {}

  /** Список проектов. Архивные (status='archived') скрыты, пока их не запросят явно. */
  list(tenantId: string, includeArchived = false): Promise<ProjectRow[]> {
    // origin_label — имя портала-источника (для группировки импортированных проектов в сайдбаре)
    return this.db.many<ProjectRow>(
      `SELECT p.*, c.label AS origin_label, c.portal AS origin_portal, ow.full_name AS owner_name
         FROM projects p
         LEFT JOIN integration_connections c ON c.id = p.origin_connection_id
         LEFT JOIN users ow ON ow.id = p.owner_user_id
        WHERE p.tenant_id = $1 AND ($2::boolean OR p.status <> 'archived')
        -- Основные доски компании всегда сверху, дальше — заданный порядок, и лишь
        -- потом новые по дате. Без этого свои доски тонули среди импортированных.
        ORDER BY p.is_default DESC, p.sort_order, p.created_at DESC`,
      [tenantId, includeArchived],
    );
  }

  /**
   * Список проектов ВИДИМЫХ человеку — с цифрами по задачам.
   *
   * Одним запросом: страница «Проекты» показывает таблицу, и считать задачи по
   * каждому проекту отдельным походом в базу — это тридцать запросов на один экран.
   *
   * Видимость решается здесь же, а не в сервисе: фильтр в SQL нельзя забыть
   * применить, а проверку в коде — можно.
   */
  listWithStats(
    tenantId: string, viewer: { userId: string; role: string }, includeArchived: boolean,
  ): Promise<(ProjectRow & {
    origin_label: string | null; owner_name: string | null;
    tasks_total: number; tasks_open: number; tasks_overdue: number;
    next_deadline: string | null; members_count: number;
  })[]> {
    // руководство видит всё: иначе некому вернуть доступ к закрытому проекту
    const boss = viewer.role === 'owner' || viewer.role === 'manager';
    return this.db.many(
      `SELECT p.*, c.label AS origin_label, c.portal AS origin_portal, ow.full_name AS owner_name,
              COALESCE(st.total, 0)::int   AS tasks_total,
              COALESCE(st.open, 0)::int    AS tasks_open,
              COALESCE(st.overdue, 0)::int AS tasks_overdue,
              st.next_deadline,
              (SELECT COUNT(*)::int FROM project_members pm WHERE pm.project_id = p.id) AS members_count
         FROM projects p
         LEFT JOIN integration_connections c ON c.id = p.origin_connection_id
         LEFT JOIN users ow ON ow.id = p.owner_user_id
         LEFT JOIN LATERAL (
           SELECT COUNT(*) AS total,
                  COUNT(*) FILTER (WHERE t.closed_at IS NULL) AS open,
                  COUNT(*) FILTER (WHERE t.closed_at IS NULL AND t.deadline_at < now()) AS overdue,
                  MIN(t.deadline_at) FILTER (WHERE t.closed_at IS NULL) AS next_deadline
             FROM tasks t WHERE t.project_id = p.id
         ) st ON TRUE
        WHERE p.tenant_id = $1 AND ($2::boolean OR p.status <> 'archived')
          AND ($3::boolean OR p.visibility = 'all'
               OR p.owner_user_id = $4::bigint
               OR EXISTS (SELECT 1 FROM project_members pm
                           WHERE pm.project_id = p.id AND pm.user_id = $4::bigint))
        ORDER BY p.is_default DESC, p.sort_order, p.created_at DESC`,
      [tenantId, includeArchived, boss, viewer.userId],
    );
  }

  /** Видит ли человек этот проект — тем же правилом, что и список. */
  async canSee(tenantId: string, projectId: string, viewer: { userId: string; role: string }): Promise<boolean> {
    if (viewer.role === 'owner' || viewer.role === 'manager') return true;
    const row = await this.db.one<{ ok: boolean }>(
      `SELECT (p.visibility = 'all'
               OR p.owner_user_id = $3::bigint
               OR EXISTS (SELECT 1 FROM project_members pm
                           WHERE pm.project_id = p.id AND pm.user_id = $3::bigint)) AS ok
         FROM projects p WHERE p.tenant_id=$1 AND p.id=$2`,
      [tenantId, projectId, viewer.userId],
    );
    return !!row?.ok;
  }

  /** Правка проекта: название и видимость. Пустые поля не трогаем. */
  async update(
    tenantId: string, id: string, patch: { name?: string; visibility?: string; budget?: number | null },
  ): Promise<ProjectRow | null> {
    const set: string[] = [];
    const vals: unknown[] = [tenantId, id];
    let i = 3;
    if (patch.name !== undefined) { set.push(`name = $${i++}`); vals.push(patch.name); }
    if (patch.visibility !== undefined) { set.push(`visibility = $${i++}`); vals.push(patch.visibility); }
    if (patch.budget !== undefined) { set.push(`budget = $${i++}`); vals.push(patch.budget); }
    if (!set.length) return this.findById(tenantId, id);
    set.push('updated_at = now()');
    return this.db.one<ProjectRow>(
      `UPDATE projects SET ${set.join(', ')} WHERE tenant_id=$1 AND id=$2 RETURNING *`, vals,
    );
  }

  /**
   * Открыть закрытый проект тем, кто в нём уже работает.
   *
   * Постановщики, исполнители и соисполнители задач проекта попадают в список
   * автоматически при закрытии доски: иначе «видно только своим» означало бы, что
   * доску отобрали у всей команды, включая тех, кто на ней работает прямо сейчас.
   */
  async seedMembersFromTasks(tenantId: string, projectId: string): Promise<void> {
    await this.db.query(
      `INSERT INTO project_members (tenant_id, project_id, user_id)
            SELECT DISTINCT $1::bigint, $2::bigint, x.user_id
              FROM (
                SELECT t.assignee_id AS user_id FROM tasks t WHERE t.project_id = $2 AND t.assignee_id IS NOT NULL
                UNION
                SELECT t.created_by FROM tasks t WHERE t.project_id = $2 AND t.created_by IS NOT NULL
                UNION
                SELECT tp.user_id FROM task_participants tp
                  JOIN tasks t ON t.id = tp.task_id WHERE t.project_id = $2
              ) x
       ON CONFLICT DO NOTHING`,
      [tenantId, projectId],
    );
  }

  /** Кто допущен к закрытому проекту. */
  members(tenantId: string, projectId: string) {
    return this.db.many<{ user_id: string; full_name: string; added_at: Date }>(
      `SELECT pm.user_id::text, u.full_name, pm.added_at
         FROM project_members pm JOIN users u ON u.id = pm.user_id
        WHERE pm.tenant_id=$1 AND pm.project_id=$2
        ORDER BY u.full_name`,
      [tenantId, projectId],
    );
  }

  async addMembers(tenantId: string, projectId: string, userIds: string[]): Promise<void> {
    if (!userIds.length) return;
    await this.db.query(
      `INSERT INTO project_members (tenant_id, project_id, user_id)
            SELECT $1::bigint, $2::bigint, x FROM UNNEST($3::bigint[]) AS x
       ON CONFLICT DO NOTHING`,
      [tenantId, projectId, userIds],
    );
  }

  async removeMember(tenantId: string, projectId: string, userId: string): Promise<void> {
    await this.db.query(
      `DELETE FROM project_members WHERE tenant_id=$1 AND project_id=$2 AND user_id=$3`,
      [tenantId, projectId, userId],
    );
  }

  /**
   * Сохранить порядок досок: пришедший список задаёт номера с первого.
   *
   * Одним запросом, а не циклом: при трёх десятках досок цикл — тридцать походов
   * в базу ради одного перетаскивания.
   */
  async saveOrder(tenantId: string, ids: string[]): Promise<void> {
    if (!ids.length) return;
    await this.db.query(
      `UPDATE projects p SET sort_order = x.pos, updated_at = now()
         FROM (SELECT id, ordinality::int AS pos
                 FROM unnest($2::bigint[]) WITH ORDINALITY AS t(id, ordinality)) x
        WHERE p.tenant_id = $1 AND p.id = x.id`,
      [tenantId, ids],
    );
  }

  userInTenant(tenantId: string, userId: string): Promise<{ id: string } | null> {
    return this.db.one<{ id: string }>(`SELECT id FROM users WHERE tenant_id = $1 AND id = $2 AND is_active`, [tenantId, userId]);
  }

  /** Ответственный за проект — один человек, к которому идут с вопросами «что по проекту». */
  setOwner(tenantId: string, id: string, userId: string | null): Promise<ProjectRow | null> {
    return this.db.one<ProjectRow>(
      `UPDATE projects SET owner_user_id = $3, updated_at = now() WHERE tenant_id = $1 AND id = $2 RETURNING *`,
      [tenantId, id, userId],
    );
  }

  /** Пометить доску основной или снять пометку. */
  setDefault(tenantId: string, id: string, isDefault: boolean): Promise<ProjectRow | null> {
    return this.db.one<ProjectRow>(
      `UPDATE projects SET is_default = $3, updated_at = now()
        WHERE tenant_id = $1 AND id = $2 RETURNING *`,
      [tenantId, id, isDefault],
    );
  }

  /**
   * Вернуть порядок по умолчанию.
   *
   * Основные доски — первыми и по алфавиту, остальные следом тоже по алфавиту.
   * Это и есть ответ на «после импорта всё перемешалось»: одно нажатие возвращает
   * список к понятному виду, не трогая ни задач, ни самих досок.
   */
  async resetOrder(tenantId: string): Promise<void> {
    await this.db.query(
      `UPDATE projects p SET sort_order = x.pos, updated_at = now()
         FROM (SELECT id, row_number() OVER (ORDER BY is_default DESC, lower(name))::int AS pos
                 FROM projects WHERE tenant_id = $1) x
        WHERE p.tenant_id = $1 AND p.id = x.id`,
      [tenantId],
    );
  }

  /** Перевод проекта в архив и обратно. Данные не трогаем — проект просто исчезает из списков. */
  setArchived(tenantId: string, id: string, archived: boolean): Promise<ProjectRow | null> {
    return this.db.one<ProjectRow>(
      `UPDATE projects SET status = $3, updated_at = now()
        WHERE tenant_id = $1 AND id = $2 RETURNING *`,
      [tenantId, id, archived ? 'archived' : 'active'],
    );
  }

  findById(tenantId: string, id: string): Promise<ProjectRow | null> {
    return this.db.one<ProjectRow>(
      `SELECT * FROM projects WHERE tenant_id = $1 AND id = $2`,
      [tenantId, id],
    );
  }

  /** Создаёт проект и набор колонок доски по умолчанию в одной транзакции. */
  async create(input: {
    tenantId: string;
    name: string;
    clientId?: string | null;
    budget?: number | null;
  }): Promise<ProjectRow> {
    return this.db.withTransaction(async (client) => {
      const proj = await client.query<ProjectRow>(
        `INSERT INTO projects (tenant_id, name, client_id, budget)
         VALUES ($1, $2, $3, $4) RETURNING *`,
        [input.tenantId, input.name, input.clientId ?? null, input.budget ?? null],
      );
      const project = proj.rows[0];
      await this.seedColumns(client, input.tenantId, project.id);
      return project;
    });
  }

  private async seedColumns(client: PoolClient, tenantId: string, projectId: string) {
    for (let i = 0; i < DEFAULT_COLUMNS.length; i++) {
      await client.query(
        `INSERT INTO board_columns (tenant_id, project_id, name, position)
         VALUES ($1, $2, $3, $4)`,
        [tenantId, projectId, DEFAULT_COLUMNS[i], i],
      );
    }
  }

  listColumns(tenantId: string, projectId: string): Promise<ColumnRow[]> {
    return this.db.many<ColumnRow>(
      `SELECT * FROM board_columns WHERE tenant_id = $1 AND project_id = $2
        ORDER BY position ASC`,
      [tenantId, projectId],
    );
  }

  findColumn(tenantId: string, projectId: string, columnId: string): Promise<ColumnRow | null> {
    return this.db.one<ColumnRow>(
      `SELECT * FROM board_columns WHERE tenant_id = $1 AND project_id = $2 AND id = $3`,
      [tenantId, projectId, columnId],
    );
  }

  /**
   * Полное удаление проекта со всеми зависимостями в одной транзакции.
   * Дочерние данные задач удаляются, неключевые ссылки (deals/alerts/recommendations)
   * обнуляются — чтобы сохранить историю сделок/рекомендаций без проекта.
   */
  async deleteCascade(tenantId: string, projectId: string): Promise<void> {
    await this.db.withTransaction(async (client) => {
      const t: [string, string] = [tenantId, projectId];
      // подзапрос id задач проекта
      const taskSub = `SELECT id FROM tasks WHERE tenant_id = $1 AND project_id = $2`;
      // отвязать ссылки на time_logs/задачи в аудите стендапов
      await client.query(
        `UPDATE standup_actions SET task_id = NULL, applied_time_log_id = NULL
          WHERE tenant_id = $1 AND (task_id IN (${taskSub})
             OR applied_time_log_id IN (SELECT id FROM time_logs WHERE tenant_id = $1 AND task_id IN (${taskSub})))`,
        t,
      );
      // external_refs комментариев/файлов задач (пока строки существуют) + маппинги задач,
      // + чанки базы знаний этого проекта (source по access_scope=project_id)
      await client.query(
        `DELETE FROM external_refs WHERE tenant_id=$1 AND entity_type='comment'
           AND local_id IN (SELECT id FROM task_comments WHERE tenant_id=$1 AND task_id IN (${taskSub}))`, t);
      await client.query(
        `DELETE FROM external_refs WHERE tenant_id=$1 AND entity_type='file'
           AND local_id IN (SELECT file_id FROM task_attachments WHERE tenant_id=$1 AND task_id IN (${taskSub}))`, t);
      await client.query(`DELETE FROM external_refs WHERE tenant_id=$1 AND entity_type='task' AND local_id IN (${taskSub})`, t);
      await client.query(`DELETE FROM knowledge_chunks WHERE tenant_id=$1 AND access_scope=$2`, t);
      // дочерние таблицы задач
      for (const tbl of [
        'task_activity',
        'task_reads',
        'task_watchers',
        'task_labels',
        'task_checklist_items',
        'task_attachments',
        'task_comments',
        'task_embeddings',
        'assignment_audit',
        'time_logs',
      ]) {
        await client.query(`DELETE FROM ${tbl} WHERE tenant_id = $1 AND task_id IN (${taskSub})`, t);
      }
      // обнулить мягкие ссылки на задачи
      await client.query(`UPDATE alerts SET task_id = NULL WHERE tenant_id = $1 AND task_id IN (${taskSub})`, t);
      await client.query(
        `UPDATE recommendations SET task_id = NULL WHERE tenant_id = $1 AND task_id IN (${taskSub})`,
        t,
      );
      // сами задачи и колонки (external_refs колонок чистим, пока board_columns существуют)
      await client.query(`DELETE FROM tasks WHERE tenant_id = $1 AND project_id = $2`, t);
      await client.query(
        `DELETE FROM external_refs WHERE tenant_id=$1 AND entity_type='column'
           AND local_id IN (SELECT id FROM board_columns WHERE tenant_id=$1 AND project_id=$2)`, t);
      await client.query(`DELETE FROM board_columns WHERE tenant_id = $1 AND project_id = $2`, t);
      // обнулить ссылки на проект
      await client.query(`UPDATE deals SET project_id = NULL WHERE tenant_id = $1 AND project_id = $2`, t);
      await client.query(`UPDATE alerts SET project_id = NULL WHERE tenant_id = $1 AND project_id = $2`, t);
      await client.query(
        `UPDATE recommendations SET project_id = NULL WHERE tenant_id = $1 AND project_id = $2`,
        t,
      );
      // импортированное из Битрикса: лента проекта (FK на проект) + маппинг самого проекта
      await client.query(`DELETE FROM imported_messages WHERE tenant_id = $1 AND project_id = $2`, t);
      await client.query(`DELETE FROM external_refs WHERE tenant_id=$1 AND entity_type='project' AND local_id=$2`, t);
      await client.query(`DELETE FROM projects WHERE tenant_id = $1 AND id = $2`, t);
    });
  }

  countColumns(tenantId: string, projectId: string): Promise<number> {
    return this.db
      .one<{ n: string }>(
        `SELECT COUNT(*)::int AS n FROM board_columns WHERE tenant_id = $1 AND project_id = $2`,
        [tenantId, projectId],
      )
      .then((r) => Number(r?.n ?? 0));
  }

  /** Добавляет колонку в конец доски. */
  addColumn(tenantId: string, projectId: string, name: string): Promise<ColumnRow | null> {
    return this.db.one<ColumnRow>(
      `INSERT INTO board_columns (tenant_id, project_id, name, position)
       VALUES ($1, $2, $3,
         (SELECT COALESCE(MAX(position) + 1, 0) FROM board_columns WHERE tenant_id = $1 AND project_id = $2))
       RETURNING *`,
      [tenantId, projectId, name],
    );
  }

  /**
   * Доски по умолчанию — в начало проекта.
   *
   * Проект, приехавший из YouGile или Битрикса, живёт с чужими колонками, а
   * заведённый вручную — с теми, что успели насоздавать. Привычного набора
   * «Новые · В работе · На тестировании · Готово» в них нет, и работа по разным
   * проектам идёт по разным правилам.
   *
   * Чего здесь НЕ происходит: ничего не удаляется и не переименовывается. Свои
   * колонки остаются целыми вместе с задачами — просто уезжают правее. Уже
   * существующая «Готово» (хоть «готово», хоть « Готово ») второй раз не заводится,
   * а встаёт на своё место в наборе: иначе с каждым нажатием доска обрастала бы
   * близнецами.
   *
   * Порядок выставляем ПОСЛЕ вставки: UNIQUE(project_id, position) не даст
   * втиснуть новую колонку в начало, пока прежние занимают эти номера.
   */
  async ensureDefaultColumns(tenantId: string, projectId: string): Promise<{ added: ColumnRow[] }> {
    return this.db.withTransaction(async (client) => {
      const existing = (
        await client.query<ColumnRow>(
          `SELECT * FROM board_columns WHERE tenant_id = $1 AND project_id = $2
            ORDER BY position ASC FOR UPDATE`,
          [tenantId, projectId],
        )
      ).rows;

      // Сравниваем без учёта регистра и пробелов по краям: «в работе» и «В работе  » —
      // это одна и та же колонка, и заводить вторую значит сломать доску.
      const key = (s: string) => s.trim().toLowerCase();
      const have = new Map(existing.map((c) => [key(c.name), c]));
      const added: ColumnRow[] = [];
      let next = existing.reduce((max, c) => Math.max(max, c.position), -1) + 1;

      for (const name of DEFAULT_COLUMNS) {
        if (have.has(key(name))) continue;
        const row = (
          await client.query<ColumnRow>(
            `INSERT INTO board_columns (tenant_id, project_id, name, position)
             VALUES ($1, $2, $3, $4) RETURNING *`,
            [tenantId, projectId, name, next++],
          )
        ).rows[0];
        have.set(key(name), row);
        added.push(row);
      }

      const head = DEFAULT_COLUMNS.map((n) => have.get(key(n))).filter((c): c is ColumnRow => !!c);
      const headIds = new Set(head.map((c) => String(c.id)));
      const tail = existing.filter((c) => !headIds.has(String(c.id)));
      await this.applyColumnOrder(client, tenantId, [...head, ...tail].map((c) => String(c.id)));
      return { added };
    });
  }

  renameColumn(tenantId: string, projectId: string, columnId: string, name: string): Promise<ColumnRow | null> {
    return this.db.one<ColumnRow>(
      `UPDATE board_columns SET name = $4 WHERE tenant_id = $1 AND project_id = $2 AND id = $3 RETURNING *`,
      [tenantId, projectId, columnId, name],
    );
  }

  /** Задачи колонки — нужны, чтобы перед удалением колонки переставить их и во внешней системе. */
  async columnTaskIds(tenantId: string, columnId: string): Promise<string[]> {
    const rows = await this.db.many<{ id: string }>(
      `SELECT id FROM tasks WHERE tenant_id = $1 AND column_id = $2`, [tenantId, columnId]);
    return rows.map((r) => r.id);
  }

  /** Удаляет колонку; её задачи переносятся в крайнюю левую из оставшихся (без потери данных). */
  async deleteColumn(tenantId: string, projectId: string, columnId: string): Promise<void> {
    await this.db.withTransaction(async (client) => {
      const others = (
        await client.query<ColumnRow>(
          `SELECT * FROM board_columns WHERE tenant_id = $1 AND project_id = $2 AND id <> $3 ORDER BY position ASC`,
          [tenantId, projectId, columnId],
        )
      ).rows;
      const target = others[0];
      if (target) {
        const off = (
          await client.query<{ next: number }>(
            `SELECT COALESCE(MAX(position) + 1, 0) AS next FROM tasks WHERE tenant_id = $1 AND column_id = $2`,
            [tenantId, target.id],
          )
        ).rows[0].next;
        // переносим задачи в целевую колонку, переоткрываем (целевая — не Done)
        await client.query(
          `UPDATE tasks SET column_id = $3, position = position + $4, status = $5, closed_at = NULL, updated_at = now()
            WHERE tenant_id = $1 AND column_id = $2`,
          [tenantId, columnId, target.id, off, target.name],
        );
      }
      await client.query(
        `DELETE FROM board_columns WHERE tenant_id = $1 AND project_id = $2 AND id = $3`,
        [tenantId, projectId, columnId],
      );
      await this.renumberColumns(client, tenantId, projectId);
    });
  }

  /** Перемещает колонку влево/вправо (перестановка с соседом). */
  async moveColumn(tenantId: string, projectId: string, columnId: string, direction: 'left' | 'right'): Promise<void> {
    await this.db.withTransaction(async (client) => {
      const cols = (
        await client.query<ColumnRow>(
          `SELECT * FROM board_columns WHERE tenant_id = $1 AND project_id = $2 ORDER BY position ASC FOR UPDATE`,
          [tenantId, projectId],
        )
      ).rows;
      const idx = cols.findIndex((c) => String(c.id) === String(columnId));
      if (idx < 0) return;
      const swap = direction === 'left' ? idx - 1 : idx + 1;
      if (swap < 0 || swap >= cols.length) return;
      const order = cols.map((c) => c.id);
      [order[idx], order[swap]] = [order[swap], order[idx]];
      await this.applyColumnOrder(client, tenantId, order);
    });
  }

  /** Устанавливает произвольный порядок колонок (drag-and-drop). Валидация набора — в сервисе. */
  async reorderColumns(tenantId: string, projectId: string, orderedIds: string[]): Promise<void> {
    void projectId;
    await this.db.withTransaction(async (client) => {
      await this.applyColumnOrder(client, tenantId, orderedIds);
    });
  }

  /** Пересортировка позиций 0..n-1 по текущему порядку (двухпроходно — из-за UNIQUE(project_id,position)). */
  private async renumberColumns(client: PoolClient, tenantId: string, projectId: string): Promise<void> {
    const cols = (
      await client.query<{ id: string }>(
        `SELECT id FROM board_columns WHERE tenant_id = $1 AND project_id = $2 ORDER BY position ASC`,
        [tenantId, projectId],
      )
    ).rows;
    await this.applyColumnOrder(client, tenantId, cols.map((c) => c.id));
  }

  /** Двухпроходное проставление позиций (сначала +большой офсет, потом финальные индексы). */
  private async applyColumnOrder(client: PoolClient, tenantId: string, orderedIds: string[]): Promise<void> {
    for (let i = 0; i < orderedIds.length; i++) {
      await client.query(`UPDATE board_columns SET position = $3 WHERE tenant_id = $1 AND id = $2`, [
        tenantId,
        orderedIds[i],
        i + 1000,
      ]);
    }
    for (let i = 0; i < orderedIds.length; i++) {
      await client.query(`UPDATE board_columns SET position = $3 WHERE tenant_id = $1 AND id = $2`, [
        tenantId,
        orderedIds[i],
        i,
      ]);
    }
  }

  findColumnByName(tenantId: string, projectId: string, name: string): Promise<ColumnRow | null> {
    return this.db.one<ColumnRow>(
      `SELECT * FROM board_columns
        WHERE tenant_id = $1 AND project_id = $2 AND lower(name) = lower($3)`,
      [tenantId, projectId, name],
    );
  }

  /** Распознаёт «корзину» колонки по имени (EN+RU) — чтобы статус-переносы работали независимо от языка набора. */
  private bucketOf(name: string): 'todo' | 'inprogress' | 'done' | null {
    const n = name.trim().toLowerCase();
    if (['done', 'готово', 'выполнено', 'завершено', 'завершён', 'завершен', 'закрыто', 'сделано'].includes(n)) return 'done';
    if (['in progress', 'inprogress', 'в работе', 'в процессе', 'делается', 'разработка'].includes(n)) return 'inprogress';
    if (['to do', 'todo', 'backlog', 'бэклог', 'новые', 'новая', 'сделать', 'очередь', 'к выполнению'].includes(n)) return 'todo';
    return null;
  }

  /** Колонка тестирования/ревью (для авто-переноса результата ИИ-агента на проверку человеку). */
  findTestingColumn(tenantId: string, projectId: string): Promise<ColumnRow | null> {
    return this.db.one<ColumnRow>(
      `SELECT * FROM board_columns
        WHERE tenant_id=$1 AND project_id=$2
          AND (lower(name) LIKE '%тест%' OR lower(name) LIKE '%testing%' OR lower(name) LIKE '%ревью%' OR lower(name) LIKE '%review%' OR lower(name)='qa')
        ORDER BY position LIMIT 1`,
      [tenantId, projectId],
    );
  }

  /** Колонка проекта по «корзине» (todo|inprogress|done); понимает и русский, и английский набор. */
  async findColumnByBucket(tenantId: string, projectId: string, bucket: 'todo' | 'inprogress' | 'done'): Promise<ColumnRow | null> {
    const cols = await this.db.many<ColumnRow>(
      `SELECT * FROM board_columns WHERE tenant_id=$1 AND project_id=$2 ORDER BY position`,
      [tenantId, projectId],
    );
    return cols.find((c) => this.bucketOf(c.name) === bucket) ?? null;
  }
}
