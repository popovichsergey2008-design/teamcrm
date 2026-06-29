import type { Pnl } from '../types';

const money = (n: number | null | undefined) =>
  n === null || n === undefined ? '—' : '₽ ' + Number(n).toLocaleString('ru-RU', { maximumFractionDigits: 0 });
const pct = (n: number | null | undefined) => (n === null || n === undefined ? '—' : `${n}%`);

/** Панель P&L в моменте: бюджет, себестоимость, маржа факт vs план (фича №5). */
export function PnlPanel({ pnl, alert }: { pnl: Pnl | null; alert: string | null }) {
  if (!pnl) return null;
  const marginLow =
    pnl.marginActual !== null && pnl.plannedMargin !== null && pnl.marginActual < pnl.plannedMargin;
  return (
    <div className="pnl">
      {alert && <div className="pnl-alert">⚠ {alert}</div>}
      <div className="pnl-grid">
        <div className="pnl-cell">
          <span className="pnl-label">Бюджет</span>
          <span className="pnl-val">{money(pnl.budget)}</span>
        </div>
        <div className="pnl-cell">
          <span className="pnl-label">Себестоимость</span>
          <span className="pnl-val">{money(pnl.costActual)}</span>
        </div>
        <div className="pnl-cell">
          <span className="pnl-label">Маржа факт</span>
          <span className={`pnl-val ${marginLow ? 'pnl-bad' : 'pnl-good'}`}>{pct(pnl.marginActual)}</span>
        </div>
        {pnl.plannedMargin !== null && (
          <div className="pnl-cell">
            <span className="pnl-label">Маржа план</span>
            <span className="pnl-val">
              {pct(pnl.plannedMargin)}
              {pnl.marginDelta !== null && (
                <span className={`pnl-delta ${pnl.marginDelta < 0 ? 'pnl-bad' : 'pnl-good'}`}>
                  {pnl.marginDelta >= 0 ? ' +' : ' '}
                  {pnl.marginDelta}
                </span>
              )}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
