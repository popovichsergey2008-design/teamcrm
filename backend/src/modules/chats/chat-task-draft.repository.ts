import { Injectable } from '@nestjs/common';
import { DbService } from '../../database/db.service';

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
  created_at: string;
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
    checklist, files, analysis, question_message_id::text, task_id::text, created_at`;

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
        WHERE tenant_id=$1 AND message_id=$2 AND status IN ('analyzing','needs_clarification','ready')
        ORDER BY id DESC LIMIT 1`,
      [tenantId, messageId],
    );
  }

  /** Все незавершённые черновики чата — по ним рисуются строки под сообщениями. */
  openInChat(tenantId: string, chatId: string): Promise<DraftRow[]> {
    return this.db.many<DraftRow>(
      `SELECT ${ChatTaskDraftRepository.COLUMNS} FROM chat_task_drafts
        WHERE tenant_id=$1 AND chat_id=$2 AND status IN ('analyzing','needs_clarification','ready')
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

  /** Проекты организации — для сопоставления названия в ответе автора. */
  projects(tenantId: string) {
    return this.db.many<{ id: string; name: string }>(
      `SELECT id::text, name FROM projects WHERE tenant_id=$1 AND status <> 'archived' ORDER BY name`,
      [tenantId],
    );
  }
}
