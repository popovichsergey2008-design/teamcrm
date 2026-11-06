import { useEffect, useState } from 'react';
import { Icon } from '../../components/Icon';
import { Button } from '../../components/ui/button';
import { confirmAction, Dialog } from '../../components/ui/dialog';
import { Input } from '../../components/ui/input';
import { api, ApiError, type BookingRules, type BookingType, type BookingTypeInput, type WeeklyHours } from '../../lib/api';
import { toastSaved } from '../../lib/notifications';

const DAYS: [string, string][] = [['1', 'Пн'], ['2', 'Вт'], ['3', 'Ср'], ['4', 'Чт'], ['5', 'Пт'], ['6', 'Сб'], ['0', 'Вс']];
const REMINDERS = [5, 10, 15, 30, 60, 1440];
const remLabel = (m: number) => (m >= 1440 ? 'за сутки' : m >= 60 ? `за ${m / 60} ч` : `за ${m} мин`);

async function copy(text: string) {
  try { await navigator.clipboard.writeText(text); toastSaved('Ссылка скопирована'); }
  catch { window.prompt('Скопируйте ссылку', text); }
}

/**
 * «Поделиться временем» (#4787, п. 6–8): ссылка вместо переписки «когда вам удобно».
 * Виды встреч (готовые и свои), когда человек вообще принимает встречи, и кто записался.
 */
export function ShareTimeDialog({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<'types' | 'rules' | 'list'>('types');
  const [types, setTypes] = useState<BookingType[] | null>(null);
  const [editing, setEditing] = useState<BookingType | 'new' | null>(null);
  const [err, setErr] = useState('');
  const load = () => api.bookingTypes().then(setTypes).catch((e) => setErr(e instanceof ApiError ? e.message : 'Не удалось загрузить'));
  useEffect(() => { void load(); }, []);

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }} size="lg" title="Поделиться временем"
      description="Отправьте ссылку клиенту или коллеге — он сам выберет удобное время, без переписки и без регистрации.">
      <div className="cal-tt">
        <div className="kv2-seg" role="tablist">
          <button className="kv2-seg-btn" aria-pressed={tab === 'types'} onClick={() => setTab('types')}>Виды встреч</button>
          <button className="kv2-seg-btn" aria-pressed={tab === 'rules'} onClick={() => setTab('rules')}>Когда принимаю</button>
          <button className="kv2-seg-btn" aria-pressed={tab === 'list'} onClick={() => setTab('list')}>Записи</button>
        </div>
        {err && <div className="tv2-callout tv2-callout-danger" role="alert"><Icon name="alert" size={15} /> {err}</div>}
        {tab === 'types' && !editing && (
          <>
            <ul className="cal-share-list">
              {(types ?? []).map((t) => (
                <li key={t.id} className="cal-share-item">
                  <div className="cal-share-main">
                    <strong>{t.title}</strong>
                    <span className="dim">
                      {t.durationMin} мин · {t.locationKind === 'call' ? 'созвон' : t.locationKind === 'phone' ? 'телефон' : (t.location || 'место')}
                      {t.weekly ? ' · свои дни и часы' : ''}{t.bufferAfter ? ` · перерыв ${t.bufferAfter} мин` : ''}
                    </span>
                  </div>
                  <div className="cal-share-actions">
                    <Button size="sm" variant="primary" onClick={() => void copy(t.url)}><Icon name="link" size={14} /> Скопировать ссылку</Button>
                    <a className="ui-btn ui-btn-ghost ui-btn-sm" href={t.url} target="_blank" rel="noreferrer" aria-label="Открыть страницу записи"><Icon name="eye" size={14} /></a>
                    <Button size="sm" variant="ghost" onClick={() => setEditing(t)} aria-label="Изменить"><Icon name="edit" size={14} /></Button>
                  </div>
                </li>
              ))}
              {types === null && <li className="dim">Загружаю…</li>}
            </ul>
            <Button variant="outline" onClick={() => setEditing('new')}><Icon name="plus" size={15} /> Свой вид встречи</Button>
          </>
        )}
        {tab === 'types' && editing && (
          <TypeEditor value={editing === 'new' ? null : editing} onDone={() => { setEditing(null); void load(); }} />
        )}
        {tab === 'rules' && <RulesEditor />}
        {tab === 'list' && <Upcoming />}
      </div>
    </Dialog>
  );
}

