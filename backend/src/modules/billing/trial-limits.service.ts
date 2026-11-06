import { Injectable } from '@nestjs/common';
import { DbService } from '../../database/db.service';
import { BillingService } from './billing.service';

/**
 * Лимиты пробного периода (#4779, п. 4): на пространство — 1 ИИ-разбор созвона до 15
 * минут записи и 20 задач голосом. Только пока идёт пробный период: оплатили — лимитов
 * нет. Счётчик не обнуляется: это лимит на весь пробный, а не на день.
 */
export const TRIAL_LIMITS = { call_ai: 1, voice_task: 20 } as const;
export type TrialKind = keyof typeof TRIAL_LIMITS;
/** Запись созвона в пробный период — до 15 минут. */
export const TRIAL_CALL_SEC = 15 * 60;

export const TRIAL_TEXT = {
  callUsed: 'ИИ-разбор в пробный период уже использован. Оплатите тариф, чтобы разбирать все созвоны.',
  callSoon: 'Запись остановится через 2 минуты, потом созвон продолжится без ИИ.',
  callStopped: 'Запись остановлена: в пробный период — до 15 минут. Созвон продолжается без ИИ, разбор идёт по записанному.',
  voiceUsed: 'Лимит задач голосом в пробный период исчерпан. Оплатите тариф, чтобы продолжить.',
};

@Injectable()
export class TrialLimitsService {
  constructor(private readonly db: DbService, private readonly billing: BillingService) {}

  /** Идёт ли пробный период: только тогда лимиты действуют. */
  async inTrial(tenantId: string): Promise<boolean> {
    const s = await this.billing.state(tenantId).catch(() => null);
    return s?.status === 'TRIAL';
  }

  async used(tenantId: string, kind: TrialKind): Promise<number> {
    const r = await this.db.one<{ used: number }>(`SELECT used FROM trial_usage WHERE tenant_id=$1 AND kind=$2`, [tenantId, kind]);
    return Number(r?.used ?? 0);
  }

  /** Сколько ещё можно: null — лимита нет (не пробный период). */
  async left(tenantId: string, kind: TrialKind): Promise<number | null> {
    if (!(await this.inTrial(tenantId))) return null;
    return Math.max(0, TRIAL_LIMITS[kind] - (await this.used(tenantId, kind)));
  }

  /** Засчитать использование (после того как действие удалось). */
  async add(tenantId: string, kind: TrialKind, n = 1): Promise<void> {
    if (n <= 0 || !(await this.inTrial(tenantId))) return;
    await this.db.query(
      `INSERT INTO trial_usage (tenant_id, kind, used) VALUES ($1, $2, $3)
       ON CONFLICT (tenant_id, kind) DO UPDATE SET used = trial_usage.used + $3, updated_at = now()`,
      [tenantId, kind, n],
    );
  }

  /** Для «Тариф и ИИ», микрофона и кнопки «Включить ИИ» в созвоне. */
  async view(tenantId: string) {
    const trial = await this.inTrial(tenantId);
    if (!trial) return { trial: false as const };
    const [call, voice] = await Promise.all([this.used(tenantId, 'call_ai'), this.used(tenantId, 'voice_task')]);
    return {
      trial: true as const,
      callAi: { used: call, limit: TRIAL_LIMITS.call_ai, maxMinutes: TRIAL_CALL_SEC / 60 },
      voiceTasks: { used: voice, limit: TRIAL_LIMITS.voice_task },
    };
  }
}
