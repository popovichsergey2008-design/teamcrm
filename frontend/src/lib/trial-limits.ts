import { useEffect, useState } from 'react';
import { request } from './api';

/** Лимиты пробного периода (#4779, п. 4): ИИ-разбор созвона и задачи голосом. */
export type TrialLimits =
  | { trial: false }
  | { trial: true; callAi: { used: number; limit: number; maxMinutes: number }; voiceTasks: { used: number; limit: number } };

let cache: { at: number; v: TrialLimits } | null = null;

export async function loadTrialLimits(fresh = false): Promise<TrialLimits | null> {
  if (!fresh && cache && Date.now() - cache.at < 60_000) return cache.v;
  try {
    const v = await request<TrialLimits>('GET', '/billing/trial-limits');
    cache = { at: Date.now(), v };
    return v;
  } catch { return null; }
}

/**
 * Лимиты пробного; перечитываются после постановки задач — счётчик голосовых меняется.
 * `enabled: false` — гостю созвона: у него нет входа, запрос дал бы 401 и выход из сессии.
 */
export function useTrialLimits(enabled = true): TrialLimits | null {
  const [v, setV] = useState<TrialLimits | null>(enabled ? cache?.v ?? null : null);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    const load = (fresh: boolean) => loadTrialLimits(fresh).then((r) => { if (alive && r) setV(r); });
    void load(false);
    const on = () => void load(true);
    window.addEventListener('teamcrm:tasks-changed', on);
    return () => { alive = false; window.removeEventListener('teamcrm:tasks-changed', on); };
  }, [enabled]);
  return v;
}
