import { Injectable } from '@nestjs/common';
import { DbService } from '../../database/db.service';
import { TeamUser } from './import-plan';

export interface JobRow {
  id: string;
  tenant_id: string;
  created_by: string | null;
  source: 'slack' | 'telegram';
  file_name: string;
  size_bytes: string;
  object_key: string | null;
  status: 'scanning' | 'ready' | 'running' | 'done' | 'failed';
  scan: unknown;
  options: unknown;
  progress: unknown;
  report: unknown;
  error: string | null;
  created_at: Date;
  updated_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
}

/** Строка сообщения для пачечной вставки. */
export interface MessageInsert {
  authorId: string | null;
  guestName: string | null;
  body: string;
  fileId: string | null;
  at: string;
  threadRootId: string | null;
  alsoInChannel: boolean;
  replyToId: string | null;
  key: string;
  importAuthor: string | null;
}

/**
 * SQL переезда из Slack и Telegram (#4902, п. 4).
 *
 * Чаты и сообщения пишем сами, а не через ChatsService: тот рассылает каждое
 * сообщение по сокету, будит слушателей (бот, календарь) и считает непрочитанное —
 * для истории пятилетней давности всё это лишнее и превратило бы 10 000 сообщений
 * в 10 000 уведомлений.
 */
@Injectable()
export class MigrationImportRepository {
  constructor(private readonly db: DbService) {}

  // ── задания ──

