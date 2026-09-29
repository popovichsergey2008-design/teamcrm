import { Injectable } from '@nestjs/common';
import { DbService } from '../../database/db.service';
import { ExtractedAction } from './analysis-schema';

/**
 * Хранение разбора переписки (ТЗ-12, этап 1).
 *
 * Здесь же — единственное место, где решается, какие чаты вообще попадают в разбор.
 * Условие повторяется в двух запросах, поэтому вынесено в константу: разъехавшись, они
 * дадут разбор личной переписки, а это не ошибка вывода, а нарушенное обещание.
 */

/**
 * Что разбираем: рабочие чаты организации, у которых разбор не выключен.
 *
 * Личные переписки (`dm`), заметки себе (`self`) и внешние чаты не разбираются ВООБЩЕ —
 * это решение заказчика от 29.09 и оно не переключается настройкой: возможность включить
 * чтение личных разговоров сотрудников не должна существовать.
 */
const ANALYZABLE = `c.kind IN ('project', 'group') AND c.is_external = FALSE AND c.ai_analysis = TRUE`;

/**
 * Кому видно наблюдение: ровно тем, кому видна сама переписка.
 *
 * Разбор не должен становиться обходным путём к чужому чату: чат проекта открыт команде,
 * закрытый чат — только участникам. Условие то же, что и в списке чатов.
 */
const VISIBLE = `(c.kind = 'project' OR EXISTS (
  SELECT 1 FROM chat_members cm WHERE cm.chat_id = c.id AND cm.user_id = $2))`;

export interface SettingsRow {
  tenant_id: string;
  enabled: boolean;
  quiet_minutes: number;
  mode: string;
}

export interface DueChatRow {
  chat_id: string;
  tenant_id: string;
  kind: string;
  title: string | null;
  project_id: string | null;
  quiet_minutes: number;
  last_message_id: string;
  /** Пояс организации: по нему модель считает «завтра» и «до пятницы». */
  timezone: string;
}

export interface MessageRow {
  id: string;
  author_id: string | null;
  author_name: string | null;
  body: string;
  created_at: Date;
  is_ai: boolean;
  reply_to_id: string | null;
  thread_root_id: string | null;
}

export interface NamedRow { id: string; name: string }

@Injectable()
export class ChatAnalysisRepository {
  constructor(private readonly db: DbService) {}

  // ── настройки ──

  async settings(tenantId: string): Promise<SettingsRow> {
    const row = await this.db.one<SettingsRow>(
      `SELECT tenant_id::text, enabled, quiet_minutes, mode
         FROM chat_analysis_settings WHERE tenant_id = $1`,
      [tenantId],
    );
    // Нет строки — значит, владелец ничего не включал: выключено.
    return row ?? { tenant_id: String(tenantId), enabled: false, quiet_minutes: 20, mode: 'suggest' };
  }

  async saveSettings(tenantId: string, patch: { enabled?: boolean; quietMinutes?: number; mode?: string }): Promise<SettingsRow> {
    const row = await this.db.one<SettingsRow>(
      `INSERT INTO chat_analysis_settings (tenant_id, enabled, quiet_minutes, mode)
       VALUES ($1, COALESCE($2, FALSE), COALESCE($3, 20), COALESCE($4, 'suggest'))
       ON CONFLICT (tenant_id) DO UPDATE SET
         enabled       = COALESCE($2, chat_analysis_settings.enabled),
         quiet_minutes = COALESCE($3, chat_analysis_settings.quiet_minutes),
         mode          = COALESCE($4, chat_analysis_settings.mode),
         updated_at    = now()
       RETURNING tenant_id::text, enabled, quiet_minutes, mode`,
      [tenantId, patch.enabled ?? null, patch.quietMinutes ?? null, patch.mode ?? null],
    );
    return row as SettingsRow;
  }

  /** Переключатель разбора у одного чата. */
  async setChatAnalysis(tenantId: string, chatId: string, on: boolean): Promise<void> {
    await this.db.query(
      `UPDATE chats SET ai_analysis = $3 WHERE tenant_id = $1 AND id = $2`,
      [tenantId, chatId, on],
    );
  }