/** Вид встречи (п. 7): название, длительность, дни и часы, место, перерывы, вопросы, напоминания. */
function TypeEditor({ value, onDone }: { value: BookingType | null; onDone: () => void }) {
  const [t, setT] = useState<BookingTypeInput>(() => value ?? {
    title: '', durationMin: 30, weekly: null, locationKind: 'call', location: null, bufferBefore: 0, bufferAfter: 0, questions: [], reminders: [15],
  });
  const [ownDays, setOwnDays] = useState(!!value?.weekly);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const set = (p: Partial<BookingTypeInput>) => setT((x) => ({ ...x, ...p }));
  const weekly: WeeklyHours = t.weekly ?? {};
  const dayRange = (d: string) => weekly[d]?.[0] ?? null;
  const setDay = (d: string, r: [string, string] | null) => {
    const w = { ...weekly };
    if (r) w[d] = [r]; else delete w[d];
    set({ weekly: w });
  };

  const save = async () => {
    setBusy(true); setErr('');
    try {
      const body = { ...t, weekly: ownDays ? (Object.keys(weekly).length ? weekly : null) : null, questions: (t.questions ?? []).filter((q) => q.text.trim()) };
      if (value) await api.bookingTypeUpdate(value.id, body); else await api.bookingTypeCreate(body);
      toastSaved('Вид встречи сохранён');
      onDone();
    } catch (e) { setErr(e instanceof ApiError ? e.message : 'Не удалось сохранить'); }
    finally { setBusy(false); }
  };

  const remove = async () => {
    if (!value || !(await confirmAction({ title: `Удалить «${value.title}»?`, description: 'Ссылка перестанет работать. Уже записанные встречи останутся.', confirmLabel: 'Удалить', danger: true }))) return;
    await api.bookingTypeDelete(value.id).catch(() => undefined);
    onDone();
  };

  return (
    <div className="cal-type-ed">
      <label className="cal-field">Название<Input value={t.title} maxLength={160} onChange={(e) => set({ title: e.target.value })} placeholder="Обсуждение проекта" /></label>
      <label className="cal-field">Описание для гостя<textarea className="ui-input" rows={2} maxLength={1000} value={t.description ?? ''} onChange={(e) => set({ description: e.target.value })} /></label>
      <div className="cal-field">Продолжительность
        <div className="cal-chips">
          {[15, 30, 45, 60, 90].map((m) => <button key={m} className={`cal-pill${t.durationMin === m ? ' on' : ''}`} onClick={() => set({ durationMin: m })}>{m} мин</button>)}
          <label className="cal-pill-input"><Input type="number" min={5} max={480} value={t.durationMin} onChange={(e) => set({ durationMin: Number(e.target.value) || 30 })} aria-label="Своя длительность" /><span>мин</span></label>
        </div>
      </div>
      <div className="cal-field">Доступные дни и часы
        <label className="cal-check"><input type="checkbox" checked={ownDays} onChange={(e) => setOwnDays(e.target.checked)} /> Свои для этого вида (иначе — общие из «Когда принимаю»)</label>
        {ownDays && (
          <div className="cal-week">
            {DAYS.map(([d, label]) => {
              const r = dayRange(d);
              return (
                <div key={d} className="cal-week-row">
                  <label className="cal-check"><input type="checkbox" checked={!!r} onChange={(e) => setDay(d, e.target.checked ? ['11:00', '16:00'] : null)} /> {label}</label>
                  {r && <>
                    <input className="ui-input cal-time" type="time" value={r[0]} onChange={(e) => setDay(d, [e.target.value, r[1]])} aria-label={`${label}, с`} />
                    <span>—</span>
                    <input className="ui-input cal-time" type="time" value={r[1]} onChange={(e) => setDay(d, [r[0], e.target.value])} aria-label={`${label}, до`} />
                  </>}
                </div>
              );
            })}
          </div>
        )}
      </div>
      <div className="cal-field">Место или способ
        <div className="kv2-seg">
          <button className="kv2-seg-btn" aria-pressed={t.locationKind === 'call'} onClick={() => set({ locationKind: 'call' })}>Созвон QEVO</button>
          <button className="kv2-seg-btn" aria-pressed={t.locationKind === 'place'} onClick={() => set({ locationKind: 'place' })}>Место</button>
          <button className="kv2-seg-btn" aria-pressed={t.locationKind === 'phone'} onClick={() => set({ locationKind: 'phone' })}>Телефон</button>
        </div>
        {t.locationKind !== 'call' && <Input value={t.location ?? ''} maxLength={255} onChange={(e) => set({ location: e.target.value })} placeholder={t.locationKind === 'phone' ? 'Номер или «позвоню сам»' : 'Адрес'} />}
      </div>
      <div className="cal-field cal-field-row">
        <label>Перерыв до, мин<Input type="number" min={0} max={240} value={t.bufferBefore ?? 0} onChange={(e) => set({ bufferBefore: Number(e.target.value) || 0 })} /></label>
        <label>Перерыв после, мин<Input type="number" min={0} max={240} value={t.bufferAfter ?? 0} onChange={(e) => set({ bufferAfter: Number(e.target.value) || 0 })} /></label>
      </div>
      <div className="cal-field">Вопросы гостю перед записью
        {(t.questions ?? []).map((q, i) => (
          <div key={i} className="cal-q-row">
            <Input value={q.text} maxLength={300} onChange={(e) => set({ questions: (t.questions ?? []).map((x, j) => (j === i ? { ...x, text: e.target.value } : x)) })} placeholder="Что вы хотите обсудить?" />
            <label className="cal-check"><input type="checkbox" checked={!!q.required} onChange={(e) => set({ questions: (t.questions ?? []).map((x, j) => (j === i ? { ...x, required: e.target.checked } : x)) })} /> обязательный</label>
            <Button size="icon-sm" variant="ghost" onClick={() => set({ questions: (t.questions ?? []).filter((_, j) => j !== i) })} aria-label="Убрать вопрос"><Icon name="close" size={14} /></Button>
          </div>
        ))}
        {(t.questions ?? []).length < 10 && <Button size="sm" variant="ghost" onClick={() => set({ questions: [...(t.questions ?? []), { text: '', required: false }] })}><Icon name="plus" size={14} /> Вопрос</Button>}
      </div>
      <div className="cal-field">Напоминания мне
        <div className="cal-chips">
          {REMINDERS.map((m) => {
            const on = (t.reminders ?? []).includes(m);
            return <button key={m} className={`cal-pill${on ? ' on' : ''}`} aria-pressed={on}
              onClick={() => set({ reminders: on ? (t.reminders ?? []).filter((x) => x !== m) : [...(t.reminders ?? []), m].sort((a, b) => a - b) })}>{remLabel(m)}</button>;
          })}
        </div>
        <span className="dim">Гостю напоминание приходит на почту за 15 минут.</span>
      </div>
      {err && <div className="tv2-callout tv2-callout-danger" role="alert"><Icon name="alert" size={15} /> {err}</div>}
      <div className="cal-tt-actions">
        <Button variant="primary" onClick={() => void save()} disabled={busy || !t.title.trim()}>Сохранить</Button>
        <Button variant="ghost" onClick={onDone}>Отмена</Button>
        {value && <Button variant="ghost" onClick={() => void remove()}><Icon name="trash" size={14} /> Удалить</Button>}
      </div>
    </div>
  );
}

