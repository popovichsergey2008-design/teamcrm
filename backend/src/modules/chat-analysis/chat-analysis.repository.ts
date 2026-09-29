import { Injectable } from '@nestjs/common';
import { DbService } from '../../database/db.service';
import { ExtractedAction } from './analysis-schema';
import { CreateFacts, QualityCounts } from './policy-rules';

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

/** Одно наблюдение со всем, что нужно, чтобы его завести, записать или отменить. */
const ONE_ACTION = `SELECT a.id::text, a.chat_id::text, a.action_type, a.title, a.description,
        a.project_id::text, a.assigner_id::text, a.assignee_id::text,
        a.deadline_at, a.status, a.created_entity_type, a.created_entity_id::text, a.updated_at,
        a.intent_confidence, a.task_id::text, c.title AS chat_title,
        a.meeting_at, a.meeting_date::text, a.duration_minutes, a.participant_ids::text[] AS participant_ids,
        a.change_kind,
        (SELECT am.message_id::text FROM chat_extracted_action_messages am
          WHERE am.action_id = a.id AND am.role = 'instruction'
          ORDER BY am.message_id LIMIT 1) AS instruction_message_id
   FROM chat_extracted_actions a
   JOIN chats c ON c.id = a.chat_id`;

export interface SettingsRow {
  tenant_id: string;
  enabled: boolean;
  quiet_minutes: number;
  mode: string;
  /** Бот вправе задать уточняющий вопрос в чате. */
  ask_in_chat: boolean;
  /** Потолок расхода в месяц, долларов; пусто — без потолка. */
  monthly_limit_usd: string | null;
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
  /** Вопросы в чатах включены владельцем. */
  ask_in_chat: boolean;
  /** suggest | auto_high — заводить ли готовые поручения самому. */
  mode: string;
  monthly_limit_usd: string | null;
  work_start: string;
  work_end: string;
  weekend_days: number[];
  holidays: string[];
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
  /** Карточка задачи, пересланная сообщением: самое твёрдое основание для статуса. */
  task_id: string | null;
}

/** Задача из справочника, который видит модель, — с тем, чья она. */
export interface CandidateTaskRow {
  id: string;
  title: string;
  assignee_id: string | null;
  created_by: string | null;
}

/** Строка журнала решений, как её видит человек. */
export interface DecisionRow {
  id: string;
  text: string;
  details: string;
  project_id: string | null;
  project_name: string | null;
  chat_id: string | null;
  chat_title: string | null;
  meeting_id: string | null;
  meeting_title: string | null;
  source_message_id: string | null;
  participants: { id: string; name: string }[];
  decided_at: Date;
  created_by: string | null;
  revoked_at: Date | null;
}

export interface NamedRow { id: string; name: string }

/** Наблюдение, ждущее ответа на вопрос бота. */
export interface AwaitingRow {
  id: string;
  tenant_id: string;
  chat_id: string;
  title: string;
  project_id: string | null;
  assignee_id: string | null;
  assigner_id: string | null;
  question_message_id: string;
  intent_confidence: string;
  project_confidence: string;
  assigner_confidence: string;
  assignee_confidence: string;
  kind: string;
  chat_project_id: string | null;
  /** task — ждём проект/исполнителя; meeting — ждём время. */
  action_type: string;
  meeting_date: string | null;
  participant_ids: string[];
  timezone: string;
}

@Injectable()
export class ChatAnalysisRepository {
  constructor(private readonly db: DbService) {}

  // ── настройки ──

  async settings(tenantId: string): Promise<SettingsRow> {
    const row = await this.db.one<SettingsRow>(
      `SELECT tenant_id::text, enabled, quiet_minutes, mode, ask_in_chat, monthly_limit_usd
         FROM chat_analysis_settings WHERE tenant_id = $1`,
      [tenantId],
    );
    // Нет строки — значит, владелец ничего не включал: выключено.
    return row ?? {
      tenant_id: String(tenantId), enabled: false, quiet_minutes: 20, mode: 'suggest', ask_in_chat: true,
      monthly_limit_usd: null,
    };
  }

