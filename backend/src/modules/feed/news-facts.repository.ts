import { Injectable } from '@nestjs/common';
import { DbService } from '../../database/db.service';

/**
 * Факты для «Новостей» (ТЗ-20, §11, §42, §26): всё, из чего собираются хайлайт дня,
 * выводы недели и кандидаты на вехи и релизы. Только чтение и только по базе —
 * текст из этих фактов пишут правила (news-rules.ts), модель лишь шлифует.
 *
 * Окно — полуинтервал [from, to) в абсолютном времени: местные границы дня считает
 * вызывающий по поясу организации.
 */
@Injectable()
export class NewsFactsRepository {
  constructor(private readonly db: DbService) {}

  /** Организации, у которых есть хоть кто-то живой: планировщик ходит только по ним. */
  activeTenants() {
    return this.db.many<{ id: string; timezone: string | null }>(
      `SELECT t.id, t.timezone FROM tenants t
        WHERE EXISTS (SELECT 1 FROM users u WHERE u.tenant_id = t.id AND u.is_active
                         AND u.last_seen_at > now() - interval '14 days')`,
    );
  }

  /**
   * Закрытые задачи окна. Только проекты, видимые всем (§56): закрытое в закрытом
   * проекте в хайлайт для всей компании не попадает ни цифрой, ни названием.
   */
  closedTasks(tenantId: string, from: Date, to: Date) {
    return this.db.many<{ id: string; title: string; project_id: string; project_name: string | null; priority: string; assignee_id: string | null; assignee_name: string | null }>(
      `SELECT t.id::text, t.title, t.project_id::text, p.name AS project_name, t.priority,
              t.assignee_id::text, u.full_name AS assignee_name
         FROM tasks t JOIN projects p ON p.id = t.project_id
    LEFT JOIN users u ON u.id = t.assignee_id
        WHERE t.tenant_id = $1 AND t.deleted_at IS NULL AND t.closed_at >= $2 AND t.closed_at < $3
          AND COALESCE(p.visibility, 'all') = 'all' AND NOT p.is_demo
        ORDER BY CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 ELSE 2 END, t.closed_at DESC`,
      [tenantId, from, to],
    );
  }

  async closedCount(tenantId: string, from: Date, to: Date): Promise<number> {
    const row = await this.db.one<{ n: number }>(
      `SELECT count(*)::int AS n FROM tasks t JOIN projects p ON p.id = t.project_id
        WHERE t.tenant_id = $1 AND t.deleted_at IS NULL AND t.closed_at >= $2 AND t.closed_at < $3
          AND COALESCE(p.visibility, 'all') = 'all' AND NOT p.is_demo`,
      [tenantId, from, to],
    );
    return Number(row?.n ?? 0);
  }

  /** Созвоны окна: штуки и минуты (§11). Только разобранные и прошедшие. */
  async meetings(tenantId: string, from: Date, to: Date) {
    const row = await this.db.one<{ n: number; sec: number }>(
      `SELECT count(*)::int AS n, COALESCE(sum(duration_sec), 0)::int AS sec
         FROM meetings m LEFT JOIN projects p ON p.id = m.project_id
        WHERE m.tenant_id = $1 AND COALESCE(m.happened_at, m.created_at) >= $2 AND COALESCE(m.happened_at, m.created_at) < $3
          AND COALESCE(p.visibility, 'all') = 'all'`,
      [tenantId, from, to],
    );
    return { count: Number(row?.n ?? 0), minutes: Math.round(Number(row?.sec ?? 0) / 60) };
  }

  /** Разобранные встречи окна — с названием для выводов недели. */
  meetingList(tenantId: string, from: Date, to: Date) {
    return this.db.many<{ id: string; title: string | null }>(
      `SELECT m.id::text, m.title FROM meetings m LEFT JOIN projects p ON p.id = m.project_id
        WHERE m.tenant_id = $1 AND m.status = 'done'
          AND COALESCE(m.happened_at, m.created_at) >= $2 AND COALESCE(m.happened_at, m.created_at) < $3
          AND COALESCE(p.visibility, 'all') = 'all'
        ORDER BY COALESCE(m.happened_at, m.created_at) DESC LIMIT 10`,
      [tenantId, from, to],
    );
  }

