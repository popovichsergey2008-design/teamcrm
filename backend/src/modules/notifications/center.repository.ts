import { Injectable } from '@nestjs/common';
import { DbService } from '../../database/db.service';

/** Задача и её люди — от них центр считает адресатов события. */
export interface CenterTaskRow {
  id: string;
  title: string;
  project_id: string;
  assignee_id: string | null;
  created_by: string | null;
  assignee_name: string | null;
  deadline_at: Date | null;
  priority: string | null;
  column_name: string | null;
  co_assignees: string[];
  watchers: string[];
}

/** Строка центра в том виде, в каком её отдаёт список. */
export interface CenterRow {
  id: string;
  event_key: string;
  category: string;
  title: string;
  body: string;
  path: string | null;
  created_at: Date;
  read_at: Date | null;
  details: Record<string, unknown> | null;
  actor_id: string | null;
  actor_name: string | null;
  actor_avatar: string | null;
  task_id: string | null;
  task_title: string | null;
  project_id: string | null;
}

export interface CenterViewer { tenantId: string; userId: string; role: string }

export interface CenterQuery {
  /** Листаем назад: записи с номером меньше этого. */
  before: string | null;
  limit: number;
  unreadOnly: boolean;
  category: string | null;
  q: string | null;
}

export const CENTER_CATEGORIES = ['task', 'comment', 'mention', 'chat', 'meet', 'other'] as const;

/**
 * Чья запись и видна ли её задача — одно условие для списка и счётчика.
 *
 * Запись о задаче показываем, только пока задача существует, не в корзине и человек
 * её видит: участник задачи или проект ему открыт (то же правило, что у списка
 * проектов). Иначе центр стал бы окном в чужие задачи — исполнителя сняли, проект
 * закрыли для своих, а заголовки и комментарии продолжали бы приходить в историю.
 * Записи без задачи (сообщения, встречи, секретарь) — личные по определению.
 */
const VISIBLE = `
      n.tenant_id = $1 AND n.user_id = $2
  AND (n.task_id IS NULL OR (
        t.id IS NOT NULL AND t.deleted_at IS NULL AND (
          $3::boolean
          OR t.assignee_id = $2::bigint OR t.created_by = $2::bigint
          OR EXISTS (SELECT 1 FROM task_participants tp WHERE tp.task_id = t.id AND tp.user_id = $2::bigint)
          OR p.visibility = 'all' OR p.owner_user_id = $2::bigint
          OR EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id = p.id AND pm.user_id = $2::bigint))))`;

const FROM = `
    FROM notification_inbox n
    LEFT JOIN tasks t ON t.id = n.task_id AND t.tenant_id = n.tenant_id
    LEFT JOIN projects p ON p.id = t.project_id`;

const boss = (v: CenterViewer) => v.role === 'owner' || v.role === 'manager';

@Injectable()
export class CenterRepository {
  constructor(private readonly db: DbService) {}

  taskWithPeople(tenantId: string, taskId: string): Promise<CenterTaskRow | null> {
    return this.db.one<CenterTaskRow>(
      `SELECT t.id::text, t.title, t.project_id::text, t.assignee_id::text, t.created_by::text,
              a.full_name AS assignee_name, t.deadline_at, t.priority, c.name AS column_name,
              COALESCE(ARRAY(SELECT tp.user_id::text FROM task_participants tp
                              WHERE tp.task_id = t.id AND tp.role = 'co_assignee'), '{}') AS co_assignees,
              COALESCE(ARRAY(SELECT tp.user_id::text FROM task_participants tp
                              WHERE tp.task_id = t.id AND tp.role = 'watcher'), '{}') AS watchers
         FROM tasks t
    LEFT JOIN users a ON a.id = t.assignee_id
    LEFT JOIN board_columns c ON c.id = t.column_id
        WHERE t.tenant_id = $1 AND t.id = $2 AND t.deleted_at IS NULL`,
      [tenantId, taskId],
    );
  }

  /** Сотрудники компании — по ним ищем «@Имя Фамилия» в комментарии. Клиенты не в счёт. */
  people(tenantId: string) {
    return this.db.many<{ id: string; full_name: string }>(
      `SELECT u.id::text, u.full_name FROM users u JOIN roles r ON r.id = u.role_id
        WHERE u.tenant_id = $1 AND u.is_active = TRUE AND r.code <> 'client'`,
      [tenantId],
    );
  }