  async saveSettings(
    tenantId: string,
    patch: {
      enabled?: boolean; quietMinutes?: number; mode?: string; askInChat?: boolean;
      /** undefined — не трогать; null — снять потолок. */
      monthlyLimitUsd?: number | null;
    },
  ): Promise<SettingsRow> {
    const row = await this.db.one<SettingsRow>(
      `INSERT INTO chat_analysis_settings (tenant_id, enabled, quiet_minutes, mode, ask_in_chat, monthly_limit_usd)
       VALUES ($1, COALESCE($2, FALSE), COALESCE($3, 20), COALESCE($4, 'suggest'), COALESCE($5, TRUE),
               CASE WHEN $6 THEN $7::numeric ELSE NULL END)
       ON CONFLICT (tenant_id) DO UPDATE SET
         enabled       = COALESCE($2, chat_analysis_settings.enabled),
         quiet_minutes = COALESCE($3, chat_analysis_settings.quiet_minutes),
         mode          = COALESCE($4, chat_analysis_settings.mode),
         ask_in_chat   = COALESCE($5, chat_analysis_settings.ask_in_chat),
         monthly_limit_usd = CASE WHEN $6 THEN $7::numeric ELSE chat_analysis_settings.monthly_limit_usd END,
         updated_at    = now()
       RETURNING tenant_id::text, enabled, quiet_minutes, mode, ask_in_chat, monthly_limit_usd`,
      [tenantId, patch.enabled ?? null, patch.quietMinutes ?? null, patch.mode ?? null, patch.askInChat ?? null,
        // «Снять потолок» и «не трогать» различаются: null — это тоже значение.
        patch.monthlyLimitUsd !== undefined, patch.monthlyLimitUsd ?? null],
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
              c.project_id::text, s.quiet_minutes, t.timezone, s.ask_in_chat,
              s.mode, s.monthly_limit_usd,
              COALESCE(w.work_start, TIME '09:00')::text AS work_start,
              COALESCE(w.work_end, TIME '18:00')::text AS work_end,
              COALESCE(w.weekend_days, ARRAY[0,6]) AS weekend_days,
              COALESCE(w.holidays, ARRAY[]::date[])::text[] AS holidays,
              COALESCE(cp.last_message_id, 0)::text AS last_message_id
         FROM chats c
         JOIN chat_analysis_settings s ON s.tenant_id = c.tenant_id AND s.enabled
         JOIN tenants t ON t.id = c.tenant_id
         LEFT JOIN org_work_settings w ON w.tenant_id = c.tenant_id
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
              m.is_ai, m.reply_to_id::text, m.thread_root_id::text, m.task_id::text
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

  /**
   * Задачи, о которых может быть статус или блокер в этом разговоре.
   *
   * Только открытые и только тех, кто в разговоре писал, — исполнителем или постановщиком:
   * о своей работе человек и говорит. Для чата проекта — только задачи этого проекта.
   * Весь список задач организации модели не отдаём: чем шире выбор, тем вернее промах.
   */
  candidateTasks(tenantId: string, authorIds: string[], projectId: string | null, limit = 40): Promise<CandidateTaskRow[]> {
    if (!authorIds.length) return Promise.resolve([]);
    return this.db.many<CandidateTaskRow>(
      `SELECT t.id::text, t.title, t.assignee_id::text, t.created_by::text
         FROM tasks t
        WHERE t.tenant_id = $1 AND t.deleted_at IS NULL AND t.closed_at IS NULL
          AND (t.assignee_id = ANY($2::bigint[]) OR t.created_by = ANY($2::bigint[]))
          AND ($3::bigint IS NULL OR t.project_id = $3::bigint)
        ORDER BY t.updated_at DESC NULLS LAST, t.id DESC
        LIMIT $4`,
      [tenantId, authorIds, projectId, limit],
    );
  }

  /**
   * Открытые задачи, заведённые из сообщений ЭТОГО чата за последний месяц (этап 7).
   * «Не делай, клиент передумал» в том же разговоре относится к ним — и только их модель
   * вправе выбрать как цель изменения.
   */
  bornHereTasks(tenantId: string, chatId: string, days = 30, limit = 30): Promise<CandidateTaskRow[]> {
    return this.db.many<CandidateTaskRow>(
      `SELECT t.id::text, t.title, t.assignee_id::text, t.created_by::text
         FROM tasks t
         JOIN chat_messages m ON m.id = t.source_chat_message_id
        WHERE t.tenant_id = $1 AND m.chat_id = $2
          AND t.deleted_at IS NULL AND t.closed_at IS NULL
          AND t.created_at > now() - make_interval(days => $3)
        ORDER BY t.id DESC
        LIMIT $4`,
      [tenantId, chatId, days, limit],
    );
  }

  /** Как задачи выглядят сейчас: изменение «на то же самое» — не изменение. */
  async taskStates(tenantId: string, ids: string[]): Promise<Map<string, {
    title: string; assignee_id: string | null; created_by: string | null; deadline_at: Date | null;
  }>> {
    if (!ids.length) return new Map();
    const rows = await this.db.many<{ id: string; title: string; assignee_id: string | null; created_by: string | null; deadline_at: Date | null }>(
      `SELECT id::text, title, assignee_id::text, created_by::text, deadline_at
         FROM tasks WHERE tenant_id = $1 AND id = ANY($2::bigint[]) AND deleted_at IS NULL`,
      [tenantId, [...new Set(ids)]],
    );
    return new Map(rows.map((r) => [r.id, r]));
  }

  /** Роль человека: изменение применяется его правами, а права зависят от роли. */
  async roleOf(tenantId: string, userId: string): Promise<string> {
    const row = await this.db.one<{ code: string }>(
      `SELECT r.code FROM users u JOIN roles r ON r.id = u.role_id WHERE u.tenant_id = $1 AND u.id = $2`,
      [tenantId, userId],
    );
    return row?.code ?? 'member';
  }

  /** Какие из названных номеров — живые задачи этой организации. */
  async aliveTasks(tenantId: string, ids: string[]): Promise<Set<string>> {
    if (!ids.length) return new Set();
    const rows = await this.db.many<{ id: string }>(
      `SELECT id::text FROM tasks WHERE tenant_id = $1 AND id = ANY($2::bigint[]) AND deleted_at IS NULL`,
      [tenantId, ids],
    );
    return new Set(rows.map((r) => r.id));
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

  async finishRun(runId: string, o: {
    status: string; model?: string | null; promptVersion?: string | null;
    actions?: number; duplicates?: number; error?: string | null;
  }): Promise<void> {
    await this.db.query(
      `UPDATE chat_analysis_runs
          SET status = $2, model = $3, prompt_version = $4,
              actions_count = COALESCE($5, 0), error = $6, duplicates = COALESCE($7, 0),
              completed_at = now()
        WHERE id = $1`,
      [runId, o.status, o.model ?? null, o.promptVersion ?? null, o.actions ?? 0, o.error ?? null, o.duplicates ?? 0],
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
         dedup_key, status, task_id, task_confidence,
         participant_ids, meeting_date, duration_minutes, change_kind)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20::bigint[],$21::date,$22,$23)
       ON CONFLICT (tenant_id, dedup_key) DO NOTHING
       RETURNING id::text`,
      [
        tenantId, runId, chatId, a.type, a.title, a.description,
        a.projectId, a.assignerId, a.assigneeId, a.deadlineAt, a.meetingAt,
        a.confidence.intent, a.confidence.project, a.confidence.assigner, a.confidence.assignee,
        a.dedupKey, status, a.taskId, a.confidence.task ?? 0,
        a.participantIds ?? [], a.meetingDate ?? null, a.durationMinutes ?? null, a.changeKind ?? null,
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

  // ── вопрос в чате ──

  /** Отметить, что спросили: второй раз к человеку не возвращаемся. */
  async markAsked(tenantId: string, id: string, messageId: string): Promise<void> {
    await this.db.query(
      `UPDATE chat_extracted_actions
          SET question_message_id = $3, asked_at = now(), updated_at = now()
        WHERE tenant_id = $1 AND id = $2`,
      [tenantId, id, messageId],
    );
  }

  /**
   * Наблюдения, ждущие ответа, вместе с обстановкой для его разбора.
   *
   * Ответ ловим в том же проходе, что и разбор, — раз в пять минут. Отдельный
   * перехват каждого сообщения дал бы мгновенность, которой тут не нужно: разговор
   * уже затих, а взамен пришлось бы связать модули в круг.
   */
  awaiting(now: Date, limit = 50): Promise<AwaitingRow[]> {
    return this.db.many<AwaitingRow>(
      `SELECT a.id::text, a.tenant_id::text, a.chat_id::text, a.title,
              a.project_id::text, a.assignee_id::text, a.assigner_id::text,
              a.question_message_id::text,
              a.intent_confidence, a.project_confidence, a.assigner_confidence, a.assignee_confidence,
              c.kind, c.project_id::text AS chat_project_id,
              a.action_type, a.meeting_date::text, a.participant_ids::text[] AS participant_ids, t.timezone
         FROM chat_extracted_actions a
         JOIN chats c ON c.id = a.chat_id
         JOIN tenants t ON t.id = a.tenant_id
         JOIN chat_analysis_settings s ON s.tenant_id = a.tenant_id AND s.enabled
        WHERE a.question_message_id IS NOT NULL
          -- изменение ждёт «да» постановщика в состоянии «готово», остальное — в «не хватает данных»
          AND (a.status = 'needs_clarification' OR (a.action_type = 'change' AND a.status = 'ready'))
          AND a.asked_at > $1::timestamptz - interval '3 days'
        ORDER BY a.asked_at
        LIMIT $2`,
      [now, limit],
    );
  }

  /** Ответ на вопрос: сообщения чата после вопроса. */
  messagesAfterQuestion(tenantId: string, chatId: string, questionMessageId: string): Promise<MessageRow[]> {
    return this.messagesAfter(tenantId, chatId, questionMessageId, 40);
  }

  /** Дозаполнить наблюдение тем, что человек ответил. */
  async fill(
    tenantId: string, id: string,
    o: { projectId?: string | null; assigneeId?: string | null; projectConfidence?: number; assigneeConfidence?: number; status: string },
  ): Promise<void> {
    await this.db.query(
      `UPDATE chat_extracted_actions
          SET project_id = COALESCE($3::bigint, project_id),
              assignee_id = COALESCE($4::bigint, assignee_id),
              project_confidence = COALESCE($5, project_confidence),
              assignee_confidence = COALESCE($6, assignee_confidence),
              status = $7, updated_at = now()
        WHERE tenant_id = $1 AND id = $2`,
      [tenantId, id, o.projectId ?? null, o.assigneeId ?? null,
        o.projectConfidence ?? null, o.assigneeConfidence ?? null, o.status],
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
              a.deadline_at, a.meeting_at, a.status, a.created_at, a.updated_at, a.asked_at,
              a.created_entity_type, a.created_entity_id::text,
              a.intent_confidence, a.project_confidence, a.assigner_confidence, a.assignee_confidence,
              a.task_id::text, a.task_confidence, tk.title AS task_title, tk.project_id::text AS task_project_id,
              a.meeting_date::text, a.duration_minutes, a.change_kind,
              COALESCE((SELECT json_agg(json_build_object('id', pu.id::text, 'name', pu.full_name)
                                        ORDER BY array_position(a.participant_ids, pu.id))
                          FROM users pu WHERE pu.id = ANY(a.participant_ids)), '[]'::json) AS participants,
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
         LEFT JOIN tasks tk ON tk.id = a.task_id AND tk.deleted_at IS NULL
        WHERE a.tenant_id = $1 AND ${VISIBLE}
          AND ($3::bigint IS NULL OR a.chat_id = $3::bigint)
        ORDER BY a.created_at DESC, a.id DESC
        LIMIT $4`,
      [tenantId, userId, o.chatId ?? null, Math.min(Math.max(o.limit ?? 50, 1), 200)],
    );
  }

  /** Одно наблюдение — с проверкой, что человеку вообще видна эта переписка. */
  one(tenantId: string, userId: string, id: string): Promise<any | null> {
    return this.db.one(`${ONE_ACTION} WHERE a.tenant_id = $1 AND a.id = $3 AND ${VISIBLE}`, [tenantId, userId, id]);
  }

  /**
   * То же для прохода самого агента — без человека, значит, и без проверки видимости.
   * Наружу из прохода ничего не уходит: он пишет только в журнал этой же организации.
   */
  oneForSystem(tenantId: string, id: string): Promise<any | null> {
    return this.db.one(`${ONE_ACTION} WHERE a.tenant_id = $1 AND a.id = $2`, [tenantId, id]);
  }

  /** Задача, куда в итоге легла строка: человек мог указать другую, чем нашёл агент. */
  async setActionTask(tenantId: string, id: string, taskId: string): Promise<void> {
    await this.db.query(
      `UPDATE chat_extracted_actions SET task_id = $3 WHERE tenant_id = $1 AND id = $2`,
      [tenantId, id, taskId],
    );
  }

  /**
   * Наблюдение, из которого агент сам завёл эту задачу. Без условия видимости чата:
   * исполнитель мог и не состоять в разговоре, а отменить ошибку вправе — кто именно,
   * решает `undoVerdict`, а наружу отсюда уходит только то, что и так есть в задаче.
   */
  byCreatedTask(tenantId: string, taskId: string): Promise<any | null> {
    return this.db.one(
      `SELECT a.id::text, a.chat_id::text, a.title, a.assigner_id::text, a.assignee_id::text,
              a.status, a.created_entity_id::text, a.updated_at
         FROM chat_extracted_actions a
        WHERE a.tenant_id = $1 AND a.created_entity_type = 'task' AND a.created_entity_id = $2::bigint
          AND a.status = 'auto_created'
        ORDER BY a.id DESC LIMIT 1`,
      [tenantId, taskId],
    );
  }

  // ── встречи ──

  /** Пояс организации: время встречи в сообщении бота — по нему, а не по серверу. */
  async timezoneOf(tenantId: string): Promise<string> {
    const row = await this.db.one<{ timezone: string | null }>(`SELECT timezone FROM tenants WHERE id = $1`, [tenantId]);
    return row?.timezone || 'Europe/Moscow';
  }

  /** Человек назвал время: встреча дозаполнена и, возможно, готова. */
  async fillMeeting(tenantId: string, id: string, o: { meetingAt: Date; status: string }): Promise<void> {
    await this.db.query(
      `UPDATE chat_extracted_actions SET meeting_at = $3, status = $4, updated_at = now()
        WHERE tenant_id = $1 AND id = $2`,
      [tenantId, id, o.meetingAt, o.status],
    );
  }

  /**
   * Событие календаря помнит договорённость, из которой выросло (ТЗ разд. 23). Отдельной
   * записью, а не полем при создании: календарь о чатах ничего не знает и знать не должен.
   */
  async setEventSource(tenantId: string, eventId: string, chatId: string, messageId: string | null): Promise<void> {
    await this.db.query(
      `UPDATE calendar_events SET source_chat_id = $3, source_chat_message_id = $4
        WHERE tenant_id = $1 AND id = $2`,
      [tenantId, eventId, chatId, messageId],
    );
  }

  // ── журнал решений ──

  /**
   * Сообщения наблюдения с авторами — по порядку. Из них собираются участники решения
   * и цитата для строки в задаче.
   */
  sourcesOf(actionId: string): Promise<{
    message_id: string; role: string; author_id: string | null; author_name: string | null; body: string; created_at: Date;
  }[]> {
    return this.db.many(
      `SELECT m.id::text AS message_id, am.role, m.author_id::text, u.full_name AS author_name, m.body, m.created_at
         FROM chat_extracted_action_messages am
         JOIN chat_messages m ON m.id = am.message_id
         LEFT JOIN users u ON u.id = m.author_id
        WHERE am.action_id = $1
        ORDER BY m.id`,
      [actionId],
    );
  }

  async addDecision(o: {
    tenantId: string; projectId: string | null; chatId: string; actionId: string;
    sourceMessageId: string | null; text: string; details: string;
    participants: string[]; decidedAt: Date; createdBy: string | null;
  }): Promise<string> {
    const row = await this.db.one<{ id: string }>(
      `INSERT INTO decisions (tenant_id, project_id, chat_id, action_id, source_message_id, text, details,
                              participants, decided_at, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::bigint[],$9,$10) RETURNING id::text`,
      [o.tenantId, o.projectId, o.chatId, o.actionId, o.sourceMessageId, o.text, o.details,
        o.participants, o.decidedAt, o.createdBy],
    );
    return String(row!.id);
  }

  /**
   * Журнал решений — только то, что человеку и так видно: решения из переписки — по
   * чатам, где он есть (то же условие, что у наблюдений), со встреч — как и сами встречи,
   * всем сотрудникам. Иначе журнал стал бы обходным путём к чужому разговору.
   */
  decisions(
    tenantId: string, userId: string,
    o: { chatId?: string | null; projectId?: string | null; withRevoked?: boolean; limit?: number },
  ): Promise<DecisionRow[]> {
    return this.db.many<DecisionRow>(
      `SELECT d.id::text, d.text, d.details, d.project_id::text, p.name AS project_name,
              d.chat_id::text, c.title AS chat_title, d.meeting_id::text, mt.title AS meeting_title,
              d.source_message_id::text, d.decided_at, d.created_by::text, d.revoked_at,
              COALESCE((SELECT json_agg(json_build_object('id', u.id::text, 'name', u.full_name) ORDER BY u.full_name)
                          FROM users u WHERE u.id = ANY(d.participants)), '[]'::json) AS participants
         FROM decisions d
         LEFT JOIN chats c     ON c.id = d.chat_id
         LEFT JOIN meetings mt ON mt.id = d.meeting_id
         LEFT JOIN projects p  ON p.id = d.project_id
        WHERE d.tenant_id = $1
          AND (d.chat_id IS NULL OR ${VISIBLE})
          AND ($3::bigint IS NULL OR d.chat_id = $3::bigint)
          AND ($4::bigint IS NULL OR d.project_id = $4::bigint)
          AND ($5::boolean OR d.revoked_at IS NULL)
        ORDER BY d.decided_at DESC, d.id DESC
        LIMIT $6`,
      [tenantId, userId, o.chatId ?? null, o.projectId ?? null, o.withRevoked === true,
        Math.min(Math.max(o.limit ?? 50, 1), 200)],
    );
  }

  oneDecision(tenantId: string, userId: string, id: string): Promise<{
    id: string; created_by: string | null; participants: string[]; revoked_at: Date | null;
  } | null> {
    return this.db.one(
      `SELECT d.id::text, d.created_by::text, d.participants::text[] AS participants, d.revoked_at
         FROM decisions d
         LEFT JOIN chats c ON c.id = d.chat_id
        WHERE d.tenant_id = $1 AND d.id = $3 AND (d.chat_id IS NULL OR ${VISIBLE})`,
      [tenantId, userId, id],
    );
  }

  async revokeDecision(tenantId: string, id: string, userId: string): Promise<void> {
    await this.db.query(
      `UPDATE decisions SET revoked_at = now(), revoked_by = $3
        WHERE tenant_id = $1 AND id = $2 AND revoked_at IS NULL`,
      [tenantId, id, userId],
    );
  }

  // ── строка в задаче ──

  /** Задача, куда ляжет статус или блокер: живая, с проектом — для события в комнату. */
  noteTarget(tenantId: string, taskId: string): Promise<{ id: string; project_id: string; title: string } | null> {
    return this.db.one(
      `SELECT id::text, project_id::text, title FROM tasks
        WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL`,
      [tenantId, taskId],
    );
  }

  /**
   * Системная строка в обсуждении задачи — тот же вид, что у предупреждений о сроке:
   * без автора и внутренняя (заказчику не видна).
   */
  addTaskNote(tenantId: string, taskId: string, body: string): Promise<{ id: string } | null> {
    return this.db.one<{ id: string }>(
      `INSERT INTO task_comments (tenant_id, task_id, author_id, body, is_client_visible, is_system)
            VALUES ($1, $2, NULL, $3, FALSE, TRUE)
         RETURNING id::text`,
      [tenantId, taskId, body],
    );
  }

  // ── политика ──

  /**
   * Мир прямо перед созданием (ТЗ разд. 53): модель смотрела на переписку, а с тех пор
   * проект могли закрыть, человека — уволить, сообщение — удалить.
   */
  async createFacts(
    tenantId: string,
    o: { projectId: string | null; assignerId: string | null; assigneeId: string | null; messageId: string | null },
  ): Promise<CreateFacts> {
    const row = await this.db.one<CreateFacts>(
      `SELECT
         EXISTS (SELECT 1 FROM projects p
                  WHERE p.tenant_id = $1 AND p.id = $2::bigint AND p.status <> 'archived') AS "projectAlive",
         EXISTS (SELECT 1 FROM users u JOIN roles r ON r.id = u.role_id
                  WHERE u.tenant_id = $1 AND u.id = $3::bigint AND u.is_active AND r.code <> 'client') AS "assignerActive",
         EXISTS (SELECT 1 FROM users u JOIN roles r ON r.id = u.role_id
                  WHERE u.tenant_id = $1 AND u.id = $4::bigint AND u.is_active AND r.code <> 'client') AS "assigneeActive",
         EXISTS (SELECT 1 FROM chat_messages m
                  WHERE m.tenant_id = $1 AND m.id = $5::bigint AND m.deleted_at IS NULL) AS "instructionAlive"`,
      [tenantId, o.projectId, o.assignerId, o.assigneeId, o.messageId],
    );
    return row ?? { projectAlive: false, assignerActive: false, assigneeActive: false, instructionAlive: false };
  }

  /** Сообщение-поручение наблюдения: откуда задача, если её заведут. */
  async instructionOf(actionId: string): Promise<string | null> {
    const row = await this.db.one<{ id: string }>(
      `SELECT message_id::text AS id FROM chat_extracted_action_messages
        WHERE action_id = $1 AND role = 'instruction'
        ORDER BY message_id LIMIT 1`,
      [actionId],
    );
    return row?.id ?? null;
  }

  /** Сколько разбор потратил в этом месяце (по оценке ai_usage). */
  async spentThisMonth(tenantId: string): Promise<number> {
    const row = await this.db.one<{ usd: string }>(
      `SELECT COALESCE(SUM(cost_estimate), 0)::text AS usd FROM ai_usage
        WHERE tenant_id = $1 AND feature = 'chat_analysis'
          AND created_at >= date_trunc('month', now())`,
      [tenantId],
    );
    return Number(row?.usd ?? 0);
  }

  /** Что человек поправил, заводя задачу: мера ошибки агента. */
  async markCorrections(tenantId: string, id: string, o: { project: boolean; assignee: boolean }): Promise<void> {
    if (!o.project && !o.assignee) return;
    await this.db.query(
      `UPDATE chat_extracted_actions
          SET corrected_project = corrected_project OR $3,
              corrected_assignee = corrected_assignee OR $4
        WHERE tenant_id = $1 AND id = $2`,
      [tenantId, id, o.project, o.assignee],
    );
  }

  /** Отменили автосозданную задачу: запоминаем кто — это промах агента. */
  async markUndone(tenantId: string, id: string, userId: string): Promise<void> {
    await this.db.query(
      `UPDATE chat_extracted_actions
          SET status = 'cancelled', undone_at = now(), undone_by = $3, updated_at = now()
        WHERE tenant_id = $1 AND id = $2`,
      [tenantId, id, userId],
    );
  }

  /**
   * Счётчики попадания за период (ТЗ разд. 58). По организации целиком: это цифры для
   * решения владельца, а не просмотр чужих переписок — текстов здесь нет.
   */
  async qualityCounts(tenantId: string, days = 30): Promise<QualityCounts> {
    const row = await this.db.one<Record<keyof QualityCounts, string>>(
      `SELECT
         COUNT(*) FILTER (WHERE action_type = 'task')                                    AS "tasksDetected",
         COUNT(*) FILTER (WHERE action_type = 'task' AND status = 'ready')               AS "ready",
         COUNT(*) FILTER (WHERE action_type = 'task' AND status = 'needs_clarification') AS "needsClarification",
         -- Попадание меряем по поручениям: решения и статусы — другая цена ошибки.
         COUNT(*) FILTER (WHERE action_type = 'task' AND status = 'confirmed')           AS "confirmed",
         COUNT(*) FILTER (WHERE action_type = 'task' AND (status = 'auto_created' OR undone_at IS NOT NULL)) AS "autoCreated",
         COUNT(*) FILTER (WHERE action_type = 'task' AND status = 'rejected')            AS "rejected",
         COUNT(*) FILTER (WHERE action_type = 'task' AND undone_at IS NOT NULL)          AS "undone",
         COUNT(*) FILTER (WHERE corrected_project)                                       AS "correctedProject",
         COUNT(*) FILTER (WHERE corrected_assignee)                                      AS "correctedAssignee",
         COUNT(*) FILTER (WHERE corrected_project OR corrected_assignee)                 AS "corrected",
         (SELECT COALESCE(SUM(duplicates), 0) FROM chat_analysis_runs
           WHERE tenant_id = $1 AND started_at > now() - make_interval(days => $2))    AS "duplicates"
         FROM chat_extracted_actions
        WHERE tenant_id = $1 AND created_at > now() - make_interval(days => $2)`,
      [tenantId, days],
    );
    const n = (k: keyof QualityCounts) => Number(row?.[k] ?? 0);
    return {
      tasksDetected: n('tasksDetected'), ready: n('ready'), needsClarification: n('needsClarification'),
      confirmed: n('confirmed'), autoCreated: n('autoCreated'), rejected: n('rejected'), undone: n('undone'),
      correctedProject: n('correctedProject'), correctedAssignee: n('correctedAssignee'),
      corrected: n('corrected'), duplicates: n('duplicates'),
    };
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
