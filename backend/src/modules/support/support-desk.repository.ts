import { Injectable } from '@nestjs/common';
import { DbService } from '../../database/db.service';

export interface ConversationRow {
  id: string;
  tenant_id: string;
  user_id: string;
  status: string;
  priority: string;
  assigned_agent_id: string | null;
  subject: string;
  ai_session_id: string | null;
  /** `agent` — помощник говорит с клиентом; `copilot` — молчит и работает на специалиста. */
  ai_mode: string;
  intent: string | null;
  required_skill: string | null;
  ai_confidence: string | null;
  ai_summary: string | null;
  /** Записка специалисту: что уже пробовали, чтобы он не спрашивал заново. */
  handoff_note: string | null;
  escalated_reason: string | null;
  ai_first_response_at: Date | null;
  human_first_response_at: Date | null;
  resolved_at: Date | null;
  closed_at: Date | null;
  csat_score: number | null;
  csat_reason: string | null;
  reopens: number;
  created_at: Date;
  updated_at: Date;
}

export interface MessageRow {
  id: string;
  conversation_id: string;
  author_id: string | null;
  author_kind: string;
  body: string;
  file_id: string | null;
  file_name: string | null;
  content_type: string | null;
  size_bytes: string | null;
  author_name: string | null;
  created_at: Date;
  edited_at: Date | null;
}

/** Технический контекст обращения — ровно то, что видно на экране (ТЗ-8, разд. 15). */
export interface ContextInput {
  url?: string | null;
  route?: string | null;
  entityType?: string | null;
  entityId?: string | null;
  browser?: string | null;
  os?: string | null;
  appVersion?: string | null;
  buildId?: string | null;
  lastError?: string | null;
  requestId?: string | null;
  network?: string | null;
}

/**
 * Хранилище службы заботы.
 *
 * Разговор, его участники, сообщения, безопасный технический контекст и дежурные.
 * Всё, что можно было взять у уже работающих частей CRM (файлы, присутствие,
 * уведомления, ИИ), здесь не повторяется — см. specs/tz8-01-support.md.
 */
@Injectable()
export class SupportDeskRepository {
  constructor(private readonly db: DbService) {}

  // ── разговоры ──
  /**
   * Живой разговор человека.
   *
   * Он всегда один: открыть поддержку второй раз, пока первая проблема не закрыта, —
   * это то же обращение, а не новое. Иначе у специалиста два окна об одном и том же.
   */
  activeOf(tenantId: string, userId: string): Promise<ConversationRow | null> {
    return this.db.one<ConversationRow>(
      `SELECT * FROM support_conversations
        WHERE tenant_id=$1 AND user_id=$2 AND closed_at IS NULL
        ORDER BY created_at DESC LIMIT 1`,
      [tenantId, userId],
    );
  }

  byId(tenantId: string, id: string): Promise<ConversationRow | null> {
    return this.db.one<ConversationRow>(
      `SELECT * FROM support_conversations WHERE tenant_id=$1 AND id=$2`, [tenantId, id],
    );
  }

  /**
   * Разговор по номеру без привязки к организации.
   *
   * Нужен ровно для одного: служба заботы вендора отвечает КЛИЕНТАМ, а значит
   * работает в чужой организации. Права проверяются выше (только техотдел), здесь —
   * просто «в какой организации живёт это обращение».
   */
  byIdAny(id: string): Promise<ConversationRow | null> {
    return this.db.one<ConversationRow>(
      `SELECT * FROM support_conversations WHERE id=$1`, [id],
    );
  }

  create(tenantId: string, userId: string, subject: string): Promise<ConversationRow | null> {
    return this.db.one<ConversationRow>(
      `INSERT INTO support_conversations (tenant_id, user_id, subject, status)
       VALUES ($1,$2,$3,'new') RETURNING *`,
      [tenantId, userId, subject.slice(0, 200)],
    );
  }

