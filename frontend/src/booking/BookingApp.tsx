import { useEffect, useMemo, useState } from 'react';
import { Icon } from '../components/Icon';
import { apiUrl } from '../lib/origin';
import './booking.css';

/**
 * Запись по ссылке (#4787, п. 6, 9, 18, 20) — страница для гостя, без аккаунта QEVO.
 *
 * `/book/<ссылка>` — выбрать день и время, ввести имя и почту, ответить на вопросы.
 * `/book/manage/<токен>` — перенести или отменить свою запись без переписки.
 * Время показывается в часовом поясе гостя (его браузера); организатор видит ту же
 * встречу в своём. Полностью работает с телефона.
 */

interface Page {
  organizer: { name: string; avatarUrl: string | null; company: string | null };
  type: { slug: string; title: string; description: string | null; durationMin: number; locationKind: 'call' | 'place' | 'phone'; location: string | null; questions: { text: string; required?: boolean }[] };
  days: { date: string; slots: string[] }[];
  booking?: { status?: string; startsAt: string; endsAt: string; name: string; email: string; callUrl?: string | null; manageUrl?: string; past?: boolean };
}

class BookError extends Error {
  constructor(message: string, public days?: Page['days']) { super(message); }
}

async function call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(apiUrl(`/api/book/${path}`), {
      method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new BookError('Нет связи с сервером — проверьте интернет и попробуйте ещё раз');
  }
  const env = await res.json().catch(() => null) as { ok: boolean; data?: T; error?: { message?: string; details?: { days?: Page['days'] } } } | null;
  if (!env?.ok) throw new BookError(env?.error?.message ?? 'Что-то пошло не так', env?.error?.details?.days);
  return env.data as T;
}

const guestTz = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return 'Europe/Moscow'; } };
const time = (iso: string) => new Date(iso).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
const dayName = (date: string) => {
  const d = new Date(`${date}T12:00:00`);
  return { wd: d.toLocaleDateString('ru-RU', { weekday: 'short' }), num: d.getDate(), month: d.toLocaleDateString('ru-RU', { month: 'short' }) };
};
const fullWhen = (s: string, e: string) =>
  `${new Date(s).toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' })}, ${time(s)}–${time(e)}`;
