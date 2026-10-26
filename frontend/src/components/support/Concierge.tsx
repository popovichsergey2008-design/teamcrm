import { useCallback, useEffect, useState } from 'react';
import './concierge.css';
import { Icon } from '../Icon';
import { api, ApiError, SupportAccessGrant, SupportConcierge as Data } from '../../lib/api';
import { navigate } from '../../lib/router';
import { getSocket } from '../../lib/socket';
import { feedback } from '../../lib/feedback';
import { useAuth } from '../../state/auth';
import { careHeadline } from '../../lib/care-rules';
import type { SupportConversation, Project } from '../../types';

const DOT: Record<string, string> = { available: 'cg-ok', busy: 'cg-busy', in_huddle: 'cg-busy', away: 'cg-off', offline: 'cg-off' };
const initials = (n: string) => n.split(/\s+/).map((x) => x[0] ?? '').join('').slice(0, 2).toUpperCase();
const hm = (iso: string | null) => (iso ? new Date(iso).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }) : '');

/**
 * Шапка консьержа (ТЗ-29, п. 6–8, 31–33): живой инженер с именем и статусом, честное
 * ожидание; все заняты — «встать в очередь», «продолжить в чате», «позвать, когда
 * освободится». Никакого «онлайн», если никого нет.
 */