  /** Мои прошлые разговоры — история «Моя поддержка» (разд. 22). */
  mine(tenantId: string, userId: string, limit = 30) {
    return this.db.many<ConversationRow & { agent_name: string | null; messages: number }>(
      `SELECT c.*, u.full_name AS agent_name,
              (SELECT COUNT(*)::int FROM support_messages m WHERE m.conversation_id = c.id) AS messages
         FROM support_conversations c
         LEFT JOIN users u ON u.id = c.assigned_agent_id
        WHERE c.tenant_id=$1 AND c.user_id=$2
        ORDER BY c.created_at DESC LIMIT $3`,
      [tenantId, userId, limit],
    );
  }

  /**
   * Очередь дежурного: кто ждёт и с чем.
   *
   * `tenantId = null` — очередь по ВСЕМ организациям: так её видит техотдел вендора.
   * Название организации идёт рядом с именем человека: без него специалист не
   * понимает, у кого именно сломалось.
   */
  queue(tenantId: string | null) {
    return this.db.many<ConversationRow & {
      user_name: string; agent_name: string | null; last_at: Date | null; tenant_name: string;
    }>(
      `SELECT c.*, u.full_name AS user_name, a.full_name AS agent_name, t.name AS tenant_name,
              (SELECT MAX(m.created_at) FROM support_messages m WHERE m.conversation_id = c.id) AS last_at
         FROM support_conversations c
         JOIN users u ON u.id = c.user_id
         JOIN tenants t ON t.id = c.tenant_id
         LEFT JOIN users a ON a.id = c.assigned_agent_id
        WHERE ($1::bigint IS NULL OR c.tenant_id = $1::bigint)
          AND c.closed_at IS NULL AND c.status <> 'ai'
        ORDER BY (c.status = 'waiting_agent') DESC, c.priority = 'critical' DESC, c.created_at`,
      [tenantId],
    );
  }

  setStatus(tenantId: string, id: string, status: string): Promise<ConversationRow | null> {
    return this.db.one<ConversationRow>(
      `UPDATE support_conversations SET status=$3, updated_at=now()
        WHERE tenant_id=$1 AND id=$2 RETURNING *`,
      [tenantId, id, status],
    );
  }

  assign(tenantId: string, id: string, agentId: string): Promise<ConversationRow | null> {
    return this.db.one<ConversationRow>(
      `UPDATE support_conversations
          SET assigned_agent_id=$3, status='in_progress', updated_at=now()
        WHERE tenant_id=$1 AND id=$2 RETURNING *`,
      [tenantId, id, agentId],
    );
  }

  /** Первый ответ фиксируем один раз: это и есть измеряемая величина SLA. */
  /** Первый ответ ЧЕЛОВЕКА: по нему считается скорость живой команды. */
  async markFirstResponse(tenantId: string, id: string): Promise<void> {
    await this.db.query(
      `UPDATE support_conversations
          SET human_first_response_at = COALESCE(human_first_response_at, now())
        WHERE tenant_id=$1 AND id=$2`,
      [tenantId, id],
    );
  }

  /**
   * Первый ответ ПОМОЩНИКА — отдельной отметкой.
   *
   * В одной колонке с человеческим ответом он маскировал скорость живой команды: бот
   * отвечает за секунды, и медиана переставала значить что-либо (02_ANTHILLBOT §16).
   */
  async markAiResponse(tenantId: string, id: string): Promise<void> {
    await this.db.query(
      `UPDATE support_conversations
          SET ai_first_response_at = COALESCE(ai_first_response_at, now())
        WHERE tenant_id=$1 AND id=$2`,
      [tenantId, id],
    );
  }

  /** Что помощник понял об обращении: тема, навык, срочность, суть. */
  async saveAiVerdict(
    tenantId: string, id: string,
    v: { confidence: string; intent: string | null; skill: string | null; priority: string; summary: string | null },
  ): Promise<void> {
    await this.db.query(
      `UPDATE support_conversations
          SET ai_confidence = $3,
              intent         = COALESCE($4, intent),
              required_skill = COALESCE($5, required_skill),
              ai_summary     = COALESCE($6, ai_summary),
              -- Срочность только повышаем: первое «критично» не должно теряться из-за
              -- спокойного уточняющего вопроса следом.
              priority = CASE
                WHEN $7 = 'critical' THEN 'critical'
                WHEN $7 = 'high' AND priority <> 'critical' THEN 'high'
                ELSE priority END,
              updated_at = now()
        WHERE tenant_id=$1 AND id=$2`,
      [tenantId, id, v.confidence, v.intent, v.skill, v.summary, v.priority],
    );
  }

