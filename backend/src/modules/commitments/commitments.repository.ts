import { Injectable } from '@nestjs/common';
import { DbService } from '../../database/db.service';

export interface CommitmentRow {
  id: string;
  tenant_id: string;
  source_type: 'chat' | 'task' | 'meeting';
  source_id: string;
  source_message_ids: string[];
  source_at: Date;
  source_offset_sec: string | null;
  quote: string;
  speaker_user_id: string;
  assigner_user_id: string | null;
  project_id: string | null;
  action_text: string;
  normalized_action: string;
  deadline_at: Date | null;
  deadline_text: string | null;
  confidence: string;
  status: string;
  linked_task_id: string | null;
  check_at: Date;
  reminded_at: Date | null;
  remind_count: number;
  escalated_at: Date | null;
  speaker_name?: string;
  assigner_name?: string | null;
  source_title?: string | null;
}

/** Сообщение-кандидат: автор, его пояс, кому отвечал, где написано. */
export interface MessageRow {
  id: string;
  container_id: string;          // чат или задача
  author_id: string;
  body: string;
  has_file: boolean;
  created_at: Date;
  tz: string;
  reply_author_id: string | null;
  prev_author_id: string | null;
  project_id: string | null;
  kind: string | null;           // вид чата
  title: string | null;
}

@Injectable()
export class CommitmentsRepository {
  constructor(private readonly db: DbService) {}

  /** Организации с живой перепиской за двое суток — по ним и ходим. */
  activeTenants() {
    return this.db.many<{ id: string; timezone: string | null }>(
      `SELECT t.id, t.timezone FROM tenants t
        WHERE EXISTS (SELECT 1 FROM chat_messages m WHERE m.tenant_id = t.id AND m.created_at > now() - interval '2 days')
           OR EXISTS (SELECT 1 FROM task_comments c WHERE c.tenant_id = t.id AND c.created_at > now() - interval '2 days')
           OR EXISTS (SELECT 1 FROM meetings mt WHERE mt.tenant_id = t.id AND mt.updated_at > now() - interval '2 days')`,
    );
  }

  async cursor(tenantId: string, source: string): Promise<string> {
    const row = await this.db.one<{ last_id: string }>(`SELECT last_id FROM proactive_cursors WHERE tenant_id=$1 AND source=$2`, [tenantId, source]);
    return row ? String(row.last_id) : '';
  }

  async setCursor(tenantId: string, source: string, lastId: string): Promise<void> {
    await this.db.query(
      `INSERT INTO proactive_cursors (tenant_id, source, last_id) VALUES ($1,$2,$3)
       ON CONFLICT (tenant_id, source) DO UPDATE SET last_id = GREATEST(proactive_cursors.last_id, $3), updated_at = now()`,
      [tenantId, source, lastId],
    );
  }

  /** Самое свежее — чтобы при первом запуске не разбирать всю историю. */
  async maxId(tenantId: string, source: 'chat_messages' | 'task_comments' | 'meetings'): Promise<string> {
    const row = await this.db.one<{ m: string | null }>(`SELECT max(id)::text AS m FROM ${source} WHERE tenant_id=$1`, [tenantId]);
    return row?.m ?? '0';
  }

  /**
   * Новые сообщения чатов (все виды, включая личные — решение 11.10). Только люди: без
   * бота и гостей по ссылке. «Кому» — автор сообщения, на которое ответили, или предыдущий
   * автор в течение двух часов.
   */
  chatMessages(tenantId: string, afterId: string, limit = 500) {
    return this.db.many<MessageRow>(
      `SELECT m.id::text, m.chat_id::text AS container_id, m.author_id::text, m.body, (m.file_id IS NOT NULL) AS has_file,
              m.created_at, COALESCE(u.timezone, t.timezone, 'Europe/Moscow') AS tz,
              (SELECT r.author_id::text FROM chat_messages r WHERE r.id = m.reply_to_id) AS reply_author_id,
              (SELECT p.author_id::text FROM chat_messages p
                WHERE p.chat_id = m.chat_id AND p.id < m.id AND p.deleted_at IS NULL AND p.author_id IS NOT NULL AND NOT p.is_ai
                  AND p.created_at > m.created_at - interval '2 hours'
                ORDER BY p.id DESC LIMIT 1) AS prev_author_id,
              c.project_id::text, c.kind, c.title
         FROM chat_messages m
         JOIN chats c ON c.id = m.chat_id
         JOIN users u ON u.id = m.author_id
         JOIN tenants t ON t.id = m.tenant_id
        WHERE m.tenant_id = $1 AND m.id > $2::bigint AND m.deleted_at IS NULL AND NOT m.is_ai AND m.guest_name IS NULL
          AND m.created_at > now() - interval '3 days'
        ORDER BY m.id LIMIT $3`,
      [tenantId, afterId || '0', limit],
    );
  }

