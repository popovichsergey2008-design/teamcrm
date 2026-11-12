import { useEffect, useState } from 'react';
import { Icon } from '../../components/Icon';
import { Button } from '../../components/ui/button';
import { Dialog } from '../../components/ui/dialog';
import { Input } from '../../components/ui/input';
import { api, ApiError, type TimePoll } from '../../lib/api';
import { toastSaved } from '../../lib/notifications';
import type { User } from '../../types';
import { dayLabel } from './TaskTimeDialog';
import './calendar.css';
import { calApi, type BestTimeResult } from './cal-api';
import { DateInput } from '../../components/DateInput';

const hhmm = (iso: string) => new Date(iso).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
type Role = 'req' | 'opt';

/** Участники: обязательный / необязательный / не зовём — одним касанием по кругу. */
function People({ people, roles, onChange, meId }: { people: User[]; roles: Record<string, Role>; onChange: (r: Record<string, Role>) => void; meId?: string }) {
  return (
    <div className="cal-chips" aria-label="Участники">
      {people.filter((u) => u.role !== 'client' && String(u.id) !== String(meId)).map((u) => {
        const r = roles[u.id];
        const next = () => { const n = { ...roles }; if (!r) n[u.id] = 'req'; else if (r === 'req') n[u.id] = 'opt'; else delete n[u.id]; onChange(n); };
        return (
          <button key={u.id} className={`cal-pill${r ? ' on' : ''}${r === 'opt' ? ' cal-pill-opt' : ''}`} aria-pressed={!!r} onClick={next}
            title={r === 'req' ? 'Обязательный — нажмите, чтобы сделать необязательным' : r === 'opt' ? 'Необязательный — нажмите, чтобы убрать' : 'Позвать'}>
            {u.fullName}{r === 'opt' ? ' (необяз.)' : ''}
          </button>
        );
      })}
    </div>
  );
}

/**
 * «Найти время» (#4892, п. 4; было — #4787, п. 15): три слота по качеству, лучший
 * помечен, у каждого причина («все свободны · не в фокусе · у всех перерыв до и после»).
 * Только в рабочих часах всех участников с учётом поясов (пояс — у имени), обед и
 * защищённый фокус не предлагаются. Полоса занятости каждого на день лучшего слота
 * показывает, почему другие варианты хуже; чужие встречи — только «занят».
 */