  /**
   * Решения окна (журнал ТЗ-12). Только из общих чатов и встреч открытых проектов:
   * решение из личной переписки или закрытого проекта всей компании не показываем.
   */
  decisions(tenantId: string, from: Date, to: Date) {
    return this.db.many<{ id: string; text: string; chat_id: string | null; meeting_id: string | null }>(
      `SELECT d.id::text, d.text, d.chat_id::text, d.meeting_id::text
         FROM decisions d
    LEFT JOIN projects p ON p.id = d.project_id
    LEFT JOIN chats c ON c.id = d.chat_id
        WHERE d.tenant_id = $1 AND d.revoked_at IS NULL AND d.decided_at >= $2 AND d.decided_at < $3
          AND COALESCE(p.visibility, 'all') = 'all'
          AND (d.chat_id IS NULL OR (c.kind IN ('project', 'channel') OR (c.kind = 'group' AND NOT COALESCE(c.is_private, TRUE))))
        ORDER BY d.decided_at DESC LIMIT 10`,
      [tenantId, from, to],
    );
  }

  /** Релизы и вехи, опубликованные в ленте за окно, — хайлайт на них ссылается (§70). */
  releasePosts(tenantId: string, from: Date, to: Date) {
    return this.db.many<{ id: string; title: string | null; body: string }>(
      `SELECT id::text, title, body FROM feed_posts
        WHERE tenant_id = $1 AND deleted_at IS NULL AND status = 'published' AND visibility = 'all'
          AND type IN ('release', 'milestone') AND published_at >= $2 AND published_at < $3
        ORDER BY id`,
      [tenantId, from, to],
    );
  }

  /** Благодарности окна: кому (для героя дня и строки «спасибо сказали N раз»). */
  kudos(tenantId: string, from: Date, to: Date) {
    return this.db.many<{ to_user_id: string; to_name: string }>(
      `SELECT (p.meta->>'toUserId') AS to_user_id, u.full_name AS to_name
         FROM feed_posts p JOIN users u ON u.id = (p.meta->>'toUserId')::bigint
        WHERE p.tenant_id = $1 AND p.deleted_at IS NULL AND p.status = 'published' AND p.type = 'kudos'
          AND p.published_at >= $2 AND p.published_at < $3`,
      [tenantId, from, to],
    );
  }

  /**
   * Снятые препятствия: исполнитель попросил перенос («не успеваю», «есть блокер»),
   * постановщик решил — да или нет. Ручной перенос срока без просьбы сюда не идёт:
   * препятствия не было. Считаем по журналу задачи, в нём оба события уже пишутся.
   */
  async blockersResolved(tenantId: string, from: Date, to: Date): Promise<number> {
    const row = await this.db.one<{ n: number }>(
      `SELECT count(*)::int AS n FROM task_activity a
        WHERE a.tenant_id = $1 AND a.created_at >= $2 AND a.created_at < $3
          AND a.kind IN ('deadline_shifted', 'deadline_shift_declined')
          AND EXISTS (SELECT 1 FROM task_activity q
                       WHERE q.task_id = a.task_id AND q.kind = 'deadline_shift_asked'
                         AND q.created_at < a.created_at AND q.created_at > a.created_at - interval '14 days')`,
      [tenantId, from, to],
    );
    return Number(row?.n ?? 0);
  }

  // ── кандидаты (§26) ──

