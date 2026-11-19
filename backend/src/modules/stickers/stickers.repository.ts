import { Injectable } from '@nestjs/common';
import { DbService } from '../../database/db.service';

export interface StickerRow {
  id: string; tenant_id: string; user_id: string; text: string; body: string | null;
  due_date: string | null; due_time: string | null; color: string; position: number;
  source: string; source_ref: Record<string, unknown> | null;
  done_at: Date | null; deleted_at: Date | null; reminded_at: Date | null; snooze_until: Date | null;
  task_id: string | null; event_id: string | null; created_at: Date; updated_at: Date;
}

const COLS = `id::text, tenant_id::text, user_id::text, text, body, to_char(due_date, 'YYYY-MM-DD') AS due_date,
  to_char(due_time, 'HH24:MI') AS due_time, color, position, source, source_ref, done_at, deleted_at, reminded_at,
  snooze_until, task_id::text, event_id::text, created_at, updated_at`;

/** Стикеры (#4997): все запросы — только свои (tenant + user), чужих стикеров не видно никому. */
@Injectable()
export class StickersRepository {
  constructor(private readonly db: DbService) {}

  /** Открытые (не сделанные и не в корзине) — вся доска одним запросом: стикеров у человека немного. */
  open(tenantId: string, userId: string): Promise<StickerRow[]> {
    return this.db.many<StickerRow>(
      `SELECT ${COLS} FROM stickers WHERE tenant_id=$1 AND user_id=$2 AND deleted_at IS NULL AND done_at IS NULL
        ORDER BY due_date NULLS LAST, due_time NULLS LAST, position, id LIMIT 2000`, [tenantId, userId]);
  }

  /** «Сделано» и «Корзина» — за 30 дней. */
  archive(tenantId: string, userId: string, kind: 'done' | 'trash'): Promise<StickerRow[]> {
    const where = kind === 'done'
      ? `deleted_at IS NULL AND done_at > now() - interval '30 days'`
      : `deleted_at > now() - interval '30 days'`;
    return this.db.many<StickerRow>(
      `SELECT ${COLS} FROM stickers WHERE tenant_id=$1 AND user_id=$2 AND ${where}
        ORDER BY ${kind === 'done' ? 'done_at' : 'deleted_at'} DESC LIMIT 500`, [tenantId, userId]);
  }

  get(tenantId: string, userId: string, id: string): Promise<StickerRow | null> {
    return this.db.one<StickerRow>(`SELECT ${COLS} FROM stickers WHERE tenant_id=$1 AND user_id=$2 AND id=$3`, [tenantId, userId, id]);
  }

  async create(p: {
    tenantId: string; userId: string; text: string; body: string | null; date: string | null; time: string | null;
    color: string; source: string; sourceRef: Record<string, unknown> | null;
  }): Promise<StickerRow> {
    const row = await this.db.one<StickerRow>(
      `INSERT INTO stickers (tenant_id, user_id, text, body, due_date, due_time, color, source, source_ref, position)
       VALUES ($1, $2, $3, $4, $5::date, $6::time, $7, $8, $9::jsonb,
               COALESCE((SELECT max(position) + 1 FROM stickers WHERE tenant_id=$1 AND user_id=$2), 0))
       RETURNING ${COLS}`,
      [p.tenantId, p.userId, p.text, p.body, p.date, p.time, p.color, p.source, p.sourceRef ? JSON.stringify(p.sourceRef) : null],
    );
    return row!;
  }

  /** Правка: только переданные поля. Перенос даты/времени сбрасывает «напомнил» — напомнит заново. */
  async patch(tenantId: string, userId: string, id: string, p: {
    text?: string; body?: string | null; date?: string | null; time?: string | null; color?: string; position?: number;
    taskId?: string | null; eventId?: string | null;
  }): Promise<StickerRow | null> {
    const sets: string[] = []; const vals: unknown[] = [tenantId, userId, id];
    const add = (sql: string, v: unknown) => { vals.push(v); sets.push(sql.replace('?', `$${vals.length}`)); };
    if (p.text !== undefined) add('text = ?', p.text);
    if (p.body !== undefined) add('body = ?', p.body);
    if (p.date !== undefined) add('due_date = ?::date', p.date);
    if (p.time !== undefined) add('due_time = ?::time', p.time);
    if (p.color !== undefined) add('color = ?', p.color);
    if (p.position !== undefined) add('position = ?', p.position);
    if (p.taskId !== undefined) add('task_id = ?::bigint', p.taskId);
    if (p.eventId !== undefined) add('event_id = ?::bigint', p.eventId);
    if (p.date !== undefined || p.time !== undefined) sets.push('reminded_at = NULL, snooze_until = NULL');
    if (!sets.length) return this.get(tenantId, userId, id);
    return this.db.one<StickerRow>(
      `UPDATE stickers SET ${sets.join(', ')}, updated_at = now() WHERE tenant_id=$1 AND user_id=$2 AND id=$3 RETURNING ${COLS}`, vals);
  }

  /** Готово / вернуть / в корзину / из корзины — пачкой: «Удалено: 3 · Отменить». */
  async mark(tenantId: string, userId: string, ids: string[], action: 'done' | 'undone' | 'delete' | 'restore'): Promise<number> {
    const set = { done: 'done_at = now()', undone: 'done_at = NULL', delete: 'deleted_at = now()', restore: 'deleted_at = NULL' }[action];
    const r = await this.db.query(
      `UPDATE stickers SET ${set}, updated_at = now() WHERE tenant_id=$1 AND user_id=$2 AND id = ANY($3::bigint[])`,
      [tenantId, userId, ids]);
    return r.rowCount ?? 0;
  }

  /** «Всё просроченное → на сегодня». */
  async overdueToToday(tenantId: string, userId: string, today: string): Promise<number> {
    const r = await this.db.query(
      `UPDATE stickers SET due_date = $3::date, reminded_at = NULL, updated_at = now()
        WHERE tenant_id=$1 AND user_id=$2 AND deleted_at IS NULL AND done_at IS NULL AND due_date < $3::date`,
      [tenantId, userId, today]);
    return r.rowCount ?? 0;
  }

  async colorNames(userId: string): Promise<Record<string, string>> {
    const r = await this.db.one<{ color_names: Record<string, string> }>(`SELECT color_names FROM sticker_prefs WHERE user_id=$1`, [userId]);
    return r?.color_names ?? {};
  }

  async setColorNames(tenantId: string, userId: string, names: Record<string, string>): Promise<void> {
    await this.db.query(
      `INSERT INTO sticker_prefs (user_id, tenant_id, color_names) VALUES ($1, $2, $3::jsonb)
       ON CONFLICT (user_id) DO UPDATE SET color_names = EXCLUDED.color_names, updated_at = now()`,
      [userId, tenantId, JSON.stringify(names)]);
  }

  timezone(tenantId: string, userId: string): Promise<{ timezone: string | null } | null> {
    return this.db.one<{ timezone: string | null }>(`SELECT timezone FROM users WHERE tenant_id=$1 AND id=$2`, [tenantId, userId]);
  }

  /** Старше 30 дней в «Сделано» и в корзине — насовсем. */
  async purge(): Promise<number> {
    const r = await this.db.query(
      `DELETE FROM stickers WHERE deleted_at < now() - interval '30 days' OR done_at < now() - interval '30 days'`);
    return r.rowCount ?? 0;
  }
}
