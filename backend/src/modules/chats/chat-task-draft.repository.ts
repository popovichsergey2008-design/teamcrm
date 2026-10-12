import { Injectable } from '@nestjs/common';
import { DbService } from '../../database/db.service';
import { projectVisibleSql, ProjectViewer, viewerParams } from '../../common/access/project-visibility';

/** Строка черновика как она лежит в базе (миграция 0126). */
export interface DraftRow {
  id: string;
  tenant_id: string;
  chat_id: string;
  message_id: string;
  initiator_id: string;
  author_id: string | null;
  status: string;
  title: string;
  description: string;
  project_id: string | null;
  assignee_id: string | null;
  assignee_reason: string | null;
  deadline: string | null;
  priority: string;
  checklist: string[];
  files: { fileId: string; name: string | null; mime: string | null; include: boolean }[];
  analysis: Record<string, unknown>;
  question_message_id: string | null;
  task_id: string | null;
  /** несколько задач из одного сообщения (ТЗ-26) — номера созданных */
  created_task_ids: string[];
  created_at: string;
  updated_at: string;
}

/** Поля, которые правит человек в предпросмотре либо дописывает разбор. */
export interface DraftPatch {
  status?: string;
  title?: string;
  description?: string;
  projectId?: string | null;
  assigneeId?: string | null;
  assigneeReason?: string | null;
  deadline?: string | null;
  priority?: string;
  checklist?: string[];
  files?: DraftRow['files'];
  analysis?: Record<string, unknown>;
  questionMessageId?: string | null;
  taskId?: string | null;
}

/** Черновики задач из сообщений. Живут, пока задача не создана или не отменена. */
@Injectable()
export class ChatTaskDraftRepository {
  constructor(private readonly db: DbService) {}

  private static readonly COLUMNS = `id::text, tenant_id::text, chat_id::text, message_id::text,
    initiator_id::text, author_id::text, status, title, description, project_id::text,
    assignee_id::text, assignee_reason, to_char(deadline, 'YYYY-MM-DD') AS deadline, priority,
    checklist, files, analysis, question_message_id::text, task_id::text,
    COALESCE(created_task_ids::text[], '{}') AS created_task_ids, created_at, updated_at`;

  async create(o: {
    tenantId: string; chatId: string; messageId: string; initiatorId: string; authorId: string | null;
  }): Promise<DraftRow> {
    const row = await this.db.one<DraftRow>(
      `INSERT INTO chat_task_drafts (tenant_id, chat_id, message_id, initiator_id, author_id)
       VALUES ($1,$2,$3,$4,$5)
       RETURNING ${ChatTaskDraftRepository.COLUMNS}`,
      [o.tenantId, o.chatId, o.messageId, o.initiatorId, o.authorId],
    );
    // INSERT ... RETURNING всегда отдаёт строку: null здесь означал бы сломанный запрос.
    return row as DraftRow;
  }

  byId(tenantId: string, id: string): Promise<DraftRow | null> {
    return this.db.one<DraftRow>(
      `SELECT ${ChatTaskDraftRepository.COLUMNS} FROM chat_task_drafts WHERE tenant_id=$1 AND id=$2`,
      [tenantId, id],
    );
  }

  /** Незавершённый черновик по этому сообщению: второй заводить незачем. */
  openByMessage(tenantId: string, messageId: string): Promise<DraftRow | null> {
    return this.db.one<DraftRow>(
      `SELECT ${ChatTaskDraftRepository.COLUMNS} FROM chat_task_drafts
        WHERE tenant_id=$1 AND message_id=$2 AND status IN ('transcribing','analyzing','needs_clarification','ready')
        ORDER BY id DESC LIMIT 1`,
      [tenantId, messageId],
    );
  }

  /** Все незавершённые черновики чата — по ним рисуются строки под сообщениями. */
  openInChat(tenantId: string, chatId: string): Promise<DraftRow[]> {
    return this.db.many<DraftRow>(
      `SELECT ${ChatTaskDraftRepository.COLUMNS} FROM chat_task_drafts
        WHERE tenant_id=$1 AND chat_id=$2 AND status IN ('transcribing','analyzing','needs_clarification','ready')
        ORDER BY id`,
      [tenantId, chatId],
    );
  }

