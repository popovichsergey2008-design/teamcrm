import { useEffect, useState } from 'react';
import { Icon } from '../Icon';
import { SkeletonList } from '../Skeleton';
import { ApiError } from '../../lib/api';
import { billingApi, periodLabel, periodPrice, type BillingView } from '../../lib/billing-api';
import { useEscape } from '../../hooks/useEscape';
import { overlayProps } from '../../lib/overlay';
import { TeamBonusBlock } from './TeamBonusBlock';
import { isNativeShell } from '../../platform';
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
    case 'ACTIVE': return `Оплачено до ${day(v.until)}${v.plan ? `, тариф «${v.plan.title}»${v.months && v.months > 1 ? ` на ${periodLabel(v.months)}` : ''}` : ''}.`;
    case 'GRACE': return `Подписка не оплачена. До ${day(v.until)} всё работает, потом QEVO перейдёт в режим «только чтение».`;
    default: return 'QEVO в режиме «только чтение»: смотреть можно, менять — нет. Данные сохранены — после оплаты всё заработает сразу.';
  }
}

/**
 * «Настройки → Тариф и оплата» (мастер-план релиза, этап 4): состояние подписки, тарифы,
 * оплата на странице ЮKassa и история платежей. Платит владелец; остальные видят состояние.
 */
/** «1 пользователь», «3 пользователя», «5 пользователей». */
const people = (n: number) => { const a = n % 100; const b = n % 10; return a > 10 && a < 20 ? 'пользователей' : b === 1 ? 'пользователь' : b >= 2 && b <= 4 ? 'пользователя' : 'пользователей'; };
const colleagues = (n: number) => { const a = n % 100; const b = n % 10; return a > 10 && a < 20 ? 'сотрудников' : b === 1 ? 'сотрудник' : b >= 2 && b <= 4 ? 'сотрудника' : 'сотрудников'; };

