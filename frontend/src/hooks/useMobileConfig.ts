import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { MobileConfig, setMobileConfig, updateVerdict } from '../lib/mobile-config';
import { showToast } from '../lib/notifications';
import { platform, isNativeShell } from '../platform';

/**
 * Конфиг оболочки при старте и при каждом возврате в приложение (ТЗ-9, волна 4).
 *
 * Возвращает вердикт по версии: `required` — экран «обновите приложение» вместо CRM,
 * `available` — одна всплывашка со ссылкой на APK за запуск. Флаги функций и политика
 * организации оседают в lib/mobile-config для всех остальных.
 */
export function useMobileConfig(signedIn: boolean): { verdict: 'none' | 'available' | 'required'; config: MobileConfig | null } {
  const [config, setConfig] = useState<MobileConfig | null>(null);
  const [verdict, setVerdict] = useState<'none' | 'available' | 'required'>('none');

  useEffect(() => {
    if (!signedIn || !isNativeShell()) return;
    let alive = true;
    let told = false;
    const load = async () => {
      try {
        const c = await api.mobileConfig();
        if (!alive) return;
        setMobileConfig(c); setConfig(c);
        const v = updateVerdict(platform.info().nativeVersion, c.android);
        setVerdict(v);
        if (v === 'available' && !told && c.android) {
          told = true;
          showToast({ title: `Доступна версия ${c.android.latestNative}`, body: 'Нажмите, чтобы скачать обновление', section: 'update' });
        }
      } catch { /* нет сети — работаем с тем, что есть */ }
    };
    void load();
    const onVisible = () => { if (document.visibilityState === 'visible') void load(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { alive = false; document.removeEventListener('visibilitychange', onVisible); };
  }, [signedIn]);

  return { verdict, config };
}