  // ── очередь на разбор ──

  /**
   * Чаты, где разговор затих и есть неразобранные сообщения.
   *
   * Тишину считаем по `last_message_at` самого чата — это дешёвая проверка по индексу,
   * которая отсеивает почти всё. Точные границы отрезков определяются уже по сообщениям.
   */
  dueChats(now: Date, tenantId: string | null, limit = 20): Promise<DueChatRow[]> {
    return this.db.many<DueChatRow>(
      `SELECT c.id::text AS chat_id, c.tenant_id::text, c.kind, c.title,
              c.project_id::text, s.quiet_minutes, t.timezone,
              COALESCE(cp.last_message_id, 0)::text AS last_message_id
         FROM chats c
         JOIN chat_analysis_settings s ON s.tenant_id = c.tenant_id AND s.enabled
         JOIN tenants t ON t.id = c.tenant_id
         LEFT JOIN chat_analysis_checkpoints cp ON cp.tenant_id = c.tenant_id AND cp.chat_id = c.id
        WHERE ${ANALYZABLE}
          AND c.last_message_at IS NOT NULL
          AND c.last_message_at <= $1::timestamptz - make_interval(mins => s.quiet_minutes)
          AND ($2::bigint IS NULL OR c.tenant_id = $2::bigint)
          AND EXISTS (
                SELECT 1 FROM chat_messages m
                 WHERE m.chat_id = c.id AND m.deleted_at IS NULL
                   AND m.id > COALESCE(cp.last_message_id, 0))
        ORDER BY c.last_message_at
        LIMIT $3`,
      [now, tenantId, limit],
    );
  }

  /** Неразобранные сообщения чата по порядку. Удалённые в разбор не идут. */
  messagesAfter(tenantId: string, chatId: string, afterId: string, limit = 400): Promise<MessageRow[]> {
    return this.db.many<MessageRow>(
      `SELECT m.id::text, m.author_id::text, u.full_name AS author_name, m.body, m.created_at,
              m.is_ai, m.reply_to_id::text, m.thread_root_id::text
         FROM chat_messages m
         LEFT JOIN users u ON u.id = m.author_id
        WHERE m.tenant_id = $1 AND m.chat_id = $2 AND m.deleted_at IS NULL AND m.id > $3
        ORDER BY m.id
        LIMIT $4`,
      [tenantId, chatId, afterId, limit],
    );
  }

  /**
   * Кого модель вправе назвать исполнителем или постановщиком.
   *
   * Участники чата и, для чата проекта, участники проекта. Всю организацию не отдаём:
   * это и лишние данные в запросе к модели, и приглашение назначить задачу человеку,
   * который к разговору отношения не имеет.
   */
  people(tenantId: string, chatId: string, projectId: string | null, limit = 60): Promise<NamedRow[]> {
    return this.db.many<NamedRow>(
      `SELECT DISTINCT u.id::text, u.full_name AS name
         FROM users u
         JOIN roles r ON r.id = u.role_id
        WHERE u.tenant_id = $1 AND u.is_active AND r.code <> 'client'
          AND (EXISTS (SELECT 1 FROM chat_members cm WHERE cm.chat_id = $2 AND cm.user_id = u.id)
               OR EXISTS (SELECT 1 FROM chat_messages m
                           WHERE m.chat_id = $2 AND m.author_id = u.id AND m.deleted_at IS NULL)
               OR ($3::bigint IS NOT NULL AND EXISTS (
                     SELECT 1 FROM project_members pm
                      WHERE pm.project_id = $3::bigint AND pm.user_id = u.id)))
        ORDER BY 2
        LIMIT $4`,
      [tenantId, chatId, projectId, limit],
    );
  }

  /** Проекты, среди которых модель выбирает. Архивные не предлагаем. */
  projects(tenantId: string, limit = 60): Promise<NamedRow[]> {
    return this.db.many<NamedRow>(
      `SELECT id::text, name FROM projects
        WHERE tenant_id = $1 AND status <> 'archived'
        ORDER BY updated_at DESC NULLS LAST, id DESC
        LIMIT $2`,
      [tenantId, limit],
    );
  }

