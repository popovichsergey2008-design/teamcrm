import { useEffect, useState } from 'react';
import { billingApi, type BillingView } from '../../lib/billing-api';
import { dayMonth, daysUntil, openTelegramBot } from '../../lib/tg-bonus';
import { Icon } from '../Icon';
import { useTrialLimits } from '../../lib/trial-limits';
import { useAuth } from '../../state/auth';
import { TeamBonusBlock } from './TeamBonusBlock';

/**
 * Блок пробного периода в «Настройки → Тариф и ИИ» (#4779, п. 3): на сайте обещаем
 * 14 дней, а условие 7 + 7 объясняем здесь. Бонус начислен — подсказки о нём прячем,
 * пишем итог. Вернулись из Telegram — перечитываем: бонус мог прийти, пока вкладка спала.
 */
export function TrialBlock() {
  const [v, setV] = useState<BillingView | null>(null);
  const [note, setNote] = useState('');
  const limits = useTrialLimits();
  const { user } = useAuth();
  useEffect(() => {
    const load = () => billingApi.view().then(setV).catch(() => undefined);
    load();
    window.addEventListener('focus', load);
    return () => window.removeEventListener('focus', load);
  }, []);
  const t = v?.trial;
  const team = v?.teamBonus ? (
    <TeamBonusBlock bonus={v.teamBonus} canInvite={user?.role === 'owner' || user?.role === 'manager'}
      onChanged={() => void billingApi.view().then(setV).catch(() => undefined)} />
  ) : null;
  if (!t) return team;
  const left = Math.min(t.baseDays, daysUntil(t.firstEnds));
  return (
    <>
    <div className="drawer-section">
      <div className="drawer-section-title">Пробный период</div>
      {/* ТЗ 10.11: 14 дней без условий — бонуса за Telegram-бота больше нет */}
      {!t.bonusDays ? (
        <p style={{ margin: 0 }}>Пробный период — {t.baseDays} дней бесплатно, без условий: до {dayMonth(t.until)}.</p>
      ) : t.bonusGranted ? (
        <p style={{ margin: 0 }}><Icon name="check-circle" size={14} /> Готово, +{t.bonusDays} дней начислены. Пробный период до {dayMonth(t.until)}.</p>
      ) : (
        <>
          <p style={{ margin: '0 0 8px' }}>
            Осталось {left} {left === 1 ? 'день' : left >= 2 && left <= 4 ? 'дня' : 'дней'} из {t.baseDays}. Зарегистрируйтесь в Telegram-боте и получите ещё {t.bonusDays} дней.
          </p>
          <button type="button" className="ui-btn ui-btn-outline ui-btn-sm"
            onClick={() => void openTelegramBot().then((ok) => setNote(ok ? 'Открыли Telegram: нажмите «Запустить» — бот начислит +7 дней.' : 'Telegram-бот сейчас недоступен — попробуйте позже.'))}>
            <Icon name="send" size={14} /> Открыть бота
          </button>
          {note && <p className="dim" style={{ margin: '6px 0 0', fontSize: 12 }}>{note}</p>}
        </>
      )}
      {/* #4779, п. 4.5: лимиты пробного периода */}
      {limits?.trial && (
        <ul className="dim" style={{ margin: '8px 0 0', paddingLeft: 18, fontSize: 13 }}>
          <li>ИИ-разбор созвона: использовано {limits.callAi.used} из {limits.callAi.limit} (до {limits.callAi.maxMinutes} минут)</li>
          <li>Задачи голосом: использовано {limits.voiceTasks.used} из {limits.voiceTasks.limit}</li>
        </ul>
      )}
    </div>
    {team}
    </>
  );
}
