import { useEffect, useState } from 'react';
import { Icon, IconName } from './Icon';
import { api } from '../lib/api';
import { lazyComponent } from '../lib/lazy';

const FocusDialog = lazyComponent(() => import('../pages/calendar/FocusDialog').then((m) => m.FocusDialog));

type MyStatus = 'free' | 'busy' | 'quick' | 'call' | 'lunch' | 'away' | 'deep';

/*
  #4782, п. 8: статус сразу объясняет коллеге, можно ли звонить и когда ждать ответа.
  Подсказки — правила из документа: звонки, уведомления и когда статус кончается.
*/
const OPTIONS: { key: MyStatus; label: string; icon: IconName; hint: string }[] = [
  { key: 'free', label: 'Свободен', icon: 'check-circle', hint: 'Звонки и уведомления по обычным правилам — пока не смените статус' },
  { key: 'busy', label: 'Занят', icon: 'target', hint: 'Перед звонком коллега увидит «Занят» и сможет продолжить. Обычные сообщения тихие, личные упоминания — по настройкам. До снятия вручную' },
  { key: 'quick', label: 'Быстрые ответы', icon: 'zap', hint: 'Звонки как обычно. Личные сообщения и упоминания — по настройкам, остальное тихо. На час или вручную' },
  { key: 'call', label: 'На созвоне', icon: 'phone', hint: 'Второй звонок без звука, коллеге предложим оставить сообщение. Тихо на время звонка. На час или вручную' },
  { key: 'lunch', label: 'Обед / перерыв', icon: 'clock', hint: 'Без звука, коллега видит время возвращения. Тихо, срочное — по вашему разрешению. На час или вручную' },
  { key: 'away', label: 'Отошёл', icon: 'user', hint: 'Звонки и уведомления по личным настройкам — до возвращения или вручную' },
  { key: 'deep', label: 'Глубокий фокус', icon: 'target', hint: 'Звонки — только срочные по вашему разрешению. Тихо, после — одно сообщение со списком. 10–120 минут или вручную' },
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
  const [deepOpen, setDeepOpen] = useState(false);

  useEffect(() => {
    if (!userId) return;
    let alive = true;
    Promise.all([api.getFocus().catch(() => null), api.presence().catch(() => [])])
      .then(([focus, rows]) => {
        if (!alive) return;
        const manual = rows.find((r) => String(r.userId) === String(userId))?.status ?? null;
        const live = focus && (!focus.until || new Date(focus.until).getTime() > Date.now()) ? focus : null;
        setStatus(live?.kind === 'call' ? 'call' : live?.kind === 'break' ? 'lunch' : live?.kind === 'quick' ? 'quick'
          : live?.kind === 'deep' ? 'deep' : manual === 'busy' ? 'busy' : manual === 'away' ? 'away' : 'free');
      });
    return () => { alive = false; };
  }, [userId]);

  const pick = async (next: MyStatus) => {
    // глубокий фокус — через окно выбора задач и времени (#4782, п. 1–2)
    if (next === 'deep') { setDeepOpen(true); return; }
    if (busy || next === status) return;
    const prev = status;
    setStatus(next);
    setBusy(true);
    try {
      // ручной статус — у «Занят» и «Отошёл»; у остальных его снимаем, иначе он перекроет перерыв
      await api.setPresenceStatus(next === 'busy' ? 'busy' : next === 'away' ? 'away' : null);
      if (next === 'call') await api.setFocus({ kind: 'call', minutes: 60 });
      else if (next === 'lunch') await api.setFocus({ kind: 'break', note: 'Обед', minutes: 60 });
      else if (next === 'quick') await api.setFocus({ kind: 'quick', note: 'Разбираю почту и чаты', minutes: 60 });
      else if (prev === 'call' || prev === 'lunch' || prev === 'quick' || prev === 'deep') await api.clearFocus();
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
      {deepOpen && <FocusDialog onClose={() => setDeepOpen(false)} onSaved={() => { setDeepOpen(false); setStatus('deep'); }} />}
    </div>
  );
}
