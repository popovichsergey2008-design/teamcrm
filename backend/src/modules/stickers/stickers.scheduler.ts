import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { runsBackground } from '../../common/process-role';
import { DbService } from '../../database/db.service';
import { PushService } from '../notifications/push.service';
import { TelegramMirror } from '../notifications/telegram-mirror.service';
import { StickersService } from './stickers.service';

const TICK_MS = 60_000;
/** Утренний список стикеров без времени — в начале рабочего дня. */
const MORNING_HOUR = 9;

/**
 * Стикер сам напоминает (#4997, пункт 6).
 * 6.1 — у стикера есть время: одно уведомление в срок (ящик, телефон, Telegram), повторно — нет;
 *       не отреагировал — стикер остаётся в «Сегодня» с красной точкой.
 * 6.2 — стикеры без времени: в 9:00 по часам человека одним уведомлением на все, не по одному.
 */
@Injectable()
export class StickersScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('Stickers');
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  private purgedOn = '';

  constructor(
    private readonly db: DbService,
    private readonly push: PushService,
    private readonly telegram: TelegramMirror,
    private readonly stickers: StickersService,
  ) {}

  onModuleInit(): void {
    if (!runsBackground()) return;
    this.timer = setInterval(() => { void this.tick(); }, TICK_MS);
    setTimeout(() => { void this.tick(); }, 20_000);
  }

  onModuleDestroy(): void { if (this.timer) clearInterval(this.timer); }

  async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      await this.timed().catch((e) => this.log.warn(`напоминания стикеров: ${(e as Error).message}`));
      await this.morning().catch((e) => this.log.warn(`утренний список стикеров: ${(e as Error).message}`));
      const day = new Date().toISOString().slice(0, 10);
      if (this.purgedOn !== day) { this.purgedOn = day; await this.stickers.purge().catch(() => 0); }
    } finally { this.busy = false; }
  }

  private async send(tenantId: string, userId: string, eventKey: string, title: string, body: string) {
    await this.push.personal({ tenantId, userId, eventKey, title, body: body.slice(0, 1000), path: '/stickers', toast: true });
    await this.telegram.push(tenantId, userId, `${title}\n\n${body.slice(0, 3500)}`).catch(() => false);
  }

  /** Срок наступил (или кончилось «Через 15 мин») — забираем строку и шлём один раз. */
  private async timed(): Promise<void> {
    const due = await this.db.many<{ id: string; tenant_id: string; user_id: string; text: string; due_time: string }>(
      `UPDATE stickers s SET reminded_at = now(), snooze_until = NULL
         FROM users u
        WHERE u.id = s.user_id AND s.deleted_at IS NULL AND s.done_at IS NULL AND s.due_time IS NOT NULL
          AND (
            (s.reminded_at IS NULL AND s.snooze_until IS NULL
              AND ((s.due_date + s.due_time) AT TIME ZONE COALESCE(NULLIF(u.timezone, ''), 'Europe/Moscow')) <= now()
              AND ((s.due_date + s.due_time) AT TIME ZONE COALESCE(NULLIF(u.timezone, ''), 'Europe/Moscow')) > now() - interval '6 hours')
            OR s.snooze_until <= now()
          )
       RETURNING s.id::text, s.tenant_id::text, s.user_id::text, s.text, to_char(s.due_time, 'HH24:MI') AS due_time`);
    for (const s of due) {
      await this.send(s.tenant_id, s.user_id, 'sticker.reminder', `📌 ${s.text}`.slice(0, 200), `Стикер на ${s.due_time}. Готово, «через 15 мин», «через час» или «завтра» — на доске «Стикеры».`)
        .catch((e) => this.log.warn(`стикер #${s.id}: ${(e as Error).message}`));
    }
  }

  /** 9:00 по часам человека: «Сегодня на стикерах: 4 — позвонить Ивану, КП Улыбке…» — одно на всех. */
  private async morning(): Promise<void> {
    const rows = await this.db.many<{ tenant_id: string; user_id: string; local_day: string; texts: string[] }>(
      `WITH people AS (
         SELECT DISTINCT s.tenant_id, s.user_id, COALESCE(NULLIF(u.timezone, ''), 'Europe/Moscow') AS tz
           FROM stickers s JOIN users u ON u.id = s.user_id
          WHERE s.deleted_at IS NULL AND s.done_at IS NULL AND s.due_time IS NULL AND s.due_date IS NOT NULL
            AND s.due_date BETWEEN current_date - 1 AND current_date + 1
       ), local AS (
         SELECT p.*, (now() AT TIME ZONE p.tz) AS ln FROM people p
       )
       SELECT l.tenant_id::text, l.user_id::text, to_char(l.ln::date, 'YYYY-MM-DD') AS local_day,
              ARRAY(SELECT s.text FROM stickers s WHERE s.user_id = l.user_id AND s.deleted_at IS NULL AND s.done_at IS NULL
                      AND s.due_time IS NULL AND s.due_date = l.ln::date ORDER BY s.position, s.id) AS texts
         FROM local l
         LEFT JOIN sticker_prefs sp ON sp.user_id = l.user_id
        WHERE EXTRACT(HOUR FROM l.ln) >= $1 AND (sp.digest_on IS NULL OR sp.digest_on < l.ln::date)`,
      [MORNING_HOUR]);
    for (const r of rows) {
      // отметку ставим и когда список пуст — второй раз за день не спрашиваем
      await this.db.query(
        `INSERT INTO sticker_prefs (user_id, tenant_id, digest_on) VALUES ($1, $2, $3::date)
         ON CONFLICT (user_id) DO UPDATE SET digest_on = EXCLUDED.digest_on, updated_at = now()`,
        [r.user_id, r.tenant_id, r.local_day]);
      if (!r.texts.length) continue;
      const list = r.texts.slice(0, 4).join(', ') + (r.texts.length > 4 ? '…' : '');
      await this.send(r.tenant_id, r.user_id, 'sticker.digest', `📌 Сегодня на стикерах: ${r.texts.length}`, list)
        .catch((e) => this.log.warn(`утренний список ${r.user_id}: ${(e as Error).message}`));
    }
  }
}
