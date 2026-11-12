import { useEffect, useState } from 'react';
import { ApiError, request } from '../../lib/api';
import { toastSaved } from '../../lib/notifications';
import { calApi, hhmm } from './cal-api';
import { fmtMinutes } from './TaskTimeDialog';

export interface Proposed { startsAt: string; endsAt: string; label: string }
interface FocusGoal { goalMin: number; plannedMin: number; proposal: Proposed[]; proposalMin: number }

/**
 * Фокус-время с недельной целью (#4892, п. 9): «6 ч из 10 ч запланировано», блоки —
 * в лучшие окна (утро, от 2 ч). «Добрать» сначала показывает блоки пунктиром.
 */
export function FocusGoalCard({ from, to, refreshKey, onPreview }: {
  from: string; to: string; refreshKey: number;
  onPreview: (p: { items: Proposed[]; apply: () => Promise<unknown>; text: string }) => void;
}) {
  const [g, setG] = useState<FocusGoal | null>(null);
  const [edit, setEdit] = useState<string | null>(null);
  const load = () => request<FocusGoal>('POST', '/calendar/plus/focus-goal', { from, to }).then(setG).catch(() => undefined);
  useEffect(() => { void load(); }, [from, to, refreshKey]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!g) return null;
  const pct = g.goalMin ? Math.min(100, Math.round((g.plannedMin / g.goalMin) * 100)) : 0;
  const saveGoal = async () => {
    const h = Number(String(edit).replace(',', '.'));
    if (!Number.isFinite(h) || h < 0 || h > 40) return;
    await calApi.savePrefs({ focusGoalMin: Math.round(h * 60) });
    setEdit(null);
    await load();
  };
  return (
    <section className="cal-assist cal-focusgoal" aria-label="Фокус-время">
      <div className="cal-assist-head"><span>Фокус-время · цель недели</span></div>
      {g.goalMin ? (
        <>
          <div className="cal-fg-title">{fmtMinutes(g.plannedMin) || '0 ч'} из {fmtMinutes(g.goalMin)} запланировано</div>
          <div className="cal-fg-bar"><span style={{ width: `${pct}%` }} /></div>
        </>
      ) : <div className="dim cal-small">Цель не задана. Например, 10 ч фокуса в неделю — QEVO сам найдёт для них лучшие окна.</div>}
      <ul className="cal-fg-rules dim">
        <li>Блоки ставятся в лучшие окна: утро, 2 ч и дольше</li>
        <li>Если на фокус ставят встречу — блок сдвигается в ближайшее свободное окно того же дня, вам приходит уведомление</li>
        <li>В «Найти время» коллеги видят «фокус», и слот на него не предлагается</li>
        <li>Во время блока: статус «В фокусе», уведомления в тишине</li>
      </ul>
      {edit !== null ? (
        <div className="cal-assist-actions">
          <input className="ui-input cal-time" value={edit} onChange={(e) => setEdit(e.target.value)} aria-label="Цель, часов в неделю" /> ч в неделю
          <button className="ui-btn ui-btn-primary ui-btn-sm" onClick={() => void saveGoal()}>Сохранить</button>
          <button className="ui-btn ui-btn-ghost ui-btn-sm" onClick={() => setEdit(null)}>Отмена</button>
        </div>
      ) : (
        <div className="cal-assist-actions">
          {g.proposal.length > 0 && (
            <button className="ui-btn ui-btn-primary ui-btn-sm" onClick={() => onPreview({
              items: g.proposal.map((p) => ({ ...p, label: `фокус · ${p.label.split(' ').pop()}` })),
              text: `Добрать ${fmtMinutes(g.proposalMin)} фокуса: ${g.proposal.map((p) => p.label).join(', ')}`,
              apply: () => request('POST', '/calendar/plus/focus-goal/apply', { from, to }),
            })}>Добрать {fmtMinutes(g.proposalMin)} на неделе</button>
          )}
          <button className="ui-btn ui-btn-outline ui-btn-sm" onClick={() => setEdit(String(Math.round(g.goalMin / 6) / 10 || 10))}>{g.goalMin ? 'Изменить цель' : 'Задать цель'}</button>
        </div>
      )}
    </section>
  );
}

