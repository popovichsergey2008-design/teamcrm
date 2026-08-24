import { Injectable } from '@nestjs/common';
import { DbService } from '../../database/db.service';

export type TaskHit = {
  id: string; title: string; project_id: string; project_name: string;
  column_name: string; closed: boolean; assignee_name: string | null;
};
export type ProjectHit = { id: string; name: string; status: string };
export type ChatHit = { id: string; title: string | null; kind: string };
export type MessageHit = {
  id: string; chat_id: string; chat_title: string | null; chat_kind: string;
  body: string; author_name: string | null; created_at: string;
};
export type PersonHit = { id: string; full_name: string; email: string; role_code: string; position: string | null };
export type DocHit = { id: string; title: string; source: string };

/**
 * Поиск по подстроке.
 *
 * Почему ILIKE, а не полнотекстовый индекс: у клиента тысячи задач и сообщений, на таком
 * объёме последовательное сканирование укладывается в десятки миллисекунд, а `tsvector`
 * потребовал бы миграции, отдельных колонок и перестройки при каждом изменении. Переходить
 * на него будем по факту замера, а не из общих соображений — заметка об этом в спеке этапа.
 *
 * Порядок ответа задаётся сортировкой «совпадение в начале выше»: человек, набравший «мар»,
 * ждёт сверху «Маркетинг», а не «Ремарки по договору».
 */
@Injectable()
export class SearchRepository {
  constructor(private readonly db: DbService) {}

  /** `%` и `_` в пользовательском вводе — это литералы, а не шаблон LIKE. */
  static like(q: string): string {
    return `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  }

  tasks(tenantId: string, q: string, limit: number): Promise<TaskHit[]> {
    return this.db.many<TaskHit>(
      `SELECT t.id, t.title, t.project_id, p.name AS project_name, bc.name AS column_name,
              (t.closed_at IS NOT NULL) AS closed, u.full_name AS assignee_name
         FROM tasks t
         JOIN projects p ON p.id = t.project_id
         JOIN board_columns bc ON bc.id = t.column_id
         LEFT JOIN users u ON u.id = t.assignee_id
        WHERE t.tenant_id = $1
          AND p.status <> 'archived'
          AND (t.title ILIKE $2 ESCAPE '\\' OR t.description ILIKE $2 ESCAPE '\\' OR t.id::text = $3)
        ORDER BY (t.id::text = $3) DESC,
                 (t.title ILIKE $4 ESCAPE '\\') DESC,
                 t.closed_at IS NOT NULL,
                 t.updated_at DESC
        LIMIT $5`,
      [tenantId, SearchRepository.like(q), q, `${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`, limit],
    );
  }

  projects(tenantId: string, q: string, limit: number): Promise<ProjectHit[]> {
    return this.db.many<ProjectHit>(
      `SELECT id, name, status FROM projects
        WHERE tenant_id = $1 AND name ILIKE $2 ESCAPE '\\'
        ORDER BY (status = 'archived'), (name ILIKE $3 ESCAPE '\\') DESC, name
        LIMIT $4`,
      [tenantId, SearchRepository.like(q), `${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`, limit],
    );
  }

  /**
   * Чаты и сообщения — только те, где человек состоит.
   *
   * Это главное место всего поиска: одна забытая проверка показывает чужую переписку.
   * Поэтому членство проверяется соединением с chat_members, а не фильтром по арендатору.
   */
  chats(tenantId: string, userId: string, q: string, limit: number): Promise<ChatHit[]> {
    return this.db.many<ChatHit>(
      `SELECT c.id, c.title, c.kind
         FROM chats c
         JOIN chat_members m ON m.chat_id = c.id AND m.user_id = $2
        WHERE c.tenant_id = $1 AND c.title ILIKE $3 ESCAPE '\\'
        ORDER BY c.last_message_at DESC NULLS LAST
        LIMIT $4`,
      [tenantId, userId, SearchRepository.like(q), limit],
    );
  }

  messages(tenantId: string, userId: string, q: string, limit: number): Promise<MessageHit[]> {
    return this.db.many<MessageHit>(
      `SELECT msg.id, msg.chat_id, c.title AS chat_title, c.kind AS chat_kind,
              msg.body, u.full_name AS author_name, msg.created_at
         FROM chat_messages msg
         JOIN chats c ON c.id = msg.chat_id
         JOIN chat_members m ON m.chat_id = c.id AND m.user_id = $2
         LEFT JOIN users u ON u.id = msg.author_id
        WHERE msg.tenant_id = $1
          AND msg.deleted_at IS NULL
          AND msg.body ILIKE $3 ESCAPE '\\'
        ORDER BY msg.created_at DESC
        LIMIT $4`,
      [tenantId, userId, SearchRepository.like(q), limit],
    );
  }

  people(tenantId: string, q: string, limit: number): Promise<PersonHit[]> {
    return this.db.many<PersonHit>(
      `SELECT u.id, u.full_name, u.email, r.code AS role_code, p.name AS position
         FROM users u
         JOIN roles r ON r.id = u.role_id
         LEFT JOIN positions p ON p.id = u.position_id
        WHERE u.tenant_id = $1 AND u.is_active
          AND (u.full_name ILIKE $2 ESCAPE '\\' OR u.email ILIKE $2 ESCAPE '\\')
        ORDER BY (u.full_name ILIKE $3 ESCAPE '\\') DESC, u.full_name
        LIMIT $4`,
      [tenantId, SearchRepository.like(q), `${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`, limit],
    );
  }

  /** Регламенты компании: их ищут по названию чаще, чем по смыслу. */
  docs(tenantId: string, q: string, limit: number): Promise<DocHit[]> {
    return this.db.many<DocHit>(
      `SELECT id, title, 'regulation' AS source FROM regulations
        WHERE tenant_id = $1 AND title ILIKE $2 ESCAPE '\\'
        ORDER BY title
        LIMIT $3`,
      [tenantId, SearchRepository.like(q), limit],
    );
  }
}
