import { useEffect } from 'react';
import { api } from '../lib/api';
import { platform, isNativeShell } from '../platform';

const DEVICE_KEY = 'teamcrm.device-id';

/**
 * Телефон представляется серверу (ТЗ-9, волна 3).
 *
 * После входа и при каждом запуске оболочки: «я такое-то устройство, такая-то
 * версия оболочки и бандла» — сервер привязывает к нему текущую сессию, руководство
 * видит его в списке устройств сотрудника, а push (волна 4) знает, кого будить.
 * Ошибка регистрации не мешает работать: приложение не про неё.
 */
export function useDeviceRegistration(signedIn: boolean): void {
  useEffect(() => {
    if (!signedIn || !isNativeShell()) return;
    let alive = true;
    void (async () => {
      const uuid = await platform.deviceUuid();
      if (!uuid || !alive) return;
      const info = platform.info();
      // Разрешение на уведомления — сразу после входа, а не в случайный момент; без него
      // молчат и push, и уведомления самого приложения (волна 12).
      if (platform.notifications.permission() === 'default') await platform.notifications.requestPermission();
      const pushToken = await platform.notifications.pushToken();
      try {
        const r = await api.registerDevice({
          deviceUuid: uuid,
          platform: info.os === 'ios' || info.os === 'android' ? info.os : 'web',
          model: info.model ?? undefined,
          nativeVersion: info.nativeVersion ?? undefined,
          webBundleVersion: info.bundleVersion,
          pushToken: pushToken ?? undefined,
        });
        platform.secureStorage.set(DEVICE_KEY, r.id);
      } catch { /* сервер недоступен — представимся в следующий раз */ }
    })();
    return () => { alive = false; };
  }, [signedIn]);
}

/** Id устройства на сервере — чтобы при выходе снять его с учёта. */
export function registeredDeviceId(): string | null {
  return platform.secureStorage.get(DEVICE_KEY);
}
export function forgetRegisteredDevice(): void {
  platform.secureStorage.remove(DEVICE_KEY);
}