  /** Кто теперь разговаривает с клиентом — помощник или специалист. */
  async setAiMode(tenantId: string, id: string, mode: 'agent' | 'copilot', reason?: string | null): Promise<void> {
    await this.db.query(
      `UPDATE support_conversations
          SET ai_mode = $3,
              escalated_reason = COALESCE($4, escalated_reason),
              updated_at = now()
        WHERE tenant_id=$1 AND id=$2`,
      [tenantId, id, mode, reason ?? null],
    );
  }

  async saveHandoffNote(tenantId: string, id: string, note: string): Promise<void> {
    await this.db.query(
      `UPDATE support_conversations SET handoff_note = $3 WHERE tenant_id=$1 AND id=$2`,
      [tenantId, id, note.slice(0, 4000)],
    );
  }

  resolve(tenantId: string, id: string): Promise<ConversationRow | null> {
    return this.db.one<ConversationRow>(
      `UPDATE support_conversations
          SET status='waiting_user', resolved_at=now(), updated_at=now()
        WHERE tenant_id=$1 AND id=$2 RETURNING *`,
      [tenantId, id],
    );
  }

  close(tenantId: string, id: string, score: number | null, reason: string | null): Promise<ConversationRow | null> {
    return this.db.one<ConversationRow>(
      `UPDATE support_conversations
          SET status='closed', closed_at=now(), csat_score=$3, csat_reason=$4, updated_at=now()
        WHERE tenant_id=$1 AND id=$2 RETURNING *`,
      [tenantId, id, score, reason],
    );
  }

  /** «Проблема снова появилась» (разд. 23): разговор оживает, счётчик растёт. */
  reopen(tenantId: string, id: string): Promise<ConversationRow | null> {
    return this.db.one<ConversationRow>(
      `UPDATE support_conversations
          SET status = CASE WHEN assigned_agent_id IS NULL THEN 'waiting_agent' ELSE 'in_progress' END,
              resolved_at = NULL, closed_at = NULL, reopens = reopens + 1, updated_at = now()
        WHERE tenant_id=$1 AND id=$2 RETURNING *`,
      [tenantId, id],
    );
  }

  async setAiSession(id: string, sessionId: string): Promise<void> {
    await this.db.query(`UPDATE support_conversations SET ai_session_id=$2 WHERE id=$1`, [id, sessionId]);
  }

