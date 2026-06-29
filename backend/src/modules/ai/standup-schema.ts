/**
 * Строгая схема извлекаемого пакета дейлика (Шаг 3.2). Невалидный по схеме
 * вывод LLM НЕ применяется (контракт безопасности). Чистая валидация + нормализация.
 */
export type StatusChange = 'DONE' | 'IN_PROGRESS' | 'TODO';
const STATUSES: StatusChange[] = ['DONE', 'IN_PROGRESS', 'TODO'];

export interface StandupAction {
  task_id: string; // нормализуем к строке (BIGINT)
  status_change?: StatusChange;
  time_logged_minutes?: number;
  blocker_detected?: string;
}

export interface StandupPackage {
  actions: StandupAction[];
  confidence: number; // 0..1
}

export interface ValidationResult {
  valid: boolean;
  value?: StandupPackage;
  errors: string[];
}

export function validateStandupPackage(raw: unknown): ValidationResult {
  const errors: string[] = [];
  if (!raw || typeof raw !== 'object') return { valid: false, errors: ['not an object'] };
  const obj = raw as Record<string, unknown>;

  if (!Array.isArray(obj.actions)) return { valid: false, errors: ['actions must be an array'] };
  if (obj.actions.length === 0) errors.push('actions is empty');

  const actions: StandupAction[] = [];
  obj.actions.forEach((a: any, i: number) => {
    if (!a || typeof a !== 'object') {
      errors.push(`action[${i}] not an object`);
      return;
    }
    if (a.task_id === undefined || a.task_id === null || `${a.task_id}`.trim() === '') {
      errors.push(`action[${i}].task_id required`);
      return;
    }
    const action: StandupAction = { task_id: String(a.task_id) };

    if (a.status_change !== undefined && a.status_change !== null) {
      const s = String(a.status_change).toUpperCase();
      if (!STATUSES.includes(s as StatusChange)) errors.push(`action[${i}].status_change invalid: ${a.status_change}`);
      else action.status_change = s as StatusChange;
    }
    if (a.time_logged_minutes !== undefined && a.time_logged_minutes !== null) {
      const m = Number(a.time_logged_minutes);
      if (!Number.isFinite(m) || m <= 0 || m > 24 * 60) errors.push(`action[${i}].time_logged_minutes invalid`);
      else action.time_logged_minutes = Math.round(m);
    }
    if (a.blocker_detected !== undefined && a.blocker_detected !== null) {
      const b = String(a.blocker_detected).trim();
      if (b) action.blocker_detected = b;
    }
    if (!action.status_change && !action.time_logged_minutes && !action.blocker_detected) {
      errors.push(`action[${i}] has no effect`);
      return;
    }
    actions.push(action);
  });

  let confidence = 1;
  if (obj.confidence !== undefined && obj.confidence !== null) {
    const c = Number(obj.confidence);
    confidence = Number.isFinite(c) ? Math.max(0, Math.min(1, c)) : 1;
  }

  if (errors.length) return { valid: false, errors };
  return { valid: true, value: { actions, confidence }, errors: [] };
}