export function CommonTimeDialog({ meId, onClose, onPick, onPoll, initialIds, initialMinutes, exceptEventId, title }: {
  meId?: string;
  onClose: () => void;
  onPick: (v: { startsAt: string; endsAt: string; participantIds: string[] }) => void;
  onPoll: () => void;
  initialIds?: string[];
  initialMinutes?: number;
  exceptEventId?: string;
  title?: string;
}) {
  const [people, setPeople] = useState<User[]>([]);
  const [roles, setRoles] = useState<Record<string, Role>>(() => Object.fromEntries((initialIds ?? []).filter((x) => String(x) !== String(meId)).map((id) => [String(id), 'req' as Role])));
  const [minutes, setMinutes] = useState(initialMinutes && initialMinutes >= 5 ? initialMinutes : 30);
  const [res, setRes] = useState<BestTimeResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => { api.listUsers().then(setPeople).catch(() => undefined); }, []);

  const find = async () => {
    setBusy(true); setErr('');
    try {
      const req = Object.entries(roles).filter(([, r]) => r === 'req').map(([id]) => id);
      const opt = Object.entries(roles).filter(([, r]) => r === 'opt').map(([id]) => id);
      setRes(await calApi.bestTime({ participantIds: req, optionalIds: opt, minutes, exceptEventId }));
    } catch (e) { setErr(e instanceof ApiError ? e.message : 'Не удалось подобрать время'); }
    finally { setBusy(false); }
  };
  // сразу ищем, если участники уже известны (из формы встречи)
  useEffect(() => { void find(); }, [roles, minutes]); // eslint-disable-line react-hooks/exhaustive-deps

  const names = res?.people.filter((p) => !p.me).map((p) => p.name.split(' ')[0]) ?? [];
  const dayStart = res ? Date.parse(res.day.startsAt) : 0;
  const daySpan = res ? Math.max(1, Date.parse(res.day.endsAt) - dayStart) : 1;
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }} size="lg"
      title={title ?? `Найти время${names.length ? ` · ${[...names, 'вы'].join(', ')}` : ''} · ${minutes} мин`}
      description="В рабочих часах всех участников, с учётом часовых поясов. Обед и фокус не предлагаются. О чужих встречах видно только «занят».">
      <div className="cal-tt">
        <div className="cal-tt-label">Участники <span className="dim">(нажмите ещё раз — необязательный)</span></div>
        <People people={people} roles={roles} onChange={setRoles} meId={meId} />
        <div className="cal-tt-label">Длительность</div>
        <div className="cal-chips">
          {[15, 30, 45, 60, 90].map((m) => <button key={m} className={`cal-pill${minutes === m ? ' on' : ''}`} onClick={() => setMinutes(m)}>{m} мин</button>)}
        </div>
        {busy && !res && <div className="dim cal-small">Подбираю…</div>}
        {res && res.slots.length > 0 && (
          <div className="cal-best-slots">
            {res.slots.map((s) => (
              <div key={s.startsAt} className={`cal-best-slot${s.best ? ' best' : ''}`}>
                {s.best && <span className="cal-pill ok">лучшее</span>}
                <div className="cal-best-when">{s.label.replace(/^./, (x) => x.toUpperCase())}</div>
                <div className="dim cal-small">{s.reasons.join(' · ')}</div>
                <button type="button" className={`ui-btn ui-btn-sm ${s.best ? 'ui-btn-primary' : 'ui-btn-outline'}`}
                  onClick={() => onPick({ startsAt: s.startsAt, endsAt: s.endsAt, participantIds: Object.keys(roles) })}>Выбрать</button>
              </div>
            ))}
          </div>
        )}
        {res && res.slots.length > 0 && (
          <div className="cal-bars">
            <div className="dim cal-small">Занятость {res.day.label}, {hhmm(res.day.startsAt)}–{hhmm(res.day.endsAt)}</div>
            {res.people.map((p) => (
              <div key={p.id} className="cal-bar-row">
                <span className="cal-bar-name">{p.name}{p.zone ? ` (${p.zone})` : ''}{p.optional ? ' · необяз.' : ''}</span>
                <span className="cal-bar">
                  {p.bar.map((b, i) => (
                    <span key={i} className={`cal-bar-seg ${b.kind}`} title={b.kind === 'meeting' ? 'занят' : b.kind === 'focus' ? 'фокус' : b.kind === 'lunch' ? 'обед' : 'вне рабочих часов'}
                      style={{ left: `${Math.max(0, (Date.parse(b.startsAt) - dayStart) / daySpan) * 100}%`, width: `${Math.max(0.5, (Date.parse(b.endsAt) - Date.parse(b.startsAt)) / daySpan * 100)}%` }} />
                  ))}
                </span>
              </div>
            ))}
            <div className="dim cal-small">синий — встречи · зелёный — фокус · коричневый — обед · пусто — свободно. Обед и фокус не предлагаются.</div>
          </div>
        )}
        {res && !res.slots.length && <div className="tv2-callout" role="status"><Icon name="info" size={15} /> {res.message ?? 'Общего окна нет — сократите встречу или сделайте часть участников необязательными.'}</div>}
        <div className="cal-tt-actions">
          <Button variant="outline" onClick={onPoll}><Icon name="list" size={15} /> Внешние участники → опрос времени</Button>
        </div>
        {err && <div className="tv2-callout tv2-callout-danger" role="alert"><Icon name="alert" size={15} /> {err}</div>}
      </div>
    </Dialog>
  );
}

/**
 * «Опрос времени» (#4787, п. 15): для встреч с внешними людьми — несколько вариантов,
 * гости по ссылке отмечают «Подходит · Возможно · Не подходит», организатор выбирает итог.
 */
