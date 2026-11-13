import { Injectable } from '@nestjs/common';
import { DbService } from '../../database/db.service';
import { CONFIRM_REMIND_HOURS, AUTO_RETRY_DELAY_SEC } from './meeting-recap-rules';

export type CardKind = 'recap' | 'confirm' | 'error';

export interface CardRow {
  id: string | null; meeting_id: string; kind: CardKind; user_id: string | null;
  chat_id: string; chat_kind: string; message_id: string;
}

export interface ReminderRow { id: string; tenant_id: string; meeting_id: string; user_id: string; chat_id: string; title: string; left: number }

/** #4902, п. 10–11: карточки встречи в чатах, подтверждения задач, автоповтор и название. */
@Injectable()
export class MeetingRecapRepository {
  constructor(private readonly db: DbService) {}

  /**
   * Занять карточку: одна каждого вида на встречу (confirm — на человека). Второй
   * разбор, вторая выкладка и гонка двух процессов получат null и ничего не пошлют.
   */
  async claimCard(tenantId: string, meetingId: string, kind: CardKind, userId: string | null): Promise<string | null> {
    const row = await this.db.one<{ id: string }>(
      `INSERT INTO meeting_chat_cards (tenant_id, meeting_id, kind, user_id) VALUES ($1,$2,$3,$4)
       ON CONFLICT DO NOTHING RETURNING id::text`,
      [tenantId, meetingId, kind, userId],
    );
    return row?.id ?? null;
  }

  async setCardMessage(cardId: string, messageId: string): Promise<void> {
    await this.db.query(`UPDATE meeting_chat_cards SET message_id = $2 WHERE id = $1`, [cardId, messageId]);
  }

  /** Сообщение не ушло — освобождаем место, чтобы следующий проход попробовал снова. */
  async dropCard(cardId: string): Promise<void> {
    await this.db.query(`DELETE FROM meeting_chat_cards WHERE id = $1 AND message_id IS NULL`, [cardId]);
  }

  /**
   * Карточка по сообщению чата. Старые карточки итога (до #4902) лежат без строки
   * в meeting_chat_cards — для них это «итог», и они тоже разворачиваются по-новому.
   */
  cardByMessage(tenantId: string, messageId: string): Promise<CardRow | null> {
    return this.db.one<CardRow>(
      `SELECT k.id::text, cm.meeting_id::text, COALESCE(k.kind, 'recap') AS kind, k.user_id::text,
              cm.chat_id::text, c.kind AS chat_kind, cm.id::text AS message_id
         FROM chat_messages cm
         JOIN chats c ON c.id = cm.chat_id AND c.tenant_id = cm.tenant_id
         LEFT JOIN meeting_chat_cards k ON k.message_id = cm.id
        WHERE cm.tenant_id = $1 AND cm.id = $2 AND cm.meeting_id IS NOT NULL`,
      [tenantId, messageId],
    );
  }

  /** Человек видит чат: участник или проектный чат (его видит вся команда — как chatAudience). */
  async inChat(chatId: string, userId: string): Promise<boolean> {
    const row = await this.db.one<{ ok: boolean }>(
      `SELECT (EXISTS (SELECT 1 FROM chat_members WHERE chat_id = $1 AND user_id = $2)
            OR EXISTS (SELECT 1 FROM chats WHERE id = $1 AND kind = 'project')) AS ok`,
      [chatId, userId],
    );
    return !!row?.ok;
  }

  /** Чаты, где лежат карточки встречи: обновить их у всех, кто их видит. */
  cardChats(meetingId: string): Promise<{ chat_id: string }[]> {
    return this.db.many<{ chat_id: string }>(
      `SELECT DISTINCT cm.chat_id::text FROM meeting_chat_cards k JOIN chat_messages cm ON cm.id = k.message_id
        WHERE k.meeting_id = $1
        UNION
       SELECT DISTINCT chat_id::text FROM chat_messages WHERE meeting_id = $1`,
      [meetingId],
    );
  }

  async names(tenantId: string, ids: string[]): Promise<Map<string, string>> {
    if (!ids.length) return new Map();
    const rows = await this.db.many<{ id: string; full_name: string }>(
      `SELECT id::text, full_name FROM users WHERE tenant_id = $1 AND id::text = ANY($2::text[])`, [tenantId, ids],
    );
    return new Map(rows.map((r) => [String(r.id), r.full_name]));
  }