  // ── сообщения ──
  addMessage(i: {
    tenantId: string; conversationId: string; authorId: string | null; kind: string;
    body: string; fileId?: string | null;
  }): Promise<MessageRow | null> {
    return this.db.one<MessageRow>(
      `INSERT INTO support_messages (tenant_id, conversation_id, author_id, author_kind, body, file_id)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [i.tenantId, i.conversationId, i.authorId, i.kind, i.body.slice(0, 8000), i.fileId ?? null],
    );
  }

  messages(conversationId: string) {
    return this.db.many<MessageRow>(
      `SELECT m.*, u.full_name AS author_name,
              f.file_name, f.content_type, f.size_bytes::text
         FROM support_messages m
         LEFT JOIN users u ON u.id = m.author_id
         LEFT JOIN files f ON f.id = m.file_id
        WHERE m.conversation_id=$1
        ORDER BY m.created_at`,
      [conversationId],
    );
  }

  /** Приложен ли файл к сообщению этого разговора: право на файл даёт только разговор. */
  async hasFile(conversationId: string, fileId: string): Promise<boolean> {
    const row = await this.db.one<{ id: string }>(
      `SELECT id::text FROM support_messages WHERE conversation_id=$1 AND file_id=$2 LIMIT 1`,
      [conversationId, fileId],
    );
    return !!row;
  }

  // ── участники ──
  /**
   * Добавить или вернуть участника.
   *
   * Роль обновляется намеренно: человек мог прийти специалистом, а потом остаться
   * инженером — в списке участников должно стоять то, кем он тут работает сейчас.
   * Единственное исключение — автор обращения: он остаётся автором, кем бы его ни
   * позвали, иначе разговор теряет хозяина (а закрывать его вправе только он).
   */
  async addParticipant(conversationId: string, userId: string, role: string): Promise<void> {
    await this.db.query(
      `INSERT INTO support_participants (conversation_id, user_id, role)
       VALUES ($1,$2,$3)
       ON CONFLICT (conversation_id, user_id) DO UPDATE
          SET left_at = NULL,
              role = CASE WHEN support_participants.role = 'user' THEN 'user' ELSE EXCLUDED.role END`,
      [conversationId, userId, role],
    );
  }

  participants(conversationId: string) {
    return this.db.many<{ user_id: string; role: string; full_name: string; joined_at: Date }>(
      `SELECT p.user_id::text, p.role, u.full_name, p.joined_at
         FROM support_participants p JOIN users u ON u.id = p.user_id
        WHERE p.conversation_id=$1 AND p.left_at IS NULL
        ORDER BY p.joined_at`,
      [conversationId],
    );
  }

  // ── контекст ──
  /**
   * Технический контекст.
   *
   * Пишем по одному разговору, перезаписывая: важно, где человек был в МОМЕНТ
   * обращения, а не вся его прогулка по системе.
   */
  async saveContext(conversationId: string, c: ContextInput): Promise<void> {
    await this.db.query(
      `INSERT INTO support_context
         (conversation_id, url, route, entity_type, entity_id, browser, os, app_version, build_id,
          last_error, request_id, network, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, now())
       ON CONFLICT (conversation_id) DO UPDATE SET
         url=EXCLUDED.url, route=EXCLUDED.route, entity_type=EXCLUDED.entity_type,
         entity_id=EXCLUDED.entity_id, browser=EXCLUDED.browser, os=EXCLUDED.os,
         app_version=EXCLUDED.app_version, build_id=EXCLUDED.build_id,
         last_error=EXCLUDED.last_error, request_id=EXCLUDED.request_id,
         network=EXCLUDED.network, updated_at=now()`,
      [
        conversationId, c.url ?? null, c.route ?? null, c.entityType ?? null, c.entityId ?? null,
        c.browser ?? null, c.os ?? null, c.appVersion ?? null, c.buildId ?? null,
        c.lastError ?? null, c.requestId ?? null, c.network ?? null,
      ],
    );
  }

  context(conversationId: string) {
    return this.db.one<Record<string, unknown>>(
      `SELECT * FROM support_context WHERE conversation_id=$1`, [conversationId],
    );
  }

  // ── действия с разрешения человека, известные проблемы, сбой (MVP 3) ──
  /** Предложенное действие: пока человек не разрешил, оно только предложение. */
  proposeAction(i: {
    conversationId: string; actorId: string; actorRole: string | null; action: string; entityType: string;
    entityId: string; preview: string; params: Record<string, unknown>; before: Record<string, unknown> | null;
  }) {
    return this.db.one<{ id: string }>(
      `INSERT INTO support_actions
         (conversation_id, actor_id, actor_role, action, entity_type, entity_id,
          preview, params_json, before_json, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'proposed') RETURNING id::text`,
      [
        i.conversationId, i.actorId, i.actorRole, i.action, i.entityType, i.entityId,
        i.preview.slice(0, 500), JSON.stringify(i.params), i.before ? JSON.stringify(i.before) : null,
      ],
    );
  }

  action(id: string) {
    return this.db.one<{
      id: string; conversation_id: string; actor_id: string | null; action: string;
      entity_type: string | null; entity_id: string | null; preview: string; status: string;
      params_json: Record<string, unknown> | null; before_json: Record<string, unknown> | null;
      approved_by_user: boolean;
    }>(
      `SELECT id::text, conversation_id::text, actor_id::text, action, entity_type, entity_id,
              preview, status, params_json, before_json, approved_by_user
         FROM support_actions WHERE id=$1`,
      [id],
    );
  }

  actions(conversationId: string) {
    return this.db.many<{
      id: string; action: string; preview: string; status: string; entity_type: string | null;
      entity_id: string | null; approved_by_user: boolean; created_at: Date; decided_at: Date | null;
    }>(
      `SELECT id::text, action, preview, status, entity_type, entity_id, approved_by_user,
              created_at, decided_at
         FROM support_actions WHERE conversation_id=$1 ORDER BY created_at`,
      [conversationId],
    );
  }

  /**
   * Решение человека по действию: сделано, отклонено или отменено.
   *
   * Адрес и устройство пишем здесь, а не при предложении: значим момент СОГЛАСИЯ —
   * именно его придётся однажды показывать, объясняя, почему в чужой задаче поменялся
   * срок.
   */
  async decideAction(
    id: string, status: string, approved: boolean, after: Record<string, unknown> | null,
    sign?: { ip?: string | null; userAgent?: string | null },
  ): Promise<void> {
    await this.db.query(
      `UPDATE support_actions
          SET status=$2, approved_by_user=$3, after_json=$4, decided_at=now(),
              approved_ip = COALESCE($5, approved_ip),
              approved_ua = COALESCE($6, approved_ua)
        WHERE id=$1`,
      [
        id, status, approved, after ? JSON.stringify(after) : null,
        sign?.ip ?? null, sign?.userAgent?.slice(0, 256) ?? null,
      ],
    );
  }

  // ── известные проблемы ──
  knownIssues(tenantId: string) {
    return this.db.many<{
      id: string; task_id: string; title: string; pattern: string; active: boolean; closed_at: Date | null;
    }>(
      `SELECT k.id::text, k.task_id::text, k.title, k.pattern, k.active, t.closed_at
         FROM support_known_issues k JOIN tasks t ON t.id = k.task_id
        WHERE k.tenant_id=$1
        ORDER BY k.active DESC, k.created_at DESC`,
      [tenantId],
    );
  }

  addKnownIssue(tenantId: string, taskId: string, title: string, pattern: string, by: string) {
    return this.db.one<{ id: string }>(
      `INSERT INTO support_known_issues (tenant_id, task_id, title, pattern, created_by)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (tenant_id, task_id) DO UPDATE
          SET title=EXCLUDED.title, pattern=EXCLUDED.pattern, active=TRUE
       RETURNING id::text`,
      [tenantId, taskId, title.slice(0, 200), pattern.slice(0, 500), by],
    );
  }

  async setKnownIssueActive(tenantId: string, id: string, active: boolean): Promise<void> {
    await this.db.query(
      `UPDATE support_known_issues SET active=$3 WHERE tenant_id=$1 AND id=$2`, [tenantId, id, active],
    );
  }

  // ── массовый сбой ──
  openIncident(tenantId: string) {
    return this.db.one<{ id: string; title: string; message: string; started_at: Date }>(
      `SELECT id::text, title, message, started_at FROM support_incidents
        WHERE tenant_id=$1 AND status='open' ORDER BY started_at DESC LIMIT 1`,
      [tenantId],
    );
  }

  createIncident(tenantId: string, title: string, message: string, by: string) {
    return this.db.one<{ id: string; title: string; message: string; started_at: Date }>(
      `INSERT INTO support_incidents (tenant_id, title, message, created_by)
       VALUES ($1,$2,$3,$4) RETURNING id::text, title, message, started_at`,
      [tenantId, title.slice(0, 200), message.slice(0, 4000), by],
    );
  }

  resolveIncident(tenantId: string, id: string) {
    return this.db.one<{ id: string; title: string }>(
      `UPDATE support_incidents SET status='resolved', resolved_at=now()
        WHERE tenant_id=$1 AND id=$2 AND status='open' RETURNING id::text, title`,
      [tenantId, id],
    );
  }

  /**
   * Кому рассказать о сбое: все, у кого сейчас открыт разговор.
   *
   * `tenantId = null` — по всем организациям: авария у вендора касается всех клиентов
   * сразу, а не той организации, из которой её заметили.
   */
  liveConversations(tenantId: string | null) {
    return this.db.many<{ id: string; tenant_id: string; user_id: string }>(
      `SELECT id::text, tenant_id::text, user_id::text FROM support_conversations
        WHERE ($1::bigint IS NULL OR tenant_id = $1::bigint) AND closed_at IS NULL`,
      [tenantId],
    );
  }

  // ── срочный доступ инженера (этап 1 коммерческой архитектуры) ──
  /**
   * Выдать инженеру доступ к обращению на срок.
   *
   * Повторная выдача продлевает: инженера зовут в разговор, а не «выписывают пропуск»,
   * и второе нажатие «Подключить инженера» должно означать «он всё ещё нужен».
   */
  grantEngineer(conversationId: string, engineerId: string, by: string, hours: number) {
    return this.db.one<{ id: string; expires_at: Date }>(
      `INSERT INTO support_engineer_grants (conversation_id, engineer_id, granted_by, expires_at)
       VALUES ($1, $2, $3, now() + ($4 || ' hours')::interval)
       RETURNING id::text, expires_at`,
      [conversationId, engineerId, by, String(hours)],
    );
  }

  /** Есть ли у инженера ЖИВОЙ доступ: не отозван и не истёк. */
  async hasLiveGrant(conversationId: string, engineerId: string): Promise<boolean> {
    const row = await this.db.one<{ id: string }>(
      `SELECT id::text FROM support_engineer_grants
        WHERE conversation_id=$1 AND engineer_id=$2
          AND revoked_at IS NULL AND expires_at > now()
        LIMIT 1`,
      [conversationId, engineerId],
    );
    return !!row;
  }

  /** Кому из инженеров открыт разговор — показывается специалисту в панели. */
  grantsOf(conversationId: string) {
    return this.db.many<{
      id: string; engineer_id: string; full_name: string; expires_at: Date; revoked_at: Date | null;
    }>(
      `SELECT g.id::text, g.engineer_id::text, u.full_name, g.expires_at, g.revoked_at
         FROM support_engineer_grants g JOIN users u ON u.id = g.engineer_id
        WHERE g.conversation_id=$1
        ORDER BY g.created_at DESC`,
      [conversationId],
    );
  }

  async revokeGrants(conversationId: string, engineerId: string, by: string): Promise<number> {
    const res = await this.db.query(
      `UPDATE support_engineer_grants SET revoked_at = now(), revoked_by = $3
        WHERE conversation_id=$1 AND engineer_id=$2 AND revoked_at IS NULL`,
      [conversationId, engineerId, by],
    );
    return res.rowCount ?? 0;
  }

  /**
   * Обращения, открытые инженеру сейчас.
   *
   * Это вся его видимость: общей очереди у инженера нет — он не первая линия
   * (01_ARCHITECTURE §3, 03_RBAC §3).
   */
  escalationsOf(engineerId: string) {
    return this.db.many<ConversationRow & {
      user_name: string; tenant_name: string; agent_name: string | null; expires_at: Date;
    }>(
      `SELECT c.*, u.full_name AS user_name, t.name AS tenant_name, a.full_name AS agent_name,
              g.expires_at
         FROM support_engineer_grants g
         JOIN support_conversations c ON c.id = g.conversation_id
         JOIN users u ON u.id = c.user_id
         JOIN tenants t ON t.id = c.tenant_id
         LEFT JOIN users a ON a.id = c.assigned_agent_id
        WHERE g.engineer_id=$1 AND g.revoked_at IS NULL AND g.expires_at > now()
        ORDER BY c.updated_at DESC`,
      [engineerId],
    );
  }

  // ── дежурные ──
  /**
   * Дежурные организации — ЗАПАСНОЙ путь, пока платформа не назначена.
   *
   * В обычной жизни на обращения отвечает техотдел вендора (platform_staff), и эта
   * таблица не используется. Руками её больше никто не заполняет: настройка службы
   * заботы клиенту не принадлежит.
   */
  agents(tenantId: string) {
    return this.db.many<{ user_id: string; full_name: string; skills: string[]; last_seen_at: Date | null; presence_status: string | null }>(
      `SELECT a.user_id::text, u.full_name, a.skills, u.last_seen_at, u.presence_status
         FROM support_agents a JOIN users u ON u.id = a.user_id
        WHERE a.tenant_id=$1 AND a.active AND u.is_active
        ORDER BY u.full_name`,
      [tenantId],
    );
  }

  /** Имя сотрудника: подставляется в системные строки разговора. */
  async userName(tenantId: string, userId: string): Promise<string | null> {
    const row = await this.db.one<{ full_name: string }>(
      `SELECT full_name FROM users WHERE tenant_id=$1 AND id=$2 AND is_active`, [tenantId, userId],
    );
    return row?.full_name ?? null;
  }

  /** То же, но про человека из другой организации: инженер вендора в чужом обращении. */
  async userNameAny(userId: string): Promise<string | null> {
    const row = await this.db.one<{ full_name: string }>(
      `SELECT full_name FROM users WHERE id=$1 AND is_active`, [userId],
    );
    return row?.full_name ?? null;
  }

  /** Владелец компании — дежурный по умолчанию, пока список пуст. */
  owner(tenantId: string) {
    return this.db.one<{ id: string; full_name: string }>(
      `SELECT u.id::text, u.full_name FROM users u
         JOIN roles r ON r.id = u.role_id
        WHERE u.tenant_id=$1 AND r.code='owner' AND u.is_active
        ORDER BY u.id LIMIT 1`,
      [tenantId],
    );
  }

  // ── баг из разговора, созвон, метрики (MVP 2) ──
  /** Связь разговора с заведённой задачей: обе стороны должны знать друг о друге. */
  async linkIssue(conversationId: string, taskId: string, issueType = 'bug'): Promise<void> {
    await this.db.query(
      `INSERT INTO support_issue_links (conversation_id, task_id, issue_type)
       VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
      [conversationId, taskId, issueType],
    );
  }

