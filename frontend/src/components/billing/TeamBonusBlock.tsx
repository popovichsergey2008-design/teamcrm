import { useState } from 'react';
import { Icon } from '../Icon';
import { InviteTeamDialog } from '../InviteTeamDialog';
import { dayMonth } from '../../lib/tg-bonus';
import type { BillingView } from '../../lib/billing-api';
import './billing.css';

/**
 * «Пригласить команду · +1 мес» (Борис, чат 10.11): 6 человек в команде, не считая
 * владельца, — и месяц бесплатно, один раз, к пробному или оплаченному сроку.
 * Начислил сервер — показываем итог; пока нет — сколько осталось позвать и кнопку.
 */
export function TeamBonusBlock({ bonus, canInvite, onChanged }: {
  bonus: NonNullable<BillingView['teamBonus']>;
  canInvite: boolean;
  onChanged: () => void;
}) {
  const [inviteOpen, setInviteOpen] = useState(false);
  const left = Math.max(0, bonus.need - bonus.invited);
  const month = bonus.months === 1 ? 'месяц' : `${bonus.months} мес.`;
  const plus = bonus.months === 1 ? '1 месяц' : `${bonus.months} мес.`;
  return (
    <div className="drawer-section">
      <div className="drawer-section-title">Пригласить команду · +1 мес</div>
      {bonus.grantedAt ? (
        <p style={{ margin: 0 }}>
          <Icon name="check-circle" size={14} /> Спасибо за команду: +{plus} начислен{bonus.until ? `, всё работает до ${dayMonth(bonus.until)}` : ''}.
        </p>
      ) : (
        <>
          <p style={{ margin: '0 0 6px' }}>
            Пригласите в QEVO {bonus.need} человек — и получите {month} бесплатно. Добавится к пробному периоду или к оплаченному сроку.
          </p>
          <div className="team-bonus-bar" role="progressbar" aria-valuemin={0} aria-valuemax={bonus.need} aria-valuenow={Math.min(bonus.invited, bonus.need)} aria-label="Приглашено в команду">
            <span style={{ width: `${Math.min(100, Math.round((bonus.invited / bonus.need) * 100))}%` }} />
          </div>
          <p className="dim" style={{ margin: '6px 0 8px', fontSize: 13 }}>
            В команде {Math.min(bonus.invited, bonus.need)} из {bonus.need}{left ? ` — осталось ${left}` : ''}. Считаются те, кто принял приглашение.
          </p>
          {canInvite && (
            <button type="button" className="ui-btn ui-btn-outline ui-btn-sm" onClick={() => setInviteOpen(true)}>
              <Icon name="users" size={14} /> Пригласить
            </button>
          )}
        </>
      )}
      {inviteOpen && <InviteTeamDialog onClose={() => setInviteOpen(false)} onDone={() => { setInviteOpen(false); onChanged(); }} />}
    </div>
  );
}
