/**
 * Аварийные выключатели и бюджет общего ИИ (ТЗ консолей, §5.5). Решает владелец
 * платформы в консоли; здесь — чистое правило «что разрешено прямо сейчас».
 *
 * Два выключателя, потому что поводы разные: «общий ключ сервера» — наши деньги
 * (пробный ИИ новых компаний, площадка вендора), «весь ИИ» — авария у провайдера или
 * утечка, когда остановить надо всё, включая ключи самих компаний.
 */

export interface AiGuardConfig {
  /** Весь ИИ выключен, включая ключи компаний. */
  allOff: boolean;
  allReason: string | null;
  /** Общий ключ сервера выключен — компании со своими ключами работают. */
  sharedOff: boolean;
  sharedReason: string | null;
  /** Потолок расхода общего ключа за календарный месяц (UTC), USD. null — без потолка. */
  monthlyBudgetUsd: number | null;
}

export const AI_GUARD_DEFAULT: AiGuardConfig = {
  allOff: false, allReason: null, sharedOff: false, sharedReason: null, monthlyBudgetUsd: null,
};

export interface AiGuardDecision {
  /** Можно ли звать модель вообще. */
  any: boolean;
  /** Можно ли тратить общий ключ сервера. */
  shared: boolean;
  /** Почему нельзя — для журнала и консоли. */
  reason: string | null;
}

export function normalizeGuard(raw: unknown): AiGuardConfig {
  const v = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const text = (x: unknown) => (typeof x === 'string' && x.trim() ? x.trim().slice(0, 300) : null);
  const budget = Number(v.monthlyBudgetUsd);
  return {
    allOff: v.allOff === true,
    allReason: text(v.allReason),
    sharedOff: v.sharedOff === true,
    sharedReason: text(v.sharedReason),
    monthlyBudgetUsd: v.monthlyBudgetUsd != null && Number.isFinite(budget) && budget >= 0 ? budget : null,
  };
}

/**
 * Резервный провайдер бюджет не обходит (§5.5): решение принимается до выбора ключа,
 * а не внутри провайдера, поэтому фолбэк на другой ключ сюда уже не доходит.
 */
export function decide(cfg: AiGuardConfig, sharedSpentUsd: number): AiGuardDecision {
  if (cfg.allOff) return { any: false, shared: false, reason: cfg.allReason ?? 'ИИ выключен владельцем платформы' };
  if (cfg.sharedOff) return { any: true, shared: false, reason: cfg.sharedReason ?? 'общий ключ выключен владельцем платформы' };
  if (cfg.monthlyBudgetUsd != null && sharedSpentUsd >= cfg.monthlyBudgetUsd) {
    return { any: true, shared: false, reason: `исчерпан месячный бюджет общего ключа: $${sharedSpentUsd.toFixed(2)} из $${cfg.monthlyBudgetUsd}` };
  }
  return { any: true, shared: true, reason: null };
}