  /** Записать событие человеку; повтор того же события (ключ) — ничего, `null`. */
  insert(i: {
    tenantId: string; userId: string; eventKey: string; title: string; body: string; path: string;
    actorId: string | null; taskId: string; details: Record<string, unknown>; dedupKey: string;
  }) {
    return this.db.one<{ id: string }>(
      `INSERT INTO notification_inbox
              (tenant_id, user_id, event_key, title, body, path, actor_id, task_id, details, dedup_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10)
       ON CONFLICT (user_id, dedup_key) WHERE dedup_key IS NOT NULL DO NOTHING
       RETURNING id::text`,
      [i.tenantId, i.userId, i.eventKey, i.title.slice(0, 255), i.body.slice(0, 500), i.path,
        i.actorId, i.taskId, JSON.stringify(i.details), i.dedupKey.slice(0, 160)],
    );
  }

  list(v: CenterViewer, q: CenterQuery): Promise<CenterRow[]> {
    const params: unknown[] = [v.tenantId, v.userId, boss(v)];
    const where: string[] = [VISIBLE];
    if (q.before) { params.push(q.before); where.push(`n.id < $${params.length}::bigint`); }
    if (q.unreadOnly) where.push('n.read_at IS NULL');
    if (q.category) { params.push(q.category); where.push(`n.category = $${params.length}`); }
    if (q.q) {
      // свой текст человека — не шаблон: % и _ ищутся как буквы
      params.push(`%${q.q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`);
      const k = params.length;
      // «#12» или «12» — ещё и номер задачи, как в реестре
      const num = /^#?\d{1,18}$/.test(q.q) ? q.q.replace('#', '') : null;
      params.push(num);
      where.push(`(n.title ILIKE $${k} OR n.body ILIKE $${k} OR t.title ILIKE $${k} OR au.full_name ILIKE $${k}
                   OR n.task_id = $${k + 1}::bigint)`);
    }
    params.push(q.limit);
    return this.db.many<CenterRow>(
      `SELECT n.id::text, n.event_key, n.category, n.title, n.body, n.path, n.created_at, n.read_at,
              n.details, n.actor_id::text, au.full_name AS actor_name, au.avatar_file_id::text AS actor_avatar,
              n.task_id::text, t.title AS task_title, t.project_id::text
         ${FROM}
    LEFT JOIN users au ON au.id = n.actor_id
        WHERE ${where.join(' AND ')}
        ORDER BY n.id DESC
        LIMIT $${params.length}`,
      params,
    );
  }

  /**
   * Сколько непрочитанного на значке.
   *
   * Обычные сообщения чатов сюда не входят: у них свой счётчик на «Чатах», и одно
   * сообщение не должно зажигать два значка. Упоминание в чате — входит: это
   * обращение лично к человеку.
   */
  async unread(v: CenterViewer): Promise<number> {
    const row = await this.db.one<{ n: string }>(
      `SELECT count(*)::text AS n ${FROM}
        WHERE ${VISIBLE} AND n.read_at IS NULL AND n.category <> 'chat'`,
      [v.tenantId, v.userId, boss(v)],
    );
    return Number(row?.n ?? 0);
  }

  /** Прочитать выбранные записи (только свои). */
  async markRead(v: CenterViewer, ids: string[]): Promise<number> {
    if (!ids.length) return 0;
    const r = await this.db.query(
      `UPDATE notification_inbox SET read_at = now()
        WHERE tenant_id = $1 AND user_id = $2 AND id = ANY($3::bigint[]) AND read_at IS NULL`,
      [v.tenantId, v.userId, ids],
    );
    return r.rowCount ?? 0;
  }

  /** «Прочитать все» — всё своё в этой компании, с фильтром по виду или без. */
  async markAll(v: CenterViewer, category: string | null): Promise<number> {
    const r = await this.db.query(
      `UPDATE notification_inbox SET read_at = now()
        WHERE tenant_id = $1 AND user_id = $2 AND read_at IS NULL AND ($3::text IS NULL OR category = $3)`,
      [v.tenantId, v.userId, category],
    );
    return r.rowCount ?? 0;
  }
}
