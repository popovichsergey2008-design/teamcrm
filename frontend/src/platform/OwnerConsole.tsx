import { FormEvent, useCallback, useEffect, useState } from 'react';
import { lazy, Suspense } from 'react';
import { fmtDate, fmtNum, Me, pc, PcError } from './api';

const AiTab = lazy(() => import('./AiTab'));
const PlansTab = lazy(() => import('./PlansTab'));

type Metric = { value: number; prev?: number; deltaPct?: number | null };
interface Overview {
  period: { from: string; toInclusive: string; days: number; tz: string; prevFrom: string; prevToInclusive: string };
  generatedAt: string;
  activityRule: string;
  metrics: Record<string, Metric>;
  subscriptions: { trial: number; paying: number; grace: number; readOnly: number; complimentary: number };
  series: { unit: 'day' | 'month'; points: { bucket: string; users: number; companies: number }[] };
  unavailable: string[];
  sources: Record<string, string>;
}
interface Tenant {
  id: string; name: string; created_at: string; is_test: boolean; is_platform: boolean; people: number;
  last_active: string | null; plan_code: string | null; sub_status: string | null; complimentary: boolean | null;
}
interface Staff {
  id: string; email: string; full_name: string; status: string; roles: string[]; requested_role: string | null;
  mfa: boolean; created_at: string; approved_at: string | null; last_login_at: string | null;
}
interface AuditRow { id: string; at: string; who: string | null; app: string | null; action: string; target: string | null; meta: Record<string, unknown>; ip: string | null }

const TABS = [
  ['overview', 'Обзор'], ['tenants', 'Компании'], ['plans', 'Тарифы'], ['ai', 'ИИ'], ['staff', 'Сотрудники платформы'], ['notice', 'Объявление'], ['audit', 'Журнал'],
] as const;
type Tab = (typeof TABS)[number][0];

const PERIOD_LABEL: [string, string][] = [
  ['today', 'Сегодня'], ['yesterday', 'Вчера'], ['7d', '7 дней'], ['month', 'Этот месяц'], ['prev_month', 'Прошлый месяц'], ['year', 'Год'], ['custom', 'Свой период'],
];
const ROLE_LABEL: Record<string, string> = { owner: 'Владелец', developer: 'Разработчик', support: 'Поддержка' };

export default function OwnerConsole({ me }: { me: Me }) {
  const [tab, setTab] = useState<Tab>('overview');
  const canStaff = me.perms.includes('staff.manage');
  return (
    <>
      <nav className="pc-tabs" aria-label="Разделы">
        {TABS.filter(([k]) => k !== 'staff' || canStaff).map(([k, l]) => (
          <button key={k} type="button" className="pc-tab" aria-pressed={tab === k} onClick={() => setTab(k)}>{l}</button>
        ))}
      </nav>
      {tab === 'overview' && <OverviewTab />}
      {tab === 'tenants' && <TenantsTab canManage={me.perms.includes('owner.manage')} />}
      {tab === 'plans' && <Suspense fallback={<p className="dim">Загрузка…</p>}><PlansTab canManage={me.perms.includes('owner.manage')} /></Suspense>}
      {tab === 'ai' && <Suspense fallback={<p className="dim">Загрузка…</p>}><AiTab canManage={me.perms.includes('owner.manage')} /></Suspense>}
      {tab === 'staff' && canStaff && <StaffTab meId={me.id} />}
      {tab === 'notice' && <NoticeTab canManage={me.perms.includes('owner.manage')} />}
      {tab === 'audit' && <AuditTab />}
    </>
  );
}

function useLoad<T>(fn: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [err, setErr] = useState('');
  const reload = useCallback(() => {
    setErr('');
    fn().then(setData).catch((e) => setErr(e instanceof PcError ? e.message : 'Не загрузилось'));
  }, deps); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { reload(); }, [reload]);
  return { data, err, reload };
}

// ── Обзор ──
const CARDS: { key: string; label: string; money?: 'rub' | 'usd'; hint?: string }[] = [
  { key: 'usersNew', label: 'Новые пользователи', hint: 'Аккаунты в настоящих компаниях. Приглашение без входа — не регистрация.' },
  { key: 'companiesNew', label: 'Новые компании' },
  { key: 'emailVerified', label: 'Подтвердили почту' },
  { key: 'joinedByInvite', label: 'Вступили по приглашению' },
  { key: 'activeUsers', label: 'Активные пользователи' },
  { key: 'newPaying', label: 'Новые платящие компании' },
  { key: 'revenueRub', label: 'Поступления', money: 'rub' },
  { key: 'payments', label: 'Платежей' },
  { key: 'aiCostUsd', label: 'Расход ИИ (оценка)', money: 'usd' },
  { key: 'aiTokens', label: 'Токенов ИИ' },
  { key: 'supportNew', label: 'Обращений в поддержку' },
  { key: 'installsNew', label: 'Новые установки Android' },
  { key: 'installsActive', label: 'Активные установки Android' },
];

