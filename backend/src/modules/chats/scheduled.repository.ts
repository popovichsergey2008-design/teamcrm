import { Injectable } from '@nestjs/common';
import { DbService } from '../../database/db.service';

export interface ScheduledRow {
  id: string;
  tenant_id: string;
  chat_id: string;
  author_id: string;
  body: string;
  thread_root_id: string | null;
  also_in_channel: boolean;
  mention_ids: string[];
  send_at: Date;
  status: string;
  /** none — один раз, daily — каждый день в это же время. */
  repeat_kind: string;
  sent_count: number;
  created_at: Date;
}

/**
 * Отложенные сообщения.
 *
 * Всё про них живёт в одной таблице и одном месте: планировщик берёт «что уже пора»,
 * человек — «что я отложил в этом чате». Ничего третьего здесь не нужно.
 */
@Injectable()
export class ScheduledRepository {
  constructor(private readonly db: DbService) {}

  create(input: {
    tenantId: string; chatId: string; authorId: string; body: string;
    threadRootId: string | null; alsoInChannel: boolean; mentionIds: string[]; sendAt: Date;
    repeatKind?: string;
  }): Promise<ScheduledRow | null> {
    return this.db.one<ScheduledRow>(
      `INSERT INTO chat_scheduled
         (tenant_id, chat_id, author_id, body, thread_root_id, also_in_channel, mention_ids, send_at, repeat_kind)
       VALUES ($1,$2,$3,$4,$5,$6,$7::bigint[],$8,$9)
       RETURNING *`,
      [
        input.tenantId, input.chatId, input.authorId, input.body,
        input.threadRootId, input.alsoInChannel, input.mentionIds, input.sendAt,
        input.repeatKind === 'daily' ? 'daily' : 'none',
      ],
    );
  }

  /** Мои отложенные в этом чате — по времени отправки, ближайшее первым. */
  listMine(tenantId: string, chatId: string, userId: string): Promise<ScheduledRow[]> {
    return this.db.many<ScheduledRow>(
      `SELECT * FROM chat_scheduled
        WHERE tenant_id=$1 AND chat_id=$2 AND author_id=$3 AND status='pending'
        ORDER BY send_at`,
      [tenantId, chatId, userId],
    );
  }

  /** Сколько отложено во всех чатах — цифра рядом с часами в поле ввода. */
  countMine(tenantId: string, userId: string): Promise<{ n: string } | null> {
    return this.db.one<{ n: string }>(
      `SELECT COUNT(*) AS n FROM chat_scheduled
        WHERE tenant_id=$1 AND author_id=$2 AND status='pending'`,
      [tenantId, userId],
    );
  }

  byId(tenantId: string, id: string): Promise<ScheduledRow | null> {
    return this.db.one<ScheduledRow>(
      `SELECT * FROM chat_scheduled WHERE tenant_id=$1 AND id=$2`, [tenantId, id],
    );
  }

  /** Отмена — не удаление: по журналу видно, что человек передумал, а не что «пропало». */
  async cancel(tenantId: string, id: string): Promise<void> {
    await this.db.query(
      `UPDATE chat_scheduled SET status='cancelled' WHERE tenant_id=$1 AND id=$2 AND status='pending'`,
      [tenantId, id],
    );
  }

  async editBody(tenantId: string, id: string, body: string): Promise<void> {
    await this.db.query(
      `UPDATE chat_scheduled SET body=$3 WHERE tenant_id=$1 AND id=$2 AND status='pending'`,
      [tenantId, id, body],
    );
  }

  async reschedule(tenantId: string, id: string, sendAt: Date): Promise<void> {
    await this.db.query(
      `UPDATE chat_scheduled SET send_at=$3 WHERE tenant_id=$1 AND id=$2 AND status='pending'`,
      [tenantId, id, sendAt],
    );
  }

  /**
   * Что уже пора отправить.
   *
   * `FOR UPDATE SKIP LOCKED` — на случай двух процессов приложения: второй просто
   * пройдёт мимо занятых строк, и сообщение не уйдёт дважды.
   */
  dueBatch(limit = 50): Promise<ScheduledRow[]> {
    return this.db.many<ScheduledRow>(
      `SELECT * FROM chat_scheduled
        WHERE status='pending' AND send_at <= now()
        ORDER BY send_at
        LIMIT $1
        FOR UPDATE SKIP LOCKED`,
      [limit],
    );
  }

  /**
   * Отправлено.
   *
   * У ежедневного напоминания строка остаётся живой и уезжает на сутки вперёд: это
   * одно и то же напоминание, а не тридцать разных. У разового — закрывается.
   *
   * Время двигаем от НАЗНАЧЕННОГО момента, а не от «сейчас»: иначе напоминание,
   * ушедшее с опозданием на минуту, каждый день сползало бы всё позже.
   */
  async markSent(id: string, messageId: string, repeatDaily = false): Promise<void> {
    if (repeatDaily) {
      await this.db.query(
        `UPDATE chat_scheduled
            SET send_at = send_at + interval '1 day',
                sent_at = now(), sent_message_id = $2, sent_count = sent_count + 1
          WHERE id = $1`,
        [id, messageId],
      );
      return;
    }
    await this.db.query(
      `UPDATE chat_scheduled
          SET status='sent', sent_at=now(), sent_message_id=$2, sent_count = sent_count + 1
        WHERE id=$1`,
      [id, messageId],
    );
  }

  /**
   * Неудача записывается, а не глотается.
   *
   * Чат могли удалить, человека — убрать из группы. Молча потерянное сообщение
   * выглядит как «система съела мой текст»; здесь видно и что не ушло, и почему.
   */
  async markFailed(id: string, error: string): Promise<void> {
    await this.db.query(
      `UPDATE chat_scheduled SET status='failed', error=$2 WHERE id=$1`,
      [id, error.slice(0, 500)],
    );
  }
}
