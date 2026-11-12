import { useEffect, useState } from 'react';
import { billingApi, type BillingView } from '../../lib/billing-api';
import { dayMonth } from '../../lib/tg-bonus';
import { useTrialLimits } from '../../lib/trial-limits';
import { useAuth } from '../../state/auth';
import { TeamBonusBlock } from './TeamBonusBlock';

/**
 * Блок пробного периода в «Настройки → Тариф и ИИ»: 14 дней без условий, как на сайте
 * (#4778: кнопки «Открыть бота» за +7 дней больше нет) — и лимиты пробного.
 */
export function TrialBlock() {
  const [v, setV] = useState<BillingView | null>(null);
  const limits = useTrialLimits();
  const { user } = useAuth();
  useEffect(() => { billingApi.view().then(setV).catch(() => undefined); }, []);
  const t = v?.trial;
  const team = v?.teamBonus ? (
    <TeamBonusBlock bonus={v.teamBonus} canInvite={user?.role === 'owner' || user?.role === 'manager'}
      onChanged={() => void billingApi.view().then(setV).catch(() => undefined)} />
  ) : null;
  if (!t) return team;
  return (
    <>
    <div className="drawer-section">
      <div className="drawer-section-title">Пробный период</div>
      <p style={{ margin: 0 }}>Пробный период — {t.baseDays} дней бесплатно, без условий: до {dayMonth(t.until)}.</p>
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