  // ── прогон ──

  async startRun(o: {
    tenantId: string; chatId: string; mode: string;
    startMessageId: string; endMessageId: string; messages: number;
  }): Promise<string> {
    const row = await this.db.one<{ id: string }>(
      `INSERT INTO chat_analysis_runs (tenant_id, chat_id, mode, start_message_id, end_message_id, messages)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id::text`,
      [o.tenantId, o.chatId, o.mode, o.startMessageId, o.endMessageId, o.messages],
    );
    return String(row!.id);
  }

  async finishRun(runId: string, o: { status: string; model?: string | null; promptVersion?: string | null; actions?: number; error?: string | null }): Promise<void> {
    await this.db.query(
      `UPDATE chat_analysis_runs
          SET status = $2, model = $3, prompt_version = $4,
              actions_count = COALESCE($5, 0), error = $6, completed_at = now()
        WHERE id = $1`,
      [runId, o.status, o.model ?? null, o.promptVersion ?? null, o.actions ?? 0, o.error ?? null],
    );
  }

  /**
   * Записать наблюдение вместе с источниками.
   *
   * Повтор (тот же ключ) пропускаем молча: это и есть защита от двойной обработки — то
   * же самое придёт и с затихшим отрезком, и с ночной сверкой.
   */
  async addAction(
    tenantId: string, runId: string, chatId: string, a: ExtractedAction, status = 'detected',
  ): Promise<string | null> {
    const row = await this.db.one<{ id: string }>(
      `INSERT INTO chat_extracted_actions (
         tenant_id, run_id, chat_id, action_type, title, description,
         project_id, assigner_id, assignee_id, deadline_at, meeting_at,
         intent_confidence, project_confidence, assigner_confidence, assignee_confidence,
         dedup_key, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
       ON CONFLICT (tenant_id, dedup_key) DO NOTHING
       RETURNING id::text`,
      [
        tenantId, runId, chatId, a.type, a.title, a.description,
        a.projectId, a.assignerId, a.assigneeId, a.deadlineAt, a.meetingAt,
        a.confidence.intent, a.confidence.project, a.confidence.assigner, a.confidence.assignee,
        a.dedupKey, status,
      ],
    );
    if (!row) return null;

    for (const s of a.sources) {
      await this.db.query(
        `INSERT INTO chat_extracted_action_messages (action_id, message_id, role)
         VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
        [row.id, s.messageId, s.role],
      );
    }
    return String(row.id);
  }

  /** Отметку двигаем только после удачного прохода — иначе сообщения потеряются. */
  async moveCheckpoint(tenantId: string, chatId: string, lastMessageId: string, runId: string): Promise<void> {
    await this.db.query(
      `INSERT INTO chat_analysis_checkpoints (tenant_id, chat_id, last_message_id, last_run_id, last_run_at)
       VALUES ($1,$2,$3,$4, now())
       ON CONFLICT (tenant_id, chat_id) DO UPDATE SET
         last_message_id = GREATEST(chat_analysis_checkpoints.last_message_id, EXCLUDED.last_message_id),
         last_run_id = EXCLUDED.last_run_id, last_run_at = now()`,
      [tenantId, chatId, lastMessageId, runId],
    );
  }

  // ── чтение ──

  /** Что агент понял: последние наблюдения организации или одного чата. */
  actions(tenantId: string, userId: string, o: { chatId?: string | null; limit?: number }): Promise<any[]> {
    return this.db.many(
      `SELECT a.id::text, a.chat_id::text, a.action_type, a.title, a.description,
              a.project_id::text, p.name AS project_name,
              a.assigner_id::text, ur.full_name AS assigner_name,
              a.assignee_id::text, ue.full_name AS assignee_name,
              a.deadline_at, a.meeting_at, a.status, a.created_at,
              a.created_entity_type, a.created_entity_id::text,
              a.intent_confidence, a.project_confidence, a.assigner_confidence, a.assignee_confidence,
              c.title AS chat_title, c.kind AS chat_kind, pc.name AS chat_project_name,
              COALESCE((
                SELECT json_agg(json_build_object('messageId', m.id::text, 'role', am.role, 'body', left(m.body, 400), 'at', m.created_at, 'author', au.full_name)
                                ORDER BY m.id)
                  FROM chat_extracted_action_messages am
                  JOIN chat_messages m ON m.id = am.message_id
                  LEFT JOIN users au ON au.id = m.author_id
                 WHERE am.action_id = a.id
              ), '[]'::json) AS sources
         FROM chat_extracted_actions a
         JOIN chats c ON c.id = a.chat_id
         LEFT JOIN projects p  ON p.id = a.project_id
         LEFT JOIN projects pc ON pc.id = c.project_id
         LEFT JOIN users ur ON ur.id = a.assigner_id
         LEFT JOIN users ue ON ue.id = a.assignee_id
        WHERE a.tenant_id = $1 AND ${VISIBLE}
          AND ($3::bigint IS NULL OR a.chat_id = $3::bigint)
        ORDER BY a.created_at DESC, a.id DESC
        LIMIT $4`,
      [tenantId, userId, o.chatId ?? null, Math.min(Math.max(o.limit ?? 50, 1), 200)],
    );
  }

  /** Одно наблюдение — с проверкой, что человеку вообще видна эта переписка. */
  one(tenantId: string, userId: string, id: string): Promise<any | null> {
    return this.db.one(
      `SELECT a.id::text, a.chat_id::text, a.action_type, a.title, a.description,
              a.project_id::text, a.assigner_id::text, a.assignee_id::text,
              a.deadline_at, a.status, a.created_entity_id::text,
              (SELECT am.message_id::text FROM chat_extracted_action_messages am
                WHERE am.action_id = a.id AND am.role = 'instruction'
                ORDER BY am.message_id LIMIT 1) AS instruction_message_id
         FROM chat_extracted_actions a
         JOIN chats c ON c.id = a.chat_id
        WHERE a.tenant_id = $1 AND a.id = $3 AND ${VISIBLE}`,
      [tenantId, userId, id],
    );
  }

  /**
   * Откуда задача взялась: сообщение, которое было поручением.
   *
   * Тем же полем пользуется «создать задачу из сообщения» — карточка задачи умеет по
   * нему открыть исходный разговор, и второго способа заводить незачем.
   */
  async linkSourceMessage(tenantId: string, taskId: string, messageId: string): Promise<void> {
    await this.db.query(
      `UPDATE tasks SET source_chat_message_id = $3 WHERE tenant_id = $1 AND id = $2`,
      [tenantId, taskId, messageId],
    );
  }

  /** Отметить, чем кончилось наблюдение: завели задачу, отвергли, отменили. */
  async markAction(
    tenantId: string, id: string,
    o: { status: string; entityType?: string | null; entityId?: string | null },
  ): Promise<void> {
    await this.db.query(
      `UPDATE chat_extracted_actions
          SET status = $3, created_entity_type = COALESCE($4, created_entity_type),
              created_entity_id = COALESCE($5, created_entity_id), updated_at = now()
        WHERE tenant_id = $1 AND id = $2`,
      [tenantId, id, o.status, o.entityType ?? null, o.entityId ?? null],
    );
  }

  /** Последние прогоны — по ним видно, что агент вообще работает и на чём спотыкается. */
  runs(tenantId: string, userId: string, limit = 20): Promise<any[]> {
    return this.db.many(
      `SELECT r.id::text, r.chat_id::text, r.mode, r.status, r.messages, r.actions_count,
              r.model, r.error, r.started_at, r.completed_at,
              c.title AS chat_title, p.name AS chat_project_name
         FROM chat_analysis_runs r
         JOIN chats c ON c.id = r.chat_id
         LEFT JOIN projects p ON p.id = c.project_id
        WHERE r.tenant_id = $1 AND ${VISIBLE}
        ORDER BY r.started_at DESC
        LIMIT $3`,
      [tenantId, userId, Math.min(Math.max(limit, 1), 100)],
    );
  }
}
