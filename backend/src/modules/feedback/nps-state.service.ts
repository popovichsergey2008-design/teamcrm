import { Global, Injectable, Module } from '@nestjs/common';
import { DbService } from '../../database/db.service';

/** После скольких задач, созданных ИИ, спрашиваем оценку (ТЗ 10.11). */
export const NPS_AI_TASKS = 10;
/** Не чаще раза в столько дней. */
export const NPS_EVERY_DAYS = 60;

/**
 * Поводы спросить «Порекомендовали бы QEVO коллеге?» (ТЗ 10.11): первый созвон с
 * ИИ-протоколом и задачи, созданные ИИ. Отдельно от опроса и без зависимостей — его
 * зовут постановка задач и разбор встреч, а им не нужно знать о службе заботы.
 */
@Injectable()
export class NpsStateService {
  constructor(private readonly db: DbService) {}

  async aiTask(tenantId: string, userId: string | null | undefined): Promise<void> {
    if (!userId) return;
    await this.db.query(
      `INSERT INTO nps_state (tenant_id, user_id, ai_tasks) VALUES ($1, $2, 1)
       ON CONFLICT (tenant_id, user_id) DO UPDATE SET ai_tasks = nps_state.ai_tasks + 1`,
      [tenantId, userId],
    ).catch(() => undefined);
  }

  async protocol(tenantId: string, userIds: (string | null | undefined)[]): Promise<void> {
    for (const userId of new Set(userIds.filter((x): x is string => !!x && !String(x).startsWith('guest:')))) {
      await this.db.query(
        `INSERT INTO nps_state (tenant_id, user_id, protocol_at) VALUES ($1, $2, now())
         ON CONFLICT (tenant_id, user_id) DO UPDATE SET protocol_at = COALESCE(nps_state.protocol_at, now())`,
        [tenantId, userId],
      ).catch(() => undefined);
    }
  }

  /** Пора спросить? Если да — отметка «спросили» ставится сразу: не чаще раза в 60 дней. */
  async claim(tenantId: string, userId: string): Promise<boolean> {
    const r = await this.db.one<{ ok: boolean }>(
      `UPDATE nps_state SET last_prompt_at = now()
        WHERE tenant_id = $1 AND user_id = $2
          AND (protocol_at IS NOT NULL OR ai_tasks >= $3)
          AND (last_prompt_at IS NULL OR last_prompt_at < now() - make_interval(days => $4::int))
        RETURNING true AS ok`,
      [tenantId, userId, NPS_AI_TASKS, NPS_EVERY_DAYS],
    );
    return !!r?.ok;
  }
}

@Global()
@Module({ providers: [NpsStateService], exports: [NpsStateService] })
export class FeedbackCoreModule {}