export function PollDialog({ onClose, onDecided }: { onClose: () => void; onDecided: () => void }) {
  const [polls, setPolls] = useState<TimePoll[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState('');
  const [minutes, setMinutes] = useState(30);
  const [options, setOptions] = useState<string[]>(['', '', '']);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const load = () => api.timePolls().then((p) => { setPolls(p); if (!p.length) setCreating(true); }).catch(() => setPolls([]));
  useEffect(() => { void load(); }, []);

  const create = async () => {
    setBusy(true); setErr('');
    try {
      const p = await api.timePollCreate({ title, minutes, options: options.filter(Boolean).map((v) => new Date(v).toISOString()) });
      await navigator.clipboard.writeText(p.url).catch(() => undefined);
      toastSaved('Опрос создан — ссылка скопирована', p.url);
      setCreating(false); setTitle(''); setOptions(['', '', '']); void load();
    } catch (e) { setErr(e instanceof ApiError ? e.message : 'Не удалось создать опрос'); }
    finally { setBusy(false); }
  };

  const decide = async (p: TimePoll, optionId: string) => {
    setBusy(true); setErr('');
    try { await api.timePollDecide(p.id, optionId); toastSaved('Встреча назначена — участникам ушли приглашения'); onDecided(); }
    catch (e) { setErr(e instanceof ApiError ? e.message : 'Не удалось назначить'); }
    finally { setBusy(false); }
  };

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }} size="md" title="Опрос времени"
      description="Предложите несколько вариантов — гости отметят «Подходит · Возможно · Не подходит», а вы выберете итог.">
      <div className="cal-tt">
        {creating ? (
          <div className="cal-type-ed">
            <label className="cal-field">Встреча<Input value={title} maxLength={255} onChange={(e) => setTitle(e.target.value)} placeholder="Обсуждение проекта" /></label>
            <div className="cal-field">Длительность
              <div className="cal-chips">{[15, 30, 45, 60, 90].map((m) => <button key={m} className={`cal-pill${minutes === m ? ' on' : ''}`} onClick={() => setMinutes(m)}>{m} мин</button>)}</div>
            </div>
            <div className="cal-field">Варианты
              {options.map((v, i) => (
                <div key={i} className="cal-q-row">
                  <DateInput className="ui-input" type="datetime-local" value={v} onChange={(e) => setOptions((o) => o.map((x, j) => (j === i ? e.target.value : x)))} aria-label={`Вариант ${i + 1}`} />
                  {options.length > 2 && <Button size="icon-sm" variant="ghost" onClick={() => setOptions((o) => o.filter((_, j) => j !== i))} aria-label="Убрать вариант"><Icon name="close" size={14} /></Button>}
                </div>
              ))}
              {options.length < 12 && <Button size="sm" variant="ghost" onClick={() => setOptions((o) => [...o, ''])}><Icon name="plus" size={14} /> Вариант</Button>}
            </div>
            <div className="cal-tt-actions">
              <Button variant="primary" onClick={() => void create()} disabled={busy || !title.trim() || options.filter(Boolean).length < 2}>Создать и скопировать ссылку</Button>
              {polls && polls.length > 0 && <Button variant="ghost" onClick={() => setCreating(false)}>К опросам</Button>}
            </div>
          </div>
        ) : (
          <>
            <Button variant="outline" onClick={() => setCreating(true)}><Icon name="plus" size={15} /> Новый опрос</Button>
            <ul className="cal-share-list">
              {(polls ?? []).map((p) => (
                <li key={p.id} className="cal-share-item cal-poll">
                  <div className="cal-share-main">
                    <strong>{p.title}</strong>
                    <span className="dim">{p.minutes} мин · ответили: {p.votes.length}{p.status === 'decided' ? ' · время выбрано' : ''}</span>
                  </div>
                  {p.status === 'open' && <Button size="sm" variant="ghost" onClick={() => void navigator.clipboard.writeText(p.url).then(() => toastSaved('Ссылка скопирована'))}><Icon name="link" size={14} /> Ссылка</Button>}
                  <ul className="cal-poll-opts">
                    {p.options.map((o) => (
                      <li key={o.id}>
                        <span>{dayLabel(o.startsAt)}, {hhmm(o.startsAt)}</span>
                        <span className="dim">подходит {o.yes} · возможно {o.maybe} · нет {o.no}</span>
                        {p.status === 'open' && <Button size="sm" variant="outline" disabled={busy} onClick={() => void decide(p, o.id)}>Выбрать итог</Button>}
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          </>
        )}
        {err && <div className="tv2-callout tv2-callout-danger" role="alert"><Icon name="alert" size={15} /> {err}</div>}
      </div>
    </Dialog>
  );
}
