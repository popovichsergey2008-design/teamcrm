import { FormEvent, useEffect, useState } from 'react';
import { fmtDate, pc, PcError } from './api';

interface Plan {
  code: string; title: string; price_rub: string; price_year_rub: string | null; max_members: number | null;
  description: string; sort_order: number; is_active: boolean; version: number;
}
interface Version {
  version: number; title: string; price_month_rub: string; price_year_rub: string | null; max_members: number | null;
  is_active: boolean; changed_by: string | null; created_at: string;
}
interface Form { code: string; title: string; priceRub: string; priceYearRub: string; maxMembers: string; description: string; sortOrder: string; isActive: boolean }

const rub = (v: number | string | null) => (v == null ? '—' : `${Number(v).toLocaleString('ru-RU')} ₽`);
const EMPTY: Form = { code: '', title: '', priceRub: '', priceYearRub: '', maxMembers: '', description: '', sortOrder: '0', isActive: true };
const toForm = (p: Plan): Form => ({
  code: p.code, title: p.title, priceRub: String(Number(p.price_rub)), priceYearRub: p.price_year_rub == null ? '' : String(Number(p.price_year_rub)),
  maxMembers: p.max_members == null ? '' : String(p.max_members), description: p.description, sortOrder: String(p.sort_order), isActive: p.is_active,
});

/**
 * Тарифы (ТЗ консолей, §5.4): месячная и годовая цены, лимит мест, доступность новым
 * клиентам. Каждое изменение — новая версия; оплаченные подписки продлеваются по своей цене.
 */
