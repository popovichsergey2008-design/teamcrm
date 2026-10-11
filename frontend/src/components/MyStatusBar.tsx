import { useEffect, useState } from 'react';
import { Icon, IconName } from './Icon';
import { api } from '../lib/api';

type MyStatus = 'free' | 'busy' | 'call' | 'lunch';

const OPTIONS: { key: MyStatus; label: string; icon: IconName; hint: string }[] = [
  { key: 'free', label: 'Свободен', icon: 'check-circle', hint: 'Можно писать и звать' },
  { key: 'busy', label: 'Занят', icon: 'target', hint: 'Не беспокоить, пока не сниму сам' },
  { key: 'call', label: 'На созвоне', icon: 'phone', hint: 'На час — потом снимется сам' },
  { key: 'lunch', label: 'На обеде', icon: 'clock', hint: 'На час — потом снимется сам' },
];

/** Событие для панели и «Команды сейчас»: свой статус поменяли здесь. */
export const PRESENCE_CHANGED = 'teamcrm:presence-changed';

/**
 * «Мой статус» на экране «Фокус дня» (#1535).
 *
 * Статусы жили в двух местах, и оба далеко от экрана, где человек начинает день:
 * «занят / отошёл» — в меню профиля, «на созвоне / перерыв» — в меню фокуса там же
 * и в палитре команд. На экране их не было вовсе, и со стороны это выглядело как
 * «кнопки пропали».
 *
 * Хранилища прежние, нового не заводим: «Занят» — ручной статус (`presence_status`),
 * «На созвоне» и «На обеде» — фокус с концом через час (`user_focus`), «Свободен»
 * снимает оба. По ним же «Команда сейчас» показывает человека коллегам.
 */
export function MyStatusBar({ userId }: { userId: string | undefined }) {
  const [status, setStatus] = useState<MyStatus | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!userId) return;
    let alive = true;
    Promise.all([api.getFocus().catch(() => null), api.presence().catch(() => [])])
      .then(([focus, rows]) => {
        if (!alive) return;
        const manual = rows.find((r) => String(r.userId) === String(userId))?.status ?? null;
        const live = focus && (!focus.until || new Date(focus.until).getTime() > Date.now()) ? focus : null;
        setStatus(live?.kind === 'call' ? 'call' : live?.kind === 'break' ? 'lunch' : manual === 'busy' ? 'busy' : 'free');
      });
    return () => { alive = false; };
  }, [userId]);

  const pick = async (next: MyStatus) => {
    if (busy || next === status) return;
    const prev = status;
    setStatus(next);
    setBusy(true);
    try {
      // ручной статус — только у «Занят»; у остальных его снимаем, иначе он перекроет перерыв
      await api.setPresenceStatus(next === 'busy' ? 'busy' : null);
      if (next === 'call') await api.setFocus({ kind: 'call', minutes: 60 });
      else if (next === 'lunch') await api.setFocus({ kind: 'break', note: 'Обед', minutes: 60 });
      else if (prev === 'call' || prev === 'lunch') await api.clearFocus();
      window.dispatchEvent(new Event('teamcrm:focus-changed'));
      window.dispatchEvent(new Event(PRESENCE_CHANGED));
    } catch {
      setStatus(prev);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="menu-theme my-status" role="group" aria-label="Мой статус для коллег">
      <span className="dim">Мой статус</span>
      <span className="menu-status">
        {OPTIONS.map((o) => (
          <button
            key={o.key}
            className={`menu-status-btn${status === o.key ? ' active' : ''}`}
            onClick={() => void pick(o.key)}
            disabled={busy}
            aria-pressed={status === o.key}
            title={o.hint}
          >
            <Icon name={o.icon} size={13} /> {o.label}
          </button>
        ))}
      </span>
    </div>
  );
}
