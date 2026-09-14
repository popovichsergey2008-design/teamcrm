import { Injectable } from '@nestjs/common';
import { DbService } from '../../database/db.service';

export interface SessionRow {
  id: string; tenant_id: string; user_id: string; title: string | null;
  context_entity_type: string | null; context_entity_id: string | null;
  created_at: Date; updated_at: Date;
}
export interface MessageRow {
  id: string; session_id: string; role: string; content: string;
  citations: unknown[] | null; tools: unknown[] | null; action_id: string | null; created_at: Date;
}
export interface ActionRow {
  id: string; tenant_id: string; session_id: string | null; user_id: string; tool: string;
  input_json: Record<string, unknown>; output_json: Record<string, unknown> | null;
  requires_approval: boolean; approved_at: Date | null; status: string; error: string | null; created_at: Date;
}

export interface MemoryRow {
  id: string; tenant_id: string; user_id: string; type: string; title: string; content: string;
  source: string; session_id: string | null; created_at: Date; updated_at: Date;
}
export interface ScheduleRow {
  id: string; tenant_id: string; user_id: string; title: string; instruction: string;
  schedule: { kind: string; time: string; weekday?: number; day?: number };
  status: string; next_run_at: Date; last_run_at: Date | null; last_result: string | null;
  last_error: string | null; runs: number; session_id: string | null; created_at: Date;
}

export interface SkillRow {
  id: string; tenant_id: string; owner_id: string | null; name: string; description: string;
  when_to_use: string; steps: string[]; inputs: string[]; output: string;
  visibility: string; status: string; version: number; uses: number;
  created_at: Date; updated_at: Date;
}

/** Источник в ответе — то, что можно открыть одним нажатием. */
export interface Source { kind: 'task' | 'message' | 'meeting' | 'project' | 'chat'; id: string; title: string; url: string }

/**
 * Хранилище агента: сессии, сообщения, действия, оценки.
 *
 * Сессия — личная: чужую не открыть даже по номеру. Все выборки — по tenant и по
 * человеку сразу: это дешевле, чем помнить о проверке в каждом методе сервиса.
 */
@Injectable()
export class AnthillRepository {
  constructor(private readonly db: DbService) {}

