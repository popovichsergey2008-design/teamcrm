import type { CostOfWork, Pnl } from '../types';
import { Icon } from './Icon';

const money = (n: number | null | undefined) =>
  n === null || n === undefined ? '—' : '₽ ' + Number(n).toLocaleString('ru-RU', { maximumFractionDigits: 0 });
const pct = (n: number | null | undefined) => (n === null || n === undefined ? '—' : `${n}%`);
const num = (n: number) => Number(n).toLocaleString('ru-RU', { maximumFractionDigits: n < 100 ? 1 : 0 });

/** Панель P&L в моменте: бюджет, себестоимость, маржа факт vs план (фича №5) + полная себестоимость (люди+ИИ). */
export function PnlPanel({ pnl, alert, cow }: { pnl: Pnl | null; alert: string | null; cow?: CostOfWork | null }) {
  if (!pnl) return null;
  const marginLow =
    pnl.marginActual !== null && pnl.plannedMargin !== null && pnl.marginActual < pnl.plannedMargin;
  return (
    <div className="pnl">
      {alert && <div className="pnl-alert"><Icon name="alert" size={14} /> {alert}</div>}
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
      {cow && (
        <div className="pnl-grid" style={{ marginTop: 8, borderTop: '1px solid var(--border, #2a2a2a)', paddingTop: 8 }}>
          <div className="pnl-cell" title="Труд: часы из тайм-трекера × ставки">
            <span className="pnl-label">Труд ({num(cow.laborHours)} ч)</span>
            <span className="pnl-val">{money(cow.laborCost)}</span>
          </div>
          <div className="pnl-cell" title={`ИИ-агент: ${cow.aiRuns} запуск(ов), ${num(cow.aiTokens)} токенов`}>
            <span className="pnl-label">ИИ-агент (~{num(cow.aiTokens)} ток.)</span>
            <span className="pnl-val">≈ {money(cow.aiCost)}</span>
          </div>
          <div className="pnl-cell" title="Полная себестоимость: труд людей + работа ИИ">
            <span className="pnl-label">Полная себестоимость</span>
            <span className="pnl-val pnl-good">{money(cow.total)}</span>
          </div>
        </div>
      )}
    </div>
  );
}
