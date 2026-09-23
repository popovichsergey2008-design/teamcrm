import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { MobileConfig, setMobileConfig, shouldOfferUpdate, updateVerdict } from '../lib/mobile-config';
import { platform, isNativeShell } from '../platform';

/** Версия, которую человек отложил: до следующего выпуска об обновлении не напоминаем. */
const SKIPPED = 'anthill.update.skipped';
function skippedVersion(): string | null {
  try { return localStorage.getItem(SKIPPED); } catch { return null; }
}

/**
 * Конфиг оболочки при старте и при каждом возврате в приложение (ТЗ-9, волна 4).
 *
 * Возвращает вердикт по версии: `required` — экран «обновите приложение» вместо CRM,
 * `available` — одна всплывашка со ссылкой на APK за запуск. Флаги функций и политика
 * организации оседают в lib/mobile-config для всех остальных.
 */
export function useMobileConfig(signedIn: boolean): {
  verdict: 'none' | 'available' | 'required';
  config: MobileConfig | null;
  /** Показать окно обновления: обязательное — всегда, обычное — раз на версию. */
  offer: boolean;
  /** «Позже»: молчим до следующего выпуска. */
  skip: () => void;
} {
  const [config, setConfig] = useState<MobileConfig | null>(null);
  const [verdict, setVerdict] = useState<'none' | 'available' | 'required'>('none');
  const [offer, setOffer] = useState(false);

  useEffect(() => {
    if (!signedIn || !isNativeShell()) return;
    let alive = true;
    const load = async () => {
      try {
        const c = await api.mobileConfig();
        if (!alive) return;
        setMobileConfig(c); setConfig(c);
        const v = updateVerdict(platform.info().nativeVersion, c.android);
        setVerdict(v);
        /*
          Раньше здесь была всплывашка со ссылкой на файл — и дальше человек оставался
          один на один с браузером, загрузками и настройками Android. Теперь показываем
          окно, которое умеет обновить приложение само (см. UpdateSheet).
        */
        setOffer(shouldOfferUpdate(v, c.android, skippedVersion()));
      } catch { /* нет сети — работаем с тем, что есть */ }
    };
    void load();
    const onVisible = () => { if (document.visibilityState === 'visible') void load(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { alive = false; document.removeEventListener('visibilitychange', onVisible); };
  }, [signedIn]);

  const skip = () => {
    setOffer(false);
    try { if (config?.android) localStorage.setItem(SKIPPED, config.android.latestNative); } catch { /* приват-режим */ }
  };

  return { verdict, config, offer, skip };
}