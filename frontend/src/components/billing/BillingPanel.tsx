import { useEffect, useState } from 'react';
import { Icon } from '../Icon';
import { SkeletonList } from '../Skeleton';
import { ApiError } from '../../lib/api';
import { billingApi, type BillingView } from '../../lib/billing-api';
import { useEscape } from '../../hooks/useEscape';
import { overlayProps } from '../../lib/overlay';
import '../ai-plan.css';
import './billing.css';

const rub = (n: number) => `${n.toLocaleString('ru-RU')} ₽`;
const day = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' }) : '');
const PAY_STATUS: Record<string, string> = { pending: 'ждёт оплаты', succeeded: 'оплачен', canceled: 'отменён', refunded: 'возвращён' };

/** Строка состояния подписки — одна фраза: что сейчас и до какого числа. */
export function statusLine(v: BillingView): string {
  if (v.complimentary) return 'Подписка действует без ограничений.';
  switch (v.status) {
    case 'TRIAL': return `Пробный период до ${day(v.until)}. Карта не нужна — выберите тариф, когда будете готовы.`;
    case 'ACTIVE': return `Оплачено до ${day(v.until)}${v.plan ? `, тариф «${v.plan.title}»${v.period === 'year' ? ' на год' : ''}` : ''}.`;
    case 'GRACE': return `Подписка не оплачена. До ${day(v.until)} всё работает, потом QEVO перейдёт в режим «только чтение».`;
    default: return 'QEVO в режиме «только чтение»: смотреть можно, менять — нет. Данные сохранены — после оплаты всё заработает сразу.';
  }
}

/**
 * «Настройки → Тариф и оплата» (мастер-план релиза, этап 4): состояние подписки, тарифы,
 * оплата на странице ЮKassa и история платежей. Платит владелец; остальные видят состояние.
 */
