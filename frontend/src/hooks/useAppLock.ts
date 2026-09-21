import { useEffect, useRef, useState } from 'react';
import { platform, isNativeShell } from '../platform';
import { readLockPolicy, shouldLock } from '../lib/app-lock';
import { effectiveLockPolicy, mobileConfig } from '../lib/mobile-config';

/** Своя политика, но не мягче той, что задала организация (приходит с /mobile/config). */
const policy = () => effectiveLockPolicy(readLockPolicy(), mobileConfig()?.biometrics.minLockPolicy);

/**
 * Когда показывать экран блокировки (ТЗ-9, волна 3).
 *
 * Только в нативной оболочке и только если на устройстве есть биометрия (или код
 * устройства — плагин умеет и его): в браузере запирать нечем. Ушли в фон —
 * запоминаем когда; вернулись — сверяем с политикой. Холодный старт с живой сессией
 * — тоже «вернулись»: время ухода лежит в localStorage и переживает перезапуск.
 */
const HIDDEN_KEY = 'teamcrm.lock-hidden-at';

export function useAppLock(signedIn: boolean): { locked: boolean; unlock: () => void } {
  const [locked, setLocked] = useState(false);
  const available = useRef(false);

  useEffect(() => {
    if (!signedIn || !isNativeShell()) { setLocked(false); return; }
    let alive = true;
    void platform.biometrics.available().then((ok) => {
      if (!alive) return;
      available.current = ok;
      // холодный старт: свернули давно — запираем сразу
      const hiddenAt = Number(localStorage.getItem(HIDDEN_KEY) ?? '') || null;
      if (ok && shouldLock(policy(), hiddenAt, Date.now())) setLocked(true);
    });
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        try { localStorage.setItem(HIDDEN_KEY, String(Date.now())); } catch { /* приватный режим */ }
        return;
      }
      const hiddenAt = Number(localStorage.getItem(HIDDEN_KEY) ?? '') || null;
      if (available.current && shouldLock(policy(), hiddenAt, Date.now())) setLocked(true);
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => { alive = false; document.removeEventListener('visibilitychange', onVisibility); };
  }, [signedIn]);

  const unlock = () => {
    setLocked(false);
    try { localStorage.removeItem(HIDDEN_KEY); } catch { /* ничего */ }
  };
  return { locked, unlock };
}