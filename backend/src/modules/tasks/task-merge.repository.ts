import { Injectable } from '@nestjs/common';
import { PoolClient } from 'pg';
import { DbService } from '../../database/db.service';

export interface MergeTaskRow {
  id: string;
  title: string;
  description: string | null;
  project_id: string;
  project_name: string | null;
  assignee_id: string | null;
  assignee_name: string | null;
  manager_id: string | null;
  manager_name: string | null;
  closed_at: Date | null;
  merged_into_id: string | null;
  created_at: Date;
}

/**
 * Данные для объединения задач.
 *
 * Отдельным репозиторием, а не в общем: здесь всё про перенос строк из одной
 * задачи в другую, и мешать это с обычными выборками доски значит однажды
 * случайно применить «перенеси всё» там, где просили «покажи список».
 */
@Injectable()
export class TaskMergeRepository {
  constructor(private readonly db: DbService) {}

  /** Задача со всем, что нужно и для проверки прав, и для показа в списке. */
  byId(tenantId: string, id: string): Promise<MergeTaskRow | null> {
    return this.db.one<MergeTaskRow>(
      `SELECT t.id, t.title, t.description, t.project_id, p.name AS project_name,
              t.assignee_id, a.full_name AS assignee_name,
              t.created_by AS manager_id, m.full_name AS manager_name,
              t.closed_at, t.merged_into_id, t.created_at
         FROM tasks t
         JOIN projects p ON p.id = t.project_id
    LEFT JOIN users a ON a.id = t.assignee_id
    LEFT JOIN users m ON m.id = t.created_by
        WHERE t.tenant_id=$1 AND t.id=$2`,
      [tenantId, id],
    );
  }

  /**
   * Кандидаты на объединение.
   *
   * Берём открытые задачи компании: закрытую объединять незачем, а объединённую —
   * нельзя. Своя задача исключается сразу, иначе она возглавит собственный список
   * похожих со стопроцентным совпадением.
   *
   * `q` — ручной поиск: по названию, номеру, проекту, исполнителю и постановщику.
   * Ровно эти пять полей человек и помнит о задаче, которую ищет.
   */
  candidates(tenantId: string, exceptId: string, q: string | null, limit: number): Promise<MergeTaskRow[]> {
    const params: unknown[] = [tenantId, exceptId, limit];
    let filter = '';
    if (q) {
      params.push(`%${q}%`);
      const like = `$${params.length}`;
      // Номер ищем отдельно и точным равенством: «1264» внутри ILIKE нашло бы и 11264
      const asNumber = /^\d+$/.test(q) ? `OR t.id = ${Number(q)}` : '';
      filter = `AND (
        t.title ILIKE ${like}
        OR p.name ILIKE ${like}
        OR a.full_name ILIKE ${like}
        OR m.full_name ILIKE ${like}
        ${asNumber}
      )`;
    }
    return this.db.many<MergeTaskRow>(
      `SELECT t.id, t.title, t.description, t.project_id, p.name AS project_name,
              t.assignee_id, a.full_name AS assignee_name,
              t.created_by AS manager_id, m.full_name AS manager_name,
              t.closed_at, t.merged_into_id, t.created_at
         FROM tasks t
         JOIN projects p ON p.id = t.project_id AND p.status <> 'archived'
    LEFT JOIN users a ON a.id = t.assignee_id
    LEFT JOIN users m ON m.id = t.created_by
        WHERE t.tenant_id=$1 AND t.id <> $2::bigint
          AND t.closed_at IS NULL AND t.merged_into_id IS NULL
          ${filter}
        ORDER BY t.id DESC
        LIMIT $3`,
      params,
    );
  }