export function ConciergeHead({ onHelpNow, compact = false }: {
  onHelpNow: () => void; hasConversation: boolean;
  /** Разговор уже идёт: шапка в одну строку, без слогана — ленте нужно место. */
  compact?: boolean;
}) {
  const [d, setD] = useState<Data | null>(null);
  const [cb, setCb] = useState<{ waiting: boolean; since: string | null } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api.supportConcierge().then(setD).catch(() => setD(null));
    api.supportCallbackState().then(setCb).catch(() => setCb(null));
  }, []);
  useEffect(() => {
    load();
    const t = window.setInterval(load, 30_000);
    const socket = getSocket();
    const ready = () => { load(); feedback('support.engineerJoined'); };
    socket.on('support.callback.ready', ready);
    return () => { window.clearInterval(t); socket.off('support.callback.ready', ready); };
  }, [load]);

  if (!d) return null;
  const top = d.engineers[0];
  const callback = async (on: boolean) => {
    setBusy(true);
    try { setCb(on ? await api.supportCallback() : await api.supportCancelCallback().then(() => ({ waiting: false, since: null }))); } catch { /* не критично */ }
    finally { setBusy(false); }
  };

  /*
    Шапка Care Hub (ТЗ-34, п. 2.1): живые фото до пяти дежурных с именами, зелёный пульс,
    «на связи 24/7 • среднее время ответа сейчас» и слоган — дословно по документу.
  */
  const faces = d.engineers.slice(0, 5);
  const live = d.estimate.kind !== 'offline';
  return (
    <div className={`cg-head${compact ? ' cg-head-compact' : ''}`} aria-label="Кто на связи">
      {faces.length > 0 && (
        <div className="cg-faces">
          {faces.map((e) => (
            <span key={e.userId} className="cg-face" title={`${e.name} · ${e.statusText}`}>
              <span className="cg-ava">
                {e.avatarUrl ? <img src={e.avatarUrl} alt="" /> : initials(e.name)}
                <span className={`cg-dot ${DOT[e.status]}`} aria-hidden="true" />
              </span>
              {!compact && <span className="cg-face-name">{e.name.split(/\s+/)[0]}</span>}
            </span>
          ))}
        </div>
      )}
      <div className="cg-line">
        <span className={`cg-pulse${live ? ' live' : ''}`} aria-hidden="true" />
        <span>{careHeadline(d.estimate, d.medianSec)}</span>
      </div>
      {!compact && <p className="cg-slogan">Вы занимаетесь делами и командой — мы берем всю настройку и рутину на себя. Чем помочь прямо сейчас?</p>}
      {compact && top && (
        <div className="cg-engineer">
          <span className="cg-who">
            <span className="dim">
              <b>{top.name}</b> · {top.role}{top.verified && <> · <Icon name="check-circle" size={11} /> сотрудник QEVO</>} · {top.statusText}
            </span>
          </span>
        </div>
      )}
      {/* без разговора «Нужна помощь сейчас» заменили три кнопки над вводом (ТЗ-34, п. 2.2) */}
      {d.estimate.kind !== 'now' && (
        <div className="cg-busy-box">
          {d.estimate.kind === 'queue' && top && (
            <span className="dim">{top.name} сейчас {top.status === 'in_huddle' ? 'на созвоне' : 'занят'}. Можно встать в очередь или продолжить в чате.</span>
          )}
          <div className="cg-row">
            {d.estimate.kind === 'queue' && <button type="button" className="ui-btn ui-btn-outline ui-btn-sm" onClick={onHelpNow}>Встать в очередь</button>}
            {cb?.waiting ? (
              <>
                <span className="dim cg-wait"><Icon name="clock" size={12} /> Позовём, когда инженер освободится</span>
                <button type="button" className="ui-btn ui-btn-ghost ui-btn-sm" disabled={busy} onClick={() => void callback(false)}>Не нужно</button>
              </>
            ) : (
              <button type="button" className="ui-btn ui-btn-outline ui-btn-sm" disabled={busy} onClick={() => void callback(true)}>
                <Icon name="bell" size={13} /> Позвать меня, когда инженер освободится
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Карточки консьержа в разговоре (ТЗ-29): согласие на запись, итог помощи,
 * 10-секундный тест, доступ инженера на 15 минут. Решает всегда сам пользователь.
 */
export function ConciergeCards({ conv, mine, onChange }: { conv: SupportConversation; mine: boolean; onChange: (c: SupportConversation) => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [grants, setGrants] = useState<SupportAccessGrant[]>([]);
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [pick, setPick] = useState('');

  const loadGrants = useCallback(() => { api.supportAccess(conv.id).then(setGrants).catch(() => setGrants([])); }, [conv.id]);
  useEffect(() => {
    loadGrants();
    const socket = getSocket();
    const on = (p: { conversationId: string }) => { if (String(p.conversationId) === String(conv.id)) loadGrants(); };
    socket.on('support.access.requested', on);
    socket.on('support.access.changed', on);
    return () => { socket.off('support.access.requested', on); socket.off('support.access.changed', on); };
  }, [conv.id, loadGrants]);
  const pending = grants.filter((g) => g.status === 'requested');
  const live = grants.filter((g) => g.status === 'granted');
  useEffect(() => {
    if (mine && pending.length && projects === null) api.listProjects().then(setProjects).catch(() => setProjects([]));
  }, [mine, pending.length, projects]);

  const run = async (fn: () => Promise<SupportConversation | SupportAccessGrant[]>) => {
    setBusy(true); setErr('');
    try {
      const r = await fn();
      if (Array.isArray(r)) setGrants(r); else onChange(r);
    } catch (e) { setErr(e instanceof ApiError ? e.message : 'Не получилось'); }
    finally { setBusy(false); }
  };

  /** #4675: доступ на 15 минут — только с согласием с Политикой удалённой поддержки (на сессию — один раз). */
  const allowAccess = async (grantId: string) => {
    // окно согласия и текст политики — отдельным куском: нужны редко
    const { ensureRemoteConsent } = await import('./remote-consent');
    const ready = await ensureRemoteConsent(conv.id, 'access', {
      grantId,
      intro: 'Специалист поддержки просит посмотреть настройки выбранного проекта на 15 минут — колонки и участников, без задач, файлов и переписки.',
    });
    if (!ready) return;
    void run(() => api.supportDecideAccess(conv.id, grantId, true, pick));
  };

  const res = conv.resolution;
  const callLive = (conv.messages ?? []).some((m) => m.kind === 'system' && /Созвон начат/.test(m.body ?? '')) && !res;

  return (
    <>
      {/* Запись звонка поддержки — только с разрешения (п. 29) */}
      {mine && callLive && conv.recordingConsent == null && (
        <div className="support-ask">
          <b>Записать этот звонок, чтобы сохранить технический контекст?</b>
          <span className="dim">Без записи ничего не сохраняется. Решаете вы.</span>
          <div className="support-ask-row">
            <button className="ui-btn ui-btn-primary ui-btn-sm" disabled={busy} onClick={() => void run(() => api.supportRecording(conv.id, true))}>Разрешить</button>
            <button className="ui-btn ui-btn-outline ui-btn-sm" disabled={busy} onClick={() => void run(() => api.supportRecording(conv.id, false))}>Без записи</button>
          </div>
        </div>
      )}

      {/* Итог помощи (п. 25) */}
      {res && (
        <div className="support-ask cg-resolution">
          <b><Icon name="check-circle" size={14} /> Готово</b>
          {res.problem && <div><span className="dim">Вопрос: </span>{res.problem}</div>}
          {res.fixed && <div><span className="dim">Что сделали: </span>{res.fixed}</div>}
          {res.checked && <div><span className="dim">Что проверили: </span>{res.checked}</div>}
          {res.next && <div><span className="dim">Дальше: </span>{res.next}</div>}
          {mine && !res.feedback && (
            <div className="support-ask-row">
              <button className="ui-btn ui-btn-primary ui-btn-sm" disabled={busy} onClick={() => { feedback('support.solved'); void run(() => api.supportResolution(conv.id, true)); }}>Всё работает</button>
              <button className="ui-btn ui-btn-outline ui-btn-sm" disabled={busy} onClick={() => void run(() => api.supportResolution(conv.id, false))}>Проблема осталась</button>
            </div>
          )}
          {res.feedback && <span className="dim">{res.feedback === 'works' ? 'Вы подтвердили: всё работает' : 'Продолжаем разбираться'}</span>}
        </div>
      )}

      {/* 10-секундный тест (п. 23): демо ИИ-созвона из онбординга */}
      {mine && conv.testOfferedAt && !res && (
        <div className="support-ask">
          <b>Проверить ИИ-протокол за 10 секунд</b>
          <span className="dim">Скажите одну фразу с поручением — QEVO покажет, какую задачу услышал. В проект ничего не попадёт без вашего согласия.</span>
          <div className="support-ask-row">
            <button className="ui-btn ui-btn-primary ui-btn-sm" onClick={() => navigate('/onboarding/ai-call')}><Icon name="mic" size={13} /> Запустить тест</button>
          </div>
        </div>
      )}

      {/* Доступ инженера на 15 минут (п. 45): решает сам пользователь и только по своему проекту */}
      {mine && pending.map((g) => (
        <div key={g.id} className="support-ask">
          <b>{g.engineer ?? 'Инженер'} просит посмотреть настройки проекта на 15 минут</b>
          {g.reason && <span className="dim">{g.reason}</span>}
          <span className="dim">Только настройки — колонки, участники. Без задач, файлов и переписки. Доступ можно закрыть в любой момент.</span>
          <div className="support-ask-row">
            <select className="input cg-select" value={pick} onChange={(e) => setPick(e.target.value)} aria-label="Какой проект показать">
              <option value="">Какой проект?</option>
              {(projects ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
            <button className="ui-btn ui-btn-primary ui-btn-sm" disabled={busy || !pick} onClick={() => void allowAccess(g.id)}>Разрешить на 15 минут</button>
            <button className="ui-btn ui-btn-outline ui-btn-sm" disabled={busy} onClick={() => void run(() => api.supportDecideAccess(conv.id, g.id, false))}>Не разрешать</button>
          </div>
        </div>
      ))}
      {mine && live.map((g) => (
        <div key={g.id} className="support-ask cg-live">
          <span><Icon name="eye" size={13} /> {g.engineer ?? 'Инженер'} видит настройки проекта «{g.projectName}» до {hm(g.expiresAt)}</span>
          <button className="ui-btn ui-btn-ghost ui-btn-sm" disabled={busy} onClick={() => void run(() => api.supportRevokeAccess(conv.id, g.id))}>Закрыть доступ</button>
        </div>
      ))}
      {err && <div className="error-text">{err}</div>}
    </>
  );
}

/**
 * Инструменты специалиста (ТЗ-29): свой статус, неудачные запросы клиента, «пожелание»,
 * 10-секундный тест, доступ к настройкам проекта и его просмотр.
 */
export function ConciergeTools({ conv, failed, onChange }: {
  conv: SupportConversation;
  failed: { method: string; path: string; status: number; requestId: string | null; at: string }[];
  onChange: (c: SupportConversation) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [grants, setGrants] = useState<SupportAccessGrant[]>([]);
  const [snap, setSnap] = useState<Awaited<ReturnType<typeof api.supportAccessView>> | null>(null);
  const [status, setStatus] = useState<string>('available');
  const { user } = useAuth();

  const loadGrants = useCallback(() => { api.supportAccess(conv.id).then(setGrants).catch(() => setGrants([])); }, [conv.id]);
  useEffect(() => {
    loadGrants();
    // свой статус: «на созвоне» и полная загрузка показываются как «занят»
    api.supportConcierge().then((d) => {
      const mine = d.engineers.find((e) => String(e.userId) === String(user?.id ?? ''));
      setStatus(mine?.status === 'away' ? 'away' : mine?.status === 'busy' || mine?.status === 'in_huddle' ? 'busy' : 'available');
    }).catch(() => undefined);
    const socket = getSocket();
    const on = (p: { conversationId: string }) => { if (String(p.conversationId) === String(conv.id)) loadGrants(); };
    socket.on('support.access.changed', on);
    return () => { socket.off('support.access.changed', on); };
  }, [conv.id, loadGrants, user?.id]);

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true); setErr('');
    try {
      const r = await fn();
      if (Array.isArray(r)) setGrants(r as SupportAccessGrant[]);
      else if (r && typeof r === 'object' && 'conversation' in (r as object)) onChange((r as { conversation: SupportConversation }).conversation);
      else if (r && typeof r === 'object' && 'messages' in (r as object)) onChange(r as SupportConversation);
    } catch (e) { setErr(e instanceof ApiError ? e.message : 'Не получилось'); }
    finally { setBusy(false); }
  };
  const live = grants.find((g) => g.status === 'granted');
  const asked = grants.find((g) => g.status === 'requested');

  return (
    <div className="cg-tools">
      <div className="support-tools-acts">
        <label className="cg-status">
          <span className="dim">Мой статус</span>
          <select className="input" value={status} onChange={(e) => { const v = e.target.value as 'available' | 'busy' | 'away'; setStatus(v); void act(() => api.supportSetMyStatus(v)); }}>
            <option value="available">На связи</option>
            <option value="busy">Занят</option>
            <option value="away">Отошёл</option>
          </select>
        </label>
      </div>
      {failed.length > 0 && (
        <div className="cg-failed">
          <b>Неудачные запросы</b>
          {failed.map((f, i) => (
            <div key={i} className="cg-mono">{f.method} {f.path} → {f.status}{f.requestId ? ` · ${f.requestId}` : ''}</div>
          ))}
        </div>
      )}
      <div className="support-tools-acts">
        <button className="ui-btn ui-btn-outline ui-btn-sm" disabled={busy} onClick={() => void act(() => api.supportCreateBug(conv.id, undefined, 'feedback'))}>
          <Icon name="bulb" size={13} /> Пожелание к продукту
        </button>
        <button className="ui-btn ui-btn-outline ui-btn-sm" disabled={busy || !!conv.testOfferedAt} onClick={() => void act(() => api.supportOfferTest(conv.id))}>
          <Icon name="mic" size={13} /> {conv.testOfferedAt ? 'Тест предложен' : '10-секундный тест'}
        </button>
        {live ? (
          <button className="ui-btn ui-btn-primary ui-btn-sm" disabled={busy} onClick={() => void api.supportAccessView(conv.id, live.id).then(setSnap).catch((e) => setErr(e instanceof ApiError ? e.message : 'Нет доступа'))}>
            <Icon name="eye" size={13} /> Настройки «{live.projectName}» до {hm(live.expiresAt)}
          </button>
        ) : (
          <button className="ui-btn ui-btn-outline ui-btn-sm" disabled={busy || !!asked} onClick={() => void act(() => api.supportRequestAccess(conv.id))}>
            <Icon name="lock" size={13} /> {asked ? 'Ждём разрешения…' : 'Попросить доступ к настройкам'}
          </button>
        )}
      </div>
      {snap?.project && (
        <div className="cg-snap" aria-label="Настройки проекта">
          <div className="cg-row"><b>{snap.project.name}</b><span className="dim">только чтение · до {hm(snap.expiresAt)}</span>
            <button className="ui-btn ui-btn-ghost ui-btn-sm" onClick={() => setSnap(null)}>Скрыть</button></div>
          <div className="dim">Видимость: {snap.project.visibility === 'all' ? 'всем в компании' : 'участникам'}{snap.project.owner_name ? ` · руководитель: ${snap.project.owner_name}` : ''}{snap.project.client_name ? ` · клиент: ${snap.project.client_name}` : ''}</div>
          <div><span className="dim">Колонки: </span>{snap.columns.map((c) => `${c.name} (${c.tasks})`).join(' → ') || '—'}</div>
          <div><span className="dim">Участники: </span>{snap.members.map((m) => m.full_name).join(', ') || '—'}</div>
        </div>
      )}
      {err && <div className="error-text">{err}</div>}
    </div>
  );
}

/**
 * Консоль → «Техотдел» (ТЗ-29, п. 7, 10, 49): свой статус, смены дежурств и метрики
 * консьержа. Вне смены инженер «не в сети» для клиентов, даже если открыт.
 */
export function ConciergeConsole({ staff, canManage }: { staff: { userId: string; name: string }[]; canManage: boolean }) {
  const [d, setD] = useState<Data | null>(null);
  const [shifts, setShifts] = useState<Awaited<ReturnType<typeof api.supportShifts>>>([]);
  const [m, setM] = useState<Awaited<ReturnType<typeof api.supportConciergeMetrics>> | null>(null);
  const [form, setForm] = useState({ userId: '', date: new Date().toISOString().slice(0, 10), from: '09:00', to: '18:00' });
  const [err, setErr] = useState('');
  const { user } = useAuth();

  const load = useCallback(() => {
    api.supportConcierge().then(setD).catch(() => setD(null));
    api.supportShifts().then(setShifts).catch(() => setShifts([]));
    api.supportConciergeMetrics().then(setM).catch(() => setM(null));
  }, []);
  useEffect(() => {
    load();
    const socket = getSocket();
    socket.on('support.availability.changed', load);
    return () => { socket.off('support.availability.changed', load); };
  }, [load]);

  const mine = d?.engineers.find((e) => String(e.userId) === String(user?.id ?? ''));
  const run = async (fn: () => Promise<unknown>) => {
    setErr('');
    try { await fn(); load(); } catch (e) { setErr(e instanceof ApiError ? e.message : 'Не получилось'); }
  };

  return (
    <div className="support-block cg-console">
      <div className="drawer-section-title">Консьерж: кто на связи</div>
      <div className="cg-row">
        <span className="dim">Мой статус:</span>
        {(['available', 'busy', 'away'] as const).map((s) => (
          <button key={s} type="button" className={`ui-btn ui-btn-sm ${mine?.status === s || (s === 'busy' && mine?.status === 'in_huddle') ? 'ui-btn-primary' : 'ui-btn-outline'}`}
            onClick={() => void run(() => api.supportSetMyStatus(s))}>
            {s === 'available' ? 'На связи' : s === 'busy' ? 'Занят' : 'Отошёл'}
          </button>
        ))}
        {d && <span className="dim">· клиенты видят: {d.estimate.text}</span>}
      </div>
      {d && (
        <div className="cg-row">
          {d.engineers.map((e) => (
            <span key={e.userId} className="ui-badge ui-badge-neutral"><span className={`cg-dot-inline ${DOT[e.status]}`} aria-hidden="true" /> {e.name} · {e.statusText}</span>
          ))}
        </div>
      )}

      <div className="drawer-section-title" style={{ marginTop: 12 }}>Смены дежурств</div>
      <p className="dim">Если у инженера есть смены, вне смены клиенты видят его «не в сети» и обращения ему не идут.</p>
      {shifts.length === 0 && <p className="dim">Смен нет — дежурят все отмеченные выше, пока на связи.</p>}
      {shifts.map((s) => (
        <div key={s.id} className="cg-row">
          <span>{s.name}</span>
          <span className="dim">{new Date(s.startsAt).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })} — {hm(s.endsAt)}</span>
          {canManage && <button type="button" className="ui-btn ui-btn-ghost ui-btn-sm" onClick={() => void run(() => api.supportCancelShift(s.id))}>Отменить</button>}
        </div>
      ))}
      {canManage && (
        <div className="cg-row">
          <select className="input cg-select" value={form.userId} onChange={(e) => setForm({ ...form, userId: e.target.value })} aria-label="Кто дежурит">
            <option value="">Кто?</option>
            {staff.map((s) => <option key={s.userId} value={s.userId}>{s.name}</option>)}
          </select>
          <input className="input" type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} aria-label="День" />
          <input className="input" type="time" value={form.from} onChange={(e) => setForm({ ...form, from: e.target.value })} aria-label="С" />
          <input className="input" type="time" value={form.to} onChange={(e) => setForm({ ...form, to: e.target.value })} aria-label="До" />
          <button type="button" className="ui-btn ui-btn-outline ui-btn-sm" disabled={!form.userId}
            onClick={() => void run(() => api.supportAddShift(form.userId, new Date(`${form.date}T${form.from}:00`).toISOString(), new Date(`${form.date}T${form.to}:00`).toISOString()))}>
            Добавить смену
          </button>
        </div>
      )}
      {m && (
        <>
          <div className="drawer-section-title" style={{ marginTop: 12 }}>За две недели</div>
          <div className="cg-row dim">
            <span>Предложено созвонов: <b>{m.huddleOffered}</b></span>
            <span>Приняли: <b>{m.huddleAcceptRate ?? '—'}{m.huddleAcceptRate != null ? '%' : ''}</b></span>
            <span>Решено: <b>{m.resolved}</b></span>
            <span>С первого контакта: <b>{m.firstContactResolution ?? '—'}{m.firstContactResolution != null ? '%' : ''}</b></span>
          </div>
        </>
      )}
      {err && <div className="error-text">{err}</div>}
    </div>
  );
}