  // ── сессии ──
  createSession(tenantId: string, userId: string, ctx?: { type: string; id: string } | null): Promise<SessionRow> {
    return this.db.one<SessionRow>(
      `INSERT INTO ai_sessions (tenant_id, user_id, context_entity_type, context_entity_id)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [tenantId, userId, ctx?.type ?? null, ctx?.id ?? null],
    ) as Promise<SessionRow>;
  }

  session(tenantId: string, userId: string, id: string): Promise<SessionRow | null> {
    return this.db.one<SessionRow>(
      `SELECT * FROM ai_sessions WHERE tenant_id=$1 AND user_id=$2 AND id=$3`, [tenantId, userId, id],
    );
  }

  /** История: свежие первыми, у каждой — первый вопрос как подпись, если названия нет. */
  sessions(tenantId: string, userId: string, limit = 50) {
    return this.db.many<SessionRow & { first_question: string | null; messages: string }>(
      `SELECT s.*,
              (SELECT m.content FROM ai_messages m WHERE m.session_id = s.id AND m.role='user' ORDER BY m.id LIMIT 1) AS first_question,
              (SELECT COUNT(*) FROM ai_messages m WHERE m.session_id = s.id) AS messages
         FROM ai_sessions s
        WHERE s.tenant_id=$1 AND s.user_id=$2
        ORDER BY s.updated_at DESC LIMIT $3`,
      [tenantId, userId, limit],
    );
  }

  async setTitle(id: string, title: string): Promise<void> {
    await this.db.query(`UPDATE ai_sessions SET title=$2, updated_at=now() WHERE id=$1`, [id, title.slice(0, 255)]);
  }

  async touch(id: string): Promise<void> {
    await this.db.query(`UPDATE ai_sessions SET updated_at=now() WHERE id=$1`, [id]);
  }

  async deleteSession(tenantId: string, userId: string, id: string): Promise<boolean> {
    const r = await this.db.query(`DELETE FROM ai_sessions WHERE tenant_id=$1 AND user_id=$2 AND id=$3`, [tenantId, userId, id]);
    return (r.rowCount ?? 0) > 0;
  }

  // ── сообщения ──
  messages(sessionId: string, limit = 200): Promise<MessageRow[]> {
    return this.db.many<MessageRow>(
      `SELECT id, session_id, role, content, citations, tools, action_id, created_at
         FROM ai_messages WHERE session_id=$1 ORDER BY id DESC LIMIT $2`,
      [sessionId, limit],
    ).then((rows) => rows.reverse());
  }

  addMessage(i: {
    tenantId: string; sessionId: string; role: 'user' | 'assistant'; content: string;
    citations?: Source[] | null; tools?: unknown[] | null; actionId?: string | null; model?: string | null;
  }): Promise<MessageRow> {
    return this.db.one<MessageRow>(
      `INSERT INTO ai_messages (tenant_id, session_id, role, content, citations, tools, action_id, model)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8) RETURNING id, session_id, role, content, citations, tools, action_id, created_at`,
      [i.tenantId, i.sessionId, i.role, i.content, i.citations ? JSON.stringify(i.citations) : null,
        i.tools ? JSON.stringify(i.tools) : null, i.actionId ?? null, i.model ?? null],
    ) as Promise<MessageRow>;
  }

  async setMessageAction(messageId: string, actionId: string): Promise<void> {
    await this.db.query(`UPDATE ai_messages SET action_id=$2 WHERE id=$1`, [messageId, actionId]);
  }

  // ── действия ──
  createAction(i: { tenantId: string; sessionId: string | null; userId: string; tool: string; input: Record<string, unknown> }): Promise<ActionRow> {
    return this.db.one<ActionRow>(
      `INSERT INTO ai_tool_actions (tenant_id, session_id, user_id, tool, input_json) VALUES ($1,$2,$3,$4,$5::jsonb) RETURNING *`,
      [i.tenantId, i.sessionId, i.userId, i.tool, JSON.stringify(i.input)],
    ) as Promise<ActionRow>;
  }

  action(tenantId: string, userId: string, id: string): Promise<ActionRow | null> {
    return this.db.one<ActionRow>(`SELECT * FROM ai_tool_actions WHERE tenant_id=$1 AND user_id=$2 AND id=$3`, [tenantId, userId, id]);
  }

  /** Правка карточки до подтверждения: меняются и параметры, и текст предложения. */
  async updateActionInput(id: string, input: Record<string, unknown>): Promise<void> {
    await this.db.query(`UPDATE ai_tool_actions SET input_json=$2::jsonb WHERE id=$1 AND status='pending'`, [id, JSON.stringify(input)]);
  }

  async setActionMessageText(actionId: string, text: string): Promise<void> {
    await this.db.query(`UPDATE ai_messages SET content=$2 WHERE action_id=$1`, [actionId, text]);
  }

  /**
   * Время подтверждения считаем в TS, а не в CASE по $2.
   *
   * Postgres выводит тип параметра один раз на весь запрос: один и тот же $2 как
   * значение колонки и как операнд сравнения роняет ВЕСЬ запрос («inconsistent
   * types deduced for parameter»), а не только эту ветку.
   */
  async finishAction(id: string, status: 'done' | 'rejected' | 'failed' | 'undone', output?: Record<string, unknown> | null, error?: string | null): Promise<void> {
    await this.db.query(
      `UPDATE ai_tool_actions SET status=$2, output_json=COALESCE($3::jsonb, output_json), error=$4,
              approved_at = COALESCE($5::timestamptz, approved_at)
        WHERE id=$1`,
      [id, status, output ? JSON.stringify(output) : null, error ?? null, status === 'done' ? new Date().toISOString() : null],
    );
  }

  /** Журнал действий человека — вкладка «История» и админский обзор. */
  actions(tenantId: string, userId: string, limit = 100): Promise<ActionRow[]> {
    return this.db.many<ActionRow>(
      `SELECT * FROM ai_tool_actions WHERE tenant_id=$1 AND user_id=$2 ORDER BY id DESC LIMIT $3`, [tenantId, userId, limit],
    );
  }

  // ── память (ТЗ-6, разд. 20–21, 57) ──

  /**
   * Запомнить факт. Повтор той же мысли обновляет строку, а не плодит вторую:
   * иначе через месяц в памяти лежит пятнадцать вариантов «работаю по Новосибирску».
   */
  rememberFact(i: { tenantId: string; userId: string; type: string; title: string; content: string; source: string; sessionId?: string | null }): Promise<MemoryRow> {
    return this.db.one<MemoryRow>(
      `INSERT INTO ai_memories (tenant_id, user_id, type, title, content, source, session_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (tenant_id, user_id, type, lower(title))
       DO UPDATE SET content = EXCLUDED.content, source = EXCLUDED.source, updated_at = now()
       RETURNING *`,
      [i.tenantId, i.userId, i.type, i.title, i.content, i.source, i.sessionId ?? null],
    ) as Promise<MemoryRow>;
  }

  memories(tenantId: string, userId: string, limit = 100): Promise<MemoryRow[]> {
    return this.db.many<MemoryRow>(
      `SELECT * FROM ai_memories WHERE tenant_id=$1 AND user_id=$2 ORDER BY updated_at DESC LIMIT $3`,
      [tenantId, userId, limit],
    );
  }

  updateMemory(tenantId: string, userId: string, id: string, title: string, content: string): Promise<MemoryRow | null> {
    return this.db.one<MemoryRow>(
      `UPDATE ai_memories SET title=$4, content=$5, source='manual', updated_at=now()
        WHERE tenant_id=$1 AND user_id=$2 AND id=$3 RETURNING *`,
      [tenantId, userId, id, title, content],
    );
  }

  async forget(tenantId: string, userId: string, id: string): Promise<boolean> {
    const r = await this.db.query(`DELETE FROM ai_memories WHERE tenant_id=$1 AND user_id=$2 AND id=$3`, [tenantId, userId, id]);
    return (r.rowCount ?? 0) > 0;
  }

  // ── регулярные задачи (разд. 15, 58) ──

  createSchedule(i: {
    tenantId: string; userId: string; title: string; instruction: string;
    schedule: Record<string, unknown>; nextRunAt: Date; sessionId?: string | null;
  }): Promise<ScheduleRow> {
    return this.db.one<ScheduleRow>(
      `INSERT INTO ai_scheduled_tasks (tenant_id, user_id, title, instruction, schedule, next_run_at, session_id)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7) RETURNING *`,
      [i.tenantId, i.userId, i.title, i.instruction, JSON.stringify(i.schedule), i.nextRunAt.toISOString(), i.sessionId ?? null],
    ) as Promise<ScheduleRow>;
  }

  schedules(tenantId: string, userId: string): Promise<ScheduleRow[]> {
    return this.db.many<ScheduleRow>(
      `SELECT * FROM ai_scheduled_tasks WHERE tenant_id=$1 AND user_id=$2 ORDER BY status, next_run_at`,
      [tenantId, userId],
    );
  }

  schedule(tenantId: string, userId: string, id: string): Promise<ScheduleRow | null> {
    return this.db.one<ScheduleRow>(
      `SELECT * FROM ai_scheduled_tasks WHERE tenant_id=$1 AND user_id=$2 AND id=$3`, [tenantId, userId, id],
    );
  }

  updateSchedule(tenantId: string, userId: string, id: string, p: {
    title?: string | null; instruction?: string | null; schedule?: Record<string, unknown> | null;
    status?: string | null; nextRunAt?: Date | null;
  }): Promise<ScheduleRow | null> {
    return this.db.one<ScheduleRow>(
      `UPDATE ai_scheduled_tasks
          SET title       = COALESCE($4, title),
              instruction = COALESCE($5, instruction),
              schedule    = COALESCE($6::jsonb, schedule),
              status      = COALESCE($7, status),
              next_run_at = COALESCE($8::timestamptz, next_run_at)
        WHERE tenant_id=$1 AND user_id=$2 AND id=$3 RETURNING *`,
      [tenantId, userId, id, p.title ?? null, p.instruction ?? null,
        p.schedule ? JSON.stringify(p.schedule) : null, p.status ?? null, p.nextRunAt ? p.nextRunAt.toISOString() : null],
    );
  }

  /** Нитка разговора задачи: заводится при первом запуске и живёт дальше. */
  async attachSession(id: string, sessionId: string): Promise<void> {
    await this.db.query(`UPDATE ai_scheduled_tasks SET session_id=$2 WHERE id=$1`, [id, sessionId]);
  }

  async deleteSchedule(tenantId: string, userId: string, id: string): Promise<boolean> {
    const r = await this.db.query(`DELETE FROM ai_scheduled_tasks WHERE tenant_id=$1 AND user_id=$2 AND id=$3`, [tenantId, userId, id]);
    return (r.rowCount ?? 0) > 0;
  }

  /**
   * Забрать созревшие задачи СЕБЕ.
   *
   * Не просто «выбрать»: во время сине-зелёной выкладки минуту работают оба цвета,
   * и одинаковый SELECT в обоих отдал бы одну задачу дважды — человек получил бы
   * два одинаковых отчёта. Поэтому сразу двигаем next_run_at на пять минут вперёд:
   * это аренда. Успели — finishRun поставит настоящее время следующего запуска;
   * упали на середине — задача сама вернётся через пять минут, а не потеряется.
   */
  claimDue(limit = 20): Promise<ScheduleRow[]> {
    return this.db.many<ScheduleRow>(
      `UPDATE ai_scheduled_tasks SET next_run_at = now() + interval '5 minutes'
        WHERE id IN (
          SELECT s.id FROM ai_scheduled_tasks s
            JOIN users u ON u.id = s.user_id AND u.is_active
           WHERE s.status='active' AND s.next_run_at <= now()
           ORDER BY s.next_run_at
           LIMIT $1
           FOR UPDATE SKIP LOCKED
        )
        RETURNING *`,
      [limit],
    );
  }

  /** Пояс и роль владельца задачи: с ними её и выполняем — от его имени. */
  userMeta(tenantId: string, userId: string) {
    return this.db.one<{ timezone: string | null; role: string }>(
      `SELECT u.timezone, COALESCE(r.code, 'member') AS role
         FROM users u LEFT JOIN roles r ON r.id = u.role_id
        WHERE u.tenant_id=$1 AND u.id=$2`,
      [tenantId, userId],
    );
  }

  async finishRun(id: string, nextRunAt: Date, result: string | null, error: string | null): Promise<void> {
    await this.db.query(
      `UPDATE ai_scheduled_tasks
          SET last_run_at=now(), next_run_at=$2, last_result=$3, last_error=$4, runs = runs + 1
        WHERE id=$1`,
      [id, nextRunAt.toISOString(), result, error],
    );
  }

  /** Пояс человека: расписания и «завтра в 9» считаются по его часам, а не по серверным. */
  async userTz(tenantId: string, userId: string): Promise<string | null> {
    const row = await this.db.one<{ timezone: string | null }>(
      `SELECT timezone FROM users WHERE tenant_id=$1 AND id=$2`, [tenantId, userId],
    );
    return row?.timezone ?? null;
  }

  /** Собирает ли агент память сам: выключатель живёт там же, где остальные настройки экрана. */
  async memoryAuto(tenantId: string, userId: string): Promise<boolean> {
    const row = await this.db.one<{ off: boolean }>(
      `SELECT (ui_prefs->'anthill'->>'memoryAuto') = 'false' AS off FROM users WHERE tenant_id=$1 AND id=$2`,
      [tenantId, userId],
    );
    return !row?.off;
  }

  // ── файлы (разд. 23) ──

  /** Вложения задачи: имя, тип, размер — чтобы агент знал, что вообще можно прочитать. */
  taskFiles(tenantId: string, taskId: string) {
    return this.db.many<{ id: string; file_name: string; content_type: string; size_bytes: string; created_at: Date }>(
      `SELECT f.id, f.file_name, f.content_type, f.size_bytes, f.created_at
         FROM task_attachments a JOIN files f ON f.id = a.file_id
        WHERE a.tenant_id=$1 AND a.task_id=$2
        ORDER BY f.id DESC LIMIT 30`,
      [tenantId, taskId],
    );
  }

  /** Вложения чата — только того, который человеку доступен (та же область видимости). */
  chatFiles(tenantId: string, userId: string, chatId: string) {
    return this.db.many<{ id: string; file_name: string; content_type: string; size_bytes: string; created_at: Date; author: string | null }>(
      `SELECT f.id, f.file_name, f.content_type, f.size_bytes, f.created_at, u.full_name AS author
         FROM chat_message_files mf
         JOIN files f ON f.id = mf.file_id
         JOIN chat_messages m ON m.id = mf.message_id
         JOIN chats c ON c.id = m.chat_id
    LEFT JOIN users u ON u.id = m.author_id
        WHERE m.tenant_id=$1 AND m.chat_id=$3 AND m.deleted_at IS NULL AND ${AnthillRepository.CHAT_SCOPE}
        ORDER BY f.id DESC LIMIT 30`,
      [tenantId, userId, chatId],
    );
  }

  fileMeta(tenantId: string, fileId: string) {
    return this.db.one<{ id: string; file_name: string; content_type: string; size_bytes: string }>(
      `SELECT id, file_name, content_type, size_bytes FROM files WHERE tenant_id=$1 AND id=$2`,
      [tenantId, fileId],
    );
  }

  // ── навыки (ТЗ-6, разд. 16–19) ──

  /**
   * Что человеку доступно: свои навыки и навыки компании.
   *
   * Чужие личные не показываем даже по номеру: навык — это ещё и описание того,
   * как человек работает, и делиться им он решает сам (поле visibility).
   */
  skills(tenantId: string, userId: string): Promise<SkillRow[]> {
    return this.db.many<SkillRow>(
      `SELECT * FROM ai_skills
        WHERE tenant_id=$1 AND status='active' AND (visibility='company' OR owner_id=$2)
        ORDER BY uses DESC, lower(name)`,
      [tenantId, userId],
    );
  }

  /**
   * Есть ли у организации хоть один навык. По этому и решаем, заводить ли
   * стартовый набор: пустой каталог не объясняет, что такое навык.
   */
  async hasSkills(tenantId: string): Promise<boolean> {
    const row = await this.db.one<{ any: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM ai_skills WHERE tenant_id=$1) AS any`, [tenantId],
    );
    return !!row?.any;
  }

  /** Общий навык компании: владельца нет — правит его только тот, кто сделает копию. */
  createCommonSkill(i: {
    tenantId: string; name: string; description: string; whenToUse: string;
    steps: string[]; inputs: string[]; output: string;
  }): Promise<SkillRow> {
    return this.db.one<SkillRow>(
      `INSERT INTO ai_skills (tenant_id, owner_id, name, description, when_to_use, steps, inputs, output, visibility)
       VALUES ($1, NULL, $2, $3, $4, $5::jsonb, $6::jsonb, $7, 'company')
       ON CONFLICT DO NOTHING RETURNING *`,
      [i.tenantId, i.name, i.description, i.whenToUse, JSON.stringify(i.steps), JSON.stringify(i.inputs), i.output],
    ) as Promise<SkillRow>;
  }

  skill(tenantId: string, userId: string, id: string): Promise<SkillRow | null> {
    return this.db.one<SkillRow>(
      `SELECT * FROM ai_skills
        WHERE tenant_id=$1 AND id=$3 AND (visibility='company' OR owner_id=$2)`,
      [tenantId, userId, id],
    );
  }

  createSkill(i: {
    tenantId: string; ownerId: string; name: string; description: string; whenToUse: string;
    steps: string[]; inputs: string[]; output: string; visibility: string;
  }): Promise<SkillRow> {
    return this.db.one<SkillRow>(
      `INSERT INTO ai_skills (tenant_id, owner_id, name, description, when_to_use, steps, inputs, output, visibility)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9) RETURNING *`,
      [i.tenantId, i.ownerId, i.name, i.description, i.whenToUse,
        JSON.stringify(i.steps), JSON.stringify(i.inputs), i.output, i.visibility],
    ) as Promise<SkillRow>;
  }

  /** Править можно только свой навык: общие меняет тот, кто их завёл. */
  updateSkill(tenantId: string, userId: string, id: string, p: {
    name?: string | null; description?: string | null; whenToUse?: string | null;
    steps?: string[] | null; output?: string | null; visibility?: string | null; status?: string | null;
  }): Promise<SkillRow | null> {
    return this.db.one<SkillRow>(
      `UPDATE ai_skills
          SET name        = COALESCE($4, name),
              description = COALESCE($5, description),
              when_to_use = COALESCE($6, when_to_use),
              steps       = COALESCE($7::jsonb, steps),
              output      = COALESCE($8, output),
              visibility  = COALESCE($9, visibility),
              status      = COALESCE($10, status),
              version     = version + 1,
              updated_at  = now()
        WHERE tenant_id=$1 AND owner_id=$2 AND id=$3 RETURNING *`,
      [tenantId, userId, id, p.name ?? null, p.description ?? null, p.whenToUse ?? null,
        p.steps ? JSON.stringify(p.steps) : null, p.output ?? null, p.visibility ?? null, p.status ?? null],
    );
  }

  async deleteSkill(tenantId: string, userId: string, id: string): Promise<boolean> {
    const r = await this.db.query(`DELETE FROM ai_skills WHERE tenant_id=$1 AND owner_id=$2 AND id=$3`, [tenantId, userId, id]);
    return (r.rowCount ?? 0) > 0;
  }

  async skillUsed(id: string): Promise<void> {
    await this.db.query(`UPDATE ai_skills SET uses = uses + 1 WHERE id=$1`, [id]);
  }

  // ── оценки ──
  async feedback(i: { tenantId: string; messageId: string; userId: string; vote: 1 | -1; reason?: string | null; comment?: string | null }): Promise<void> {
    await this.db.query(
      `INSERT INTO ai_feedback (tenant_id, message_id, user_id, vote, reason, comment) VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (message_id, user_id) DO UPDATE SET vote=EXCLUDED.vote, reason=EXCLUDED.reason, comment=EXCLUDED.comment, created_at=now()`,
      [i.tenantId, i.messageId, i.userId, i.vote, i.reason ?? null, i.comment ?? null],
    );
  }

  messageOwner(tenantId: string, messageId: string): Promise<{ user_id: string } | null> {
    return this.db.one<{ user_id: string }>(
      `SELECT s.user_id FROM ai_messages m JOIN ai_sessions s ON s.id = m.session_id WHERE m.tenant_id=$1 AND m.id=$2`,
      [tenantId, messageId],
    );
  }

  // ── чтение данных CRM для инструментов (только там, где нет готового сервиса) ──

  /** Условие доступа к чату — то же, что в списке чатов: участник или чат проекта. */
  private static readonly CHAT_SCOPE = `(c.kind = 'project' OR EXISTS (SELECT 1 FROM chat_members m WHERE m.chat_id = c.id AND m.user_id = $2))`;

  chatRecent(tenantId: string, userId: string, chatId: string, limit = 40) {
    return this.db.many<{ id: string; author: string | null; body: string; created_at: Date; is_ai: boolean }>(
      `SELECT m.id, u.full_name AS author, m.body, m.created_at, m.is_ai
         FROM chat_messages m JOIN chats c ON c.id = m.chat_id LEFT JOIN users u ON u.id = m.author_id
        WHERE m.tenant_id=$1 AND m.chat_id=$3 AND m.deleted_at IS NULL AND ${AnthillRepository.CHAT_SCOPE}
        ORDER BY m.id DESC LIMIT $4`,
      [tenantId, userId, chatId, limit],
    ).then((r) => r.reverse());
  }

  chatTitle(tenantId: string, userId: string, chatId: string) {
    return this.db.one<{ id: string; kind: string; title: string | null }>(
      `SELECT c.id, c.kind,
              COALESCE(p.name, c.title, (SELECT u2.full_name FROM chat_members m2 JOIN users u2 ON u2.id = m2.user_id
                                          WHERE m2.chat_id = c.id AND m2.user_id <> $2 AND c.kind='dm' LIMIT 1)) AS title
         FROM chats c LEFT JOIN projects p ON p.id = c.project_id
        WHERE c.tenant_id=$1 AND c.id=$3 AND ${AnthillRepository.CHAT_SCOPE}`,
      [tenantId, userId, chatId],
    );
  }

  /** Задача целиком для «объясни, что от меня требуется»: описание, чек-лист, последние реплики. */
  taskFull(tenantId: string, taskId: string) {
    return this.db.one<{
      id: string; title: string; description: string | null; status: string; closed_at: Date | null;
      deadline_at: Date | null; priority: string | null; project_id: string; project_name: string;
      assignee: string | null; assignee_id: string | null; manager: string | null;
      checklist: { text: string; done: boolean }[];
      comments: { author: string | null; body: string; at: Date }[];
    }>(
      `SELECT t.id, t.title, t.description, bc.name AS status, t.closed_at, t.deadline_at, t.priority,
              t.project_id, p.name AS project_name, a.full_name AS assignee, t.assignee_id, mg.full_name AS manager,
              COALESCE((SELECT json_agg(json_build_object('text', ci.text, 'done', ci.is_done) ORDER BY ci.position)
                          FROM task_checklist_items ci WHERE ci.task_id = t.id), '[]'::json) AS checklist,
              COALESCE((SELECT json_agg(x) FROM (
                          SELECT u.full_name AS author, c.body, c.created_at AS at
                            FROM task_comments c LEFT JOIN users u ON u.id = c.author_id
                           WHERE c.task_id = t.id ORDER BY c.id DESC LIMIT 12) x), '[]'::json) AS comments
         FROM tasks t
         JOIN board_columns bc ON bc.id = t.column_id
         JOIN projects p ON p.id = t.project_id
    LEFT JOIN users a ON a.id = t.assignee_id
    LEFT JOIN users mg ON mg.id = t.created_by
        WHERE t.tenant_id=$1 AND t.id=$2`,
      [tenantId, taskId],
    );
  }

  project(tenantId: string, projectId: string) {
    return this.db.one<{ id: string; name: string; status: string; owner: string | null; client: string | null; open_tasks: number; overdue: number }>(
      `SELECT p.id, p.name, p.status, ow.full_name AS owner, cl.name AS client,
              (SELECT COUNT(*)::int FROM tasks t WHERE t.project_id = p.id AND t.closed_at IS NULL) AS open_tasks,
              (SELECT COUNT(*)::int FROM tasks t WHERE t.project_id = p.id AND t.closed_at IS NULL AND t.deadline_at < now()) AS overdue
         FROM projects p LEFT JOIN users ow ON ow.id = p.owner_user_id LEFT JOIN clients cl ON cl.id = p.client_id
        WHERE p.tenant_id=$1 AND p.id=$2`,
      [tenantId, projectId],
    );
  }

  projectByName(tenantId: string, name: string) {
    return this.db.one<{ id: string; name: string }>(
      `SELECT id, name FROM projects WHERE tenant_id=$1 AND status <> 'archived' AND lower(name) LIKE lower($2) ORDER BY length(name) LIMIT 1`,
      [tenantId, `%${name}%`],
    );
  }

  projectTasks(tenantId: string, projectId: string, limit = 30) {
    return this.db.many<{ id: string; title: string; status: string; assignee: string | null; deadline_at: Date | null }>(
      `SELECT t.id, t.title, bc.name AS status, a.full_name AS assignee, t.deadline_at
         FROM tasks t JOIN board_columns bc ON bc.id = t.column_id LEFT JOIN users a ON a.id = t.assignee_id
        WHERE t.tenant_id=$1 AND t.project_id=$2 AND t.closed_at IS NULL
        ORDER BY t.deadline_at NULLS LAST, t.updated_at DESC LIMIT $3`,
      [tenantId, projectId, limit],
    );
  }

  meetings(tenantId: string, q: string | null, limit = 8) {
    return this.db.many<{ id: string; title: string; at: Date; status: string; summary: string | null; project_name: string | null }>(
      `SELECT m.id, m.title, COALESCE(m.happened_at, m.created_at) AS at, m.status, s.summary, p.name AS project_name
         FROM meetings m LEFT JOIN meeting_summaries s ON s.meeting_id = m.id LEFT JOIN projects p ON p.id = m.project_id
        WHERE m.tenant_id=$1 AND ($2::text IS NULL OR m.title ILIKE $2 OR p.name ILIKE $2 OR s.summary ILIKE $2)
        ORDER BY at DESC LIMIT $3`,
      [tenantId, q ? `%${q}%` : null, limit],
    );
  }

  meeting(tenantId: string, id: string) {
    return this.db.one<{ id: string; title: string; at: Date; status: string; summary: string | null; decisions: unknown; project_name: string | null;
      drafts: { title: string; status: string; task_id: string | null }[] }>(
      `SELECT m.id, m.title, COALESCE(m.happened_at, m.created_at) AS at, m.status, s.summary, s.decisions, p.name AS project_name,
              COALESCE((SELECT json_agg(json_build_object('title', d.title, 'status', d.status, 'task_id', d.task_id))
                          FROM meeting_task_drafts d WHERE d.meeting_id = m.id), '[]'::json) AS drafts
         FROM meetings m LEFT JOIN meeting_summaries s ON s.meeting_id = m.id LEFT JOIN projects p ON p.id = m.project_id
        WHERE m.tenant_id=$1 AND m.id=$2`,
      [tenantId, id],
    );
  }

  users(tenantId: string) {
    return this.db.many<{ id: string; full_name: string }>(
      `SELECT id, full_name FROM users WHERE tenant_id=$1 AND is_active ORDER BY full_name`, [tenantId],
    );
  }
}