  /** Что лежит в задаче — для предпросмотра «что переедет». */
  async contents(tenantId: string, taskId: string) {
    const [comments, files, checklist, participants, messages, meetings] = await Promise.all([
      this.count(`SELECT COUNT(*) AS n FROM task_comments WHERE tenant_id=$1 AND task_id=$2`, tenantId, taskId),
      this.count(`SELECT COUNT(*) AS n FROM task_attachments WHERE tenant_id=$1 AND task_id=$2`, tenantId, taskId),
      this.count(`SELECT COUNT(*) AS n FROM task_checklist_items WHERE tenant_id=$1 AND task_id=$2`, tenantId, taskId),
      this.count(
        `SELECT COUNT(DISTINCT user_id) AS n FROM task_participants WHERE tenant_id=$1 AND task_id=$2`,
        tenantId, taskId,
      ),
      this.count(`SELECT COUNT(*) AS n FROM chat_messages WHERE tenant_id=$1 AND task_id=$2`, tenantId, taskId),
      this.count(`SELECT COUNT(*) AS n FROM meeting_task_drafts WHERE tenant_id=$1 AND task_id=$2`, tenantId, taskId),
    ]);
    return { comments, files, checklist, participants, messages, meetings };
  }

  private async count(sql: string, tenantId: string, taskId: string): Promise<number> {
    const row = await this.db.one<{ n: string }>(sql, [tenantId, taskId]);
    return Number(row?.n ?? 0);
  }

  /** Пункты чек-листа по порядку — их склеивают и показывают до объединения. */
  checklist(tenantId: string, taskId: string): Promise<{ id: string; text: string; is_done: boolean }[]> {
    return this.db.many(
      `SELECT id, text, is_done FROM task_checklist_items
        WHERE tenant_id=$1 AND task_id=$2 ORDER BY position, id`,
      [tenantId, taskId],
    );
  }

  /** Кого затрагивает объединение: исполнители, постановщики, соисполнители, наблюдатели. */
  async peopleOf(tenantId: string, taskIds: string[]): Promise<string[]> {
    const rows = await this.db.many<{ user_id: string }>(
      `SELECT assignee_id::text AS user_id FROM tasks
        WHERE tenant_id=$1 AND id = ANY($2::bigint[]) AND assignee_id IS NOT NULL
       UNION
       SELECT created_by::text FROM tasks
        WHERE tenant_id=$1 AND id = ANY($2::bigint[]) AND created_by IS NOT NULL
       UNION
       SELECT user_id::text FROM task_participants
        WHERE tenant_id=$1 AND task_id = ANY($2::bigint[])
       UNION
       SELECT user_id::text FROM task_watchers
        WHERE tenant_id=$1 AND task_id = ANY($2::bigint[])`,
      [tenantId, taskIds],
    );
    return rows.map((r) => String(r.user_id));
  }

