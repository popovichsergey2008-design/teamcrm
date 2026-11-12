import { useEffect, useState } from 'react';
import { Icon } from '../../components/Icon';
import { ApiError } from '../../lib/api';
import { toastSaved } from '../../lib/notifications';
import { navigate } from '../../lib/router';
import { calApi, hhmm, PrepCard } from './cal-api';

/**
 * Карточка встречи = подготовка (#4892, п. 6): «Войти в звонок», участники, повестка
 * от ИИ (из обсуждения в чате, открытых и просроченных задач — её можно править),
 * с прошлой встречи — что договорились и что не сделано, материалы. Повестка уходит
 * участникам только по «Отправить повестку». За N минут до начала — подготовка в QEVO
 * и в Telegram; N настраивается здесь же.
 */
export function MeetingPrep({ eventId, onJoin }: { eventId: string; onJoin: (c: PrepCard) => void }) {
  const [c, setC] = useState<PrepCard | null>(null);
  const [edit, setEdit] = useState<string | null>(null);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const load = () => calApi.prep(eventId).then(setC).catch((e) => setErr(e instanceof ApiError ? e.message : ''));
  useEffect(() => { void load(); }, [eventId]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!c) return err ? <div className="dim cal-small">{err}</div> : null;

  const soon = Date.parse(c.startsAt) - Date.now();
  const past = Date.parse(c.endsAt) < Date.now();
  const run = async (what: string, fn: () => Promise<unknown>) => {
    setBusy(what); setErr('');
    try { await fn(); await load(); } catch (e) { setErr(e instanceof ApiError ? e.message : 'Не получилось'); } finally { setBusy(''); }
  };

  return (
    <section className="cal-prep" aria-label="Подготовка к встрече">
      <div className="cal-prep-head">
        <div>
          {!past && soon > 0 && soon < 3 * 3600_000 && <div className="cal-first-kicker">через {Math.max(1, Math.round(soon / 60000))} мин</div>}
          <div className="cal-prep-title">{c.title} · {hhmm(c.startsAt)}–{hhmm(c.endsAt)}</div>
          <div className="dim cal-small">{c.people.join(' · ')}</div>
        </div>
        {(c.publicId || c.meetRoomId) && !past && (
          <button type="button" className="ui-btn ui-btn-primary ui-btn-sm" onClick={() => onJoin(c)}><Icon name="video" size={14} /> Войти в звонок</button>
        )}
      </div>

      <div className="cal-prep-block">
        <div className="cal-prep-row">
          <div>
            <b>Повестка от ИИ</b>
            <div className="dim cal-small">{c.agenda ? (c.agenda.auto ? c.agenda.source : 'поправлена вручную') : 'ещё не собрана'}{c.agenda?.sentAt ? ' · отправлена участникам' : ''}</div>
          </div>
          {c.canEdit && edit === null && (
            <span className="cal-prep-links">
              {c.agenda && <button type="button" className="cal-link" onClick={() => setEdit(c.agenda!.body)}>изменить</button>}
              <button type="button" className="cal-link" disabled={!!busy} onClick={() => void run('gen', () => calApi.genAgenda(eventId, true))}>{busy === 'gen' ? 'собираю…' : c.agenda ? 'собрать заново' : 'собрать'}</button>
            </span>
          )}
        </div>
        {edit !== null ? (
          <>
            <textarea className="ui-input cal-prep-edit" rows={5} value={edit} onChange={(e) => setEdit(e.target.value)} aria-label="Повестка" />
            <div className="cal-dialog-actions">
              <button type="button" className="ui-btn ui-btn-primary ui-btn-sm" disabled={!!busy || !edit.trim()} onClick={() => void run('save', async () => { await calApi.saveAgenda(eventId, edit); setEdit(null); toastSaved('Повестка сохранена', c.title); })}>Сохранить</button>
              <button type="button" className="ui-btn ui-btn-ghost ui-btn-sm" onClick={() => setEdit(null)}>Отмена</button>
            </div>
          </>
        ) : c.agenda ? (
          <div className="cal-prep-agenda">{c.agenda.body.split('\n').filter(Boolean).map((l, i) => <div key={i}>{l}</div>)}</div>
        ) : null}
        {c.canEdit && c.agenda && edit === null && !past && (
          <button type="button" className="ui-btn ui-btn-outline ui-btn-sm" disabled={!!busy}
            onClick={() => void run('send', async () => { const r = await calApi.sendAgenda(eventId); toastSaved('Повестка отправлена', `участникам: ${r.sent}`); })}>
            <Icon name="send" size={13} /> {c.agenda.sentAt ? 'Отправить ещё раз' : 'Отправить повестку'}
          </button>
        )}
      </div>

      {c.previous && (
        <div className="cal-prep-block">
          <b>С прошлой встречи ({new Date(c.previous.date).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' })})</b>
          {c.previous.items.length ? c.previous.items.map((it, i) => (
            <div key={i} className="dim cal-small">
              договорились: {it.assignee ? `${it.assignee.split(' ')[0]} — ` : ''}{it.title}
              {it.deadlineAt ? ` до ${new Date(it.deadlineAt).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' })}` : ''}
              {' · '}{it.done ? <span className="ok">сделано</span> : <span className="cal-overdue">не сделано</span>}
            </div>
          )) : <div className="dim cal-small">договорённостей в протоколе нет</div>}
        </div>
      )}

      {c.materials.length > 0 && (
        <div className="cal-prep-block">
          <b>Материалы</b>
          <div className="cal-small">
            {c.materials.map((m, i) => (
              <span key={i}>
                {i > 0 && ' · '}
                {m.kind === 'doc' && m.url ? <a href={m.url} target="_blank" rel="noreferrer">{m.title} (док)</a>
                  : m.kind === 'protocol' ? <button type="button" className="cal-link" onClick={() => navigate({ section: 'chat', view: 'meetings', meetingId: m.meetingId! })}>{m.title}</button>
                    : <button type="button" className="cal-link" title={m.hint} onClick={() => navigate({ section: 'projects', projectId: m.projectId!, taskId: m.taskId! })}>{m.title}</button>}
              </span>
            ))}
          </div>
        </div>
      )}

      <div className="dim cal-small cal-prep-foot">
        Подготовка с кнопкой «Войти» приходит в QEVO и в Telegram за{' '}
        <select className="cal-prep-min" value={c.prepMin} aria-label="За сколько минут присылать подготовку"
          onChange={(e) => void run('min', async () => { await calApi.savePrefs({ prepMin: Number(e.target.value) }); })}>
          {[5, 10, 15, 30, 60].map((m) => <option key={m} value={m}>{m}</option>)}
        </select>{' '}минут до начала.
      </div>
      {err && <div className="tv2-callout tv2-callout-danger" role="alert"><Icon name="alert" size={14} /> {err}</div>}
    </section>
  );
}
