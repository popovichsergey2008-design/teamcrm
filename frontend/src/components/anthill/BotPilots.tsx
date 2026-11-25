import { useCallback, useEffect, useState } from 'react';
import { Icon } from '../Icon';
import { ClampText } from '../ClampText';
import { RichText } from '../RichText';
import { Dialog, confirmAction } from '../ui/dialog';
import { api, ApiError, request } from '../../lib/api';
import type { AnthillActionRow, AnthillReminder, AnthillSchedule, SecretaryPrefs } from '../../lib/api';
import { toastSaved } from '../../lib/notifications';
import { navigate } from '../../lib/router';
import { botApi } from './bot-api';
import './bot-v3.css';

/**
 * Вкладка «Автопилоты» (#5035, п. 6): всё регулярное — в одном месте (раньше — галочки
 * на стартовом экране, в каталоге и во вкладке «Задачи»).
 *
 * «Готовые» — 6 строк: название (нажатие — пример на ваших данных), подпись, время,
 * переключатель. «Мои» — свои регулярные задачи с «Править» и переключателем. Справка
 * перед встречей — одно время везде, по умолчанию за 15 минут. «Следующий запуск» —
 * подписью сервера в поясе расписания (18:00 не превращается в 22:00).
 */
type Kind = 'morning' | 'meeting' | 'evening' | 'staff' | 'silent' | 'week';
interface Ready {
  id: Kind; title: string; hint: string;
  /** Варианты времени: значение и подпись. */
  options: { v: string; label: string }[];
  /** Сводки секретаря — настройкой; остальные — регулярной задачей бота. */
  secretary?: 'morning' | 'evening' | 'meeting';
  instruction?: string;
  /** Пример на данных человека — тем же запросом в чат. */
  example: string;
}
const times = (list: string[], suffix: string) => list.map((t) => ({ v: t, label: `${t} · ${suffix}` }));
const READY: Ready[] = [
  { id: 'morning', title: 'Утром — ваш день', hint: 'встречи, сроки, просрочки, что ждёт решения', secretary: 'morning', options: times(['8:00', '8:30', '9:00', '9:30', '10:00'], 'будни'), example: 'Сводка моего дня: встречи, сроки, просрочки и что ждёт моего решения.' },
  { id: 'meeting', title: 'Перед встречей — справка', hint: 'кто будет, прошлые решения, открытые задачи', secretary: 'meeting', options: [{ v: '15', label: 'за 15 мин' }, { v: '30', label: 'за 30 мин' }, { v: '60', label: 'за час' }], example: 'Подготовь брифинг к моей ближайшей встрече: кто будет, что обсуждали раньше, открытые задачи и вопросы.' },
  { id: 'evening', title: 'Вечером — итоги', hint: 'что сделано, перенесено, что завтра', secretary: 'evening', options: times(['17:00', '17:30', '18:00', '18:30', '19:00', '20:00'], 'будни'), example: 'Итоги моего дня: что сделано, что перенесено, что на завтра.' },
  { id: 'staff', title: 'Сводка отчётов сотрудников', hint: 'по человеку: сделано, риски, кто не прислал', options: times(['9:00', '9:30', '10:00', '11:00'], 'будни'), instruction: 'Сведи вчерашние отчёты сотрудников в одну сводку: по человеку — что сделано, статус «по плану» или «риски», кто не прислал.', example: 'Сведи вчерашние отчёты сотрудников в одну сводку: по человеку — что сделано, статус «по плану» или «риски», кто не прислал.' },
  { id: 'silent', title: 'Кто не ответил', hint: 'сообщения и поручения без ответа больше 1 дня', options: times(['9:00', '10:00', '11:00', '15:00'], 'будни'), instruction: 'Какие мои сообщения и поручения остались без ответа больше 1 дня? Список и вежливые напоминания черновиками.', example: 'Какие мои сообщения и поручения остались без ответа больше 1 дня? Список и вежливые напоминания черновиками — ничего не отправляй.' },
  { id: 'week', title: 'Недельный обзор', hint: 'закрыто, перенесено, просрочено, риски', options: [{ v: 'fri16', label: 'пт 16:00' }, { v: 'fri17', label: 'пт 17:00' }, { v: 'mon9', label: 'пн 9:00' }], instruction: 'Недельный обзор: что закрыто, что переносится, что просрочено, главные риски следующей недели.', example: 'Недельный обзор: что закрыто, что переносится, что просрочено, главные риски следующей недели.' },
];
/** Старые названия тех же автопилотов (#4893) — чтобы включённые раньше узнавались. */
const LEGACY: Partial<Record<Kind, string[]>> = { week: ['Обзор задач за неделю'] };
const DEFAULT: Record<Kind, string> = { morning: '9:00', meeting: '15', evening: '18:30', staff: '9:30', silent: '10:00', week: 'fri16' };
const phraseOf = (k: Kind, v: string) => (k === 'week'
  ? ({ fri16: 'каждую пятницу в 16:00', fri17: 'каждую пятницу в 17:00', mon9: 'каждый понедельник в 9:00' } as Record<string, string>)[v] ?? 'каждую пятницу в 16:00'
  : `по будням в ${v}`);
