import { useEffect, useState } from 'react';
import { billingApi, type BillingView } from '../../lib/billing-api';
import { navigate } from '../../lib/router';
import { statusLine } from './BillingPanel';
import { openTelegramBot } from '../../lib/tg-bonus';
import '../qa-switch.css';

const DAY = 86_400_000;

/**
 * Плашка о подписке: за 3 дня до конца пробного, в льготные дни и в «только чтении».
 * Ленивая; сама спрашивает состояние — в остальное время её не видно.
 */
export default function BillingBar({ isOwner }: { isOwner: boolean }) {
  const [v, setV] = useState<BillingView | null>(null);
  const [hidden, setHidden] = useState(false);
  useEffect(() => { billingApi.view().then(setV).catch(() => undefined); }, []);
  if (!v || hidden || v.complimentary) return null;
  /*
    #4779, п. 3.4: за 2 дня до конца первых 7 дней — предложить +7 за Telegram-бота.
    Бонус уже взят — эта плашка не нужна, дальше обычная «за 3 дня до конца».
  */
  const t = v.trial;
  const firstLeft = t && !t.bonusGranted ? new Date(t.firstEnds).getTime() - Date.now() : null;
  if (firstLeft !== null && firstLeft > 0 && firstLeft <= 2 * DAY) {
    const days = Math.ceil(firstLeft / DAY);
    return (
      <div className="qa-bar" role="status">
        <span className="qa-bar-text">
          {days >= 2 ? 'Через 2 дня' : 'Завтра'} тест закончится. Зарегистрируйтесь в Telegram-боте: ещё 7 дней бесплатно.
        </span>
        <button type="button" className="qa-bar-back" onClick={() => void openTelegramBot()}>Открыть бота</button>
        <button type="button" className="qa-bar-back" onClick={() => setHidden(true)}>Позже</button>
      </div>
    );
  }
  const soon = v.status === 'TRIAL' && v.until && new Date(v.until).getTime() - Date.now() < 3 * DAY;
  if (!(soon || v.status === 'GRACE' || v.status === 'READ_ONLY')) return null;
  return (
    <div className="qa-bar" role="status">
      <span className="qa-bar-text">{statusLine(v)}{!isOwner && v.status !== 'TRIAL' ? ' Оплачивает владелец компании.' : ''}</span>
      {isOwner && (
        <button type="button" className="qa-bar-back" onClick={() => navigate({ section: 'settings', tab: 'billing' })}>
          {v.status === 'TRIAL' ? 'Выбрать тариф' : 'Оплатить'}
        </button>
      )}
      {v.status !== 'READ_ONLY' && <button type="button" className="qa-bar-back" onClick={() => setHidden(true)}>Позже</button>}
    </div>
  );
}