  /** Черновики, которые ждут ответа о проекте: в них может метить следующая реплика. */
  awaiting(tenantId: string, chatId: string): Promise<DraftRow[]> {
    return this.db.many<DraftRow>(
      `SELECT ${ChatTaskDraftRepository.COLUMNS} FROM chat_task_drafts
        WHERE tenant_id=$1 AND chat_id=$2 AND status='needs_clarification'
        ORDER BY id`,
      [tenantId, chatId],
    );
  }

  /**
   * Правка полей. Собираем SET по тем ключам, что пришли: отдельный метод на каждое
   * поле превратился бы в десяток почти одинаковых запросов.
   */
  async patch(tenantId: string, id: string, p: DraftPatch): Promise<DraftRow | null> {
    const set: string[] = ['updated_at = now()'];
    const params: unknown[] = [tenantId, id];
    const add = (column: string, value: unknown, cast = '') => {
      params.push(value);
      set.push(`${column} = $${params.length}${cast}`);
    };
    if (p.status !== undefined) add('status', p.status);
    if (p.title !== undefined) add('title', p.title);
    if (p.description !== undefined) add('description', p.description);
    if (p.projectId !== undefined) add('project_id', p.projectId, '::bigint');
    if (p.assigneeId !== undefined) add('assignee_id', p.assigneeId, '::bigint');
    if (p.assigneeReason !== undefined) add('assignee_reason', p.assigneeReason);
    if (p.deadline !== undefined) add('deadline', p.deadline, '::date');
    if (p.priority !== undefined) add('priority', p.priority);
    if (p.checklist !== undefined) add('checklist', JSON.stringify(p.checklist), '::jsonb');
    if (p.files !== undefined) add('files', JSON.stringify(p.files), '::jsonb');
    if (p.analysis !== undefined) add('analysis', JSON.stringify(p.analysis), '::jsonb');
    if (p.questionMessageId !== undefined) add('question_message_id', p.questionMessageId, '::bigint');
    if (p.taskId !== undefined) add('task_id', p.taskId, '::bigint');

    return this.db.one<DraftRow>(
      `UPDATE chat_task_drafts SET ${set.join(', ')}
        WHERE tenant_id=$1 AND id=$2
        RETURNING ${ChatTaskDraftRepository.COLUMNS}`,
      params,
    );
  }

  /** Все вложения сообщения: и новые (несколько файлов), и старое одиночное поле. */
  messageFiles(tenantId: string, messageId: string) {
    return this.db.many<{ file_id: string; file_name: string | null; content_type: string | null }>(
      `SELECT mf.file_id::text, f.file_name, f.content_type
         FROM chat_message_files mf
         JOIN files f ON f.id = mf.file_id
        WHERE mf.tenant_id=$1 AND mf.message_id=$2
        UNION
       SELECT m.file_id::text, f2.file_name, f2.content_type
         FROM chat_messages m
         JOIN files f2 ON f2.id = m.file_id
        WHERE m.tenant_id=$1 AND m.id=$2 AND m.file_id IS NOT NULL`,
      [tenantId, messageId],
    );
  }

  /** Текст соседей по разговору: на что отвечали и с чего началась ветка. */
  contextText(tenantId: string, messageId: string) {
    return this.db.one<{ reply_body: string | null; root_body: string | null }>(
      `SELECT r.body AS reply_body, t.body AS root_body
         FROM chat_messages m
         LEFT JOIN chat_messages r ON r.id = m.reply_to_id
         LEFT JOIN chat_messages t ON t.id = m.thread_root_id
        WHERE m.tenant_id=$1 AND m.id=$2`,
      [tenantId, messageId],
    );
  }

