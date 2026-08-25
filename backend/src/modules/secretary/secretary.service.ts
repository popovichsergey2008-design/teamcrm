import { Injectable, Logger } from '@nestjs/common';
import { DbService } from '../../database/db.service';
import { startOfLocalDay } from '../../common/time/local-day';

export type AiActionKind =
  | 'meeting_task'
  | 'meeting_summary'
  | 'standup'
  | 'agent_run'
  | 'inbox_draft'
  | 'nl_task'
  | 'ping'
  | 'agenda';

/**
 * Сколько ручной работы заменяет одно действие, в минутах.
 *
 * Цифры грубые и намеренно круглые: точные на вид числа тут были бы выдумкой.
 * Порядок взят из ТЗ (протокол встречи ≈ 20 минут, напоминание ≈ 3) и из того,
 * сколько на деле занимает оформить задачу руками.
 */
const SAVED_MINUTES: Record<AiActionKind, number> = {
  meeting_summary: 20,
  standup: 10,
  agent_run: 15,
  meeting_task: 3,
  inbox_draft: 3,
  nl_task: 2,
  // напоминание ≈ 3 минуты по ТЗ: столько занимает вспомнить, найти задачу и написать человеку
  ping: 3,
  // повестка ≈ 5 минут: столько уходит на «так, о чём мы хотели поговорить» в начале встречи
  agenda: 5,
};

export type AiAction = {
  id: string;
  kind: AiActionKind;
  summary: string;
  saved_minutes: number;
  created_at: string;
  subject_type: string | null;
  subject_id: string | null;
  user_name: string | null;
};

@Injectable()
export class SecretaryService {
  private readonly logger = new Logger(SecretaryService.name);

  constructor(private readonly db: DbService) {}

  /**
   * Записать автоматическое действие.
   *
   * Ошибка записи не должна валить то действие, ради которого всё затевалось:
   * задача со встречи важнее строчки в журнале. Поэтому здесь ничего не бросаем,
   * а пишем в лог — молчаливого пропуска, как было с loadStickers, нам хватило.
   */
  async record(input: {
    tenantId: string;
    userId?: string | null;
    kind: AiActionKind;
    summary: string;
    subjectType?: 'task' | 'meeting' | 'project' | null;
    subjectId?: string | number | null;
  }): Promise<void> {
    try {
      await this.db.query(
        `INSERT INTO ai_actions (tenant_id, user_id, kind, subject_type, subject_id, summary, saved_minutes)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          input.tenantId,
          input.userId ?? null,
          input.kind,
          input.subjectType ?? null,
          input.subjectId ?? null,
          input.summary.slice(0, 300),
          SAVED_MINUTES[input.kind] ?? 0,
        ],
      );
    } catch (e) {
      this.logger.warn(`не записал действие ${input.kind}: ${e instanceof Error ? e.message : e}`);
    }
  }

  /**
   * Сводка за сегодня для виджета: сколько сделано и сколько это стоило бы времени.
   * «Сегодня» — по часам человека: иначе вечерняя работа по Москве считалась бы завтрашней.
   */
  async summary(tenantId: string, tzOffsetMin = 0): Promise<{ actions: number; savedMinutes: number }> {
    const row = await this.db.one<{ actions: string; saved: string }>(
      `SELECT COUNT(*) AS actions, COALESCE(SUM(saved_minutes), 0) AS saved
         FROM ai_actions
        WHERE tenant_id = $1 AND created_at >= $2`,
      [tenantId, startOfLocalDay(tzOffsetMin)],
    );
    return { actions: Number(row?.actions ?? 0), savedMinutes: Number(row?.saved ?? 0) };
  }

  /** Лента журнала: что, кому и когда сделал ассистент. */
  feed(tenantId: string, limit = 50): Promise<AiAction[]> {
    return this.db.many<AiAction>(
      `SELECT a.id, a.kind, a.summary, a.saved_minutes, a.created_at, a.subject_type, a.subject_id,
              u.full_name AS user_name
         FROM ai_actions a
         LEFT JOIN users u ON u.id = a.user_id
        WHERE a.tenant_id = $1
        ORDER BY a.created_at DESC
        LIMIT $2`,
      [tenantId, Math.min(Math.max(limit, 1), 200)],
    );
  }
}
