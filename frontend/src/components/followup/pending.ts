import { api } from '../../lib/api';

/**
 * Итог для клиента готов, а организатора в этот момент не было в сети (#1525, фича 5):
 * событие followup.ready он пропустил. При следующем входе окно всплывает само — один
 * раз и только по свежей встрече (за сутки): вчерашний отчёт клиенту уже никого не удивит.
 * Отдельный кусок, чтобы первый экран не тяжелел.
 */
export async function pendingFollowup(): Promise<string | null> {
  const { items } = await api.proposals();
  const fresh = Date.now() - 24 * 3600_000;
  const p = items.find((x) => x.skill === 'followup' && ['new', 'seen'].includes(x.status)
    && new Date(x.createdAt).getTime() > fresh && !shown(x.id));
  return p ? p.id : null;
}

function shown(id: string): boolean {
  try { return localStorage.getItem(`qevo.followupPopup.${id}`) === '1'; } catch { return true; }
}