export default function BillingPanel({ canPay, onClose }: { canPay: boolean; onClose: () => void }) {
  useEscape(onClose);
  const [v, setV] = useState<BillingView | null>(null);
  const [err, setErr] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState('');
  /*
    19.11.2026: срок оплаты — любое число месяцев. На 1–11 месяцев сумма = цена месяца ×
    месяцы (скидки нет), на год — годовая цена со скидкой.
  */
  const [months, setMonths] = useState(1);
  /*
    #5000: «оплатить 5 человек на 2 месяца», а в команде пока четверо — число пользователей
    выбирают сами: не меньше, чем сейчас в команде (вместе с владельцем), больше — можно.
  */
  /*
    20.11.2026 (заказчик): считается каждый человек в пространстве — автоматически, а сверху
    можно добавить ещё мест (для тех, кого пригласят). Итого = (в пространстве + добавлено) × цена.
  */
  const [extra, setExtra] = useState(0);
  /** Сколько мест оплачиваем: все, кто в пространстве, плюс добавленные. */
  const seatsFor = (view: BillingView) => Math.max(1, view.members) + extra;

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
      const r = await billingApi.checkout(code, months, v ? seatsFor(v) : undefined);
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
              <div className="dim bil-note">В команде сейчас {v.members} {people(v.members)} — вы и {Math.max(0, v.members - 1)} {colleagues(v.members - 1)}.{v.seats ? ` Оплачено мест: ${v.seats}.` : ''}</div>
              {v.testMode && <div className="dim bil-note">Тестовый режим ЮKassa: настоящие деньги не списываются.</div>}
            </div>

            {v.teamBonus && <TeamBonusBlock bonus={v.teamBonus} canInvite={canPay} onChanged={() => void billingApi.view().then(setV).catch(() => undefined)} />}

            {!v.complimentary && (
              <div className="drawer-section">
                <div className="drawer-section-title">Тарифы</div>
                <div className="bil-term">
                  <label className="bil-term-label" htmlFor="bil-months">Оплатить на</label>
                  <select id="bil-months" className="ui-input ui-input-sm bil-term-select" value={months} onChange={(e) => setMonths(Number(e.target.value))}>
                    {Array.from({ length: 11 }, (_, i) => i + 1).map((n) => <option key={n} value={n}>{periodLabel(n)}</option>)}
                    <option value={12}>1 год{v.plans.some((p) => p.priceYear != null && p.priceYear < p.price * 12) ? ' — со скидкой' : ''}</option>
                  </select>
                  <span className="kv2-seg" role="group" aria-label="Быстрый выбор срока">
                    {[1, 3, 6, 12].map((n) => (
                      <button key={n} type="button" className="kv2-seg-btn" aria-pressed={months === n} onClick={() => setMonths(n)}>{n === 12 ? 'Год' : `${n} мес`}</button>
                    ))}
                  </span>
                </div>
                <div className="dim bil-note">Скидка — только при оплате сразу за год. На 1–11 месяцев сумма — цена месяца × число месяцев.</div>
                {!v.configured && <div className="dim">Оплата скоро появится. Пока всё работает — напишите в поддержку, если нужен счёт.</div>}
                <div className="bil-plans">
                  {v.plans.map((p) => {
                    const tooSmall = p.maxMembers !== null && v.members > p.maxMembers;
                    const year = months === 12 && p.priceYear != null;
                    const sum = periodPrice(p.price, p.priceYear, months);
                    const term = months === 1 ? 'в месяц' : `за ${periodLabel(months)}`;
                    const current = v.plan?.code === p.code && v.status === 'ACTIVE';
                    return (
                      <div key={p.code} className={`bil-plan ${current ? 'bil-plan-current' : ''}`}>
                        <div className="bil-plan-title">{p.title}</div>
                        {/* ТЗ 10.11: один тариф «QEVO» как на сайте — цена за пользователя */}
                        {p.perMember ? (<>
                          <div className="bil-plan-price">от {rub(p.priceYear != null ? Math.round(p.priceYear / 12) : p.price)} <span className="dim">за пользователя в месяц</span></div>
                          <div className="dim bil-note">{p.priceYear != null ? `${rub(Math.round(p.priceYear / 12))} при оплате за год, ` : ''}{rub(p.price)} при помесячной оплате</div>
                          <div className="dim bil-plan-text">{p.description}</div>
                          <div className="bil-seats-box">
                            <div>В пространстве: <b>{Math.max(1, v.members)} {people(Math.max(1, v.members))}</b></div>
                            <div className="bil-seats-row">
                              <span>Добавить мест</span>
                              <span className="bil-stepper">
                                <button type="button" onClick={() => setExtra((n) => Math.max(0, n - 1))} disabled={extra === 0} aria-label="Меньше">−</button>
                                <input type="number" min={0} max={500} value={extra} aria-label="Сколько мест добавить"
                                  onChange={(e) => setExtra(Math.max(0, Math.min(500, Math.round(Number(e.target.value) || 0))))} />
                                <button type="button" onClick={() => setExtra((n) => Math.min(500, n + 1))} aria-label="Больше">+</button>
                              </span>
                            </div>
                            <div className="dim bil-note">Каждый человек в пространстве считается сам. Добавленные места — для тех, кого ещё пригласите.</div>
                          </div>
                          <div className="bil-note">К оплате: {seatsFor(v)} {people(seatsFor(v))} × {rub(sum)} = <b>{rub(sum * seatsFor(v))}</b> {term}{year && p.priceYear! < p.price * 12 ? `, выгода ${rub((p.price * 12 - p.priceYear!) * seatsFor(v))}` : ''}</div>
                        </>) : (<>
                        <div className="bil-plan-price">{rub(sum)} <span className="dim">{term}</span></div>
                        {months > 1 && !year && <div className="dim bil-note">{rub(p.price)} × {months}</div>}
                        {year && <div className="dim bil-note">≈ {rub(Math.round(p.priceYear! / 12))} в месяц{p.priceYear! < p.price * 12 ? `, выгода ${rub(p.price * 12 - p.priceYear!)}` : ''}</div>}
                        <div className="dim bil-plan-text">{p.maxMembers ? `До ${p.maxMembers} сотрудников. ` : 'Без ограничения сотрудников. '}{p.description}</div>
                        </>)}
                        {/* 17.11: в приложении для Android оплаты нет — только в веб-версии */}
                        {canPay && v.configured && !isNativeShell() && (
                          <button
                            className="ui-btn ui-btn-primary ui-btn-sm"
                            disabled={!!busy || tooSmall}
                            title={tooSmall ? `В компании ${v.members} сотрудников — тариф не подходит` : undefined}
                            onClick={() => void pay(p.code)}
                          >
                            {busy === p.code ? '...' : `${current ? 'Продлить' : 'Оплатить'} на ${periodLabel(months)}`}
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
                {!canPay && <div className="dim bil-note">Оплачивает владелец компании.</div>}
                {canPay && v.configured && isNativeShell() && (
                  <div className="bil-note"><Icon name="info" size={14} /> Оплата — в веб-версии: откройте <b>app.qevo.one</b> в браузере на компьютере или телефоне, «Настройки → Тариф и оплата».</div>
                )}
                {v.lockedPrice != null && v.plan && <div className="dim bil-note">Продление — по цене, за которую вы платили: {rub(v.lockedPrice)} {v.months && v.months > 1 ? `за ${periodLabel(v.months)}` : 'в месяц'}. Если прайс изменится, предупредим заранее.</div>}
                {v.priceChange && <div className="bil-note"><b>Цена меняется:</b> {v.priceChange.nextPeriod ? `со следующего продления после ${new Date(v.priceChange.at).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' })}` : `с продления ${new Date(v.priceChange.at).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' })}`} — {rub(v.priceChange.price)} {v.months && v.months > 1 ? `за ${periodLabel(v.months)}` : 'в месяц'}.</div>}
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
                      <span>{rub(p.amount)}{p.months && p.months > 1 ? ` · ${periodLabel(p.months)}` : ''}{p.test ? ' · тест' : ''}</span>
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