export default function BillingPanel({ canPay, onClose }: { canPay: boolean; onClose: () => void }) {
  useEscape(onClose);
  const [v, setV] = useState<BillingView | null>(null);
  const [err, setErr] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState('');
  const [period, setPeriod] = useState<'month' | 'year'>('month');

  const load = () => billingApi.view().then(setV).catch((e) => setErr(e instanceof ApiError ? e.message : 'Не удалось загрузить'));

  useEffect(() => {
    // вернулись со страницы ЮKassa: ?paid=<наш id платежа> — сверяем сразу, не ждём уведомления
    const paid = new URLSearchParams(window.location.search).get('paid');
    if (paid) {
      history.replaceState(history.state, '', window.location.pathname);
      billingApi.check(paid)
        .then((r) => setNote(r.status === 'succeeded' || r.status === 'already' ? 'Оплата прошла — спасибо!' : r.status === 'canceled' ? 'Оплата отменена.' : 'Платёж ещё обрабатывается — обновим, как только ЮKassa подтвердит.'))
        .catch(() => undefined)
        .finally(() => void load());
    } else void load();
  }, []);

  const pay = async (code: string) => {
    setBusy(code); setErr('');
    try {
      const r = await billingApi.checkout(code, period);
      window.location.href = r.confirmationUrl; // страница ЮKassa: данные карты к нам не попадают
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Не получилось начать оплату');
      setBusy('');
    }
  };

  return (
    <div className="drawer-overlay" {...overlayProps(onClose)}>
      <aside className="drawer drawer-wide" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-head">
          <h3><Icon name="building" size={18} /> Тариф и оплата</h3>
          <button className="ui-btn ui-btn-ghost ui-btn-sm" onClick={onClose} title="Закрыть"><Icon name="close" /></button>
        </div>

        {!v && !err && <SkeletonList rows={4} />}
        {err && <div className="error-text" role="alert">{err}</div>}
        {note && <div className="pnl-good" role="status">{note}</div>}

        {v && (
          <>
            <div className="drawer-section">
              <div className="drawer-section-title">Подписка</div>
              <div className={v.status === 'READ_ONLY' || v.status === 'GRACE' ? 'error-text' : ''}>{statusLine(v)}</div>
              <div className="dim bil-note">Сотрудников в компании: {v.members}.</div>
              {v.testMode && <div className="dim bil-note">Тестовый режим ЮKassa: настоящие деньги не списываются.</div>}
            </div>

            {!v.complimentary && (
              <div className="drawer-section">
                <div className="drawer-section-title">Тарифы</div>
                {v.plans.some((p) => p.priceYear != null) && (
                  <div className="kv2-seg bil-period" role="group" aria-label="Период оплаты">
                    <button type="button" className="kv2-seg-btn" aria-pressed={period === 'month'} onClick={() => setPeriod('month')}>Помесячно</button>
                    <button type="button" className="kv2-seg-btn" aria-pressed={period === 'year'} onClick={() => setPeriod('year')}>На год</button>
                  </div>
                )}
                {!v.configured && <div className="dim">Оплата скоро появится. Пока всё работает — напишите в поддержку, если нужен счёт.</div>}
                <div className="bil-plans">
                  {v.plans.filter((p) => period === 'month' || p.priceYear != null).map((p) => {
                    const tooSmall = p.maxMembers !== null && v.members > p.maxMembers;
                    const year = period === 'year' && p.priceYear != null;
                    const current = v.plan?.code === p.code && v.status === 'ACTIVE';
                    return (
                      <div key={p.code} className={`bil-plan ${current ? 'bil-plan-current' : ''}`}>
                        <div className="bil-plan-title">{p.title}</div>
                        <div className="bil-plan-price">{rub(year ? p.priceYear! : p.price)} <span className="dim">{year ? '/ год' : '/ мес'}</span></div>
                        {year && <div className="dim bil-note">≈ {rub(Math.round(p.priceYear! / 12))} в месяц{p.priceYear! < p.price * 12 ? `, выгода ${rub(p.price * 12 - p.priceYear!)}` : ''}</div>}
                        <div className="dim bil-plan-text">{p.maxMembers ? `До ${p.maxMembers} сотрудников. ` : 'Без ограничения сотрудников. '}{p.description}</div>
                        {canPay && v.configured && (
                          <button
                            className="ui-btn ui-btn-primary ui-btn-sm"
                            disabled={!!busy || tooSmall}
                            title={tooSmall ? `В компании ${v.members} сотрудников — тариф не подходит` : undefined}
                            onClick={() => void pay(p.code)}
                          >
                            {busy === p.code ? '...' : current ? (year ? 'Продлить на год' : 'Продлить на месяц') : 'Оплатить'}
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
                {!canPay && <div className="dim bil-note">Оплачивает владелец компании.</div>}
                {v.lockedPrice != null && v.plan && <div className="dim bil-note">Продление — по цене, за которую вы платили: {rub(v.lockedPrice)} {v.period === 'year' ? 'за год' : 'в месяц'}. Если прайс изменится, предупредим заранее.</div>}
                {canPay && v.autopayAvailable && v.plan && (
                  <label className="bil-note">
                    <input type="checkbox" checked={v.autopay} onChange={(e) => void billingApi.autopay(e.target.checked).then(setV).catch(() => undefined)} />
                    {' '}Продлевать автоматически с сохранённой карты
                  </label>
                )}
              </div>
            )}

            {v.payments.length > 0 && (
              <div className="drawer-section">
                <div className="drawer-section-title">Платежи</div>
                <ul className="bil-payments">
                  {v.payments.map((p) => (
                    <li key={p.id}>
                      <span>{day(p.createdAt)}</span>
                      <span>{v.plans.find((x) => x.code === p.plan)?.title ?? p.plan}</span>
                      <span>{rub(p.amount)}{p.months === 12 ? ' · год' : ''}{p.test ? ' · тест' : ''}</span>
                      <span className="dim">{PAY_STATUS[p.status] ?? p.status}{p.periodEnd && p.status === 'succeeded' ? ` · до ${day(p.periodEnd)}` : ''}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}
      </aside>
    </div>
  );
}
