import { Injectable, Logger } from '@nestjs/common';
import { DbService } from '../../database/db.service';
import { AppException } from '../../common/http/app-exception';

/** Виды фокуса. `task` ставится автоматически при старте таймера по задаче. */
export const FOCUS_KINDS = ['deep', 'call', 'quick', 'break', 'task'] as const;
export type FocusKind = (typeof FOCUS_KINDS)[number];

export type Focus = {
  kind: FocusKind;
  note: string | null;
  taskId: string | null;
  until: string | null;
  userId?: string;
  userName?: string;
};

@Injectable()
export class FocusService {
  private readonly logger = new Logger(FocusService.name);

  constructor(private readonly db: DbService) {}

  /**
   * Свой фокус. Истёкший не возвращаем: обещание «до 16:00» должно само
   * заканчиваться в 16:00, а не висеть, пока человек не вспомнит его снять.
   * Сравнение с now() при чтении надёжнее расписания, которое может не отработать.
   */
  async mine(tenantId: string, userId: string): Promise<Focus | null> {
    const row = await this.db.one<any>(
      `SELECT kind, note, task_id, until FROM user_focus
        WHERE tenant_id = $1 AND user_id = $2 AND (until IS NULL OR until > now())`,
      [tenantId, userId],
    );
    return row ? { kind: row.kind, note: row.note, taskId: row.task_id, until: row.until } : null;
  }

  /** Кто чем занят в организации — для чатов и карточек коллег. */
  async team(tenantId: string): Promise<Focus[]> {
    const rows = await this.db.many<any>(
      `SELECT f.user_id, u.full_name, f.kind, f.note, f.task_id, f.until
         FROM user_focus f
         JOIN users u ON u.id = f.user_id
        WHERE f.tenant_id = $1 AND (f.until IS NULL OR f.until > now())`,
      [tenantId],
    );
    return rows.map((r) => ({
      userId: String(r.user_id), userName: r.full_name,
      kind: r.kind, note: r.note, taskId: r.task_id, until: r.until,
    }));
  }

  /**
   * Поставить фокус.
   * @param minutes сколько он держится; 0 или пусто — до отмены руками
   */
  async set(tenantId: string, userId: string, input: {
    kind: string; note?: string | null; minutes?: number | null; taskId?: string | null;
  }): Promise<Focus> {
    if (!FOCUS_KINDS.includes(input.kind as FocusKind)) {
      throw AppException.validation('Неизвестный вид фокуса');
    }
    // Верхняя граница — сутки: «не беспокоить» на неделю это уже отпуск,
    // а он живёт в другом месте (user_availability).
    const minutes = Math.max(0, Math.min(Math.trunc(input.minutes ?? 0), 24 * 60));
    const until = minutes > 0 ? new Date(Date.now() + minutes * 60_000) : null;

    await this.db.query(
      `INSERT INTO user_focus (tenant_id, user_id, kind, note, task_id, until, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, now())
       ON CONFLICT (tenant_id, user_id) DO UPDATE
         SET kind = EXCLUDED.kind, note = EXCLUDED.note, task_id = EXCLUDED.task_id,
             until = EXCLUDED.until, updated_at = now()`,
      [tenantId, userId, input.kind, input.note?.slice(0, 160) ?? null, input.taskId ?? null, until],
    );
    return { kind: input.kind as FocusKind, note: input.note ?? null, taskId: input.taskId ?? null, until: until?.toISOString() ?? null };
  }

  async clear(tenantId: string, userId: string): Promise<{ cleared: boolean }> {
    await this.db.query(`DELETE FROM user_focus WHERE tenant_id = $1 AND user_id = $2`, [tenantId, userId]);
    return { cleared: true };
  }

  /**
   * Автофокус при старте таймера: человек взял задачу в работу — статус ставится сам.
   *
   * Заданный руками фокус не трогаем: если человек написал «Готовлю отчёт для совета
   * директоров», подменять это названием задачи нельзя. И падать здесь нельзя тоже —
   * таймер важнее статуса.
   */
  async fromTaskStart(tenantId: string, userId: string, taskId: string, taskTitle: string): Promise<void> {
    try {
      await this.db.query(
        `INSERT INTO user_focus (tenant_id, user_id, kind, note, task_id, until, updated_at)
         VALUES ($1, $2, 'task', $3, $4, NULL, now())
         ON CONFLICT (tenant_id, user_id) DO UPDATE
           SET kind = 'task', note = EXCLUDED.note, task_id = EXCLUDED.task_id,
               until = NULL, updated_at = now()
         WHERE user_focus.kind = 'task'`,
        [tenantId, userId, taskTitle.slice(0, 160), taskId],
      );
    } catch (e) {
      this.logger.warn(`автофокус не поставлен: ${e instanceof Error ? e.message : e}`);
    }
  }
}