function money(v: number, cur: 'rub' | 'usd') {
  return new Intl.NumberFormat('ru-RU', { style: 'currency', currency: cur === 'rub' ? 'RUB' : 'USD', maximumFractionDigits: cur === 'rub' ? 0 : 2 }).format(v);
}

function OverviewTab() {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/Moscow';
  const [period, setPeriod] = useState('month');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const q = new URLSearchParams({ period, tz, ...(period === 'custom' ? { from, to } : {}) }).toString();
  const ready = period !== 'custom' || (from && to);
  const { data, err } = useLoad<Overview | null>(() => (ready ? pc<Overview>('GET', `/pc/owner/overview?${q}`) : Promise.resolve(null)), [q, ready]);

  return (
    <section>
      <div className="pc-row pc-wrap">
        <div className="pc-seg" role="group" aria-label="Период">
          {PERIOD_LABEL.map(([k, l]) => <button key={k} type="button" aria-pressed={period === k} onClick={() => setPeriod(k)}>{l}</button>)}
        </div>
        {period === 'custom' && (
          <span className="pc-row">
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} aria-label="С" />
            <span className="dim">—</span>
            <input type="date" value={to} onChange={(e) => setTo(e.target.value)} aria-label="По" />
          </span>
        )}
      </div>
      {err && <p className="pc-err">{err}</p>}
      {data && (
        <>
          <p className="dim pc-meta">
            {data.period.from} — {data.period.toInclusive} ({data.period.days} дн.), пояс {data.period.tz}. Сравнение с {data.period.prevFrom} — {data.period.prevToInclusive}.
            {' '}Обновлено {fmtDate(data.generatedAt)} (считается при открытии). Без тестовых компаний и площадки QEVO.
          </p>
          <div className="pc-kpis">
            <Kpi label="Всего пользователей" value={fmtNum(data.metrics.usersTotal.value)} />
            <Kpi label="Всего компаний" value={fmtNum(data.metrics.companiesTotal.value)} />
            <Kpi label="На пробном" value={fmtNum(data.subscriptions.trial)} />
            <Kpi label="Платят сейчас" value={fmtNum(data.subscriptions.paying)} />
            <Kpi label="Льготные дни / только чтение" value={`${data.subscriptions.grace} / ${data.subscriptions.readOnly}`} />
            <Kpi label="Бесплатно (льгота)" value={fmtNum(data.subscriptions.complimentary)} />
          </div>
          <h3>За период</h3>
          <div className="pc-kpis">
            {CARDS.map((c) => {
              const m = data.metrics[c.key];
              return <Kpi key={c.key} label={c.label} hint={c.hint} value={c.money ? money(m.value, c.money) : fmtNum(m.value)} delta={m.deltaPct} />;
            })}
            <Kpi label="Скачивания" value="Нет данных" hint="Раздачу APK пока не считаем" />
            <Kpi label="Возвраты" value="Нет данных" />
          </div>
          <h3>Регистрации {data.series.unit === 'day' ? 'по дням' : 'по месяцам'}</h3>
          <Bars points={data.series.points} />
          <p className="dim pc-meta">Активность: {data.activityRule}. Установки: {data.sources.installs}. Поступления: {data.sources.revenue}. ИИ: {data.sources.aiCost}.</p>
        </>
      )}
      {!data && !err && ready && <p className="dim">Считаю…</p>}
    </section>
  );
}

function Kpi({ label, value, delta, hint }: { label: string; value: string; delta?: number | null; hint?: string }) {
  return (
    <div className="pc-kpi" title={hint}>
      <div className="pc-kpi-label">{label}</div>
      <div className="pc-kpi-value">{value}</div>
      {delta !== undefined && (
        <div className={`pc-kpi-delta${delta == null ? ' dim' : delta >= 0 ? ' pc-up' : ' pc-down'}`}>
          {delta == null ? 'нет базы для сравнения' : `${delta > 0 ? '+' : ''}${delta}% к прошлому периоду`}
        </div>
      )}
    </div>
  );
}

