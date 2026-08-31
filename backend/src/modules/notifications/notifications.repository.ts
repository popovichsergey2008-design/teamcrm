import { Injectable } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { DbService } from '../../database/db.service';
import { EventKey, OWN_EVENT_KEY } from './mail.templates';

export interface MailRow {
  id: string; tenant_id: string; user_id: string | null; to_email: string;
  subject: string; body_text: string; body_html: string | null;
  event_key: string; attempts: number;
  /** Когда дубль ушёл в Telegram: повтор письма не должен слать второе сообщение. */
  tg_sent_at: Date | null;
  /** Вложения письма: приглашение календаря возит с собой .ics. */
  attachments: { name: string; content: string }[] | null;
}

/** Кому и куда слать: адрес нужен внешний, отписка — по личному токену. */
export interface Recipient {
  id: string; email: string; full_name: string; unsubscribe_token: string;
}

@Injectable()
export class NotificationsRepository {
  constructor(private readonly db: DbService) {}

  /**
   * Получатели события по задаче: исполнитель и постановщик.
   *
   * Автор действия получает письмо наравне с остальными — так задача, поставленная
   * себе, тоже приходит на почту и работает напоминанием. Кому это лишнее, выключают
   * отдельным переключателем «письма о моих собственных действиях».
   * Отключившие вид письма отсеиваются здесь же, чтобы не готовить письмо зря.
   */
  async recipientsForTask(tenantId: string, taskId: string, eventKey: EventKey, actorId: string | null): Promise<Recipient[]> {
    return this.db.many<Recipient>(
      `SELECT DISTINCT u.id, u.email, u.full_name, u.unsubscribe_token
         FROM tasks t
         JOIN users u ON u.tenant_id = t.tenant_id AND u.id IN (t.assignee_id, t.created_by)
    LEFT JOIN notification_prefs p
           ON p.tenant_id = u.tenant_id AND p.user_id = u.id AND p.event_key = $3
    LEFT JOIN notification_prefs own
           ON own.tenant_id = u.tenant_id AND own.user_id = u.id AND own.event_key = $5
        WHERE t.tenant_id = $1 AND t.id = $2
          AND u.is_active = TRUE
          AND u.email IS NOT NULL
          AND COALESCE(p.enabled, TRUE)
          AND ($4::bigint IS NULL OR u.id <> $4::bigint OR COALESCE(own.enabled, TRUE))`,
      [tenantId, taskId, eventKey, actorId, OWN_EVENT_KEY],
    );
  }

  /** Имя того, кто совершил действие: в письме важно, кто именно, а не «система». */
  async actorName(tenantId: string, actorId: string | null): Promise<string> {
    if (!actorId) return 'TEAMCRM';
    const row = await this.db.one<{ full_name: string }>(
      `SELECT full_name FROM users WHERE tenant_id=$1 AND id=$2`, [tenantId, actorId]);
    return row?.full_name || 'Коллега';
  }

  /** Данные для письма: чем полнее сводка, тем реже приходится открывать задачу. */
  taskCard(tenantId: string, taskId: string) {
    return this.db.one<{
      title: string; project_id: string; project_name: string;
      column_name: string | null; assignee_name: string | null;
      priority: string | null; deadline_at: Date | null;
    }>(
      `SELECT t.title, t.project_id, p.name AS project_name,
              c.name AS column_name, a.full_name AS assignee_name,
              t.priority, t.deadline_at
         FROM tasks t
         JOIN projects p ON p.id = t.project_id
    LEFT JOIN board_columns c ON c.id = t.column_id
    LEFT JOIN users a ON a.id = t.assignee_id
        WHERE t.tenant_id = $1 AND t.id = $2`,
      [tenantId, taskId],
    );
  }

  /**
   * Один получатель по id — для адресных писем.
   *
   * Общий список получателей по задаче здесь не годится: соисполнителя и наблюдателя
   * в нём нет по определению, а письмо нужно именно им.
   */
  recipientById(tenantId: string, userId: string): Promise<Recipient | null> {
    return this.db.one<Recipient>(
      `SELECT id, email, full_name, unsubscribe_token
         FROM users
        WHERE tenant_id=$1 AND id=$2 AND is_active = TRUE AND email IS NOT NULL`,
      [tenantId, userId],
    );
  }