  async segmentsCount(meetingId: string): Promise<number> {
    const r = await this.db.one<{ n: number }>(`SELECT count(*)::int AS n FROM meeting_segments WHERE meeting_id = $1`, [meetingId]);
    return Number(r?.n ?? 0);
  }

  /**
   * ИИ-название — только поверх названия по умолчанию и только один раз: если человек
   * успел переименовать встречу, условие `title = $2` его правку не перетрёт.
   */
  async setAiTitle(meetingId: string, was: string, title: string): Promise<boolean> {
    const r = await this.db.query(
      `UPDATE meetings SET title = $3, title_ai = TRUE, updated_at = now()
        WHERE id = $1 AND title = $2 AND NOT title_ai`,
      [meetingId, was, title.slice(0, 255)],
    );
    return (r.rowCount ?? 0) > 0;
  }

  /** Старые встречи с «Созвон 11.11, 09:22» и готовыми итогами — переименовать задним числом. */
  untitled(limit: number): Promise<{ id: string; tenant_id: string }[]> {
    return this.db.many(
      `SELECT m.id::text, m.tenant_id::text FROM meetings m
        WHERE m.status = 'done' AND NOT m.title_ai AND m.title ~ '^Созвон [0-9]{1,2}\\.[0-9]{1,2}'
          AND m.created_at > now() - interval '60 days'
          AND EXISTS (SELECT 1 FROM meeting_summaries s WHERE s.meeting_id = m.id)
        ORDER BY m.id DESC LIMIT $1`,
      [limit],
    );
  }

  /**
   * Упавшая обработка: первый раз — назначить автоповтор и вернуть 'scheduled';
   * повтор уже был — 'exhausted' (тогда бот показывает ошибку с «Повторить»).
   */
  async scheduleRetry(meetingId: string): Promise<'scheduled' | 'pending' | 'exhausted'> {
    const row = await this.db.one<{ auto_retry_at: Date | null; auto_retried_at: Date | null }>(
      `SELECT auto_retry_at, auto_retried_at FROM meetings WHERE id = $1`, [meetingId],
    );
    if (!row) return 'exhausted';
    if (row.auto_retried_at) return 'exhausted';
    if (row.auto_retry_at) return 'pending';
    await this.db.query(
      `UPDATE meetings SET auto_retry_at = now() + make_interval(secs => $2) WHERE id = $1 AND auto_retry_at IS NULL`,
      [meetingId, AUTO_RETRY_DELAY_SEC],
    );
    return 'scheduled';
  }

  dueRetries(): Promise<{ id: string; tenant_id: string }[]> {
    return this.db.many(
      `SELECT id::text, tenant_id::text FROM meetings
        WHERE status = 'error' AND auto_retried_at IS NULL AND auto_retry_at IS NOT NULL AND auto_retry_at <= now()
        ORDER BY auto_retry_at LIMIT 10`,
    );
  }

  async claimRetry(meetingId: string): Promise<boolean> {
    const r = await this.db.query(
      `UPDATE meetings SET auto_retried_at = now() WHERE id = $1 AND auto_retried_at IS NULL`, [meetingId],
    );
    return (r.rowCount ?? 0) > 0;
  }

  /** Кому слать личный список: исполнители живых задач встречи (не отклонённых хозяином). */
  assignees(tenantId: string, meetingId: string): Promise<{ user_id: string }[]> {
    return this.db.many(
      `SELECT DISTINCT d.assignee_id::text AS user_id
         FROM meeting_task_drafts d JOIN users u ON u.id = d.assignee_id AND u.is_active
         JOIN roles r ON r.id = u.role_id AND r.code <> 'client'
        WHERE d.tenant_id = $1 AND d.meeting_id = $2 AND d.status <> 'rejected'`,
      [tenantId, meetingId],
    );
  }

