import { useEffect, useState } from 'react';
import { api } from '../lib/api';

type Limit = Awaited<ReturnType<typeof api.aiLimit>>;
const num = (n: number) => Math.round(n).toLocaleString('ru-RU');

/**
 * Шкала лимита ИИ (#4779, п. 6.6): «Использовано N из 1 000 000», когда лимит обновится и
 * сколько уйдёт до конца месяца при нынешнем темпе. Со своим ключом лимита нет — шкалы тоже.
 */
export function AiLimitBar() {
  const [l, setL] = useState<Limit | null>(null);
  useEffect(() => { api.aiLimit().then(setL).catch(() => undefined); }, []);
  if (!l || l.own || l.platform || !l.tokensLimit) return null;
  const pct = Math.min(100, Math.round((l.tokensUsed / l.tokensLimit) * 100));
  const over = (l.forecast ?? 0) > l.tokensLimit;
  return (
    <div className="drawer-section">
      <div className="drawer-section-title">Лимит ИИ на месяц</div>
      <div style={{ fontSize: 13, marginBottom: 6 }}>Использовано {num(l.tokensUsed)} из {num(l.tokensLimit)}</div>
      <div role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label="Израсходовано лимита ИИ"
        style={{ height: 8, borderRadius: 4, background: 'var(--hover)', overflow: 'hidden' }}>
        <div style={{ width: `${pct}%`, height: '100%', background: pct >= 100 ? 'var(--danger)' : pct >= 80 ? 'var(--warn)' : 'var(--accent)' }} />
      </div>
      <div className="dim" style={{ fontSize: 12, marginTop: 6 }}>
        Лимит обновится {l.resetsAt ? new Date(l.resetsAt).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' }) : '1-го числа'}.
        {l.forecast != null && <> Прогноз до конца месяца: {num(l.forecast)}{over ? ' — больше лимита, стоит подключить свой ключ Kimi' : ''}.</>}
        {' '}При 80% и 100% администратору придёт уведомление.
      </div>
    </div>
  );
}