/** Полоса предпросмотра: «Применить» / «Отменить» — ничего не ставится без нажатия. */
export function PreviewBar({ text, onApply, onCancel }: { text: string; onApply: () => Promise<void>; onCancel: () => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <div className="cal-undo cal-previewbar" role="status">
      <span><b>Предпросмотр:</b> {text}</span>
      <button className="ui-btn ui-btn-primary ui-btn-sm" disabled={busy} onClick={async () => { setBusy(true); try { await onApply(); } finally { setBusy(false); } }}>{busy ? 'Применяю…' : 'Применить'}</button>
      <button className="ui-btn ui-btn-ghost ui-btn-sm" onClick={onCancel}>Отменить</button>
      <span className="dim cal-small">ничего не ставится без «Применить» · сроки не меняются</span>
    </div>
  );
}

interface Declines {
  eventId: string; title: string; canEdit: boolean; total: number; triggered: boolean;
  declined: { name: string; comment: string | null }[];
  slots: { startsAt: string; endsAt: string; label: string; reasons: string[] }[];
}

/**
 * Перенос в 1 клик (#4892, п. 10): отказалась половина участников или ключевой —
 * баннер с причинами и 2 слотами, когда свободны все. «Перенести» шлёт новое
 * приглашение и сообщение в чат встречи.
 */
export function RescheduleBanner({ eventId, onMoved }: { eventId: string; onMoved: () => void }) {
  const [d, setD] = useState<Declines | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => { request<Declines>('GET', `/calendar/plus/events/${eventId}/declines`).then(setD).catch(() => undefined); }, [eventId]);
  if (!d || !d.triggered || !d.canEdit || !d.slots.length) return null;
  const move = async (s: { startsAt: string; endsAt: string; label: string }) => {
    setBusy(true); setErr('');
    try {
      await request('POST', `/calendar/plus/events/${eventId}/reschedule`, { startsAt: s.startsAt, endsAt: s.endsAt });
      toastSaved('Встреча перенесена', `${s.label} · приглашения обновлены`);
      onMoved();
    } catch (e) { setErr(e instanceof ApiError ? e.message : 'Не удалось перенести'); } finally { setBusy(false); }
  };
  return (
    <section className="cal-resched" aria-label="Участники отклонили">
      <div className="cal-first-kicker warn">{d.declined.length} из {d.total} участников отклонили</div>
      <div className="dim cal-small">{d.declined.map((x) => `${x.name}: ${x.comment ? `«${x.comment}»` : 'без комментария'}`).join(' · ')}</div>
      <div className="cal-best-slots">
        {d.slots.map((s, i) => (
          <div key={s.startsAt} className={`cal-best-slot${i === 0 ? ' best' : ''}`}>
            {i === 0 && <span className="cal-pill ok">все свободны</span>}
            <div className="cal-best-when">{s.label.replace(/^./, (x) => x.toUpperCase())}</div>
            {i > 0 && <div className="dim cal-small">все свободны</div>}
            <button type="button" className={`ui-btn ui-btn-sm ${i === 0 ? 'ui-btn-primary' : 'ui-btn-outline'}`} disabled={busy} onClick={() => void move(s)}>Перенести</button>
          </div>
        ))}
      </div>
      <div className="dim cal-small">После переноса участники получат новое приглашение и сообщение в чат встречи.</div>
      {err && <div className="cal-phrase-err">{err}</div>}
    </section>
  );
}

/** Отказ с причиной (п. 10): «в это время у врача» — организатор увидит её в баннере. */
export function DeclineBox({ eventId, onDone, onCancel }: { eventId: string; onDone: () => void; onCancel: () => void }) {
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <div className="cal-decline">
      <input className="ui-input" autoFocus placeholder="Причина (необязательно): например, «в это время у врача»" value={comment}
        onChange={(e) => setComment(e.target.value)} aria-label="Причина отказа" maxLength={300} />
      <button type="button" className="ui-btn ui-btn-outline ui-btn-sm" disabled={busy} onClick={async () => {
        setBusy(true);
        try { await request('POST', `/calendar/plus/events/${eventId}/decline`, { comment: comment.trim() || undefined }); toastSaved('Вы отказались', comment.trim() ? 'причину увидит организатор' : ''); onDone(); }
        finally { setBusy(false); }
      }}>Отклонить</button>
      <button type="button" className="ui-btn ui-btn-ghost ui-btn-sm" onClick={onCancel}>Отмена</button>
    </div>
  );
}

export const shortRange = (a: string, b: string) => `${hhmm(a)}–${hhmm(b)}`;