export default function PlansTab({ canManage }: { canManage: boolean }) {
  const [plans, setPlans] = useState<Plan[] | null>(null);
  const [form, setForm] = useState<Form | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [versions, setVersions] = useState<{ code: string; rows: Version[] } | null>(null);
  const [err, setErr] = useState('');

  const load = () => pc<Plan[]>('GET', '/pc/owner/plans').then(setPlans).catch((e) => setErr(e instanceof PcError ? e.message : 'Не загрузилось'));
  useEffect(() => { void load(); }, []);

  const showVersions = (code: string) => pc<Version[]>('GET', `/pc/owner/plans/${code}/versions`).then((rows) => setVersions({ code, rows })).catch(() => undefined);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!form) return;
    setErr('');
    try {
      await pc('POST', '/pc/owner/plans', {
        code: form.code.trim(), title: form.title.trim(), priceRub: Number(form.priceRub),
        priceYearRub: form.priceYearRub.trim() ? Number(form.priceYearRub) : null,
        maxMembers: form.maxMembers.trim() ? Number(form.maxMembers) : null,
        description: form.description, sortOrder: Number(form.sortOrder) || 0, isActive: form.isActive,
      });
      setForm(null); await load();
    } catch (x) { setErr(x instanceof PcError ? x.message : 'Не получилось'); }
  };

  const month = Number(form?.priceRub) || 0;
  const year = Number(form?.priceYearRub) || 0;

  return (
    <section>
      <p className="dim pc-meta">Цены в рублях, без чеков (решение 30.10). Годовая цена — полная сумма за год: скидку за год задаёте сами. Изменение цены не трогает уже оплаченные подписки — они продлеваются по своей цене.</p>
      {err && <p className="pc-err">{err}</p>}
      <div className="pc-table-wrap">
        <table className="pc-table">
          <thead><tr><th>Тариф</th><th>Месяц</th><th>Год</th><th>Сотрудников</th><th>Новым клиентам</th><th>Версия</th><th /></tr></thead>
          <tbody>
            {plans?.map((p) => (
              <tr key={p.code} className={p.is_active ? '' : 'dim'}>
                <td><b>{p.title}</b> <span className="dim">{p.code}</span><div className="dim">{p.description}</div></td>
                <td>{rub(p.price_rub)}</td>
                <td>{rub(p.price_year_rub)}{p.price_year_rub && <div className="dim">≈ {rub(Math.round(Number(p.price_year_rub) / 12))}/мес</div>}</td>
                <td>{p.max_members ?? 'без ограничения'}</td>
                <td>{p.is_active ? 'продаётся' : 'скрыт'}</td>
                <td><button type="button" className="pc-link" onClick={() => void showVersions(p.code)}>v{p.version}</button></td>
                <td>{canManage && <button type="button" className="pc-btn pc-btn-ghost" onClick={() => { setIsNew(false); setForm(toForm(p)); }}>Изменить</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {canManage && !form && <button type="button" className="pc-btn pc-gap" onClick={() => { setIsNew(true); setForm(EMPTY); }}>Новый тариф</button>}

      {form && (
        <form className="pc-card pc-form pc-gap" onSubmit={save}>
          <h3 className="pc-h-flat">{isNew ? 'Новый тариф' : `Тариф «${form.title}»`}</h3>
          {isNew && <label>Код (латиница, навсегда)<input value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} pattern="[a-z0-9_-]{2,32}" required /></label>}
          <label>Название<input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} required maxLength={80} /></label>
          <div className="pc-row pc-wrap">
            <label>Цена за месяц, ₽<input type="number" min={1} value={form.priceRub} onChange={(e) => setForm({ ...form, priceRub: e.target.value })} required /></label>
            <label>Цена за год, ₽ (пусто — на год не продаётся)<input type="number" min={1} value={form.priceYearRub} onChange={(e) => setForm({ ...form, priceYearRub: e.target.value })} /></label>
            <label>Сотрудников до (пусто — без ограничения)<input type="number" min={1} value={form.maxMembers} onChange={(e) => setForm({ ...form, maxMembers: e.target.value })} /></label>
            <label>Порядок<input type="number" value={form.sortOrder} onChange={(e) => setForm({ ...form, sortOrder: e.target.value })} /></label>
          </div>
          {year > 0 && month > 0 && (
            <p className="dim pc-hint">За год: {rub(year)} ≈ {rub(Math.round(year / 12))} в месяц{year < month * 12 ? ` — скидка ${Math.round((1 - year / (month * 12)) * 100)}% к помесячной оплате` : year > month * 12 ? ' — дороже помесячной оплаты' : ''}.</p>
          )}
          <label>Описание<textarea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} maxLength={500} rows={2} /></label>
          <label className="pc-check"><input type="checkbox" checked={form.isActive} onChange={(e) => setForm({ ...form, isActive: e.target.checked })} /> Продаётся новым клиентам</label>
          <div className="pc-actions">
            <button className="pc-btn">Сохранить новой версией</button>
            <button type="button" className="pc-btn pc-btn-ghost" onClick={() => setForm(null)}>Отмена</button>
          </div>
        </form>
      )}

      {versions && (
        <div className="pc-card pc-gap">
          <div className="pc-row pc-between">
            <h3 className="pc-h-flat">История тарифа {versions.code}</h3>
            <button type="button" className="pc-btn pc-btn-ghost" onClick={() => setVersions(null)}>Закрыть</button>
          </div>
          <div className="pc-table-wrap pc-gap">
            <table className="pc-table">
              <thead><tr><th>Версия</th><th>Когда</th><th>Кто</th><th>Месяц</th><th>Год</th><th>Сотрудников</th><th>Продаётся</th></tr></thead>
              <tbody>{versions.rows.map((v) => (
                <tr key={v.version}><td>v{v.version}</td><td>{fmtDate(v.created_at)}</td><td>{v.changed_by ?? '—'}</td><td>{rub(v.price_month_rub)}</td><td>{rub(v.price_year_rub)}</td><td>{v.max_members ?? '∞'}</td><td>{v.is_active ? 'да' : 'нет'}</td></tr>
              ))}</tbody>
            </table>
          </div>
        </div>
      )}
    </section>
  );
}
