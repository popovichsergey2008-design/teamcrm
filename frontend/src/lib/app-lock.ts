/**
 * Блокировка приложения биометрией (ТЗ-9, волна 3).
 *
 * Политика — через сколько минут в фоне просить Face ID / отпечаток: «выключено»,
 * сразу, 1, 5, 15 минут. По умолчанию — 5 минут (решение заказчика: «максимально
 * защищённые умолчания»). Организация может ужесточить — это придёт с `/mobile/config`
 * (волна 4); пока политика своя на устройстве.
 *
 * Чистая часть — расчёт «пора ли блокировать» — вынесена сюда и проверяется logic-check:
 * ошибка здесь либо запирает человека каждые десять секунд, либо не запирает никогда.
 */
export type LockPolicy = 'off' | 'immediately' | '1' | '5' | '15';

export const LOCK_POLICIES: { value: LockPolicy; label: string }[] = [
  { value: 'immediately', label: 'сразу, как свернули' },
  { value: '1', label: 'через минуту в фоне' },
  { value: '5', label: 'через 5 минут в фоне' },
  { value: '15', label: 'через 15 минут в фоне' },
  { value: 'off', label: 'не блокировать' },
];

export const DEFAULT_LOCK_POLICY: LockPolicy = '5';
const KEY = 'teamcrm.lock-policy';

export function readLockPolicy(storage: Pick<Storage, 'getItem'> = localStorage): LockPolicy {
  try {
    const v = storage.getItem(KEY);
    return LOCK_POLICIES.some((p) => p.value === v) ? (v as LockPolicy) : DEFAULT_LOCK_POLICY;
  } catch { return DEFAULT_LOCK_POLICY; }
}

export function writeLockPolicy(policy: LockPolicy, storage: Pick<Storage, 'setItem'> = localStorage): void {
  try { storage.setItem(KEY, policy); } catch { /* приватный режим */ }
}

/** Пора ли запереть: ушли в фон в `hiddenAt`, вернулись в `now`. */
export function shouldLock(policy: LockPolicy, hiddenAt: number | null, now: number): boolean {
  if (policy === 'off' || hiddenAt === null) return false;
  if (policy === 'immediately') return true;
  return now - hiddenAt >= Number(policy) * 60_000;
}