  issues(conversationId: string) {
    return this.db.many<{ task_id: string; issue_type: string; title: string; closed_at: Date | null; project_id: string }>(
      `SELECT l.task_id::text, l.issue_type, t.title, t.closed_at, t.project_id::text
         FROM support_issue_links l JOIN tasks t ON t.id = l.task_id
        WHERE l.conversation_id=$1
        ORDER BY l.created_at`,
      [conversationId],
    );
  }

  /** Разговоры, которые ждут этой задачи: по ним пойдёт весть о выпущенном исправлении. */
  conversationsOfTask(taskId: string) {
    return this.db.many<{ conversation_id: string; tenant_id: string; user_id: string }>(
      `SELECT l.conversation_id::text, c.tenant_id::text, c.user_id::text
         FROM support_issue_links l JOIN support_conversations c ON c.id = l.conversation_id
        WHERE l.task_id=$1`,
      [taskId],
    );
  }

  /** Созвон из разговора: якорь, по которому итог вернётся в поддержку. */
  startHuddle(conversationId: string, roomId: string, startedBy: string) {
    return this.db.one<{ id: string }>(
      `INSERT INTO support_huddles (conversation_id, room_id, started_by)
       VALUES ($1,$2,$3) RETURNING id::text`,
      [conversationId, roomId, startedBy],
    );
  }