  /** Токен отписки создаём при первой надобности — старым сотрудникам его никто не выдавал. */
  async ensureUnsubscribeToken(userId: string, existing: string | null): Promise<string> {
    if (existing) return existing;
    const token = randomBytes(24).toString('hex');
    await this.db.query(
      `UPDATE users SET unsubscribe_token = $2 WHERE id = $1 AND unsubscribe_token IS NULL`,
      [userId, token],
    );
    const row = await this.db.one<{ unsubscribe_token: string }>(
      `SELECT unsubscribe_token FROM users WHERE id = $1`, [userId]);
    return row?.unsubscribe_token ?? token;
  }

  /**
   * Постановка письма в очередь. Повтор того же события тому же человеку
   * отбрасывается по ключу — вебхук или двойной клик не превратятся в два письма.
   */
  async enqueue(i: {
    tenantId: string; userId: string; toEmail: string; subject: string;
    text: string; html: string; eventKey: string; dedupKey: string;
  }): Promise<void> {
    await this.db.query(
      `INSERT INTO mail_outbox (tenant_id, user_id, to_email, subject, body_text, body_html, event_key, dedup_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (dedup_key) DO NOTHING`,
      [i.tenantId, i.userId, i.toEmail, i.subject.slice(0, 255), i.text, i.html, i.eventKey, i.dedupKey.slice(0, 160)],
    );
  }

  claim(limit: number): Promise<MailRow[]> {
    return this.db.many<MailRow>(
      `UPDATE mail_outbox m SET status='sending', attempts=attempts+1, updated_at=now()
        WHERE m.id IN (
          SELECT id FROM mail_outbox
           WHERE status='pending' AND next_attempt_at<=now()
           ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED)
        RETURNING m.*`,
      [limit],
    );
  }

  async done(id: string): Promise<void> {
    await this.db.query(
      `UPDATE mail_outbox SET status='done', last_error=NULL, sent_at=now(), updated_at=now() WHERE id=$1`, [id]);
  }

  async fail(id: string, error: string, retryInSec: number | null): Promise<void> {
    if (retryInSec === null) {
      await this.db.query(
        `UPDATE mail_outbox SET status='error', last_error=$2, updated_at=now() WHERE id=$1`, [id, error.slice(0, 500)]);
      return;
    }
    await this.db.query(
      `UPDATE mail_outbox SET status='pending', last_error=$2,
              next_attempt_at=now() + ($3 || ' seconds')::interval, updated_at=now()
        WHERE id=$1`,
      [id, error.slice(0, 500), String(retryInSec)],
    );
  }

  /** Дубль ушёл в мессенджер. Отмечаем отдельно от письма: каналы независимы. */
  async markTelegramSent(id: string): Promise<void> {
    await this.db.query(`UPDATE mail_outbox SET tg_sent_at=now() WHERE id=$1`, [id]);
  }

  /** Перезапуск на середине отправки: «в отправке» без ответа → снова в очередь. */
  async requeueStuck(): Promise<void> {
    await this.db.query(`UPDATE mail_outbox SET status='pending', updated_at=now() WHERE status='sending'`);
  }

  // ── настройки ──
  listPrefs(tenantId: string, userId: string) {
    return this.db.many<{ event_key: string; enabled: boolean }>(
      `SELECT event_key, enabled FROM notification_prefs WHERE tenant_id=$1 AND user_id=$2`,
      [tenantId, userId],
    );
  }

  /** Настройка включена? Строки нет — значит, действует умолчание «да». */
  async prefEnabled(tenantId: string, userId: string, eventKey: string): Promise<boolean> {
    const row = await this.db.one<{ enabled: boolean }>(
      `SELECT enabled FROM notification_prefs WHERE tenant_id=$1 AND user_id=$2 AND event_key=$3`,
      [tenantId, userId, eventKey],
    );
    return row?.enabled ?? true;
  }

  async setPref(tenantId: string, userId: string, eventKey: string, enabled: boolean): Promise<void> {
    await this.db.query(
      `INSERT INTO notification_prefs (tenant_id, user_id, event_key, enabled)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (tenant_id, user_id, event_key) DO UPDATE SET enabled=$4, updated_at=now()`,
      [tenantId, userId, eventKey, enabled],
    );
  }

  /** Отписка по токену из письма — без входа в систему. */
  async unsubscribeByToken(token: string, eventKeys: string[]): Promise<boolean> {
    const user = await this.db.one<{ id: string; tenant_id: string }>(
      `SELECT id, tenant_id FROM users WHERE unsubscribe_token = $1`, [token]);
    if (!user) return false;
    for (const key of eventKeys) await this.setPref(user.tenant_id, user.id, key, false);
    return true;
  }
}