  async createJob(i: { tenantId: string; userId: string; source: string; fileName: string; size: number }): Promise<JobRow> {
    return (await this.db.one<JobRow>(
      `INSERT INTO migration_import_jobs (tenant_id, created_by, source, file_name, size_bytes)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [i.tenantId, i.userId, i.source, i.fileName.slice(0, 300), i.size],
    ))!;
  }

  job(tenantId: string, id: string): Promise<JobRow | null> {
    return this.db.one<JobRow>(`SELECT * FROM migration_import_jobs WHERE tenant_id=$1 AND id=$2`, [tenantId, id]);
  }

  jobs(tenantId: string): Promise<JobRow[]> {
    return this.db.many<JobRow>(
      `SELECT id, tenant_id, created_by, source, file_name, size_bytes, status, progress, report, error,
              created_at, updated_at, started_at, finished_at
         FROM migration_import_jobs WHERE tenant_id=$1 ORDER BY id DESC LIMIT 20`,
      [tenantId],
    );
  }

  async scanned(id: string, objectKey: string, scan: unknown): Promise<void> {
    await this.db.query(
      `UPDATE migration_import_jobs SET status='ready', object_key=$2, scan=$3::jsonb, updated_at=now()
        WHERE id=$1 AND status='scanning'`,
      [id, objectKey, JSON.stringify(scan)],
    );
  }

  /**
   * Взять задание в работу. Условие на статус — защита от двойного нажатия и от двух
   * процессов: второй UPDATE не найдёт строку «ready» и ничего не запустит.
   */
  async claim(tenantId: string, id: string, options: unknown): Promise<JobRow | null> {
    return this.db.one<JobRow>(
      `UPDATE migration_import_jobs
          SET status='running', options=$3::jsonb, started_at=now(), updated_at=now(), error=NULL, report=NULL,
              progress='{"stage":"start"}'::jsonb
        WHERE tenant_id=$1 AND id=$2 AND status='ready'
        RETURNING *`,
      [tenantId, id, JSON.stringify(options)],
    );
  }

  async progress(id: string, progress: unknown): Promise<void> {
    await this.db.query(
      `UPDATE migration_import_jobs SET progress=$2::jsonb, updated_at=now() WHERE id=$1 AND status='running'`,
      [id, JSON.stringify(progress)],
    );
  }

  async finish(id: string, status: 'done' | 'failed' | 'ready', report: unknown, error: string | null, keepObject: boolean): Promise<void> {
    await this.db.query(
      `UPDATE migration_import_jobs
          SET status=$2, report=$3::jsonb, error=$4, finished_at=now(), updated_at=now(),
              object_key = CASE WHEN $5::boolean THEN object_key ELSE NULL END
        WHERE id=$1`,
      [id, status, report === null ? null : JSON.stringify(report), error, keepObject],
    );
  }

  async failScan(id: string, error: string): Promise<void> {
    await this.db.query(
      `UPDATE migration_import_jobs SET status='failed', error=$2, finished_at=now(), updated_at=now() WHERE id=$1`,
      [id, error.slice(0, 1000)],
    );
  }

  /**
   * Задания, чей процесс умер (выкладка, падение): пульс давно не обновлялся.
   * Переводим в «прервано», архив оставляем — можно запустить заново, и благодаря
   * ключам сообщений повтор продолжит с места, не создав дублей.
   */
  async expireStale(tenantId: string, minutes: number): Promise<void> {
    await this.db.query(
      `UPDATE migration_import_jobs
          SET status = CASE WHEN status='running' AND object_key IS NOT NULL THEN 'ready' ELSE 'failed' END,
              error = CASE WHEN status='running'
                           THEN 'Перенос прервался (сервер перезапускался). Запустите ещё раз — уже перенесённое не задвоится'
                           ELSE 'Разбор архива прервался. Загрузите архив ещё раз' END,
              updated_at = now()
        WHERE tenant_id=$1 AND status IN ('running','scanning')
          AND updated_at < now() - make_interval(mins => $2)`,
      [tenantId, minutes],
    );
  }

  // ── люди ──

  /** Сотрудники организации (без заказчиков — их в командные чаты не пускаем). */
  teamUsers(tenantId: string): Promise<TeamUser[]> {
    return this.db.many<TeamUser>(
      `SELECT u.id::text, u.email, u.full_name
         FROM users u JOIN roles r ON r.id = u.role_id
        WHERE u.tenant_id=$1 AND u.is_active AND r.code <> 'client'`,
      [tenantId],
    );
  }

  async pendingInviteEmails(tenantId: string): Promise<Set<string>> {
    const rows = await this.db.many<{ email: string }>(
      `SELECT lower(email) AS email FROM invites WHERE tenant_id=$1 AND accepted_at IS NULL AND expires_at > now()`,
      [tenantId],
    );
    return new Set(rows.map((r) => r.email));
  }

  // ── что уже перенесено ──

  async refs(tenantId: string, sourceKey: string, kind: 'chat' | 'file'): Promise<Map<string, string>> {
    const rows = await this.db.many<{ external_id: string; local_id: string }>(
      `SELECT external_id, local_id::text FROM migration_import_refs WHERE tenant_id=$1 AND source_key=$2 AND kind=$3`,
      [tenantId, sourceKey, kind],
    );
    return new Map(rows.map((r) => [r.external_id, r.local_id]));
  }

  async setRef(tenantId: string, sourceKey: string, kind: 'chat' | 'file', externalId: string, localId: string): Promise<void> {
    await this.db.query(
      `INSERT INTO migration_import_refs (tenant_id, source_key, kind, external_id, local_id)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (tenant_id, source_key, kind, external_id) DO UPDATE SET local_id = EXCLUDED.local_id`,
      [tenantId, sourceKey, kind, externalId.slice(0, 255), localId],
    );
  }

  // ── чаты ──

  async chatAlive(tenantId: string, chatId: string): Promise<boolean> {
    return !!(await this.db.one(`SELECT 1 AS ok FROM chats WHERE tenant_id=$1 AND id=$2`, [tenantId, chatId]));
  }

  /** Сообщения в чате, приехавшие НЕ из этого источника: в такой чат историю не подмешиваем. */
  async foreignMessages(tenantId: string, chatId: string, keyPrefix: string): Promise<number> {
    const row = await this.db.one<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM chat_messages
        WHERE tenant_id=$1 AND chat_id=$2 AND (import_key IS NULL OR left(import_key, length($3)) <> $3)`,
      [tenantId, chatId, keyPrefix],
    );
    return row?.n ?? 0;
  }

  findProject(tenantId: string, name: string): Promise<{ id: string } | null> {
    return this.db.one<{ id: string }>(
      `SELECT id::text FROM projects
        WHERE tenant_id=$1 AND lower(name)=lower($2) AND status <> 'archived'
        ORDER BY id LIMIT 1`,
      [tenantId, name],
    );
  }

  projectChat(projectId: string): Promise<{ id: string } | null> {
    return this.db.one<{ id: string }>(`SELECT id::text FROM chats WHERE project_id=$1`, [projectId]);
  }

  /** Собственный чат проекта: уникален на проект, гонку двух вставок гасит индекс. */
  async ensureProjectChat(tenantId: string, projectId: string, createdBy: string): Promise<string> {
    const row = await this.db.one<{ id: string }>(
      `INSERT INTO chats (tenant_id, kind, project_id, created_by) VALUES ($1,'project',$2,$3)
       ON CONFLICT (project_id) WHERE project_id IS NOT NULL DO NOTHING RETURNING id::text`,
      [tenantId, projectId, createdBy],
    );
    return row?.id ?? (await this.projectChat(projectId))!.id;
  }

  async createChat(i: {
    tenantId: string; kind: 'channel' | 'group' | 'dm'; title: string | null; description: string | null;
    isPrivate: boolean; linkedProjectId: string | null; createdBy: string; dmKey?: string | null;
  }): Promise<string> {
    const row = await this.db.one<{ id: string }>(
      `INSERT INTO chats (tenant_id, kind, title, description, is_private, linked_project_id, created_by, dm_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id::text`,
      [i.tenantId, i.kind, i.title?.slice(0, 160) ?? null, i.description?.slice(0, 2000) ?? null,
        i.isPrivate, i.linkedProjectId, i.createdBy, i.dmKey ?? null],
    );
    return row!.id;
  }

  findDm(tenantId: string, key: string): Promise<{ id: string } | null> {
    return this.db.one<{ id: string }>(`SELECT id::text FROM chats WHERE tenant_id=$1 AND dm_key=$2`, [tenantId, key]);
  }

  /** Участники: первый в списке с ролью owner, если владельца в чате ещё нет. */
  async addMembers(tenantId: string, chatId: string, members: { userId: string; role: 'owner' | 'member' }[]): Promise<void> {
    if (!members.length) return;
    await this.db.query(
      `INSERT INTO chat_members (chat_id, user_id, tenant_id, role, last_read_at)
       SELECT $1, x.uid, $2, x.role, now()
         FROM unnest($3::bigint[], $4::text[]) AS x(uid, role)
       ON CONFLICT DO NOTHING`,
      [chatId, tenantId, members.map((m) => m.userId), members.map((m) => m.role)],
    );
  }

  // ── сообщения ──

  /**
   * Пачка сообщений одним запросом. ON CONFLICT по ключу импорта — повтор того же
   * архива ничего не вставит второй раз; вернутся только вставленные строки.
   */
  async insertMessages(tenantId: string, chatId: string, rows: MessageInsert[]): Promise<{ id: string; import_key: string }[]> {
    if (!rows.length) return [];
    return this.db.many<{ id: string; import_key: string }>(
      `INSERT INTO chat_messages
         (tenant_id, chat_id, author_id, guest_name, body, file_id, created_at,
          thread_root_id, also_in_channel, reply_to_id, import_key, import_author)
       SELECT $1, $2, x.author, x.guest, x.body, x.file, x.at, x.root, x.bc, x.reply, x.k, x.ia
         FROM unnest($3::bigint[], $4::text[], $5::text[], $6::bigint[], $7::timestamptz[],
                     $8::bigint[], $9::boolean[], $10::bigint[], $11::text[], $12::text[])
              WITH ORDINALITY AS x(author, guest, body, file, at, root, bc, reply, k, ia, ord)
        ORDER BY x.ord
       ON CONFLICT (tenant_id, import_key) WHERE import_key IS NOT NULL DO NOTHING
       RETURNING id::text, import_key`,
      [
        tenantId, chatId,
        rows.map((r) => r.authorId), rows.map((r) => r.guestName), rows.map((r) => r.body),
        rows.map((r) => r.fileId), rows.map((r) => r.at), rows.map((r) => r.threadRootId),
        rows.map((r) => r.alsoInChannel), rows.map((r) => r.replyToId), rows.map((r) => r.key),
        rows.map((r) => r.importAuthor),
      ],
    );
  }

  /** id уже перенесённых сообщений — нужны корням веток и цитатам при повторе. */
  async idsByKeys(tenantId: string, keys: string[]): Promise<Map<string, string>> {
    if (!keys.length) return new Map();
    const rows = await this.db.many<{ id: string; import_key: string }>(
      `SELECT id::text, import_key FROM chat_messages WHERE tenant_id=$1 AND import_key = ANY($2::text[])`,
      [tenantId, keys],
    );
    return new Map(rows.map((r) => [r.import_key, r.id]));
  }

  async insertMessageFiles(tenantId: string, rows: { messageId: string; fileId: string; position: number }[]): Promise<void> {
    if (!rows.length) return;
    await this.db.query(
      `INSERT INTO chat_message_files (message_id, file_id, tenant_id, position)
       SELECT x.m, x.f, $1, x.p FROM unnest($2::bigint[], $3::bigint[], $4::int[]) AS x(m, f, p)
       ON CONFLICT DO NOTHING`,
      [tenantId, rows.map((r) => r.messageId), rows.map((r) => r.fileId), rows.map((r) => r.position)],
    );
  }

  /**
   * Довести чат после переноса:
   *  — счётчики ответов у корней веток (обычная отправка ведёт их по одному);
   *  — время последнего сообщения — по истории, а не по моменту импорта, иначе
   *    перенесённый архив всплыл бы наверх списка как «свежая переписка»;
   *  — всё перенесённое — прочитанным: 10 000 непрочитанных никому не нужны;
   *  — отметка разбора переписки: агент анализа чатов (ТЗ-12) не должен поднимать
   *    из архива пятилетней давности «поручения» и тратить на это ИИ.
   */
  async finalizeChat(tenantId: string, chatId: string): Promise<void> {
    await this.db.query(
      `UPDATE chat_messages r
          SET reply_count = s.n, last_reply_at = s.last
         FROM (SELECT thread_root_id, COUNT(*)::int AS n, max(created_at) AS last
                 FROM chat_messages
                WHERE tenant_id=$1 AND chat_id=$2 AND thread_root_id IS NOT NULL AND deleted_at IS NULL
                GROUP BY thread_root_id) s
        WHERE r.id = s.thread_root_id`,
      [tenantId, chatId],
    );
    await this.db.query(
      `UPDATE chats SET last_message_at = GREATEST(last_message_at,
              (SELECT max(created_at) FROM chat_messages WHERE chat_id=$2 AND deleted_at IS NULL))
        WHERE tenant_id=$1 AND id=$2`,
      [tenantId, chatId],
    );
    await this.db.query(`UPDATE chat_members SET last_read_at = now() WHERE chat_id=$1`, [chatId]);
    await this.db.query(
      `INSERT INTO chat_analysis_checkpoints (tenant_id, chat_id, last_message_id)
       SELECT $1, $2, COALESCE(max(id), 0) FROM chat_messages WHERE chat_id=$2
       ON CONFLICT (tenant_id, chat_id)
         DO UPDATE SET last_message_id = GREATEST(chat_analysis_checkpoints.last_message_id, EXCLUDED.last_message_id)`,
      [tenantId, chatId],
    );
  }

  /**
   * Подписать сообщения тех, кто пришёл в команду после первого импорта: человек
   * принял приглашение — повторный импорт ставит его автором вместо подписи-имени.
   */
  async relinkAuthors(tenantId: string, chatIds: string[], pairs: { ext: string; userId: string }[]): Promise<number> {
    if (!chatIds.length || !pairs.length) return 0;
    const res = await this.db.query(
      `UPDATE chat_messages m
          SET author_id = p.uid, guest_name = NULL
         FROM unnest($3::text[], $4::bigint[]) AS p(ext, uid)
        WHERE m.tenant_id=$1 AND m.chat_id = ANY($2::bigint[])
          AND m.author_id IS NULL AND m.import_author = p.ext`,
      [tenantId, chatIds, pairs.map((p) => p.ext), pairs.map((p) => p.userId)],
    );
    return res.rowCount ?? 0;
  }
}
