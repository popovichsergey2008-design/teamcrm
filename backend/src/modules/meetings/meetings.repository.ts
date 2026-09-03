import { Injectable } from '@nestjs/common';
import { DbService } from '../../database/db.service';
import { Reply } from './transcript.util';

export interface MeetingRow {
  id: string; tenant_id: string; project_id: string | null; title: string;
  happened_at: Date | null; source: string; file_id: string | null; duration_sec: number | null;
  status: string; error: string | null; created_by: string | null; created_at: Date;
}

export interface DraftRow {
  id: string; meeting_id: string; title: string; description: string | null;
  assignee_id: string | null; assignee_hint: string | null; project_id: string | null;
  project_hint: string | null; column_id: string | null; column_hint: string | null;
  author_id: string | null; author_hint: string | null;
  deadline_at: Date | null; quote: string | null; status: string; task_id: string | null;
}

@Injectable()
export class MeetingsRepository {
  constructor(private readonly db: DbService) {}

  create(i: {
    tenantId: string; projectId: string | null; title: string; happenedAt: string | null;
    source: string; fileId: string | null; createdBy: string | null;
    /** Чат, из которого начали созвон: туда после разбора придёт карточка с итогом. */
    chatId?: string | null;
  }) {
    return this.db.one<MeetingRow>(
      `INSERT INTO meetings (tenant_id, project_id, title, happened_at, source, file_id, created_by, chat_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [i.tenantId, i.projectId, i.title, i.happenedAt, i.source, i.fileId, i.createdBy, i.chatId ?? null],
    ) as Promise<MeetingRow>;
  }

  /**
   * Карточка итога в чат, из которого начали созвон.
   *
   * Пишем сообщением без автора (системная строка) — итог принадлежит разговору,
   * а не человеку. Тело остаётся человекочитаемым: в письмах и выгрузках карточек нет,
   * а `meeting_id` даёт интерфейсу развернуть его в сводку с кнопкой «Открыть разбор».
   */
  async postMeetingCard(tenantId: string, chatId: string, meetingId: string, body: string): Promise<string | null> {
    const row = await this.db.one<{ id: string }>(
      `INSERT INTO chat_messages (tenant_id, chat_id, author_id, body, meeting_id)
       VALUES ($1,$2,NULL,$3,$4) RETURNING id`,
      [tenantId, chatId, body.slice(0, 4000), meetingId],
    );
    await this.db.query(`UPDATE chats SET last_message_at=now() WHERE id=$1`, [chatId]);
    return row?.id ?? null;
  }

  /** Кому показать карточку: участники чата (у проектного — вся команда). */
  async chatAudience(tenantId: string, chatId: string): Promise<string[]> {
    const rows = await this.db.many<{ user_id: string }>(
      `SELECT m.user_id FROM chat_members m WHERE m.chat_id=$1
        UNION
       SELECT u.id::text FROM users u
        WHERE u.tenant_id=$2 AND EXISTS (SELECT 1 FROM chats c WHERE c.id=$1 AND c.kind='project')`,
      [chatId, tenantId],
    );
    return rows.map((r) => String(r.user_id));
  }

  get(tenantId: string, id: string) {
    return this.db.one<MeetingRow>(`SELECT * FROM meetings WHERE tenant_id=$1 AND id=$2`, [tenantId, id]);
  }

  list(tenantId: string) {
    return this.db.many<MeetingRow & { drafts_pending: number }>(
      `SELECT m.*, (SELECT count(*)::int FROM meeting_task_drafts d
                     WHERE d.meeting_id=m.id AND d.status='pending') AS drafts_pending
         FROM meetings m WHERE m.tenant_id=$1 ORDER BY m.created_at DESC LIMIT 100`,
      [tenantId],
    );
  }

  async setStatus(id: string, status: string, error: string | null = null): Promise<void> {
    await this.db.query(`UPDATE meetings SET status=$2, error=$3, updated_at=now() WHERE id=$1`, [id, status, error]);
  }
  async setDuration(id: string, seconds: number): Promise<void> {
    await this.db.query(`UPDATE meetings SET duration_sec=$2, updated_at=now() WHERE id=$1`, [id, seconds]);
  }

  /** Стенограмма пишется целиком: повторная обработка заменяет прежнюю, а не дописывает. */
  async replaceSegments(
    tenantId: string, meetingId: string,
    replies: (Reply & { speakerUserId?: string | null })[],
  ): Promise<void> {
    await this.db.withTransaction(async (c) => {
      await c.query(`DELETE FROM meeting_segments WHERE meeting_id=$1`, [meetingId]);
      for (const [idx, r] of replies.entries()) {
        await c.query(
          `INSERT INTO meeting_segments (tenant_id, meeting_id, idx, start_sec, end_sec, speaker, speaker_user_id, text)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [tenantId, meetingId, idx, r.start.toFixed(2), r.end.toFixed(2), r.speaker, r.speakerUserId ?? null, r.text],
        );
      }
    });
  }

  segments(tenantId: string, meetingId: string) {
    return this.db.many<{ idx: number; start_sec: string; end_sec: string | null; speaker: string | null; text: string }>(
      `SELECT idx, start_sec, end_sec, speaker, text FROM meeting_segments
        WHERE tenant_id=$1 AND meeting_id=$2 ORDER BY idx`,
      [tenantId, meetingId],
    );
  }

  async saveSummary(tenantId: string, meetingId: string, summary: string, decisions: string[], risks: string[]): Promise<void> {
    await this.db.query(
      `INSERT INTO meeting_summaries (meeting_id, tenant_id, summary, decisions, risks)
       VALUES ($1,$2,$3,$4::jsonb,$5::jsonb)
       ON CONFLICT (meeting_id) DO UPDATE SET summary=EXCLUDED.summary, decisions=EXCLUDED.decisions, risks=EXCLUDED.risks`,
      [meetingId, tenantId, summary, JSON.stringify(decisions), JSON.stringify(risks)],
    );
  }

  summary(tenantId: string, meetingId: string) {
    return this.db.one<{ summary: string; decisions: string[]; risks: string[] }>(
      `SELECT summary, decisions, risks FROM meeting_summaries WHERE tenant_id=$1 AND meeting_id=$2`,
      [tenantId, meetingId],
    );
  }

  /** Черновики пересоздаются при повторном разборе — но уже применённые не трогаем. */
  async replaceDrafts(tenantId: string, meetingId: string, drafts: {
    title: string; description: string | null; assigneeId: string | null; assigneeHint: string | null;
    projectId: string | null; projectHint: string | null;
    columnId: string | null; columnHint: string | null;
    authorId: string | null; authorHint: string | null;
    deadlineAt: string | null; quote: string | null;
  }[]): Promise<void> {
    await this.db.withTransaction(async (c) => {
      await c.query(`DELETE FROM meeting_task_drafts WHERE meeting_id=$1 AND status='pending'`, [meetingId]);
      for (const d of drafts) {
        await c.query(
          `INSERT INTO meeting_task_drafts
             (tenant_id, meeting_id, title, description, assignee_id, assignee_hint,
              project_id, project_hint, column_id, column_hint, author_id, author_hint, deadline_at, quote)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
          [tenantId, meetingId, d.title, d.description, d.assigneeId, d.assigneeHint,
            d.projectId, d.projectHint, d.columnId, d.columnHint, d.authorId, d.authorHint, d.deadlineAt, d.quote],
        );
      }
    });
  }

  /** Проекты арендатора вместе с колонками — контекст для разбора встречи. */
  projectsWithColumns(tenantId: string) {
    return this.db.many<{ id: string; name: string; columns: { id: string; name: string }[] }>(
      `SELECT p.id, p.name,
              COALESCE(json_agg(json_build_object('id', c.id, 'name', c.name) ORDER BY c.position)
                       FILTER (WHERE c.id IS NOT NULL), '[]') AS columns
         FROM projects p
    LEFT JOIN board_columns c ON c.project_id = p.id
        WHERE p.tenant_id = $1 AND p.status <> 'archived'
        GROUP BY p.id, p.name
        ORDER BY p.name`,
      [tenantId],
    );
  }

  drafts(tenantId: string, meetingId: string) {
    return this.db.many<DraftRow>(
      `SELECT * FROM meeting_task_drafts WHERE tenant_id=$1 AND meeting_id=$2 ORDER BY id`,
      [tenantId, meetingId],
    );
  }

  /**
   * Судьба созданных по встрече задач: жива ли, кто делает, где стоит.
   *
   * LEFT JOIN, а не INNER: задачу могли удалить, и Summary не должен вести человека
   * на несуществующую страницу — «задача удалена» честнее пустой ссылки.
   */
  linkedTasks(tenantId: string, meetingId: string) {
    return this.db.many<{
      draft_id: string; task_id: string; title: string | null; project_id: string | null;
      column_name: string | null; closed: boolean; assignee_name: string | null; manager_name: string | null;
    }>(
      `SELECT d.id::text AS draft_id, d.task_id::text AS task_id,
              t.title, t.project_id::text AS project_id, c.name AS column_name,
              (t.closed_at IS NOT NULL) AS closed,
              ua.full_name AS assignee_name, um.full_name AS manager_name
         FROM meeting_task_drafts d
    LEFT JOIN tasks t ON t.id = d.task_id AND t.tenant_id = d.tenant_id
    LEFT JOIN board_columns c ON c.id = t.column_id
    LEFT JOIN users ua ON ua.id = t.assignee_id
    LEFT JOIN users um ON um.id = t.created_by
        WHERE d.tenant_id = $1 AND d.meeting_id = $2 AND d.task_id IS NOT NULL
        ORDER BY d.id`,
      [tenantId, meetingId],
    );
  }

  /**
   * Из какой встречи выросла задача — обратная ссылка в карточке.
   *
   * Через ту же таблицу черновиков: отдельного поля у задачи нет и не нужно, связь
   * уже есть, ей просто никто не пользовался.
   */
  meetingOfTask(tenantId: string, taskId: string) {
    return this.db.one<{ meeting_id: string; title: string | null; happened_at: Date | null }>(
      `SELECT m.id::text AS meeting_id, m.title, m.happened_at
         FROM meeting_task_drafts d
         JOIN meetings m ON m.id = d.meeting_id
        WHERE d.tenant_id = $1 AND d.task_id = $2
        ORDER BY d.id LIMIT 1`,
      [tenantId, taskId],
    );
  }

  draft(tenantId: string, id: string) {
    return this.db.one<DraftRow>(`SELECT * FROM meeting_task_drafts WHERE tenant_id=$1 AND id=$2`, [tenantId, id]);
  }

  /**
   * Правка черновика ДО создания задачи.
   *
   * Пишем в базу, а не держим в форме: человек проверяет список после встречи не за
   * один присест — уходит уточнить, возвращается, обновляет страницу. Потерянные
   * правки здесь означают «проще создать задачу и переписать её потом», то есть ровно
   * ту работу, которую разбор встречи и должен был снять.
   *
   * Пустая строка — это осознанно стёртое описание, поэтому `undefined` (поле не
   * трогали) и `null`/'' (очистили) различаются.
   */
  async updateDraft(tenantId: string, id: string, patch: {
    title?: string; description?: string | null; assigneeId?: string | null; projectId?: string | null;
  }): Promise<DraftRow | null> {
    return this.db.one<DraftRow>(
      `UPDATE meeting_task_drafts
          SET title = COALESCE($3, title),
              description = CASE WHEN $4::text IS NULL THEN description ELSE NULLIF($4::text, '') END,
              assignee_id = CASE WHEN $5::text IS NULL THEN assignee_id ELSE NULLIF($5::text, '')::bigint END,
              project_id = CASE WHEN $6::text IS NULL THEN project_id ELSE NULLIF($6::text, '')::bigint END
        WHERE tenant_id=$1 AND id=$2 AND status='pending'
        RETURNING *`,
      [
        tenantId, id,
        patch.title ?? null,
        patch.description === undefined ? null : String(patch.description ?? ''),
        patch.assigneeId === undefined ? null : String(patch.assigneeId ?? ''),
        patch.projectId === undefined ? null : String(patch.projectId ?? ''),
      ],
    );
  }

  async markDraftApplied(id: string, taskId: string): Promise<void> {
    await this.db.query(`UPDATE meeting_task_drafts SET status='applied', task_id=$2 WHERE id=$1`, [id, taskId]);
  }
  /** Вернуть отклонённый черновик в ожидание — путь назад для уборки. */
  async restoreDraft(id: string): Promise<void> {
    await this.db.query(`UPDATE meeting_task_drafts SET status='pending' WHERE id=$1 AND task_id IS NULL`, [id]);
  }

  async markDraftRejected(id: string): Promise<void> {
    await this.db.query(`UPDATE meeting_task_drafts SET status='rejected' WHERE id=$1`, [id]);
  }

  /** Сотрудники организации — для сопоставления имени, прозвучавшего на встрече. */
  teamMembers(tenantId: string) {
    return this.db.many<{ id: string; full_name: string; email: string | null }>(
      `SELECT id, full_name, email FROM users WHERE tenant_id=$1 AND is_active=TRUE`, [tenantId]);
  }

  // ---------- модератор встреч ----------

  /**
   * Из какого события календаря вырос созвон.
   *
   * Ищем по комнате: кнопка «Начать созвон» в событии ведёт именно в неё. Берём
   * ближайшее по времени событие с этой комнатой — комнату могут переиспользовать
   * из недели в неделю, и привязаться к прошлогодней планёрке было бы неверно.
   */
  eventByRoom(tenantId: string, roomId: string) {
    return this.db.one<{ id: string }>(
      `SELECT id FROM calendar_events
        WHERE tenant_id = $1 AND meet_room_id = $2
        ORDER BY abs(EXTRACT(EPOCH FROM (starts_at - now())))
        LIMIT 1`,
      [tenantId, roomId],
    );
  }

  async linkEvent(meetingId: string, eventId: string): Promise<void> {
    await this.db.query(`UPDATE meetings SET event_id=$2 WHERE id=$1`, [meetingId, eventId]);
  }

  /**
   * Кому рассылать итог: те, кто говорил на встрече, автор разбора и приглашённые
   * на событие. Молчавший участник — тоже участник, поэтому одних говоривших мало.
   */
  audience(tenantId: string, meetingId: string): Promise<{ user_id: string }[]> {
    return this.db.many<{ user_id: string }>(
      `SELECT DISTINCT u.id AS user_id
         FROM users u
        WHERE u.tenant_id = $1 AND u.is_active
          AND (
            u.id IN (SELECT s.speaker_user_id FROM meeting_segments s
                      WHERE s.meeting_id = $2 AND s.speaker_user_id IS NOT NULL)
            OR u.id = (SELECT m.created_by FROM meetings m WHERE m.id = $2)
            OR u.id IN (SELECT p.user_id FROM calendar_participants p
                         JOIN meetings m ON m.event_id = p.event_id
                        WHERE m.id = $2 AND p.status <> 'declined')
          )`,
      [tenantId, meetingId],
    );
  }

  /** Настройки компании, от которых зависит разбор: автосоздание и режим ассистента. */
  async meetingSettings(tenantId: string): Promise<{ autoTasks: boolean; mode: string }> {
    const row = await this.db.one<{ meeting_auto_tasks: boolean; assistant_mode: string }>(
      `SELECT meeting_auto_tasks, assistant_mode FROM tenants WHERE id = $1`, [tenantId],
    );
    return { autoTasks: row?.meeting_auto_tasks !== false, mode: row?.assistant_mode ?? 'copilot' };
  }

  async setAutoTasks(tenantId: string, enabled: boolean): Promise<boolean> {
    await this.db.query(`UPDATE tenants SET meeting_auto_tasks = $2 WHERE id = $1`, [tenantId, enabled]);
    return enabled;
  }
}
