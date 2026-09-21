import type { LockPolicy } from './app-lock';

/**
 * Конфигурация мобильного клиента с сервера (ТЗ-9, волна 4).
 *
 * Приходит одним ответом при старте оболочки: версии и обязательность обновления,
 * флаги функций, политика организации, авария. Хранится в памяти модуля — компоненты
 * читают синхронно, а перезапрос делает хук.
 */
export interface MobileConfig {
  android: { latestNative: string; minimumNative: string; apkUrl: string; sha256: string; force: boolean; notes?: string } | null;
  bundle: { version: string; minNative: string; url: string; sha256: string; mandatory: boolean } | null;
  features: Record<string, boolean>;
  privacy: { push: 'hide' | 'sender_only' | 'full' };
  biometrics: { minLockPolicy: LockPolicy };
  incident: { id: string; title: string; message: string } | null;
}

let current: MobileConfig | null = null;
export function setMobileConfig(c: MobileConfig | null): void { current = c; }
export function mobileConfig(): MobileConfig | null { return current; }

/** Флаг функции: сервер может выключить рискованное без новой сборки; нет конфига — включено. */
export function featureOn(flag: string): boolean {
  return current?.features?.[flag] ?? true;
}

/**
 * Сравнение версий вида «1.2.3» (лишнее — «(4)», буквы — отбрасывается).
 * Возвращает <0, 0, >0. Пустая версия считается самой старой.
 */
export function compareVersions(a: string | null | undefined, b: string | null | undefined): number {
  const parse = (v: string | null | undefined) => String(v ?? '').split(/[^0-9]+/).filter(Boolean).map(Number);
  const x = parse(a); const y = parse(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

/** Что делать с версией оболочки: молчать, предложить обновиться или не пускать без обновления. */
export function updateVerdict(native: string | null, release: MobileConfig['android']): 'none' | 'available' | 'required' {
  if (!release || !native) return 'none';
  if (release.force && compareVersions(native, release.minimumNative) < 0) return 'required';
  if (compareVersions(native, release.latestNative) < 0) return 'available';
  return 'none';
}

/** Политика блокировки с учётом организации: своя не мягче организационной. */
const ORDER: LockPolicy[] = ['off', '15', '5', '1', 'immediately'];
export function effectiveLockPolicy(own: LockPolicy, orgMin: LockPolicy | undefined): LockPolicy {
  if (!orgMin) return own;
  return ORDER.indexOf(orgMin) > ORDER.indexOf(own) ? orgMin : own;
}