  /**
   * Веха: в открытом проекте не осталось открытых задач, а закрыто хотя бы 3 — и последняя
   * закрылась за последние двое суток. Ключ — проект и день последнего закрытия: проект,
   * который дозакрыли через месяц, даст новую веху, а повторный проход — нет.
   */
  milestoneCandidates(tenantId: string) {
    return this.db.many<{ project_id: string; name: string; visibility: string; closed: number; last_closed: Date; target_date: string | null }>(
      `SELECT p.id::text AS project_id, p.name, COALESCE(p.visibility, 'all') AS visibility,
              count(*) FILTER (WHERE t.closed_at IS NOT NULL)::int AS closed,
              max(t.closed_at) AS last_closed, to_char(p.target_date, 'YYYY-MM-DD') AS target_date
         FROM projects p JOIN tasks t ON t.project_id = p.id AND t.deleted_at IS NULL
        WHERE p.tenant_id = $1 AND COALESCE(p.status, 'active') <> 'archived' AND NOT p.is_demo
        GROUP BY p.id
       HAVING count(*) FILTER (WHERE t.closed_at IS NULL) = 0
          AND count(*) FILTER (WHERE t.closed_at IS NOT NULL) >= 3
          AND max(t.closed_at) > now() - interval '48 hours'`,
      [tenantId],
    );
  }

  /** Релиз-кандидат: закрыта задача с меткой «релиз» за последние двое суток. */
  releaseTaskCandidates(tenantId: string) {
    return this.db.many<{ id: string; title: string; project_id: string; project_name: string; visibility: string }>(
      `SELECT t.id::text, t.title, t.project_id::text, p.name AS project_name, COALESCE(p.visibility, 'all') AS visibility
         FROM tasks t JOIN projects p ON p.id = t.project_id
        WHERE t.tenant_id = $1 AND t.deleted_at IS NULL AND t.closed_at > now() - interval '48 hours' AND NOT p.is_demo
          AND EXISTS (SELECT 1 FROM task_labels tl JOIN labels l ON l.id = tl.label_id
                       WHERE tl.task_id = t.id AND l.name ILIKE 'релиз%')`,
      [tenantId],
    );
  }

  /**
   * Авторы (§29): исполнители и соисполнители закрытых задач — в порядке вклада.
   * Для вехи — задачи проекта за последний месяц, для релиза — выбранные задачи.
   */
  contributors(tenantId: string, o: { projectId?: string; taskIds?: string[] }) {
    return this.db.many<{ user_id: string; name: string; n: number }>(
      `WITH picked AS (
         SELECT t.id, t.assignee_id FROM tasks t
          WHERE t.tenant_id = $1 AND t.deleted_at IS NULL AND t.closed_at IS NOT NULL
            AND (($2::bigint IS NOT NULL AND t.project_id = $2::bigint AND t.closed_at > now() - interval '30 days')
                 OR ($3::bigint[] IS NOT NULL AND t.id = ANY($3::bigint[])))
       ), people AS (
         SELECT assignee_id AS user_id FROM picked WHERE assignee_id IS NOT NULL
         UNION ALL
         SELECT tp.user_id FROM task_participants tp JOIN picked ON picked.id = tp.task_id WHERE tp.role = 'co_assignee'
       )
       SELECT u.id::text AS user_id, u.full_name AS name, count(*)::int AS n
         FROM people JOIN users u ON u.id = people.user_id AND u.is_active
        GROUP BY u.id, u.full_name ORDER BY n DESC, u.full_name LIMIT 8`,
      [tenantId, o.projectId ?? null, o.taskIds?.length ? o.taskIds : null],
    );
  }

  /** Задачи для «Объявить релиз»: закрытые задачи проекта за 30 дней — выбрать, что вошло. */
  recentClosed(tenantId: string, projectId: string) {
    return this.db.many<{ id: string; title: string; closed_at: Date; assignee_name: string | null }>(
      `SELECT t.id::text, t.title, t.closed_at, u.full_name AS assignee_name
         FROM tasks t LEFT JOIN users u ON u.id = t.assignee_id
        WHERE t.tenant_id = $1 AND t.project_id = $2 AND t.deleted_at IS NULL
          AND t.closed_at > now() - interval '30 days'
        ORDER BY t.closed_at DESC LIMIT 60`,
      [tenantId, projectId],
    );
  }

  /** Кто одобряет черновики системы: владелец и руководители. */
  approvers(tenantId: string) {
    return this.db.many<{ id: string }>(
      `SELECT u.id::text FROM users u JOIN roles r ON r.id = u.role_id
        WHERE u.tenant_id = $1 AND u.is_active AND r.code IN ('owner', 'manager')`,
      [tenantId],
    );
  }
}