/** Когда человек принимает встречи (п. 8): гость видит только время, прошедшее все правила. */
function RulesEditor() {
  const [r, setR] = useState<BookingRules | null>(null);
  const [newDate, setNewDate] = useState('');
  const [vac, setVac] = useState({ from: '', to: '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => { api.bookingRules().then(setR).catch((e) => setErr(e instanceof ApiError ? e.message : 'Не удалось загрузить')); }, []);
  if (!r) return err ? <div className="tv2-callout tv2-callout-danger">{err}</div> : <div className="dim">Загружаю…</div>;
  const set = (p: Partial<BookingRules>) => setR({ ...r, ...p });
  const setRanges = (d: string, list: [string, string][]) => {
    const w = { ...r.weekly };
    if (list.length) w[d] = list; else delete w[d];
    set({ weekly: w });
  };

  const save = async () => {
    setBusy(true); setErr('');
    try {
      const { saved: _s, ...body } = r;
      void _s;
      setR(await api.bookingRulesSave(body));
      toastSaved('Правила записи сохранены');
    } catch (e) { setErr(e instanceof ApiError ? e.message : 'Не удалось сохранить'); }
    finally { setBusy(false); }
  };

  return (
    <div className="cal-type-ed">
      <div className="cal-field">Часы для встреч по дням недели
        <div className="cal-week">
          {DAYS.map(([d, label]) => {
            const list = r.weekly[d] ?? [];
            return (
              <div key={d} className="cal-week-row">
                <label className="cal-check"><input type="checkbox" checked={list.length > 0} onChange={(e) => setRanges(d, e.target.checked ? [['09:00', '18:00']] : [])} /> {label}</label>
                {list.map((x, i) => (
                  <span key={i} className="cal-range">
                    <input className="ui-input cal-time" type="time" value={x[0]} onChange={(e) => setRanges(d, list.map((y, j) => (j === i ? [e.target.value, y[1]] : y)))} aria-label={`${label}, с`} />
                    <span>—</span>
                    <input className="ui-input cal-time" type="time" value={x[1]} onChange={(e) => setRanges(d, list.map((y, j) => (j === i ? [y[0], e.target.value] : y)))} aria-label={`${label}, до`} />
                    {list.length > 1 && <button className="ui-btn ui-btn-ghost ui-btn-icon-sm" onClick={() => setRanges(d, list.filter((_, j) => j !== i))} aria-label="Убрать промежуток"><Icon name="close" size={12} /></button>}
                  </span>
                ))}
                {list.length > 0 && list.length < 4 && (
                  <button className="cal-due-link" onClick={() => {
                    const last = list[list.length - 1];
                    setRanges(d, [...list.slice(0, -1), [last[0], '13:00'], ['14:00', last[1] > '14:00' ? last[1] : '18:00']]);
                  }}>+ перерыв</button>
                )}
              </div>
            );
          })}
        </div>
      </div>
      <div className="cal-field cal-field-row">
        <label>Не больше встреч в день<Input type="number" min={0} max={50} value={r.maxPerDay ?? ''} placeholder="без лимита" onChange={(e) => set({ maxPerDay: e.target.value ? Number(e.target.value) : null })} /></label>
        <label>Запись не позже чем за, часов<Input type="number" min={0} max={336} value={Math.round(r.minNoticeMin / 60)} onChange={(e) => set({ minNoticeMin: Math.max(0, Number(e.target.value) || 0) * 60 })} /></label>
        <label>Открыто вперёд на, дней<Input type="number" min={1} max={365} value={r.horizonDays} onChange={(e) => set({ horizonDays: Math.max(1, Number(e.target.value) || 14) })} /></label>
      </div>
      <div className="cal-field">Закрытые даты
        <div className="cal-chips">
          {r.blockedDates.map((d) => (
            <span key={d} className="cal-pill on">{new Date(`${d}T12:00`).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })}
              <button className="cal-pill-x" onClick={() => set({ blockedDates: r.blockedDates.filter((x) => x !== d) })} aria-label="Открыть дату">×</button></span>
          ))}
          <input className="ui-input cal-time" type="date" value={newDate} onChange={(e) => setNewDate(e.target.value)} aria-label="Дата" />
          <Button size="sm" variant="ghost" disabled={!newDate} onClick={() => { set({ blockedDates: [...new Set([...r.blockedDates, newDate])].sort() }); setNewDate(''); }}>Закрыть дату</Button>
        </div>
      </div>
      <div className="cal-field">Отпуск
        <div className="cal-chips">
          {r.vacations.map((v, i) => (
            <span key={i} className="cal-pill on">{v.from} — {v.to}
              <button className="cal-pill-x" onClick={() => set({ vacations: r.vacations.filter((_, j) => j !== i) })} aria-label="Убрать отпуск">×</button></span>
          ))}
          <input className="ui-input cal-time" type="date" value={vac.from} onChange={(e) => setVac({ ...vac, from: e.target.value })} aria-label="Отпуск с" />
          <input className="ui-input cal-time" type="date" value={vac.to} onChange={(e) => setVac({ ...vac, to: e.target.value })} aria-label="Отпуск по" />
          <Button size="sm" variant="ghost" disabled={!vac.from || !vac.to || vac.from > vac.to} onClick={() => { set({ vacations: [...r.vacations, vac] }); setVac({ from: '', to: '' }); }}>Добавить</Button>
        </div>
      </div>
      <label className="cal-field">Ваш часовой пояс<Input value={r.timezone ?? ''} onChange={(e) => set({ timezone: e.target.value })} placeholder="Europe/Moscow" /></label>
      {err && <div className="tv2-callout tv2-callout-danger" role="alert"><Icon name="alert" size={15} /> {err}</div>}
      <div className="cal-tt-actions"><Button variant="primary" onClick={() => void save()} disabled={busy}>Сохранить правила</Button></div>
    </div>
  );
}

function Upcoming() {
  const [list, setList] = useState<Awaited<ReturnType<typeof api.bookingUpcoming>> | null>(null);
  useEffect(() => { api.bookingUpcoming().then(setList).catch(() => setList([])); }, []);
  if (!list) return <div className="dim">Загружаю…</div>;
  if (!list.length) return <div className="dim">Пока никто не записался. Отправьте ссылку из «Видов встреч».</div>;
  return (
    <ul className="cal-share-list">
      {list.map((b) => (
        <li key={b.id} className="cal-share-item">
          <div className="cal-share-main">
            <strong>{b.guestName} · {b.typeTitle}</strong>
            <span className="dim">{new Date(b.startsAt).toLocaleString('ru-RU', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })} · {b.guestEmail}</span>
          </div>
        </li>
      ))}
    </ul>
  );
}
