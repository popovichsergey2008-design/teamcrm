import { useCallback, useEffect, useState } from 'react';
import { Icon } from '../Icon';
import { ApiError, request } from '../../lib/api';
import { apiUrl } from '../../lib/origin';
import { getSocket } from '../../lib/socket';
import { navigate } from '../../lib/router';
import './meeting-chat-card.css';

interface CardTask {
  draftId: string; title: string; deadlineAt: string | null; status: string; taskId: string | null;
  confirm: 'taken' | 'declined' | null; error?: string | null;
}
interface CardData {
  kind: 'recap' | 'confirm' | 'error';
  meeting: { id: string; title: string; status: string; error: string | null; durationMin: number | null; autoRetry: 'scheduled' | null };
  hidden: boolean;
  summary?: string | null;
  decisions?: string[];
  risks?: string[];
  people?: { userId: string | null; name: string; tasks: CardTask[] }[];
  counts?: { confirmed: number; total: number };
  mine: CardTask[];
  recording?: { url: string } | null;
}

const BUSY = ['queued', 'transcribing', 'analyzing'];
const day = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' }) : '');

/**
 * Итоги созвона в чате (#4902, п. 10–11). Одно сообщение чата с meeting_id — три вида:
 *  • итог в чате, откуда звонили: название от ИИ, решения, риски, задачи по людям и кнопки;
 *  • личный список задач в «Заметках»: «✓ беру», «срок», «не моё», «Подтвердить всё»;
 *  • сбой обработки с «Повторить» (один автоповтор уже был).
 * Данные живые (/meeting-cards/:id): нажал «беру» один — счётчик обновился у всех.
 */