  /** Мои задачи встречи — и те, от которых я отказался («не моё» снимает исполнителя). */
  myDrafts(tenantId: string, meetingId: string, userId: string) {
    return this.db.many<{
      id: string; title: string; assignee_id: string | null; deadline_at: Date | null; status: string;
      task_id: string | null; confirm_state: string | null; project_id: string | null; error_message: string | null;
    }>(
      `SELECT id::text, title, assignee_id::text, deadline_at, status, task_id::text, confirm_state, project_id::text, error_message
         FROM meeting_task_drafts
        WHERE tenant_id = $1 AND meeting_id = $2 AND status <> 'rejected'
          AND (assignee_id = $3 OR (confirm_state = 'declined' AND confirmed_by = $3))
        ORDER BY id`,
      [tenantId, meetingId, userId],
    );
  }

  /** «✓ беру» / «не моё». «Не моё» по ещё не созданной задаче снимает исполнителя — её переназначит хозяин. */
  async setConfirm(draftId: string, state: 'taken' | 'declined', userId: string): Promise<void> {
    await this.db.query(
      `UPDATE meeting_task_drafts
          SET confirm_state = $2::varchar, confirmed_at = now(), confirmed_by = $3,
              assignee_id = CASE WHEN $2::varchar = 'declined' AND task_id IS NULL THEN NULL ELSE assignee_id END
        WHERE id = $1`,
      [draftId, state, userId],
    );
  }

  /** Исполнителя поменяли руками — прежний ответ к новому человеку не относится. */
  async resetConfirm(draftId: string): Promise<void> {
    await this.db.query(
      `UPDATE meeting_task_drafts SET confirm_state = NULL, confirmed_at = NULL, confirmed_by = NULL WHERE id = $1`, [draftId],
    );
  }

  /**
   * Карточки подтверждения старше суток, где у человека остались неразобранные задачи:
   * одно напоминание на карточку. Старше недели — уже не напоминаем.
   */
  async dueReminders(): Promise<ReminderRow[]> {
    const rows = await this.db.many<ReminderRow>(
      `SELECT k.id::text, k.tenant_id::text, k.meeting_id::text, k.user_id::text, cm.chat_id::text, m.title,
              (SELECT count(*)::int FROM meeting_task_drafts d
                WHERE d.meeting_id = k.meeting_id AND d.assignee_id = k.user_id
                  AND d.status <> 'rejected' AND d.confirm_state IS NULL) AS left
         FROM meeting_chat_cards k
         JOIN chat_messages cm ON cm.id = k.message_id
         JOIN meetings m ON m.id = k.meeting_id
        WHERE k.kind = 'confirm' AND k.reminded_at IS NULL
          AND k.created_at < now() - make_interval(hours => $1)
          AND k.created_at > now() - interval '7 days'
        ORDER BY k.id LIMIT 50`,
      [CONFIRM_REMIND_HOURS],
    );
    return rows.filter((r) => Number(r.left) > 0);
  }

  async claimReminder(cardId: string): Promise<boolean> {
    const r = await this.db.query(`UPDATE meeting_chat_cards SET reminded_at = now() WHERE id = $1 AND reminded_at IS NULL`, [cardId]);
    return (r.rowCount ?? 0) > 0;
  }

  async retell(meetingId: string): Promise<{ retell_text: string | null; retell_file_id: string | null } | null> {
    return this.db.one(`SELECT retell_text, retell_file_id::text FROM meetings WHERE id = $1`, [meetingId]);
  }

  async saveRetell(meetingId: string, text: string, fileId: string | null): Promise<void> {
    await this.db.query(`UPDATE meetings SET retell_text = $2, retell_file_id = $3 WHERE id = $1`, [meetingId, text, fileId]);
  }

  /** Повторный разбор пересобрал итоги — старый пересказ больше не про эту встречу. */
  async clearRetell(meetingId: string): Promise<void> {
    await this.db.query(`UPDATE meetings SET retell_text = NULL, retell_file_id = NULL WHERE id = $1`, [meetingId]);
  }

  /** Владелец итогов: организатор события, иначе тот, кто начал созвон. */
  async ownerOf(meetingId: string): Promise<string | null> {
    const r = await this.db.one<{ owner: string | null }>(
      `SELECT COALESCE((SELECT owner_id::text FROM meeting_postcall_reviews WHERE meeting_id = m.id), m.created_by::text) AS owner
         FROM meetings m WHERE m.id = $1`,
      [meetingId],
    );
    return r?.owner ?? null;
  }
}