  /** Новые сообщения в обсуждениях задач. «Кому» — на чьё ответили, иначе постановщик. */
  taskComments(tenantId: string, afterId: string, limit = 500) {
    return this.db.many<MessageRow>(
      `SELECT c.id::text, c.task_id::text AS container_id, c.author_id::text, c.body, (c.file_id IS NOT NULL) AS has_file,
              c.created_at, COALESCE(u.timezone, tn.timezone, 'Europe/Moscow') AS tz,
              (SELECT r.author_id::text FROM task_comments r WHERE r.id = c.reply_to_id) AS reply_author_id,
              tk.created_by::text AS prev_author_id,
              tk.project_id::text, 'task' AS kind, tk.title
         FROM task_comments c
         JOIN tasks tk ON tk.id = c.task_id AND tk.deleted_at IS NULL
         JOIN users u ON u.id = c.author_id
         JOIN tenants tn ON tn.id = c.tenant_id
        WHERE c.tenant_id = $1 AND c.id > $2::bigint AND NOT c.is_ai AND NOT COALESCE(c.is_system, FALSE) AND c.author_id IS NOT NULL
          AND c.created_at > now() - interval '3 days'
        ORDER BY c.id LIMIT $3`,
      [tenantId, afterId || '0', limit],
    );
  }

  /** Разобранные встречи после курсора — с репликами, где известен говорящий. */
  meetingsDone(tenantId: string, afterId: string) {
    return this.db.many<{ id: string; title: string | null; project_id: string | null; created_by: string | null; at: Date }>(
      `SELECT id::text, title, project_id::text, created_by::text, COALESCE(happened_at, created_at) AS at
         FROM meetings WHERE tenant_id=$1 AND id > $2::bigint AND status = 'done' ORDER BY id LIMIT 50`,
      [tenantId, afterId || '0'],
    );
  }

  segments(meetingId: string) {
    return this.db.many<{ idx: number; start_sec: string; speaker_user_id: string; text: string; tz: string }>(
      `SELECT s.idx, s.start_sec, s.speaker_user_id::text, s.text, COALESCE(u.timezone, t.timezone, 'Europe/Moscow') AS tz
         FROM meeting_segments s JOIN users u ON u.id = s.speaker_user_id JOIN tenants t ON t.id = s.tenant_id
        WHERE s.meeting_id = $1 AND s.speaker_user_id IS NOT NULL ORDER BY s.idx`,
      [meetingId],
    );
  }

  /** Второй участник личного чата — «кому» обещали в личке. */
  async dmPeer(chatId: string, userId: string): Promise<string | null> {
    const row = await this.db.one<{ user_id: string }>(
      `SELECT cm.user_id::text FROM chat_members cm JOIN chats c ON c.id = cm.chat_id
        WHERE cm.chat_id=$1 AND c.kind='dm' AND cm.user_id <> $2::bigint LIMIT 1`,
      [chatId, userId],
    );
    return row?.user_id ?? null;
  }

  /**
   * Задача по этому обещанию уже есть (§20): создана из этого же сообщения, или на того же
   * человека с похожим названием за последнюю неделю. Похожесть решает вызывающий.
   */
  similarTasks(tenantId: string, assigneeId: string, messageId: string | null) {
    return this.db.many<{ id: string; title: string; closed: boolean; from_message: boolean }>(
      `SELECT id::text, title, (closed_at IS NOT NULL) AS closed,
              (source_chat_message_id IS NOT NULL AND source_chat_message_id = $3::bigint) AS from_message
         FROM tasks
        WHERE tenant_id=$1 AND deleted_at IS NULL
          AND ((assignee_id = $2::bigint AND created_at > now() - interval '7 days')
               OR ($3::bigint IS NOT NULL AND source_chat_message_id = $3::bigint))
        ORDER BY created_at DESC LIMIT 40`,
      [tenantId, assigneeId, messageId],
    );
  }

  async insert(c: {
    tenantId: string; sourceType: string; sourceId: string; messageIds: string[]; sourceAt: Date; offsetSec?: number | null;
    quote: string; speaker: string; assigner: string | null; projectId: string | null; action: string; normalized: string;
    deadlineAt: Date | null; deadlineText: string | null; confidence: number; status: string; linkedTaskId: string | null; checkAt: Date;
  }): Promise<string | null> {
    const row = await this.db.one<{ id: string }>(
      `INSERT INTO commitments (tenant_id, source_type, source_id, source_message_ids, source_at, source_offset_sec, quote,
                                speaker_user_id, assigner_user_id, project_id, action_text, normalized_action, deadline_at,
                                deadline_text, confidence, status, linked_task_id, check_at)
       VALUES ($1,$2,$3,$4::bigint[],$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
       ON CONFLICT (tenant_id, source_type, source_id, speaker_user_id, normalized_action) DO NOTHING RETURNING id::text`,
      [c.tenantId, c.sourceType, c.sourceId, c.messageIds, c.sourceAt, c.offsetSec ?? null, c.quote.slice(0, 1000), c.speaker,
        c.assigner, c.projectId, c.action.slice(0, 200), c.normalized.slice(0, 120), c.deadlineAt, c.deadlineText?.slice(0, 40) ?? null,
        c.confidence.toFixed(2), c.status, c.linkedTaskId, c.checkAt],
    );
    return row?.id ?? null;
  }