  /**
   * Само объединение — одной транзакцией.
   *
   * Переписка, файлы, сообщения чата и связи со встречами ПЕРЕЕЗЖАЮТ: разговор об
   * одной работе должен быть в одном месте. Чек-лист, люди и метки КОПИРУЮТСЯ —
   * вторая задача остаётся читаемой записью о том, что в ней было.
   *
   * Учтённое время не трогаем вовсе: часы принадлежат работе, которую человек
   * действительно делал по той задаче, и переносить их значит врать себестоимости.
   */
  async apply(input: {
    tenantId: string;
    primaryId: string;
    secondaryId: string;
    actorId: string;
    title: string | null;
    description: string | null;
    checklist: string[] | null;
  }): Promise<void> {
    const { tenantId, primaryId, secondaryId, actorId } = input;
    await this.db.withTransaction(async (c: PoolClient) => {
      const p = [tenantId, primaryId, secondaryId];

      await c.query(`UPDATE task_comments SET task_id=$2 WHERE tenant_id=$1 AND task_id=$3`, p);
      await c.query(
        `INSERT INTO task_attachments (tenant_id, task_id, file_id)
              SELECT tenant_id, $2::bigint, file_id FROM task_attachments
               WHERE tenant_id=$1 AND task_id=$3
         ON CONFLICT (task_id, file_id) DO NOTHING`, p,
      );
      // Свой список параметров, а не общий `p`: Postgres роняет ВЕСЬ запрос, если
      // переданный параметр в тексте не используется («could not determine data
      // type of parameter $2»). Эти грабли у нас уже были в реестре задач.
      await c.query(`DELETE FROM task_attachments WHERE tenant_id=$1 AND task_id=$2`, [tenantId, secondaryId]);
      await c.query(`UPDATE chat_messages SET task_id=$2 WHERE tenant_id=$1 AND task_id=$3`, p);
      await c.query(`UPDATE meeting_task_drafts SET task_id=$2 WHERE tenant_id=$1 AND task_id=$3`, p);

      // Люди второй задачи переезжают соисполнителями и наблюдателями. Исполнитель
      // второй задачи — соисполнитель первой: работу он уже делал, и вычеркнуть его
      // объединением значит потерять того, кто в теме.
      await c.query(
        `INSERT INTO task_participants (tenant_id, task_id, user_id, role, added_by)
              SELECT tenant_id, $2::bigint, user_id, role, $4::bigint FROM task_participants
               WHERE tenant_id=$1 AND task_id=$3
         ON CONFLICT DO NOTHING`, [...p, actorId],
      );
      await c.query(
        `INSERT INTO task_participants (tenant_id, task_id, user_id, role, added_by)
              SELECT $1::bigint, $2::bigint, s.assignee_id, 'co_assignee', $4::bigint
                FROM tasks s, tasks pr
               WHERE s.tenant_id=$1 AND s.id=$3 AND pr.tenant_id=$1 AND pr.id=$2
                 AND s.assignee_id IS NOT NULL
                 AND s.assignee_id IS DISTINCT FROM pr.assignee_id
         ON CONFLICT DO NOTHING`, [...p, actorId],
      );
      await c.query(
        `INSERT INTO task_watchers (tenant_id, task_id, user_id)
              SELECT tenant_id, $2::bigint, user_id FROM task_watchers
               WHERE tenant_id=$1 AND task_id=$3
         ON CONFLICT DO NOTHING`, p,
      );
      await c.query(
        `INSERT INTO task_labels (tenant_id, task_id, label_id)
              SELECT tenant_id, $2::bigint, label_id FROM task_labels
               WHERE tenant_id=$1 AND task_id=$3
         ON CONFLICT DO NOTHING`, p,
      );

      // Чек-лист: если человек утвердил склеенный список, он заменяет прежний целиком —
      // иначе пункты второй задачи просто дописываются на сервисном слое.
      if (input.checklist) {
        await c.query(`DELETE FROM task_checklist_items WHERE tenant_id=$1 AND task_id=$2`, [tenantId, primaryId]);
        let pos = 0;
        for (const text of input.checklist) {
          pos += 1;
          await c.query(
            `INSERT INTO task_checklist_items (tenant_id, task_id, text, position) VALUES ($1,$2,$3,$4)`,
            [tenantId, primaryId, text.slice(0, 500), pos],
          );
        }
      }

      if (input.title || input.description !== null) {
        await c.query(
          `UPDATE tasks
              SET title = COALESCE($3::varchar, title),
                  description = COALESCE($4::text, description),
                  updated_at = now()
            WHERE tenant_id=$1 AND id=$2`,
          [tenantId, primaryId, input.title, input.description],
        );
      }

      // Вторая задача остаётся — с пометкой и ссылкой. Удалять её нельзя: на её
      // номер уже ссылались в переписке и в отчётах.
      await c.query(
        `UPDATE tasks
            SET merged_into_id=$3::bigint, merged_at=now(), merged_by=$4::bigint,
                closed_at=COALESCE(closed_at, now()), updated_at=now()
          WHERE tenant_id=$1 AND id=$2`,
        [tenantId, secondaryId, primaryId, actorId],
      );
    });
  }
}
