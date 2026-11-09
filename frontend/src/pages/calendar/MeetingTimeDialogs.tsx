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
 * «Найти общее время» (#4787, п. 15): свободны все обязательные — лучше и необязательные.
 * Про чужие встречи — только «занят». Выбранный вариант открывает форму встречи, и перед
 * сохранением занятость проверяется ещё раз.
 */
export function CommonTimeDialog({ meId, onClose, onPick, onPoll }: {
  meId?: string;
  onClose: () => void;
  onPick: (v: { startsAt: string; endsAt: string; participantIds: string[] }) => void;
  onPoll: () => void;
}) {
  const [people, setPeople] = useState<User[]>([]);
  const [roles, setRoles] = useState<Record<string, Role>>({});
  const [minutes, setMinutes] = useState(30);
  const [opts, setOpts] = useState<{ startsAt: string; endsAt: string; busyOptional: string[]; note: string }[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => { api.listUsers().then(setPeople).catch(() => undefined); }, []);
  useEffect(() => { setOpts(null); }, [roles, minutes]);

  const find = async () => {
    setBusy(true); setErr('');
    try {
      const req = Object.entries(roles).filter(([, r]) => r === 'req').map(([id]) => id);
      const opt = Object.entries(roles).filter(([, r]) => r === 'opt').map(([id]) => id);
      setOpts((await api.calendarCommonTime({ participantIds: req, optionalIds: opt, minutes })).options);
    } catch (e) { setErr(e instanceof ApiError ? e.message : 'Не удалось подобрать время'); }
    finally { setBusy(false); }
  };

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }} size="md" title="Найти общее время"
      description="Выберите участников и длительность — QEVO покажет, когда свободны все. О чужих встречах видно только «занят».">
      <div className="cal-tt">
        <div className="cal-tt-label">Участники <span className="dim">(нажмите ещё раз — необязательный)</span></div>
        <People people={people} roles={roles} onChange={setRoles} meId={meId} />
        <div className="cal-tt-label">Длительность</div>
        <div className="cal-chips">
          {[15, 30, 45, 60, 90].map((m) => <button key={m} className={`cal-pill${minutes === m ? ' on' : ''}`} onClick={() => setMinutes(m)}>{m} мин</button>)}
        </div>
        <div className="cal-tt-actions">
          <Button variant="primary" onClick={() => void find()} disabled={busy || !Object.keys(roles).length}><Icon name="search" size={15} /> Найти время</Button>
          <Button variant="ghost" onClick={onPoll}><Icon name="list" size={15} /> Есть внешние участники — опрос времени</Button>
        </div>
        {opts && opts.length > 0 && (
          <ul className="cal-tt-options">
            {opts.map((o) => (
              <li key={o.startsAt}>
                <button className="cal-tt-option" onClick={() => onPick({ startsAt: o.startsAt, endsAt: o.endsAt, participantIds: Object.keys(roles) })}>
                  <strong>{dayLabel(o.startsAt)}, {hhmm(o.startsAt)}</strong>
                  <span className="dim">{o.note}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {opts && !opts.length && <div className="tv2-callout" role="status"><Icon name="info" size={15} /> В ближайшие дни общего окна нет — сократите встречу или сделайте часть участников необязательными.</div>}
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