  /**
   * Проекты организации — для выбора и сопоставления названия в ответе автора.
   * С человеком — только те, что он видит: закрытый проект не должен всплывать даже
   * названием в выпадающем списке (ТЗ-26, §29).
   */
  projects(tenantId: string, viewer?: ProjectViewer) {
    if (!viewer) {
      return this.db.many<{ id: string; name: string }>(
        `SELECT id::text, name FROM projects WHERE tenant_id=$1 AND status <> 'archived' ORDER BY name`,
        [tenantId],
      );
    }
    return this.db.many<{ id: string; name: string }>(
      `SELECT p.id::text, p.name FROM projects p
        WHERE p.tenant_id=$1 AND p.status <> 'archived' AND NOT p.is_demo
          AND ${projectVisibleSql('p.id', { user: '$2', all: '$3', client: '$4' })}
        ORDER BY p.name`,
      [tenantId, ...viewerParams(viewer)],
    );
  }

  /**
   * Три вероятных проекта для переписки вне проекта (ТЗ-26, §10): где работают оба —
   * и нажавший, и автор, — и где нажавший недавно ставил или делал задачи.
   */
  suggestProjects(tenantId: string, viewer: ProjectViewer, authorId: string | null) {
    return this.db.many<{ id: string }>(
      `SELECT p.id::text
         FROM projects p
        WHERE p.tenant_id = $1 AND p.status <> 'archived' AND NOT p.is_demo
          AND ${projectVisibleSql('p.id', { user: '$2', all: '$3', client: '$4' })}
        ORDER BY
          (CASE WHEN EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id = p.id AND pm.user_id = $5::bigint)
                  OR p.owner_user_id = $5::bigint THEN 2 ELSE 0 END)
          + (CASE WHEN EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id = p.id AND pm.user_id = $2::bigint)
                  OR p.owner_user_id = $2::bigint THEN 1 ELSE 0 END)
          + LEAST(3, (SELECT count(*) FROM tasks t WHERE t.project_id = p.id AND t.deleted_at IS NULL
                        AND (t.created_by = $2::bigint OR t.assignee_id = $2::bigint)
                        AND t.updated_at > now() - interval '14 days'))
          DESC, p.updated_at DESC
        LIMIT 3`,
      [tenantId, ...viewerParams(viewer), authorId],
    );
  }

  /** Реплики перед сообщением в том же разговоре (§37): контекст, но не весь чат. */
  before(tenantId: string, messageId: string, n = 3) {
    return this.db.many<{ body: string; author: string | null }>(
      `SELECT p.body, u.full_name AS author
         FROM chat_messages m
         JOIN chat_messages p ON p.chat_id = m.chat_id AND p.created_at < m.created_at
              AND p.deleted_at IS NULL AND COALESCE(p.body, '') <> ''
              AND p.thread_root_id IS NOT DISTINCT FROM m.thread_root_id
         LEFT JOIN users u ON u.id = p.author_id
        WHERE m.tenant_id = $1 AND m.id = $2
        ORDER BY p.created_at DESC LIMIT $3`,
      [tenantId, messageId, n],
    );
  }

  /** Расшифровка голосового — у самого сообщения (ТЗ-26, §15). */
  transcript(tenantId: string, messageId: string) {
    return this.db.one<{ transcript: string | null; transcript_status: string | null; transcribed_at: Date | null }>(
      `SELECT transcript, transcript_status, transcribed_at FROM chat_messages WHERE tenant_id = $1 AND id = $2`,
      [tenantId, messageId],
    );
  }

  async setTranscript(tenantId: string, messageId: string, status: string, text: string | null = null): Promise<void> {
    await this.db.query(
      `UPDATE chat_messages SET transcript_status = $3, transcript = COALESCE($4, transcript),
              transcribed_at = CASE WHEN $3::text = 'ready' THEN now() ELSE transcribed_at END
        WHERE tenant_id = $1 AND id = $2`,
      [tenantId, messageId, status, text],
    );
  }

  /** Создана очередная задача из сообщения — запомнить номер (повтор её пропустит). */
  async addCreatedTask(tenantId: string, id: string, taskId: string): Promise<void> {
    await this.db.query(
      `UPDATE chat_task_drafts SET created_task_ids = array_append(created_task_ids, $3::bigint), updated_at = now()
        WHERE tenant_id = $1 AND id = $2 AND NOT ($3::bigint = ANY(created_task_ids))`,
      [tenantId, id, taskId],
    );
  }
}
