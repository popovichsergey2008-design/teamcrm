import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import { MobileConfig, setMobileConfig, shouldOfferUpdate, updateVerdict, UPDATE_SNOOZE_MS } from '../lib/mobile-config';
import { platform, isNativeShell } from '../platform';

/** Как часто без сети сверяемся, не кончился ли час после «Позже». */
const SNOOZE_CHECK_MS = 60 * 1000;

/**
 * Конфиг оболочки при старте и при каждом возврате в приложение (ТЗ-9, волна 4).
 *
 * Возвращает вердикт по версии: `required` — экран «обновите приложение» вместо CRM,
 * `available` — окно обновления. Флаги функций и политика организации оседают
 * в lib/mobile-config для всех остальных.
 */
export function useMobileConfig(signedIn: boolean): {
  verdict: 'none' | 'available' | 'required';
  config: MobileConfig | null;
  /** Показать окно обновления: обязательное — всегда, обычное — если не отложено. */
  offer: boolean;
  /** «Позже»: молчим час в этом запуске. */
  skip: () => void;
} {
  const [config, setConfig] = useState<MobileConfig | null>(null);
  const [verdict, setVerdict] = useState<'none' | 'available' | 'required'>('none');
  const [offer, setOffer] = useState(false);
  /*
    Отсрочка живёт только в памяти, а не в localStorage — намеренно: новый запуск
    приложения (или новый вход) снова напоминает об обновлении, даже если «Позже»
    нажали случайно. В пределах запуска окно возвращается через час.
  */
  const snoozedUntil = useRef<number | null>(null);
  const last = useRef<{ v: 'none' | 'available' | 'required'; release: MobileConfig['android'] } | null>(null);

  useEffect(() => {
    if (!signedIn || !isNativeShell()) return;
    let alive = true;
    snoozedUntil.current = null;
    const evaluate = () => {
      if (!last.current) return;
      setOffer(shouldOfferUpdate(last.current.v, last.current.release, snoozedUntil.current, Date.now()));
    };
    const load = async () => {
      try {
        const c = await api.mobileConfig();
        if (!alive) return;
        setMobileConfig(c); setConfig(c);
        const v = updateVerdict(platform.info().nativeVersion, c.android);
        setVerdict(v);
        last.current = { v, release: c.android };
        evaluate();
      } catch { /* нет сети — работаем с тем, что есть */ }
    };
    void load();
    const onVisible = () => { if (document.visibilityState === 'visible') void load(); };
    document.addEventListener('visibilitychange', onVisible);
    // Долгая работа без сворачивания: visibilitychange не придёт, час отсчитываем сами.
    const timer = window.setInterval(() => {
      if (snoozedUntil.current !== null && Date.now() >= snoozedUntil.current) evaluate();
    }, SNOOZE_CHECK_MS);
    return () => {
      alive = false;
      document.removeEventListener('visibilitychange', onVisible);
      window.clearInterval(timer);
    };
  }, [signedIn]);

  const skip = () => {
    setOffer(false);
    snoozedUntil.current = Date.now() + UPDATE_SNOOZE_MS;
  };

  return { verdict, config, offer, skip };
}
