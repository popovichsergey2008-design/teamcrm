import { meetingVisibleSql, projectVisibleSql, ProjectViewer, viewerParams } from '../../common/access/project-visibility';
import { maskSecrets, matchesOutsideSecrets } from '../../common/secrets';
import { Injectable } from '@nestjs/common';
import { DbService } from '../../database/db.service';

export type TaskHit = {
  id: string; title: string; project_id: string; project_name: string;
  column_name: string; closed: boolean; assignee_name: string | null;
  deadline_at?: string | null; description?: string | null;
};
export type ProjectHit = { id: string; name: string; status: string };
export type ChatHit = { id: string; title: string | null; kind: string };
export type MessageHit = {
  id: string; chat_id: string; chat_title: string | null; chat_kind: string;
  body: string; author_name: string | null; created_at: string;
};
export type PersonHit = { id: string; full_name: string; email: string; role_code: string; position: string | null };
export type DocHit = { id: string; title: string; source: string };
export type MeetingHit = { id: string; title: string; happened_at: string; source: string };

/**
 * #4922: запрос → слова для поиска. Слова ищутся в любом порядке («акция отчёт» находит
 * «Отчёт по акции»), «ё» и «е» не различаются, «#123» и «№123» — номер задачи.
 */
export function queryWords(q: string): string[] {
  const words = q.toLowerCase().replace(/ё/g, 'е').replace(/[#№]/g, ' ').split(/[\s,.;:!?()«»"']+/).filter(Boolean);
  const long = words.filter((w) => w.length >= 2);
  return (long.length ? long : words).slice(0, 6).map((w) => `%${w.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
}

/** Номер задачи в запросе: «123», «#123», «№ 123». */
export function queryNumber(q: string): string {
  const m = /^\s*[#№]?\s*(\d{1,9})\s*$/.exec(q);
  return m ? m[1] : '';
}

/** Все слова запроса ($param — text[]) встречаются в выражении, без различия «ё» и «е». */
const allWords = (expr: string, param: string) =>
  `NOT EXISTS (SELECT 1 FROM unnest(${param}::text[]) w WHERE translate(${expr}, 'ёЁ', 'еЕ') NOT ILIKE w ESCAPE '\\')`;

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

  /** Задачи — только видимых проектов (ТЗ-21, этап 0): закрытый проект в поиске не всплывает. */
  tasks(tenantId: string, q: string, limit: number, viewer: ProjectViewer, offset = 0): Promise<TaskHit[]> {
    return this.db.many<TaskHit>(
      `SELECT t.id, t.title, t.project_id, p.name AS project_name, bc.name AS column_name,
              (t.closed_at IS NOT NULL) AS closed, u.full_name AS assignee_name, t.deadline_at,
              CASE WHEN NOT (${allWords('t.title', '$2')}) THEN left(t.description, 2000) END AS description
         FROM tasks t
         JOIN projects p ON p.id = t.project_id
         JOIN board_columns bc ON bc.id = t.column_id
         LEFT JOIN users u ON u.id = t.assignee_id
        WHERE t.tenant_id = $1
          AND t.deleted_at IS NULL
          AND p.status <> 'archived'
          AND (${allWords("t.title || ' ' || COALESCE(t.description, '')", '$2')} OR t.id::text = $3)
          AND ${projectVisibleSql('t.project_id', { user: '$7', all: '$8', client: '$9' })}
        ORDER BY (t.id::text = $3) DESC,
                 (${allWords('t.title', '$2')}) DESC,
                 (t.title ILIKE $4 ESCAPE '\\') DESC,
                 t.closed_at IS NOT NULL,
                 t.updated_at DESC
        LIMIT $5 OFFSET $6`,
      [tenantId, queryWords(q), queryNumber(q), `${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`, limit, offset, ...viewerParams(viewer)],
    );
  }

  projects(tenantId: string, q: string, limit: number, viewer: ProjectViewer, offset = 0): Promise<ProjectHit[]> {
    return this.db.many<ProjectHit>(
      `SELECT id, name, status FROM projects
        WHERE tenant_id = $1 AND ${allWords('name', '$2')}
          AND ${projectVisibleSql('projects.id', { user: '$6', all: '$7', client: '$8' })}
        ORDER BY (status = 'archived'), (name ILIKE $3 ESCAPE '\\') DESC, name
        LIMIT $4 OFFSET $5`,
      [tenantId, queryWords(q), `${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`, limit, offset, ...viewerParams(viewer)],
    );
  }

  /**
   * Чаты и сообщения — только те, где человек состоит.
   *
   * Это главное место всего поиска: одна забытая проверка показывает чужую переписку.
   * Поэтому членство проверяется соединением с chat_members, а не фильтром по арендатору.
   */
  chats(tenantId: string, userId: string, q: string, limit: number, offset = 0): Promise<ChatHit[]> {
    return this.db.many<ChatHit>(
      `SELECT c.id, c.title, c.kind
         FROM chats c
         JOIN chat_members m ON m.chat_id = c.id AND m.user_id = $2
        WHERE c.tenant_id = $1 AND c.title IS NOT NULL AND ${allWords('c.title', '$3')}
        ORDER BY c.last_message_at DESC NULLS LAST
        LIMIT $4 OFFSET $5`,
      [tenantId, userId, queryWords(q), limit, offset],
    );
  }

  messages(tenantId: string, userId: string, q: string, limit: number, offset = 0): Promise<MessageHit[]> {
    return this.db.many<MessageHit>(
      `SELECT msg.id, msg.chat_id, c.title AS chat_title, c.kind AS chat_kind,
              msg.body, u.full_name AS author_name, msg.created_at
         FROM chat_messages msg
         JOIN chats c ON c.id = msg.chat_id
         JOIN chat_members m ON m.chat_id = c.id AND m.user_id = $2
         LEFT JOIN users u ON u.id = msg.author_id
        WHERE msg.tenant_id = $1
          AND msg.deleted_at IS NULL
          AND ${allWords('msg.body', '$3')}
        ORDER BY msg.created_at DESC
        LIMIT $4 OFFSET $5`,
      [tenantId, userId, queryWords(q), limit, offset],
    // #4902, п. 13: найдено только внутри пароля — не находка; в выдаче секрет точками
    ).then((rows) => rows
      // каждое слово запроса — вне секретов (#4922: слова ищутся порознь)
      .filter((r) => queryWords(q).every((w) => matchesOutsideSecrets(String(r.body ?? '').replace(/ё/gi, 'е'), w.slice(1, -1).replace(/\\(.)/g, '$1'))))
      .map((r) => ({ ...r, body: maskSecrets(r.body) })));
  }

  people(tenantId: string, q: string, limit: number, offset = 0): Promise<PersonHit[]> {
    return this.db.many<PersonHit>(
      `SELECT u.id, u.full_name, u.email, r.code AS role_code, p.name AS position
         FROM users u
         JOIN roles r ON r.id = u.role_id
         LEFT JOIN positions p ON p.id = u.position_id
        WHERE u.tenant_id = $1 AND u.is_active
          AND ${allWords("u.full_name || ' ' || u.email || ' ' || COALESCE(p.name, '')", '$2')}
        ORDER BY (u.full_name ILIKE $3 ESCAPE '\\') DESC, u.full_name
        LIMIT $4 OFFSET $5`,
      [tenantId, queryWords(q), `${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`, limit, offset],
    );
  }

  /** Регламенты компании: их ищут по названию чаще, чем по смыслу. */
  docs(tenantId: string, q: string, limit: number, offset = 0): Promise<DocHit[]> {
    return this.db.many<DocHit>(
      `SELECT id, title, 'regulation' AS source FROM regulations
        WHERE tenant_id = $1 AND ${allWords('title', '$2')}
        ORDER BY title
        LIMIT $3 OFFSET $4`,
      [tenantId, queryWords(q), limit, offset],
    );
  }

  /** #4922: встречи и протоколы — по названию; видимость та же, что у списка встреч. */
  meetings(tenantId: string, q: string, limit: number, viewer: ProjectViewer, offset = 0): Promise<MeetingHit[]> {
    return this.db.many<MeetingHit>(
      `SELECT m.id, m.title, COALESCE(m.happened_at, m.created_at) AS happened_at, m.source
         FROM meetings m
        WHERE m.tenant_id = $1 AND ${allWords('m.title', '$2')}
          AND ${meetingVisibleSql('m', { user: '$5', all: '$6', client: '$7' })}
        ORDER BY COALESCE(m.happened_at, m.created_at) DESC
        LIMIT $3 OFFSET $4`,
      [tenantId, queryWords(q), limit, offset, ...viewerParams(viewer)],
    );
  }
}