function Bars({ points }: { points: { bucket: string; users: number; companies: number }[] }) {
  if (!points.length) return <p className="dim">Регистраций за период нет.</p>;
  const max = Math.max(1, ...points.map((p) => p.users));
  return (
    <div className="pc-bars" role="table" aria-label="Регистрации">
      {points.map((p) => (
        <div key={p.bucket} className="pc-bar" role="row" title={`${p.bucket}: пользователей ${p.users}, компаний ${p.companies}`}>
          <span className="pc-bar-fill" style={{ height: `${(p.users / max) * 100}%` }} />
          <span className="pc-bar-label">{p.bucket.slice(5)}</span>
          <span className="pc-bar-n">{p.users}</span>
        </div>
      ))}
    </div>
  );
}

// ── Компании ──
const SUB_LABEL: Record<string, string> = { TRIAL: 'пробный', ACTIVE: 'оплачен', GRACE: 'льготные дни', READ_ONLY: 'только чтение', PAST_DUE: 'просрочен' };

function TenantsTab({ canManage }: { canManage: boolean }) {
  const { data, err, reload } = useLoad(() => pc<Tenant[]>('GET', '/pc/owner/tenants'), []);
  const [showTest, setShowTest] = useState(false);
  const toggle = async (t: Tenant) => {
    try { await pc('POST', `/pc/owner/tenants/${t.id}/test`, { isTest: !t.is_test }); reload(); } catch (e) { alert(e instanceof PcError ? e.message : 'Не получилось'); }
  };
  const rows = (data ?? []).filter((t) => showTest || !t.is_test);
  return (
    <section>
      <div className="pc-row">
        <label className="pc-check"><input type="checkbox" checked={showTest} onChange={(e) => setShowTest(e.target.checked)} /> Показывать тестовые</label>
        <span className="dim">Всего: {data?.length ?? '…'}, настоящих: {data?.filter((t) => !t.is_test && !t.is_platform).length ?? '…'}</span>
      </div>
      {err && <p className="pc-err">{err}</p>}
      <div className="pc-table-wrap">
        <table className="pc-table">
          <thead><tr><th>Компания</th><th>Создана</th><th>Людей</th><th>Были в сети</th><th>Подписка</th><th>Тестовая</th></tr></thead>
          <tbody>
            {rows.map((t) => (
              <tr key={t.id} className={t.is_test ? 'dim' : ''}>
                <td>{t.name}{t.is_platform && <span className="pc-tag">площадка QEVO</span>} <span className="dim">#{t.id}</span></td>
                <td>{fmtDate(t.created_at)}</td>
                <td>{t.people}</td>
                <td>{fmtDate(t.last_active)}</td>
                <td>{t.complimentary ? 'бесплатно' : t.sub_status ? `${SUB_LABEL[t.sub_status] ?? t.sub_status}${t.plan_code ? ` · ${t.plan_code}` : ''}` : 'пробный (по дате)'}</td>
                <td>{!t.is_platform && <input type="checkbox" checked={t.is_test} disabled={!canManage} onChange={() => void toggle(t)} aria-label={`Тестовая: ${t.name}`} />}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="dim pc-meta">Тестовые компании не попадают в статистику. Содержимое компаний (задачи, чаты) консоль не показывает.</p>
    </section>
  );
}

// ── Сотрудники платформы ──
function StaffTab({ meId }: { meId: string }) {
  const { data, err, reload } = useLoad(() => pc<Staff[]>('GET', '/pc/owner/staff'), []);
  const save = async (s: Staff, patch: Partial<Pick<Staff, 'status' | 'roles'>>) => {
    try { await pc('POST', `/pc/owner/staff/${s.id}`, { status: patch.status ?? s.status, roles: patch.roles ?? s.roles }); reload(); }
    catch (e) { alert(e instanceof PcError ? e.message : 'Не получилось'); }
  };
  const pending = (data ?? []).filter((s) => s.status === 'pending');
  return (
    <section>
      {err && <p className="pc-err">{err}</p>}
      {pending.length > 0 && <h3>Ждут одобрения: {pending.length}</h3>}
      <div className="pc-table-wrap">
        <table className="pc-table">
          <thead><tr><th>Сотрудник</th><th>Статус</th><th>Консоли</th><th>Код 2FA</th><th>Последний вход</th><th /></tr></thead>
          <tbody>
            {(data ?? []).map((s) => (
              <tr key={s.id}>
                <td><b>{s.full_name}</b><div className="dim">{s.email}</div>{s.status === 'pending' && s.requested_role && <div className="dim">просит: {ROLE_LABEL[s.requested_role] ?? s.requested_role}</div>}</td>
                <td>{s.status === 'pending' ? 'заявка' : s.status === 'active' ? 'активен' : 'заблокирован'}</td>
                <td>
                  {(['owner', 'developer', 'support'] as const).map((r) => (
                    <label key={r} className="pc-check">
                      <input type="checkbox" checked={s.roles.includes(r)} disabled={s.id === meId && r === 'owner'}
                        onChange={(e) => void save(s, { roles: e.target.checked ? [...s.roles, r] : s.roles.filter((x) => x !== r) })} />
                      {ROLE_LABEL[r]}
                    </label>
                  ))}
                </td>
                <td>{s.mfa ? 'настроен' : 'нет'}</td>
                <td>{fmtDate(s.last_login_at)}</td>
                <td className="pc-actions">
                  {s.status === 'pending' && (
                    <button type="button" className="pc-btn" onClick={() => void save(s, { status: 'active', roles: s.roles.length ? s.roles : [s.requested_role ?? 'developer'] })}>Одобрить</button>
                  )}
                  {s.id !== meId && s.status !== 'blocked' && <button type="button" className="pc-btn pc-btn-ghost" onClick={() => void save(s, { status: 'blocked' })}>Заблокировать</button>}
                  {s.status === 'blocked' && <button type="button" className="pc-btn pc-btn-ghost" onClick={() => void save(s, { status: 'active' })}>Разблокировать</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="dim pc-meta">Роль открывает только свою консоль. Снятая роль или блокировка закрывает уже открытые сессии сразу.</p>
    </section>
  );
}

// ── Объявление ──
function NoticeTab({ canManage }: { canManage: boolean }) {
  const { data, reload } = useLoad(() => pc<{ text: string; level: string; ends_at: string } | null>('GET', '/pc/owner/notice'), []);
  const [text, setText] = useState('Идёт обновление QEVO — примерно час-полтора. Возможны короткие перебои: если что-то не сохранилось, повторите через минуту. Данные не пострадают.');
  const [minutes, setMinutes] = useState(90);
  const [level, setLevel] = useState<'info' | 'warn'>('warn');
  const [err, setErr] = useState('');
  const send = async (e: FormEvent) => {
    e.preventDefault(); setErr('');
    try { await pc('POST', '/pc/owner/notice', { text, minutes, level }); reload(); } catch (x) { setErr(x instanceof PcError ? x.message : 'Не получилось'); }
  };
  const clear = async () => { await pc('DELETE', '/pc/owner/notice').catch(() => undefined); reload(); };
  return (
    <section className="pc-card">
      <h3>Плашка для всех пользователей CRM</h3>
      {data ? (
        <p>Сейчас показывается до {fmtDate(data.ends_at)}: «{data.text}» {canManage && <button type="button" className="pc-btn pc-btn-ghost" onClick={() => void clear()}>Снять</button>}</p>
      ) : <p className="dim">Сейчас объявления нет.</p>}
      {canManage && (
        <form onSubmit={send} className="pc-form">
          <label>Текст<textarea value={text} onChange={(e) => setText(e.target.value)} maxLength={400} rows={3} required /></label>
          <div className="pc-row">
            <label>Сколько показывать, минут<input type="number" min={5} max={10080} value={minutes} onChange={(e) => setMinutes(Number(e.target.value))} /></label>
            <label>Вид<select value={level} onChange={(e) => setLevel(e.target.value as 'info' | 'warn')}><option value="warn">предупреждение</option><option value="info">информация</option></select></label>
          </div>
          {err && <p className="pc-err">{err}</p>}
          <button className="pc-btn">Показать всем</button>
        </form>
      )}
    </section>
  );
}

// ── Журнал ──
const ACTION_LABEL: Record<string, string> = {
  login: 'вход', 'login.fail': 'неудачный вход', 'mfa.enable': 'включил код 2FA', 'staff.register': 'заявка на доступ',
  'staff.bootstrap_owner': 'первый владелец', 'staff.update': 'изменил сотрудника', 'tenant.test': 'отметка «тестовая»',
  'notice.set': 'объявление', 'notice.clear': 'снял объявление', 'ai.guard': 'выключатели и бюджет ИИ', 'error.status': 'статус ошибки', 'plan.save': 'тариф',
};

function AuditTab() {
  const { data, err } = useLoad(() => pc<AuditRow[]>('GET', '/pc/owner/audit?limit=300'), []);
  return (
    <section>
      {err && <p className="pc-err">{err}</p>}
      <div className="pc-table-wrap">
        <table className="pc-table">
          <thead><tr><th>Когда</th><th>Кто</th><th>Консоль</th><th>Действие</th><th>Объект</th><th>IP</th></tr></thead>
          <tbody>
            {(data ?? []).map((r) => (
              <tr key={r.id}>
                <td>{fmtDate(r.at)}</td><td>{r.who ?? '—'}</td><td>{r.app ?? '—'}</td>
                <td>{ACTION_LABEL[r.action] ?? r.action}</td><td>{r.target ?? ''}</td><td className="dim">{r.ip ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
