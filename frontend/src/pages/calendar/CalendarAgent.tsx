import { useEffect, useState } from 'react';
import { Icon } from '../../components/Icon';
import { Dialog } from '../../components/ui/dialog';
import { useVoiceInput } from '../../hooks/useVoiceInput';
import { ApiError, request } from '../../lib/api';
import { plural } from '../../lib/chat-text';
import { toastSaved } from '../../lib/notifications';
import { fmtMinutes } from './TaskTimeDialog';

interface PlanItem {
  kind: 'move' | 'create'; eventId?: string; title: string; fromStartsAt?: string; fromEndsAt?: string;
  startsAt: string; endsAt: string; status: string; ok: boolean; participantIds?: string[];
}
interface Plan { kind: 'plan' | 'summary' | 'none'; text: string; items: PlanItem[]; message: string | null }

const when = (iso: string) => `${new Date(iso).toLocaleDateString('ru-RU', { weekday: 'short' })} ${new Date(iso).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}`;
const pad = (n: number) => String(n).padStart(2, '0');
const local = (iso: string) => { const d = new Date(iso); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`; };

/**
 * ИИ-агент календаря (#4892, п. 13): «перенеси все мои встречи завтра после 15:00 на
 * пятницу», «найди час с Глебом на этой неделе», «освободи мне утро четверга», «что у
 * меня завтра?». Ответ — план: было → стало, «все свободны» или «Алина занята», текст
 * участникам. «Применить», «Изменить», «Отмена»; без «Применить» ничего не меняется.
 */
/** #4920, п. 2: разговор с агентом не пропадает при закрытии окна — до 10 последних реплик. */
const HISTORY_KEY = 'calendar.agent.history';
type Turn = { asked: string; text: string };
const loadTurns = (): Turn[] => { try { return JSON.parse(localStorage.getItem(HISTORY_KEY) ?? '[]').slice(-10); } catch { return []; } };
const saveTurns = (t: Turn[]) => { try { localStorage.setItem(HISTORY_KEY, JSON.stringify(t.slice(-10))); } catch { /* без хранилища — история до закрытия окна */ } };

export function CalendarAgent({ initial, onClose, onApplied }: { initial?: string; onClose: () => void; onApplied: () => void }) {
  const [text, setText] = useState(initial ?? '');
  const [asked, setAsked] = useState('');
  const [plan, setPlan] = useState<Plan | null>(null);
  /** Прошлые реплики: показываем над ответом и отправляем агенту — «а во вторник?» понятно из них. */
  const [turns, setTurns] = useState<Turn[]>(loadTurns);
  const [edit, setEdit] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const ask = async (t: string) => {
    if (t.trim().length < 3) return;
    // прошлый ответ уходит в историю, как только задан новый вопрос
    const past = asked && plan ? [...turns, { asked, text: plan.text }].slice(-10) : turns;
    setTurns(past); saveTurns(past);
    setBusy(true); setErr(''); setEdit(false); setAsked(t.trim());
    try {
      const r = await request<Plan>('POST', '/calendar/plus/agent', { text: t.trim(), history: past.map((x) => x.asked).slice(-5) });
      setPlan(r); setText('');
      saveTurns([...past, { asked: t.trim(), text: r.text }]);
    }
    catch (e) { setErr(e instanceof ApiError ? e.message : 'Агент не ответил'); }
    finally { setBusy(false); }
  };
  useEffect(() => { if (initial) void ask(initial); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const voice = useVoiceInput(async (heard) => { void ask(heard); });
  const apply = async () => {
    if (!plan) return;
    setBusy(true); setErr('');
    try {
      const r = await request<{ applied: number }>('POST', '/calendar/plus/agent/apply', { items: plan.items, message: plan.message });
      toastSaved('План применён', `изменений: ${r.applied}`);
      onApplied();
    } catch (e) { setErr(e instanceof ApiError ? e.message : 'Не удалось применить'); }
    finally { setBusy(false); }
  };
  const listen = () => {
    try {
      const u = new SpeechSynthesisUtterance(plan?.text ?? '');
      u.lang = 'ru-RU';
      window.speechSynthesis.cancel();
      window.speechSynthesis.speak(u);
    } catch { /* озвучки нет — текст и так на экране */ }
  };
  const setTime = (i: number, v: string) => setPlan((p) => {
    if (!p) return p;
    const items = [...p.items];
    const dur = Date.parse(items[i].endsAt) - Date.parse(items[i].startsAt);
    const s = new Date(v).getTime();
    if (Number.isNaN(s)) return p;
    items[i] = { ...items[i], startsAt: new Date(s).toISOString(), endsAt: new Date(s + dur).toISOString(), status: 'вы выбрали время', ok: true };
    return { ...p, items };
  });

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }} size="lg" title="ИИ-агент · календарь"
      description="Агент ничего не меняет без «Применить». Работает здесь, в чате с ботом, голосом и в Telegram.">
      <div className="cal-agent">
        {turns.length > 0 && (
          <div className="cal-agent-history" aria-label="Прошлые команды" style={{ display: 'grid', gap: 6, maxHeight: 220, overflowY: 'auto' }}>
            {turns.map((x, i) => (
              <div key={i} style={{ display: 'grid', gap: 2 }}>
                <div className="cal-agent-me">{x.asked}</div>
                <div className="dim cal-small" style={{ whiteSpace: 'pre-line' }}>{x.text}</div>
              </div>
            ))}
            <button type="button" className="cal-due-link" style={{ justifySelf: 'start' }} onClick={() => { setTurns([]); saveTurns(asked && plan ? [{ asked, text: plan.text }] : []); }}>Очистить историю</button>
          </div>
        )}
        {asked && <div className="cal-agent-me">{asked}</div>}
        {plan && plan.kind === 'summary' && (
          <div className="cal-agent-card">
            {plan.text.split('\n').map((l, i) => <div key={i} className={i === 0 ? 'cal-agent-title' : 'cal-small'}>{l}</div>)}
            <button type="button" className="ui-btn ui-btn-outline ui-btn-sm" onClick={listen}><Icon name="play" size={13} /> Прослушать</button>
          </div>
        )}
        {plan && plan.kind !== 'summary' && (
          <div className="cal-agent-card">
            <div className="cal-agent-title">{plan.items.length ? `План изменений · ${plan.items.length}` : plan.text}</div>
            {plan.items.length > 0 && plan.text && !plan.text.startsWith('План') && <div className="dim cal-small">{plan.text}</div>}
            {plan.items.map((it, i) => (
              <div key={`${it.eventId ?? 'new'}${i}`} className="cal-agent-row">
                <span>{it.title}{it.fromStartsAt ? ` · ${when(it.fromStartsAt)} →` : ' · новая встреча'}</span>
                {edit
                  ? <input type="datetime-local" className="ui-input cal-agent-time" value={local(it.startsAt)} onChange={(e) => setTime(i, e.target.value)} aria-label={`Новое время: ${it.title}`} />
                  : <b>{when(it.startsAt)}</b>}
                <span className={`cal-pill ${it.ok ? 'ok' : 'warn'}`}>{it.status}</span>
              </div>
            ))}
            {plan.message && <div className="dim cal-small">Участникам уйдёт: «{plan.message}»</div>}
            {plan.items.length > 0 && (
              <div className="cal-dialog-actions">
                <button type="button" className="ui-btn ui-btn-primary ui-btn-sm" disabled={busy} onClick={() => void apply()}>{busy ? 'Применяю…' : 'Применить'}</button>
                <button type="button" className="ui-btn ui-btn-outline ui-btn-sm" onClick={() => setEdit((v) => !v)}>{edit ? 'Готово' : 'Изменить'}</button>
                <button type="button" className="ui-btn ui-btn-ghost ui-btn-sm" onClick={() => { setPlan(null); setAsked(''); }}>Отмена</button>
              </div>
            )}
          </div>
        )}
        {err && <div className="tv2-callout tv2-callout-danger" role="alert"><Icon name="alert" size={14} /> {err}</div>}
        <div className="cal-phrase-field">
          <input className="cal-phrase-input" value={text} disabled={busy} onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void ask(text); } }}
            placeholder="«перенеси все мои встречи завтра после 15:00 на пятницу» · «что у меня завтра?»" aria-label="Команда агенту" />
          <button type="button" className={`cal-phrase-mic${voice.recording ? ' on' : ''}`} onClick={voice.toggle} disabled={voice.transcribing} aria-label="Сказать голосом"><Icon name={voice.transcribing ? 'clock' : 'mic'} size={15} /></button>
          <button type="button" className="ui-btn ui-btn-primary ui-btn-sm" disabled={busy || text.trim().length < 3} onClick={() => void ask(text)}>{busy ? '…' : 'Отправить'}</button>
        </div>
      </div>
    </Dialog>
  );
}

interface MyWeek {
  meetingMin: number; focusMin: number; otherMin: number; workMin: number;
  recurring: { seriesId: string; title: string; weeklyMin: number; count: number; nextEventId: string | null; canEdit: boolean }[];
  bare: { count: number; days: string[] }; bestFocus: string | null;
}
interface TeamRow { userId: string; name: string; meetingMin: number; focusMin: number }

/**
 * Аналитика времени (#4892, п. 12): «Моя неделя» — встречи, фокус, остальное, самые
 * «дорогие» регулярные встречи, встречи без повестки и итогов, лучшее время для фокуса.
 * «Команда» — руководителю, только часы по категориям, без названий чужих встреч.
 */
export function TimeAnalytics({ from, to, boss, onClose, onChanged }: { from: string; to: string; boss: boolean; onClose: () => void; onChanged: () => void }) {
  const [me, setMe] = useState<MyWeek | null>(null);
  const [team, setTeam] = useState<TeamRow[] | null>(null);
  const load = () => {
    request<MyWeek>('GET', `/calendar/plus/analytics/me?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`).then(setMe).catch(() => undefined);
    if (boss) request<TeamRow[]>('GET', `/calendar/plus/analytics/team?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`).then(setTeam).catch(() => undefined);
  };
  useEffect(load, [from, to, boss]); // eslint-disable-line react-hooks/exhaustive-deps
  const h = (m: number) => fmtMinutes(m) || '0 ч';
  const max = Math.max(1, ...(team ?? []).map((r) => r.meetingMin + r.focusMin));
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }} size="lg" title="Аналитика времени">
      <div className="cal-analytics">
        <section className="cal-agent-card">
          <div className="cal-first-kicker">Моя неделя</div>
          {!me ? <div className="dim cal-small">Считаю…</div> : (
            <>
              <div className="cal-agent-title">{h(me.meetingMin)} встреч · {h(me.focusMin)} фокуса · {h(me.otherMin)} на остальное</div>
              {me.recurring.map((r) => (
                <div key={r.seriesId} className="cal-agent-row">
                  <span>Повторяющаяся «{r.title}» — {h(r.weeklyMin)} в неделю</span>
                  {r.canEdit && r.nextEventId && (
                    <button type="button" className="ui-btn ui-btn-outline ui-btn-sm" onClick={() => void request('POST', '/calendar/plus/analytics/shorten', { eventId: r.nextEventId, minutes: 30 })
                      .then(() => { toastSaved('Серия сокращена', 'следующие встречи — по 30 мин'); load(); onChanged(); }).catch(() => undefined)}>Сократить до 30 мин?</button>
                  )}
                </div>
              ))}
              <div className="cal-agent-row"><span>{me.bare.count
                ? `${me.bare.count} ${plural(me.bare.count, 'встреча прошла', 'встречи прошли', 'встреч прошло')} без повестки и итогов`
                : 'Все встречи — с повесткой или итогами'}</span><span className="dim">{me.bare.days.join(', ')}</span></div>
              <div className="cal-agent-row"><span>Лучшее время для фокуса</span><b>{me.bestFocus ?? '—'}</b></div>
            </>
          )}
        </section>
        {boss && (
          <section className="cal-agent-card">
            <div className="cal-first-kicker">Команда · для руководителя</div>
            {(team ?? []).map((r) => (
              <div key={r.userId} className="cal-team-row">
                <span className="cal-bar-name">{r.name}</span>
                <span className="cal-bar">
                  <span className="cal-bar-seg meeting" style={{ left: 0, width: `${(r.meetingMin / max) * 100}%` }} />
                  <span className="cal-bar-seg focus" style={{ left: `${(r.meetingMin / max) * 100}%`, width: `${(r.focusMin / max) * 100}%` }} />
                </span>
                <span className="dim cal-small">{h(r.meetingMin)} встреч · {h(r.focusMin)} фокуса</span>
              </div>
            ))}
            <div className="dim cal-small">Только часы по категориям, без содержания чужих встреч. Нагрузка по задачам — в «Пульсе команды».</div>
          </section>
        )}
      </div>
    </Dialog>
  );
}