const tzLabel = () => {
  try {
    const off = new Intl.DateTimeFormat('ru-RU', { timeZoneName: 'shortOffset' }).formatToParts(new Date()).find((x) => x.type === 'timeZoneName')?.value;
    return `${guestTz()}${off ? ` (${off})` : ''}`;
  } catch { return guestTz(); }
};
/** Слоты приходят моментами UTC — день для гостя считаем по ЕГО часам. */
function regroup(days: Page['days']): Page['days'] {
  const map = new Map<string, string[]>();
  for (const d of days) for (const s of d.slots) {
    const x = new Date(s);
    const key = `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
    (map.get(key) ?? map.set(key, []).get(key)!).push(s);
  }
  return [...map.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, slots]) => ({ date, slots: slots.sort() }));
}

export default function BookingApp() {
  const path = location.pathname.replace(/\/+$/, '');
  const manage = path.startsWith('/book/manage/') ? decodeURIComponent(path.slice('/book/manage/'.length)) : null;
  const poll = path.startsWith('/book/poll/') ? decodeURIComponent(path.slice('/book/poll/'.length)) : null;
  const slug = manage || poll ? null : decodeURIComponent(path.slice('/book/'.length));
  useEffect(() => { document.title = manage ? 'Ваша запись — QEVO' : 'Запись на встречу — QEVO'; }, [manage]);
  return (
    <main className="bk">
      {manage ? <Manage token={manage} /> : poll ? <Poll slug={poll} /> : slug ? <Book slug={slug} /> : <Missing />}
      <footer className="bk-foot">Работает на <a href="https://qevo.one" target="_blank" rel="noreferrer">QEVO</a></footer>
    </main>
  );
}

function Missing() {
  return <section className="bk-card"><h1>Ссылка неполная</h1><p className="bk-dim">Попросите организатора прислать ссылку записи ещё раз.</p></section>;
}

function Organizer({ page }: { page: Page }) {
  return (
    <header className="bk-org">
      {page.organizer.avatarUrl
        ? <img className="bk-avatar" src={apiUrl(page.organizer.avatarUrl)} alt="" />
        : <span className="bk-avatar bk-initials" aria-hidden="true">{page.organizer.name.split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase()}</span>}
      <div>
        <div className="bk-dim">{page.organizer.name}{page.organizer.company ? ` · ${page.organizer.company}` : ''}</div>
        <h1>{page.type.title}</h1>
        <div className="bk-meta">
          <span><Icon name="clock" size={15} /> {page.type.durationMin} мин</span>
          <span>
            <Icon name={page.type.locationKind === 'call' ? 'video' : page.type.locationKind === 'phone' ? 'phone' : 'pin'} size={15} />{' '}
            {page.type.locationKind === 'call' ? 'Видеосозвон в браузере' : page.type.location || (page.type.locationKind === 'phone' ? 'По телефону' : 'Место уточнит организатор')}
          </span>
        </div>
        {page.type.description && <p className="bk-desc">{page.type.description}</p>}
      </div>
    </header>
  );
}

/** Выбор дня и времени — общий для записи и переноса. */
function SlotPicker({ days, picked, onPick }: { days: Page['days']; picked: string | null; onPick: (iso: string) => void }) {
  const local = useMemo(() => regroup(days), [days]);
  const [day, setDay] = useState<string | null>(null);
  useEffect(() => { if (!day || !local.some((d) => d.date === day)) setDay(local[0]?.date ?? null); }, [local, day]);
  if (!local.length) return <p className="bk-empty">Свободного времени в ближайшие дни нет. Напишите организатору — он предложит другое.</p>;
  const slots = local.find((d) => d.date === day)?.slots ?? [];
  return (
    <div className="bk-pick">
      <div className="bk-days" role="tablist" aria-label="Доступные дни">
        {local.map((d) => {
          const n = dayName(d.date);
          return (
            <button key={d.date} role="tab" aria-selected={d.date === day} className={`bk-day${d.date === day ? ' on' : ''}`} onClick={() => setDay(d.date)}>
              <span className="bk-day-wd">{n.wd}</span><span className="bk-day-num">{n.num}</span><span className="bk-day-mon">{n.month}</span>
            </button>
          );
        })}
      </div>
      <div className="bk-tz bk-dim"><Icon name="clock" size={13} /> Время показано в вашем часовом поясе: {tzLabel()}</div>
      <div className="bk-slots" role="listbox" aria-label="Свободное время">
        {slots.map((s) => (
          <button key={s} role="option" aria-selected={picked === s} className={`bk-slot${picked === s ? ' on' : ''}`} onClick={() => onPick(s)}>{time(s)}</button>
        ))}
      </div>
    </div>
  );
}

function Book({ slug }: { slug: string }) {
  const [page, setPage] = useState<Page | null>(null);
  const [err, setErr] = useState('');
  const [picked, setPicked] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [answers, setAnswers] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<Page['booking'] | null>(null);

  useEffect(() => { call<Page>('GET', encodeURIComponent(slug)).then(setPage).catch((e: Error) => setErr(e.message)); }, [slug]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!picked || !page) return;
    setBusy(true); setErr('');
    try {
      const r = await call<Page>('POST', encodeURIComponent(slug), { startsAt: picked, name, email, timeZone: guestTz(), answers });
      setDone(r.booking ?? null);
    } catch (x) {
      const b = x as BookError;
      setErr(b.message);
      // время успели занять — показываем свежие варианты, выбранное снимаем
      if (b.days) { setPage({ ...page, days: b.days }); setPicked(null); }
    } finally { setBusy(false); }
  };

  if (!page) return <section className="bk-card">{err ? <><h1>Запись недоступна</h1><p className="bk-dim">{err}</p></> : <p className="bk-dim">Загружаю…</p>}</section>;
  if (done) {
    return (
      <section className="bk-card bk-done">
        <div className="bk-ok"><Icon name="check-circle" size={28} /></div>
        <h1>Встреча подтверждена</h1>
        <p><strong>{page.type.title}</strong> с {page.organizer.name}</p>
        <p className="bk-when">{fullWhen(done.startsAt, done.endsAt)}</p>
        <p className="bk-dim">Подтверждение и файл для календаря отправлены на {done.email}.</p>
        {done.callUrl && <a className="ui-btn ui-btn-primary bk-wide" href={done.callUrl}><Icon name="video" size={16} /> Ссылка на созвон</a>}
        {done.manageUrl && (
          <div className="bk-row">
            <a className="ui-btn ui-btn-outline" href={`${done.manageUrl}?do=reschedule`}>Перенести встречу</a>
            <a className="ui-btn ui-btn-ghost" href={`${done.manageUrl}?do=cancel`}>Отменить встречу</a>
          </div>
        )}
        <p className="bk-soft">Хотите так же принимать записи без переписки? <a href="https://qevo.one" target="_blank" rel="noreferrer">Создать свою страницу записи в QEVO</a></p>
      </section>
    );
  }
  return (
    <section className="bk-card">
      <Organizer page={page} />
      <h2 className="bk-h2">Выберите удобное время</h2>
      <SlotPicker days={page.days} picked={picked} onPick={setPicked} />
      {picked && (
        <form className="bk-form" onSubmit={(e) => void submit(e)}>
          <div className="bk-chosen"><Icon name="calendar" size={15} /> {fullWhen(picked, new Date(Date.parse(picked) + page.type.durationMin * 60_000).toISOString())}</div>
          <label>Ваше имя<input className="ui-input" required maxLength={120} value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" /></label>
          <label>Email<input className="ui-input" required type="email" maxLength={320} value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" /></label>
          {page.type.questions.map((q, i) => (
            <label key={i}>{q.text}{q.required ? ' *' : ''}
              <textarea className="ui-input" rows={3} required={!!q.required} maxLength={2000} value={answers[i] ?? ''}
                onChange={(e) => setAnswers((a) => { const n = [...a]; n[i] = e.target.value; return n; })} />
            </label>
          ))}
          <button className="ui-btn ui-btn-primary bk-wide" type="submit" disabled={busy}>{busy ? 'Записываю…' : 'Подтвердить запись'}</button>
          <p className="bk-dim bk-small">Регистрироваться в QEVO не нужно.</p>
        </form>
      )}
      {err && <p className="bk-err" role="alert"><Icon name="alert" size={15} /> {err}</p>}
    </section>
  );
}

function Manage({ token }: { token: string }) {
  const [page, setPage] = useState<Page | null>(null);
  const [err, setErr] = useState('');
  const [mode, setMode] = useState<'view' | 'reschedule' | 'cancel'>(() => {
    const d = new URLSearchParams(location.search).get('do');
    return d === 'reschedule' || d === 'cancel' ? d : 'view';
  });
  const [picked, setPicked] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  useEffect(() => { call<Page>('GET', `manage/${encodeURIComponent(token)}`).then(setPage).catch((e: Error) => setErr(e.message)); }, [token]);

  const reschedule = async () => {
    if (!picked || !page) return;
    setBusy(true); setErr('');
    try {
      setPage(await call<Page>('POST', `manage/${encodeURIComponent(token)}/reschedule`, { startsAt: picked }));
      setMode('view'); setPicked(null); setMsg('Встреча перенесена. Организатор и вы получите уведомление, прежнее время освободилось.');
    } catch (x) {
      const b = x as BookError;
      setErr(b.message);
      if (b.days) { setPage({ ...page, days: b.days }); setPicked(null); }
    } finally { setBusy(false); }
  };

  const cancel = async () => {
    setBusy(true); setErr('');
    try {
      setPage(await call<Page>('POST', `manage/${encodeURIComponent(token)}/cancel`));
      setMode('view'); setMsg('Встреча отменена. Напоминаний больше не будет.');
    } catch (x) { setErr((x as Error).message); }
    finally { setBusy(false); }
  };

  if (!page) return <section className="bk-card">{err ? <><h1>Запись не найдена</h1><p className="bk-dim">{err}</p></> : <p className="bk-dim">Загружаю…</p>}</section>;
  const b = page.booking!;
  const cancelled = b.status === 'cancelled';
  return (
    <section className="bk-card">
      <Organizer page={page} />
      <div className={`bk-status${cancelled ? ' off' : ''}`}>
        <Icon name={cancelled ? 'close' : 'check-circle'} size={16} />
        <span>{cancelled ? 'Встреча отменена' : b.past ? 'Встреча прошла' : 'Встреча запланирована'}: <strong>{fullWhen(b.startsAt, b.endsAt)}</strong></span>
      </div>
      {msg && <p className="bk-okmsg" role="status">{msg}</p>}
      {!cancelled && !b.past && mode === 'view' && (
        <div className="bk-row">
          <button className="ui-btn ui-btn-outline" onClick={() => setMode('reschedule')}>Перенести встречу</button>
          <button className="ui-btn ui-btn-ghost" onClick={() => setMode('cancel')}>Отменить встречу</button>
        </div>
      )}
      {!cancelled && !b.past && mode === 'reschedule' && (
        <>
          <h2 className="bk-h2">Выберите новое время</h2>
          <SlotPicker days={page.days} picked={picked} onPick={setPicked} />
          <div className="bk-row">
            <button className="ui-btn ui-btn-primary" disabled={!picked || busy} onClick={() => void reschedule()}>{busy ? 'Переношу…' : 'Перенести на это время'}</button>
            <button className="ui-btn ui-btn-ghost" onClick={() => { setMode('view'); setPicked(null); }}>Назад</button>
          </div>
        </>
      )}
      {!cancelled && !b.past && mode === 'cancel' && (
        <div className="bk-confirm">
          <p>Отменить встречу «{page.type.title}»? Организатор получит уведомление.</p>
          <div className="bk-row">
            <button className="ui-btn ui-btn-destructive" disabled={busy} onClick={() => void cancel()}>{busy ? 'Отменяю…' : 'Да, отменить'}</button>
            <button className="ui-btn ui-btn-ghost" onClick={() => setMode('view')}>Не отменять</button>
          </div>
        </div>
      )}
      {err && <p className="bk-err" role="alert"><Icon name="alert" size={15} /> {err}</p>}
    </section>
  );
}

interface PollPage {
  title: string; minutes: number; status: string; organizer: { name: string; company: string | null };
  options: { id: string; startsAt: string; yes: number; maybe: number }[]; voters: number;
}

/** Опрос времени (#4787, п. 15): «Подходит · Возможно · Не подходит» по каждому варианту. */
function Poll({ slug }: { slug: string }) {
  const [page, setPage] = useState<PollPage | null>(null);
  const [err, setErr] = useState('');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [answers, setAnswers] = useState<Record<string, 'yes' | 'maybe' | 'no'>>({});
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  useEffect(() => { call<PollPage>('GET', `poll/${encodeURIComponent(slug)}`).then(setPage).catch((e: Error) => setErr(e.message)); }, [slug]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setErr('');
    try { setPage(await call<PollPage>('POST', `poll/${encodeURIComponent(slug)}/vote`, { name, email: email || undefined, answers })); setDone(true); }
    catch (x) { setErr((x as Error).message); }
    finally { setBusy(false); }
  };

  if (!page) return <section className="bk-card">{err ? <><h1>Опрос недоступен</h1><p className="bk-dim">{err}</p></> : <p className="bk-dim">Загружаю…</p>}</section>;
  const end = (s: string) => new Date(Date.parse(s) + page.minutes * 60_000).toISOString();
  return (
    <section className="bk-card">
      <header>
        <div className="bk-dim">{page.organizer.name}{page.organizer.company ? ` · ${page.organizer.company}` : ''} предлагает время</div>
        <h1>{page.title}</h1>
        <div className="bk-meta"><span><Icon name="clock" size={15} /> {page.minutes} мин</span><span><Icon name="users" size={15} /> ответили: {page.voters}</span></div>
      </header>
      {page.status !== 'open' && <p className="bk-okmsg">Организатор уже выбрал время — приглашение придёт на почту.</p>}
      {done && page.status === 'open' && <p className="bk-okmsg" role="status">Спасибо! Ответ сохранён. Когда организатор выберет время, придёт приглашение со ссылкой на встречу.</p>}
      {page.status === 'open' && (
        <form className="bk-form" onSubmit={(e) => void submit(e)}>
          <div className="bk-tz bk-dim"><Icon name="clock" size={13} /> Время показано в вашем часовом поясе: {tzLabel()}</div>
          {page.options.map((o) => (
            <div key={o.id} className="bk-poll-row">
              <span className="bk-poll-when">{fullWhen(o.startsAt, end(o.startsAt))}</span>
              <span className="bk-poll-acts" role="radiogroup" aria-label={fullWhen(o.startsAt, end(o.startsAt))}>
                {([['yes', 'Подходит'], ['maybe', 'Возможно'], ['no', 'Не подходит']] as const).map(([k, label]) => (
                  <button key={k} type="button" role="radio" aria-checked={answers[o.id] === k} className={`bk-slot${answers[o.id] === k ? ' on' : ''}`}
                    onClick={() => setAnswers((a) => ({ ...a, [o.id]: k }))}>{label}</button>
                ))}
              </span>
            </div>
          ))}
          <label>Ваше имя<input className="ui-input" required maxLength={120} value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" /></label>
          <label>Email — чтобы получить приглашение<input className="ui-input" type="email" maxLength={320} value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" /></label>
          <button className="ui-btn ui-btn-primary bk-wide" type="submit" disabled={busy || !Object.keys(answers).length}>{busy ? 'Сохраняю…' : 'Отправить ответ'}</button>
        </form>
      )}
      {err && <p className="bk-err" role="alert"><Icon name="alert" size={15} /> {err}</p>}
    </section>
  );
}