  /** Какому разговору принадлежит комната созвона — спрашивается при обработке записи. */
  huddleByRoom(roomId: string) {
    return this.db.one<{ id: string; conversation_id: string; tenant_id: string }>(
      `SELECT h.id::text, h.conversation_id::text, c.tenant_id::text
         FROM support_huddles h JOIN support_conversations c ON c.id = h.conversation_id
        WHERE h.room_id=$1 AND h.ended_at IS NULL
        ORDER BY h.started_at DESC LIMIT 1`,
      [roomId],
    );
  }

  async finishHuddle(id: string, meetingId: string | null): Promise<void> {
    await this.db.query(
      `UPDATE support_huddles SET ended_at = now(), meeting_id = $2 WHERE id = $1`,
      [id, meetingId],
    );
  }

  /**
   * Метрики службы заботы (разд. 30).
   *
   * Одним запросом и за окно в 30 дней: руководителю нужна не история за всё время,
   * а ответ на вопрос «как мы работаем сейчас». Медиану считаем, а не среднее —
   * один ночной разговор не должен рисовать несуществующую картину.
   */
  dashboard(tenantId: string | null) {
    return this.db.one<{
      total: string; active: string; waiting: string; resolved: string;
      first_median: string | null; ai_median: string | null; resolution_median: string | null;
      escalated: string; escalated_unsure: string;
      csat_avg: string | null; csat_count: string; reopened: string; ai_only: string;
    }>(
      `WITH win AS (
         SELECT * FROM support_conversations
          WHERE ($1::bigint IS NULL OR tenant_id = $1::bigint)
            AND created_at > now() - interval '30 days'
       )
       SELECT COUNT(*)::text AS total,
              COUNT(*) FILTER (WHERE closed_at IS NULL)::text AS active,
              COUNT(*) FILTER (WHERE status = 'waiting_agent')::text AS waiting,
              COUNT(*) FILTER (WHERE closed_at IS NOT NULL)::text AS resolved,
              percentile_cont(0.5) WITHIN GROUP (
                ORDER BY EXTRACT(EPOCH FROM (human_first_response_at - created_at))
              ) FILTER (WHERE human_first_response_at IS NOT NULL)::text AS first_median,
              percentile_cont(0.5) WITHIN GROUP (
                ORDER BY EXTRACT(EPOCH FROM (ai_first_response_at - created_at))
              ) FILTER (WHERE ai_first_response_at IS NOT NULL)::text AS ai_median,
              -- Доля эскалаций: сколько разговоров помощник не закрыл сам.
              COUNT(*) FILTER (WHERE escalated_reason IS NOT NULL)::text AS escalated,
              COUNT(*) FILTER (WHERE escalated_reason = 'low_confidence')::text AS escalated_unsure,
              percentile_cont(0.5) WITHIN GROUP (
                ORDER BY EXTRACT(EPOCH FROM (closed_at - created_at))
              ) FILTER (WHERE closed_at IS NOT NULL)::text AS resolution_median,
              AVG(csat_score) FILTER (WHERE csat_score IS NOT NULL)::text AS csat_avg,
              COUNT(*) FILTER (WHERE csat_score IS NOT NULL)::text AS csat_count,
              COUNT(*) FILTER (WHERE reopens > 0)::text AS reopened,
              -- решено без человека: разговор закрыт, а специалист так и не понадобился
              COUNT(*) FILTER (WHERE closed_at IS NOT NULL AND assigned_agent_id IS NULL)::text AS ai_only
         FROM win`,
      [tenantId],
    );
  }

  /**
   * Честное время первого ответа (разд. 6).
   *
   * Медиана за две недели: среднее задирает один ночной разговор, а обещать по нему
   * нельзя — человек ждёт «двадцать секунд» и злится на третьей минуте.
   */
  async medianFirstResponse(tenantId: string | null): Promise<number | null> {
    const row = await this.db.one<{ sec: string | null }>(
      `SELECT percentile_cont(0.5) WITHIN GROUP (
                ORDER BY EXTRACT(EPOCH FROM (human_first_response_at - created_at))
              )::text AS sec
         FROM support_conversations
        WHERE ($1::bigint IS NULL OR tenant_id = $1::bigint)
          AND human_first_response_at IS NOT NULL
          AND created_at > now() - interval '14 days'`,
      [tenantId],
    );
    const sec = Number(row?.sec ?? NaN);
    return Number.isFinite(sec) && sec > 0 ? Math.round(sec) : null;
  }
}