const hhmm = (v: string) => (v.length === 4 ? `0${v}` : v);
const short = (v: string | null | undefined) => (v ? v.replace(/^0(\d):/, '$1:') : null);

export default function BotPilots({ onExample, onOpenSession }: { onExample: (prompt: string) => void; onOpenSession: (id: string) => void }) {
  const [prefs, setPrefs] = useState<SecretaryPrefs | null>(null);
  const [rows, setRows] = useState<AnthillSchedule[]>([]);
  const [pending, setPending] = useState<AnthillActionRow[]>([]);
  const [reminders, setReminders] = useState<AnthillReminder[]>([]);
  const [week, setWeek] = useState<{ text: string; minutes: number; method: { key: string; minutes: number; what: string }[] } | null>(null);
  const [method, setMethod] = useState(false);
  const [pick, setPick] = useState<Record<string, string>>({});
  const [ask, setAsk] = useState<{ r: Ready; when: string } | null>(null);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [err, setErr] = useState('');

  const load = useCallback(() => {
    void api.secretaryPrefs().then(setPrefs).catch(() => undefined);
    void api.anthillSchedules().then(setRows).catch(() => undefined);
    void api.anthillReminders().then(setReminders).catch(() => undefined);
    void api.anthillActions().then((l) => setPending(l.filter((a) => a.status === 'pending'))).catch(() => undefined);
    void request<NonNullable<typeof week>>('GET', '/anthill/week').then(setWeek).catch(() => undefined);
  }, []);
  useEffect(() => {
    load();
    window.addEventListener('teamcrm:bot-schedules', load);
    return () => window.removeEventListener('teamcrm:bot-schedules', load);
  }, [load]);

  const fail = (e: unknown, t = 'Не получилось') => setErr(e instanceof ApiError ? e.message : t);
  const rowOf = (r: Ready) => rows.find((x) => (x.title === r.title || LEGACY[r.id]?.includes(x.title)) && x.status !== 'done');
  const readyTitles = new Set(READY.flatMap((r) => [r.title, ...(LEGACY[r.id] ?? [])]));
  const mine = rows.filter((x) => !readyTitles.has(x.title) && x.status !== 'done');

  const isOn = (r: Ready) => (r.secretary === 'morning' ? !!prefs?.morningAt : r.secretary === 'evening' ? !!prefs?.eveningAt
    : r.secretary === 'meeting' ? !!prefs?.meetingBriefMin : rowOf(r)?.status === 'active');
  const value = (r: Ready): string => {
    if (pick[r.id]) return pick[r.id];
    if (r.secretary === 'morning') return short(prefs?.morningAt) ?? DEFAULT.morning;
    if (r.secretary === 'evening') return short(prefs?.eveningAt) ?? DEFAULT.evening;
    if (r.secretary === 'meeting') return prefs?.meetingBriefMin ? String(prefs.meetingBriefMin) : DEFAULT.meeting;
    const row = rowOf(r);
    if (row && r.id !== 'week') return short(row.schedule.time) ?? DEFAULT[r.id];
    if (row && r.id === 'week') return row.schedule.weekday === 1 ? 'mon9' : row.schedule.time?.startsWith('17') ? 'fri17' : 'fri16';
    return DEFAULT[r.id];
  };
  const secretaryPatch = (r: Ready, on: boolean, v: string): Partial<SecretaryPrefs> => (r.secretary === 'morning' ? { morningAt: on ? hhmm(v) : null }
    : r.secretary === 'evening' ? { eveningAt: on ? hhmm(v) : null } : { meetingBriefMin: on ? Number(v) : null });

  /** Когда придёт первый выпуск — словами для вопроса «Включить?». */
  const firstRun = async (r: Ready, v: string): Promise<string> => {
    if (r.secretary === 'meeting') return `за ${v === '60' ? 'час' : `${v} мин`} до ближайшей встречи`;
    if (r.secretary) {
      const [h, m] = v.split(':').map(Number);
      const at = new Date(); at.setHours(h, m, 0, 0);
      return `${at.getTime() > Date.now() ? 'сегодня' : 'завтра'} в ${v}`;
    }
    try { return (await botApi.schedulePreview(phraseOf(r.id, v))).firstRun; } catch { return phraseOf(r.id, v); }
  };

  const toggle = async (r: Ready) => {
    setErr('');
    const v = value(r);
    try {
      if (isOn(r)) {
        // выключается одним нажатием
        if (r.secretary) setPrefs(await api.saveSecretaryPrefs(secretaryPatch(r, false, v)));
        else { const row = rowOf(r); if (row) await api.anthillPatchSchedule(row.id, { status: 'paused' }); load(); }
        toastSaved('Выключено', r.title);
        return;
      }
      setAsk({ r, when: await firstRun(r, v) });
    } catch (e) { fail(e); }
  };
  const enable = async (r: Ready) => {
    const v = value(r);
    try {
      if (r.secretary) setPrefs(await api.saveSecretaryPrefs(secretaryPatch(r, true, v)));
      else {
        const row = rowOf(r);
        if (row) await api.anthillPatchSchedule(row.id, { status: 'active', schedule: phraseOf(r.id, v) });
        else await botApi.addSchedule({ title: r.title, instruction: r.instruction!, schedule: phraseOf(r.id, v) });
        load();
      }
      toastSaved('Включено', r.title);
    } catch (e) { fail(e); }
    finally { setAsk(null); }
  };
  const changeTime = async (r: Ready, v: string) => {
    setPick((p) => ({ ...p, [r.id]: v }));
    if (!isOn(r)) return;
    try {
      if (r.secretary) setPrefs(await api.saveSecretaryPrefs(secretaryPatch(r, true, v)));
      else { const row = rowOf(r); if (row) { await api.anthillPatchSchedule(row.id, { schedule: phraseOf(r.id, v) }); load(); } }
      toastSaved('Время изменено', r.title);
    } catch (e) { fail(e); }
  };
  const saveDelivery = async (patch: Partial<SecretaryPrefs>) => {
    try { setPrefs(await api.saveSecretaryPrefs(patch)); } catch (e) { fail(e); }
  };

  return (
    <div className="bv-pane" aria-label="Автопилоты">
      <h2 className="bv-h">Автопилоты</h2>
      <p className="bv-sub">
        Бот сам делает это по расписанию и присылает в чат{' '}
        <button type="button" className="link-btn" onClick={() => { void api.openSelfChat().then((c) => navigate({ section: 'chat', chatId: String(c.id) })).catch(() => navigate({ section: 'chat' })); }}>«Заметки»</button>
        {' '}и уведомлением. Включается одним переключателем. Нажмите на название — покажу пример на ваших данных.
      </p>
      {err && <div className="error-text" role="alert">{err}</div>}

      <section className="bv-card">
        <div className="bv-card-h"><b>Готовые</b></div>
        {READY.map((r) => {
          const on = isOn(r);
          const v = value(r);
          const row = rowOf(r);
          return (
            <div key={r.id} className="bv-pilot">
              <button type="button" className="bv-pilot-text" onClick={() => onExample(r.example)} title="Показать пример на ваших данных">
                <b>{r.title}</b>
                <span>{r.hint}{on && row?.nextRunLabel ? ` · следующий: ${row.nextRunLabel}` : ''}</span>
              </button>
              <select className="bv-time" value={v} onChange={(e) => void changeTime(r, e.target.value)} aria-label={`Время: ${r.title}`}>
                {!r.options.some((o) => o.v === v) && <option value={v}>{r.secretary === 'meeting' ? `за ${v} мин` : `${v} · будни`}</option>}
                {r.options.map((o) => <option key={o.v} value={o.v}>{r.secretary && r.secretary !== 'meeting' && prefs && !prefs.weekdaysOnly ? o.label.replace('будни', 'каждый день') : o.label}</option>)}
              </select>
              <button type="button" role="switch" aria-checked={on} className={`bv-switch${on ? ' is-on' : ''}`} onClick={() => void toggle(r)} aria-label={`${on ? 'Выключить' : 'Включить'}: ${r.title}`}>
                <i />
              </button>
            </div>
          );
        })}
      </section>

      <section className="bv-card">
        <div className="bv-card-h"><b>Мои</b><span className="bv-sp" /><button type="button" className="ui-btn ui-btn-outline ui-btn-sm" onClick={() => setAdding((x) => !x)}><Icon name="plus" size={13} /> Свой автопилот</button></div>
        {adding && <PilotForm onCancel={() => setAdding(false)} onSave={async (d) => { await api.anthillAddSchedule(d); setAdding(false); load(); toastSaved('Автопилот создан', d.title); }} />}
        {mine.length === 0 && !adding && <div className="bv-empty">Своих пока нет. Попросите в чате: «каждый понедельник в 9:00 дай список просроченных» — или нажмите «Свой автопилот».</div>}
        {mine.map((row) => (
          <div key={row.id} className="bv-pilot bv-pilot-mine">
            <div className="bv-pilot-text bv-pilot-static">
              <b>{row.title}</b>
              <span>{row.label}{row.status === 'active' && row.nextRunLabel ? ` · следующая: ${row.nextRunLabel}` : row.status === 'paused' ? ' · на паузе' : ''}</span>
              {row.lastError && <span className="error-text">Прошлый запуск не удался: {row.lastError}</span>}
            </div>
            <button type="button" className="ui-btn ui-btn-outline ui-btn-sm" onClick={() => setEditing((x) => (x === row.id ? null : row.id))}>Править</button>
            <button type="button" role="switch" aria-checked={row.status === 'active'} className={`bv-switch${row.status === 'active' ? ' is-on' : ''}`}
              onClick={() => void api.anthillPatchSchedule(row.id, { status: row.status === 'active' ? 'paused' : 'active' }).then(load).catch(fail)}
              aria-label={`${row.status === 'active' ? 'Выключить' : 'Включить'}: ${row.title}`}><i /></button>
            {editing === row.id && (
              <PilotForm
                row={row}
                onCancel={() => setEditing(null)}
                onSave={async (d) => { await api.anthillPatchSchedule(row.id, d); setEditing(null); load(); }}
                onDelete={async () => {
                  if (!(await confirmAction({ title: `Удалить «${row.title}»?`, description: 'Автопилот перестанет выполняться.', danger: true }))) return;
                  await api.anthillDeleteSchedule(row.id); setEditing(null); load();
                }}
                onOpenSession={row.sessionId ? () => onOpenSession(row.sessionId!) : undefined}
              />
            )}
          </div>
        ))}
      </section>

      {pending.length > 0 && (
        <section className="bv-card">
          <div className="bv-card-h"><b>Ждут вашего решения</b></div>
          {pending.map((a) => (
            <div key={a.id} className="bv-pilot">
              <div className="bv-pilot-text bv-pilot-static">
                <b>{a.tool === 'create_scheduled_task' ? 'Делать регулярно' : a.tool === 'create_task' ? 'Создать задачу' : a.tool === 'create_reminder' ? 'Напоминание' : 'Действие бота'}</b>
                <ClampText className="dim" lines={2}>{String((a.input as Record<string, unknown> | null)?.title ?? (a.input as Record<string, unknown> | null)?.text ?? (a.input as Record<string, unknown> | null)?.instruction ?? '')}</ClampText>
              </div>
              <button type="button" className="ui-btn ui-btn-primary ui-btn-sm" onClick={() => void api.anthillConfirm(a.id).then(load).catch(fail)}><Icon name="check" size={13} /> Да</button>
              <button type="button" className="ui-btn ui-btn-ghost ui-btn-sm" onClick={() => void api.anthillReject(a.id).then(load).catch(fail)}>Отмена</button>
            </div>
          ))}
        </section>
      )}

      {reminders.length > 0 && (
        <section className="bv-card">
          <div className="bv-card-h"><b>Напоминания</b></div>
          {reminders.map((r) => (
            <div key={r.id} className="bv-pilot">
              <div className="bv-pilot-text bv-pilot-static">
                <b>{r.text}</b>
                <span>{new Date(r.dueAt).toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })}{r.repeat ? ` · ${r.repeat.toLowerCase()}` : ''}</span>
              </div>
              <button type="button" className="msg-icon" title="Отменить напоминание" aria-label="Отменить напоминание" onClick={() => void api.anthillCancelReminder(r.id).then(load).catch(fail)}><Icon name="close" size={13} /></button>
            </div>
          ))}
        </section>
      )}

      {prefs && (
        <details className="bv-delivery">
          <summary>Как доставлять сводки</summary>
          <label><input type="checkbox" checked={prefs.weekdaysOnly} onChange={(e) => void saveDelivery({ weekdaysOnly: e.target.checked })} /> Только в будни</label>
          <label><input type="checkbox" checked={prefs.channels.push} onChange={(e) => void saveDelivery({ channels: { ...prefs.channels, push: e.target.checked } })} /> Уведомлением на телефон <span className="dim">— в приложении сводка будет всегда</span></label>
          <label><input type="checkbox" checked={prefs.channels.telegram} onChange={(e) => void saveDelivery({ channels: { ...prefs.channels, telegram: e.target.checked } })} /> В Telegram <span className="dim">— если бот привязан в личном кабинете</span></label>
        </details>
      )}

      {week && week.minutes > 0 && (
        <div className="bv-week">
          {week.text}{' '}
          <button type="button" className="link-btn" aria-expanded={method} onClick={() => setMethod((x) => !x)}>Как считали</button>
          {method && (
            <ul className="dim">
              {week.method.map((m) => <li key={m.key}>{m.what} — {m.minutes} мин</li>)}
              <li>Числа — из журнала действий бота за последние 7 дней.</li>
            </ul>
          )}
        </div>
      )}

      {ask && (
        <Dialog open onOpenChange={(o) => { if (!o) setAsk(null); }} size="sm" title={ask.r.title}
          footer={(
            <>
              <button type="button" className="ui-btn ui-btn-ghost ui-btn-md" onClick={() => setAsk(null)}>Отмена</button>
              <button type="button" className="ui-btn ui-btn-primary ui-btn-md" onClick={() => void enable(ask.r)}>Включить</button>
            </>
          )}>
          <p style={{ margin: 0 }}>Пришлю {ask.when} в чат «Заметки». Включить?</p>
        </Dialog>
      )}
    </div>
  );
}

