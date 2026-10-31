import { FormEvent, useEffect, useState } from 'react';
import { fmtNum, pc, PcError } from './api';

interface Guard { allOff: boolean; allReason: string | null; sharedOff: boolean; sharedReason: string | null; monthlyBudgetUsd: number | null }
interface AiView {
  config: Guard;
  decision: { any: boolean; shared: boolean; reason: string | null };
  sharedSpentUsd: number;
  tenants: { tenantId: string; name: string; isTest: boolean; ownKey: boolean; usd: number; tokens: number; calls: number }[];
}

const usd = (v: number) => `$${v.toFixed(2)}`;

/**
 * Общий ИИ (ТЗ консолей, §5.5): месячный бюджет общего ключа и два аварийных выключателя.
 * Выключение — только с причиной: она уходит в журнал.
 */
export default function AiTab({ canManage }: { canManage: boolean }) {
  const [v, setV] = useState<AiView | null>(null);
  const [form, setForm] = useState<Guard | null>(null);
  const [budget, setBudget] = useState('');
  const [err, setErr] = useState('');
  const [saved, setSaved] = useState(false);

  const load = () => pc<AiView>('GET', '/pc/owner/ai').then((x) => {
    setV(x); setForm(x.config); setBudget(x.config.monthlyBudgetUsd == null ? '' : String(x.config.monthlyBudgetUsd));
  }).catch((e) => setErr(e instanceof PcError ? e.message : 'Не загрузилось'));
  useEffect(() => { void load(); }, []);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!form) return;
    setErr(''); setSaved(false);
    try {
      await pc('POST', '/pc/owner/ai', { ...form, monthlyBudgetUsd: budget.trim() === '' ? null : Number(budget) });
      setSaved(true); await load();
    } catch (x) { setErr(x instanceof PcError ? x.message : 'Не получилось'); }
  };

  if (!v || !form) return err ? <p className="pc-err">{err}</p> : <p className="dim">Загрузка…</p>;
  const left = v.config.monthlyBudgetUsd == null ? null : Math.max(0, v.config.monthlyBudgetUsd - v.sharedSpentUsd);
  const shared = v.tenants.filter((t) => !t.ownKey);

  return (
    <section>
      <div className="pc-kpis">
        <div className="pc-kpi"><div className="pc-kpi-label">Сейчас</div>
          <div className={`pc-kpi-value ${v.decision.any && v.decision.shared ? 'pc-up' : 'pc-down'}`}>
            {!v.decision.any ? 'весь ИИ выключен' : !v.decision.shared ? 'общий ключ закрыт' : 'работает'}
          </div>
          {v.decision.reason && <div className="pc-kpi-delta dim">{v.decision.reason}</div>}
        </div>
        <div className="pc-kpi"><div className="pc-kpi-label">Общий ключ: расход за месяц</div><div className="pc-kpi-value">{usd(v.sharedSpentUsd)}</div>
          <div className="pc-kpi-delta dim">оценка по прайсу моделей, месяц по UTC</div></div>
        <div className="pc-kpi"><div className="pc-kpi-label">Остаток бюджета</div><div className="pc-kpi-value">{left == null ? 'без потолка' : usd(left)}</div></div>
      </div>

      <form className="pc-card pc-form pc-gap" onSubmit={save}>
        <h3 className="pc-h-flat">Бюджет и выключатели</h3>
        <label>Потолок общего ключа за месяц, USD (пусто — без потолка)
          <input type="number" min={0} step="0.01" value={budget} onChange={(e) => setBudget(e.target.value)} disabled={!canManage} />
        </label>
        <p className="dim pc-hint">Общий ключ сервера — наши деньги: пробный ИИ новых компаний и демо. Потолок исчерпан — общий ключ закрывается до 1-го числа, компании со своими ключами работают.</p>

        <label className="pc-check"><input type="checkbox" checked={form.sharedOff} disabled={!canManage} onChange={(e) => setForm({ ...form, sharedOff: e.target.checked })} /> Выключить общий ключ сервера</label>
        {form.sharedOff && <label>Причина<input value={form.sharedReason ?? ''} onChange={(e) => setForm({ ...form, sharedReason: e.target.value })} maxLength={300} disabled={!canManage} /></label>}

        <label className="pc-check"><input type="checkbox" checked={form.allOff} disabled={!canManage} onChange={(e) => setForm({ ...form, allOff: e.target.checked })} /> Выключить ВЕСЬ ИИ, включая ключи компаний</label>
        {form.allOff && <label>Причина<input value={form.allReason ?? ''} onChange={(e) => setForm({ ...form, allReason: e.target.value })} maxLength={300} disabled={!canManage} /></label>}
        <p className="dim pc-hint">Срабатывает за полминуты. Без ИИ возможности работают правилами, как у компании без ключа. Пользователям об этом стоит сказать объявлением.</p>

        {err && <p className="pc-err">{err}</p>}
        {saved && <p className="pc-up">Сохранено и записано в журнал.</p>}
        {canManage && <button className="pc-btn">Сохранить</button>}
      </form>

      <h3>Расход ИИ за месяц по компаниям</h3>
      <div className="pc-table-wrap">
        <table className="pc-table">
          <thead><tr><th>Компания</th><th>Чей ключ</th><th>Запросов</th><th>Токенов</th><th>Стоимость</th></tr></thead>
          <tbody>
            {v.tenants.length === 0 && <tr><td colSpan={5} className="dim">В этом месяце ИИ не вызывали.</td></tr>}
            {v.tenants.map((t) => (
              <tr key={t.tenantId} className={t.isTest ? 'dim' : ''}>
                <td>{t.name} <span className="dim">#{t.tenantId}{t.isTest ? ' · тестовая' : ''}</span></td>
                <td>{t.ownKey ? 'свой' : 'общий'}</td><td>{fmtNum(t.calls)}</td><td>{fmtNum(t.tokens)}</td><td>{usd(t.usd)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="dim pc-meta">На общем ключе: {shared.length} компаний. Демо в Telegram-боте считается отдельно и в бюджет пока не входит.</p>
    </section>
  );
}
