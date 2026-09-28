import { Injectable } from '@nestjs/common';
import { DbService } from '../../database/db.service';
import { NoticeKind } from './deadline-notice';

export interface DeadlineCandidate {
  tenant_id: string;
  task_id: string;
  project_id: string;
  title: string;
  deadline_at: string;
  closed: boolean;
  assignee_id: string | null;
  assignee_name: string | null;
  /** Часовой пояс исполнителя: срок в тексте должен читаться так же, как в карточке. */
  timezone: string | null;
  /** Про какие виды с ЭТИМ сроком уже говорили. */
  said: NoticeKind[];
}

/**
 * Предупреждения о сроке: кого пора предупредить и о чём уже сказали.
 *
 * Отбор идёт по всем организациям сразу — планировщик один на сервер. Ограничение
 * сверху обязательно: на большой базе первый проход после простоя иначе разом поднял
 * бы тысячи задач и написал в каждую.
 */
@Injectable()
export class DeadlineNoticesRepository {
  constructor(private readonly db: DbService) {}

  /**
   * Задачи, у которых срок уже близко или прошёл.
   *
   * Берём только те, где есть что сказать: либо про «скоро» ещё не говорили, либо про
   * «просрочена». Проверку «что именно сказать» делает чистая функция noticeDue —
   * здесь отсекаем лишь заведомо ненужное, чтобы не тащить всю базу.
   *
   * Закрытые и удалённые не трогаем: у закрытой задачи срока больше нет, а корзина —
   * это уже не работа.
   */
  due(now: Date, soonMs: number, limit = 200): Promise<DeadlineCandidate[]> {
    return this.db.many<DeadlineCandidate>(
      `SELECT t.tenant_id::text, t.id::text AS task_id, t.project_id::text, t.title,
              t.deadline_at, (t.closed_at IS NOT NULL) AS closed,
              t.assignee_id::text, u.full_name AS assignee_name, u.timezone,
              COALESCE((
                SELECT array_agg(n.kind)
                  FROM task_deadline_notices n
                 WHERE n.task_id = t.id AND n.deadline_at = t.deadline_at
              ), ARRAY[]::text[]) AS said
         FROM tasks t
         LEFT JOIN users u ON u.id = t.assignee_id
         JOIN projects p ON p.id = t.project_id AND p.status <> 'archived'
        WHERE t.deadline_at IS NOT NULL
          AND t.closed_at IS NULL
          AND t.deleted_at IS NULL
          AND t.deadline_at <= $1::timestamptz + ($2::bigint || ' milliseconds')::interval
          AND NOT EXISTS (
                SELECT 1 FROM task_deadline_notices n
                 WHERE n.task_id = t.id AND n.deadline_at = t.deadline_at
                   AND n.kind = CASE WHEN t.deadline_at <= $1::timestamptz THEN 'overdue' ELSE 'soon' END
              )
        ORDER BY t.deadline_at
        LIMIT $3`,
      [now.toISOString(), String(soonMs), limit],
    );
  }

  /**
   * Запомнить, что сказали.
   *
   * Возвращает false, если запись уже была: во время выкладки недолго живут два
   * экземпляра приложения, и оба могут взять одну задачу. Выигрывает тот, кто успел
   * вставить строку, — второй промолчит и не продублирует сообщение.
   */
  async remember(tenantId: string, taskId: string, kind: NoticeKind, deadlineAt: string): Promise<boolean> {
    const row = await this.db.one<{ id: string }>(
      `INSERT INTO task_deadline_notices (tenant_id, task_id, kind, deadline_at)
            VALUES ($1, $2, $3, $4)
       ON CONFLICT (task_id, kind, deadline_at) DO NOTHING
         RETURNING id::text`,
      [tenantId, taskId, kind, deadlineAt],
    );
    return !!row;
  }

  /**
   * Системная строка в обсуждение задачи: без автора и ТОЛЬКО для своих.
   *
   * Заказчику её не показываем намеренно: «мы не успеваем» — разговор, который ведут
   * с клиентом словами и в нужный момент, а не автоматическим объявлением в ленте.
   */
  addSystemComment(tenantId: string, taskId: string, body: string): Promise<{ id: string } | null> {
    return this.db.one<{ id: string }>(
      `INSERT INTO task_comments (tenant_id, task_id, author_id, body, is_client_visible, is_system)
            VALUES ($1, $2, NULL, $3, FALSE, TRUE)
         RETURNING id::text`,
      [tenantId, taskId, body],
    );
  }

  /** Кому это касается: исполнитель, постановщик и участники — им и подсвечивать задачу. */
  async interested(tenantId: string, taskId: string): Promise<string[]> {
    const rows = await this.db.many<{ user_id: string }>(
      `SELECT DISTINCT user_id::text FROM (
         SELECT assignee_id AS user_id FROM tasks WHERE tenant_id = $1 AND id = $2
         UNION
         SELECT created_by FROM tasks WHERE tenant_id = $1 AND id = $2
         UNION
         SELECT user_id FROM task_participants WHERE tenant_id = $1 AND task_id = $2
       ) x WHERE user_id IS NOT NULL`,
      [tenantId, taskId],
    );
    return rows.map((r) => String(r.user_id));
  }
}