  /** Открытые обещания в этом разговоре — для «выполнил» / «отменили» по новым сообщениям. */
  openIn(tenantId: string, sourceType: string, sourceId: string) {
    return this.db.many<CommitmentRow>(
      `SELECT * FROM commitments WHERE tenant_id=$1 AND source_type=$2 AND source_id=$3
          AND status IN ('detected','tracked','needs_followup') AND source_at > now() - interval '30 days'`,
      [tenantId, sourceType, sourceId],
    );
  }

  /** Пора проверить (§21). */
  due(limit = 200) {
    return this.db.many<CommitmentRow>(
      `SELECT c.*, su.full_name AS speaker_name, au.full_name AS assigner_name,
              COALESCE(ch.title, tk.title, mt.title) AS source_title
         FROM commitments c
         JOIN users su ON su.id = c.speaker_user_id AND su.is_active
    LEFT JOIN users au ON au.id = c.assigner_user_id
    LEFT JOIN chats ch ON c.source_type = 'chat' AND ch.id = c.source_id
    LEFT JOIN tasks tk ON c.source_type = 'task' AND tk.id = c.source_id
    LEFT JOIN meetings mt ON c.source_type = 'meeting' AND mt.id = c.source_id
        WHERE c.status IN ('detected','tracked','needs_followup') AND c.check_at <= now()
        ORDER BY c.check_at LIMIT $1`,
      [limit],
    );
  }

  get(tenantId: string, id: string) {
    return this.db.one<CommitmentRow>(
      `SELECT c.*, su.full_name AS speaker_name, au.full_name AS assigner_name,
              COALESCE(ch.title, tk.title, mt.title) AS source_title
         FROM commitments c JOIN users su ON su.id = c.speaker_user_id
    LEFT JOIN users au ON au.id = c.assigner_user_id
    LEFT JOIN chats ch ON c.source_type = 'chat' AND ch.id = c.source_id
    LEFT JOIN tasks tk ON c.source_type = 'task' AND tk.id = c.source_id
    LEFT JOIN meetings mt ON c.source_type = 'meeting' AND mt.id = c.source_id
        WHERE c.tenant_id=$1 AND c.id=$2`,
      [tenantId, id],
    );
  }

  async taskClosed(taskId: string): Promise<boolean> {
    const row = await this.db.one<{ ok: boolean }>(`SELECT (closed_at IS NOT NULL) AS ok FROM tasks WHERE id=$1 AND deleted_at IS NULL`, [taskId]);
    return !!row?.ok;
  }

  async update(id: string, patch: Partial<{ status: string; linked_task_id: string | null; check_at: Date; reminded_at: Date; remind_count: number;
    escalated_at: Date; fulfilled_at: Date; fulfilled_by: string; cancelled_at: Date }>): Promise<void> {
    const keys = Object.keys(patch);
    if (!keys.length) return;
    const sets = keys.map((k, i) => `${k} = $${i + 2}`).join(', ');
    await this.db.query(`UPDATE commitments SET ${sets}, updated_at = now() WHERE id = $1`, [id, ...keys.map((k) => (patch as Record<string, unknown>)[k])]);
  }

  /** Обещания человека — для экрана «Обещания» (§10): мои и данные мне. */
  forUser(tenantId: string, userId: string) {
    return this.db.many<CommitmentRow>(
      `SELECT c.*, su.full_name AS speaker_name, au.full_name AS assigner_name,
              COALESCE(ch.title, tk.title, mt.title) AS source_title
         FROM commitments c JOIN users su ON su.id = c.speaker_user_id
    LEFT JOIN users au ON au.id = c.assigner_user_id
    LEFT JOIN chats ch ON c.source_type = 'chat' AND ch.id = c.source_id
    LEFT JOIN tasks tk ON c.source_type = 'task' AND tk.id = c.source_id
    LEFT JOIN meetings mt ON c.source_type = 'meeting' AND mt.id = c.source_id
        WHERE c.tenant_id=$1 AND (c.speaker_user_id=$2::bigint OR c.assigner_user_id=$2::bigint)
          AND (c.status IN ('detected','tracked','needs_followup') OR c.updated_at > now() - interval '7 days')
        ORDER BY (c.status IN ('detected','tracked','needs_followup')) DESC, COALESCE(c.deadline_at, c.check_at)
        LIMIT 100`,
      [tenantId, userId],
    );
  }

  /** Основной проект компании — куда ставить задачу по обещанию из личной переписки. */
  async defaultProject(tenantId: string): Promise<string | null> {
    const row = await this.db.one<{ id: string }>(
      `SELECT id::text FROM projects WHERE tenant_id=$1 AND COALESCE(status,'active') <> 'archived'
        ORDER BY is_default DESC, sort_order, created_at LIMIT 1`,
      [tenantId],
    );
    return row?.id ?? null;
  }
}