/** Свой автопилот: название, что делать, когда; в «Править» — ещё «Удалить» и «Нитка». */
function PilotForm({ row, onSave, onCancel, onDelete, onOpenSession }: {
  row?: AnthillSchedule;
  onSave: (d: { title: string; instruction: string; schedule: string }) => Promise<void>;
  onCancel: () => void; onDelete?: () => Promise<void>; onOpenSession?: () => void;
}) {
  const [v, setV] = useState({ title: row?.title ?? '', instruction: row?.instruction ?? '', schedule: row?.label ?? '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const save = async () => {
    setBusy(true); setErr('');
    try { await onSave({ title: v.title.trim(), instruction: v.instruction.trim(), schedule: v.schedule.trim() }); }
    catch (e) { setErr(e instanceof ApiError ? e.message : 'Не удалось сохранить'); }
    finally { setBusy(false); }
  };
  return (
    <div className="bv-form">
      <label><span>Название</span><input className="input" value={v.title} onChange={(e) => setV({ ...v, title: e.target.value })} placeholder="Просроченные за неделю" /></label>
      <label><span>Что делать при каждом запуске</span><textarea className="input" rows={2} value={v.instruction} onChange={(e) => setV({ ...v, instruction: e.target.value })} placeholder="дай список просроченных задач по всем проектам" /></label>
      <label><span>Когда</span><input className="input" value={v.schedule} onChange={(e) => setV({ ...v, schedule: e.target.value })} placeholder="каждый понедельник в 9:00" /></label>
      {err && <div className="error-text">{err}</div>}
      {row?.lastResult && (
        <details><summary>Что пришло в прошлый раз</summary><RichText text={row.lastResult} /></details>
      )}
      <div className="bv-form-acts">
        <button type="button" className="ui-btn ui-btn-primary ui-btn-sm" disabled={busy || !v.title.trim() || v.instruction.trim().length < 5 || !v.schedule.trim()} onClick={() => void save()}>Сохранить</button>
        <button type="button" className="ui-btn ui-btn-ghost ui-btn-sm" disabled={busy} onClick={onCancel}>Отмена</button>
        {onOpenSession && <button type="button" className="ui-btn ui-btn-ghost ui-btn-sm" onClick={onOpenSession}><Icon name="chat" size={13} /> Прошлые выпуски</button>}
        {onDelete && <button type="button" className="ui-btn ui-btn-ghost ui-btn-sm bv-danger" disabled={busy} onClick={() => void onDelete()}><Icon name="trash" size={13} /> Удалить</button>}
      </div>
    </div>
  );
}