export default function MeetingChatCard({ messageId, meetingId, body, stamp, stampTitle }: {
  messageId: string; meetingId: string; body: string; stamp: string; stampTitle: string;
}) {
  const [d, setD] = useState<CardData | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [dateFor, setDateFor] = useState<string | null>(null);
  const [date, setDate] = useState('');
  const [listen, setListen] = useState(false);
  const [retell, setRetell] = useState<{ text: string; audio: { url: string } | null } | null>(null);

  const load = useCallback(() => request<CardData>('GET', `/meeting-cards/${messageId}`)
    .then((x) => { setD(x); setFailed(false); }).catch(() => setFailed(true)), [messageId]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const s = getSocket();
    const on = (e: { meetingId?: string }) => { if (String(e?.meetingId) === String(meetingId)) void load(); };
    s.on('meeting.card', on);
    return () => { s.off('meeting.card', on); };
  }, [meetingId, load]);

  const act = async (key: string, fn: () => Promise<{ note?: string | null; notes?: string[] } | unknown>) => {
    setBusy(key); setNote('');
    try {
      const r = (await fn()) as { note?: string | null; notes?: string[] } | null;
      const msg = r?.note ?? (r?.notes?.length ? r.notes.join(' ') : '');
      if (msg) setNote(msg);
      await load();
    } catch (e) { setNote(e instanceof ApiError ? e.message : 'Не получилось — попробуйте ещё раз'); }
    finally { setBusy(null); }
  };

  const take = (t: CardTask, deadline?: string) => act(`take-${t.draftId}`, () => request('POST', `/meeting-cards/drafts/${t.draftId}/take`,
    deadline ? { deadlineAt: new Date(`${deadline}T18:00:00`).toISOString() } : {})).then(() => setDateFor(null));
  const decline = (t: CardTask) => act(`decline-${t.draftId}`, () => request('POST', `/meeting-cards/drafts/${t.draftId}/decline`));
  const protocol = () => navigate({ section: 'chat', view: 'postcall', meetingId: String(meetingId) });
  const askRetell = async () => {
    if (retell) { setRetell(null); return; }
    setBusy('retell'); setNote('');
    try { setRetell(await request('POST', `/meeting-cards/${messageId}/retell`)); }
    catch (e) { setNote(e instanceof ApiError ? e.message : 'Пересказ не получился'); }
    finally { setBusy(null); }
  };

  // пока карточка грузится или недоступна — прежний вид: текст сообщения и «Открыть разбор»
  if (!d) {
    const [head, ...rest] = body.split('\n');
    return (
      <div className="meet-card">
        <div className="meet-card-head"><Icon name="record" size={14} /> <b>{head}</b><span className="chat-time" title={stampTitle}>{stamp}</span></div>
        {rest.filter(Boolean).map((line, k) => <div key={k} className="meet-card-line">{line}</div>)}
        {failed && (
          <button type="button" className="ui-btn ui-btn-ghost ui-btn-sm" onClick={protocol}>
            <Icon name="list" size={13} /> Открыть разбор
          </button>
        )}
      </div>
    );
  }

  const m = d.meeting;
  const head = (icon: 'record' | 'check-circle' | 'alert', title: string) => (
    <div className="mcc-head">
      <Icon name={icon} size={15} /> <b>{title}</b>
      {m.durationMin ? <span className="mcc-dim">· {m.durationMin} мин</span> : null}
      <span className="chat-time" title={stampTitle}>{stamp}</span>
    </div>
  );
  const taskRow = (t: CardTask, own: boolean) => {
    const done = t.confirm === 'taken';
    return (
      <li key={t.draftId} className={`mcc-task${t.confirm ? ` is-${t.confirm}` : ''}`}>
        <span className="mcc-task-title">{t.title}{t.deadlineAt && <span className="mcc-dim"> · до {day(t.deadlineAt)}</span>}</span>
        {!own && (
          <span className="mcc-state">{done ? '✓ взял(а)' : t.confirm === 'declined' ? 'не моё' : 'ждёт ответа'}</span>
        )}
        {own && t.confirm && (
          <span className="mcc-state">{done ? '✓ беру' : 'не моё — хозяин встречи переназначит'}</span>
        )}
        {own && !t.confirm && (
          <span className="mcc-actions">
            <button type="button" className="ui-btn ui-btn-outline ui-btn-sm" disabled={!!busy} onClick={() => void take(t)}>✓ беру</button>
            <button type="button" className="ui-btn ui-btn-ghost ui-btn-sm" disabled={!!busy}
              onClick={() => { setDateFor(dateFor === t.draftId ? null : t.draftId); setDate(t.deadlineAt ? t.deadlineAt.slice(0, 10) : ''); }}>
              <Icon name="calendar" size={13} /> срок
            </button>
            <button type="button" className="ui-btn ui-btn-ghost ui-btn-sm" disabled={!!busy} onClick={() => void decline(t)}>не моё</button>
          </span>
        )}
        {own && dateFor === t.draftId && (
          <span className="mcc-date">
            <input type="date" className="ui-input" value={date} min={new Date().toISOString().slice(0, 10)}
              onChange={(e) => setDate(e.target.value)} aria-label="Срок задачи" />
            <button type="button" className="ui-btn ui-btn-sm" disabled={!date || !!busy} onClick={() => void take(t, date)}>Беру к сроку</button>
          </span>
        )}
        {own && t.error && !done && <span className="mcc-dim mcc-err">{t.error}</span>}
      </li>
    );
  };
  const footer = note && <div className="mcc-note"><Icon name="info" size={12} /> {note}</div>;

  // ---- ошибка обработки ----
  if (d.kind === 'error') {
    if (BUSY.includes(m.status)) {
      return <div className="mcc mcc-warn">{head('alert', `Повторяю обработку: ${m.title}`)}<div className="mcc-dim">Итоги придут сюда, как только будут готовы.</div></div>;
    }
    if (m.status !== 'error') {
      return (
        <div className="mcc mcc-ok">
          {head('check-circle', `Созвон обработан: ${m.title}`)}
          <div className="mcc-buttons"><button type="button" className="ui-btn ui-btn-ghost ui-btn-sm" onClick={protocol}><Icon name="list" size={13} /> Протокол</button></div>
        </div>
      );
    }
    return (
      <div className="mcc mcc-danger">
        {head('alert', `Не удалось обработать созвон «${m.title}»`)}
        {m.error && <div className="mcc-line">{m.error}</div>}
        <div className="mcc-dim">{m.autoRetry ? 'Повторю автоматически через минуту.' : 'Автоматический повтор уже был.'}</div>
        <div className="mcc-buttons">
          <button type="button" className="ui-btn ui-btn-sm" disabled={!!busy}
            onClick={() => void act('retry', () => request('POST', `/meeting-cards/${messageId}/retry`))}>
            <Icon name="refresh" size={13} /> {busy === 'retry' ? 'Запускаю…' : 'Повторить'}
          </button>
          <button type="button" className="ui-btn ui-btn-ghost ui-btn-sm" onClick={protocol}><Icon name="list" size={13} /> Протокол</button>
        </div>
        {footer}
      </div>
    );
  }

  // ---- личный список задач ----
  if (d.kind === 'confirm') {
    const open = d.mine.filter((t) => !t.confirm && t.status !== 'rejected');
    return (
      <div className="mcc">
        {head('check-circle', `Ваши задачи со встречи «${m.title}»`)}
        {d.mine.length ? <ul className="mcc-tasks">{d.mine.map((t) => taskRow(t, true))}</ul> : <div className="mcc-dim">Задач за вами не осталось.</div>}
        <div className="mcc-buttons">
          {open.length > 1 && (
            <button type="button" className="ui-btn ui-btn-sm" disabled={!!busy}
              onClick={() => void act('all', () => request('POST', `/meeting-cards/${messageId}/confirm-all`))}>
              <Icon name="check-check" size={13} /> Подтвердить всё
            </button>
          )}
          <button type="button" className="ui-btn ui-btn-ghost ui-btn-sm" onClick={() => navigate('/tasks/mine')}><Icon name="user" size={13} /> Мои задачи</button>
          {!d.hidden && <button type="button" className="ui-btn ui-btn-ghost ui-btn-sm" onClick={protocol}><Icon name="list" size={13} /> Протокол</button>}
        </div>
        {footer}
      </div>
    );
  }

  // ---- итог в чате ----
  if (d.hidden) {
    return <div className="mcc">{head('record', 'Созвон завершён')}<div className="mcc-dim">Итоги видны участникам проекта встречи.</div></div>;
  }
  if (BUSY.includes(m.status)) {
    return <div className="mcc">{head('record', m.title)}<div className="mcc-dim"><span className="spin-sm" /> Собираю итоги…</div></div>;
  }
  const decisions = (d.decisions ?? []).filter(Boolean);
  const risks = (d.risks ?? []).filter(Boolean);
  const people = (d.people ?? []).filter((p) => p.tasks.length);
  return (
    <div className="mcc">
      {head('record', m.title)}
      {d.summary && <div className="mcc-line mcc-summary">{d.summary}</div>}
      {decisions.length > 0 && (
        <div className="mcc-block"><div className="mcc-label">Решения</div><ul>{decisions.slice(0, 6).map((x, i) => <li key={i}>{x}</li>)}</ul></div>
      )}
      {risks.length > 0 && (
        <div className="mcc-block"><div className="mcc-label">Риски</div><ul>{risks.slice(0, 4).map((x, i) => <li key={i}>{x}</li>)}</ul></div>
      )}
      {people.length > 0 && (
        <div className="mcc-block">
          <div className="mcc-label">
            Задачи по людям
            {d.counts && d.counts.total > 0 && <span className="mcc-dim"> · подтверждено {Math.min(d.counts.confirmed, d.counts.total)} из {d.counts.total}</span>}
          </div>
          {people.map((p) => (
            <div key={p.userId ?? 'none'} className="mcc-person">
              <div className="mcc-person-name">{p.name}</div>
              <ul className="mcc-tasks">{p.tasks.map((t) => taskRow(t, !!p.userId && d.mine.some((x) => x.draftId === t.draftId)))}</ul>
            </div>
          ))}
        </div>
      )}
      <div className="mcc-buttons">
        <button type="button" className="ui-btn ui-btn-ghost ui-btn-sm" onClick={() => navigate('/tasks/mine')}><Icon name="user" size={13} /> Мои задачи</button>
        <button type="button" className="ui-btn ui-btn-ghost ui-btn-sm" onClick={protocol}><Icon name="list" size={13} /> Протокол</button>
        {d.recording && (
          <button type="button" className="ui-btn ui-btn-ghost ui-btn-sm" aria-pressed={listen} onClick={() => setListen(!listen)}><Icon name="play" size={13} /> Запись</button>
        )}
        <button type="button" className="ui-btn ui-btn-ghost ui-btn-sm" aria-pressed={!!retell} disabled={busy === 'retell'} onClick={() => void askRetell()}>
          <Icon name="sparkles" size={13} /> {busy === 'retell' ? 'Готовлю пересказ…' : 'Пересказ за 1 минуту'}
        </button>
      </div>
      {listen && d.recording && <audio className="mcc-audio" src={apiUrl(d.recording.url)} controls preload="metadata" />}
      {retell && (
        <div className="mcc-retell">
          {retell.audio && <audio className="mcc-audio" src={apiUrl(retell.audio.url)} controls autoPlay />}
          <div className="mcc-line">{retell.text}</div>
        </div>
      )}
      {footer}
    </div>
  );
}
