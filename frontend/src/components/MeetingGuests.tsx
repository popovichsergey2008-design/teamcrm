import { FormEvent, useEffect, useState } from 'react';
import { Icon } from './Icon';
import { api, ApiError, MeetingInvite } from '../lib/api';
import { toastSaved } from '../lib/notifications';

/**
 * Гости встречи по email (ТЗ-14, §66–70, §112).
 *
 * Человеку со стороны — личное приглашение: письмо с файлом встречи для его календаря и
 * СВОЯ ссылка. По ней он войдёт в зал ожидания под своим именем; отозвать можно одного
 * гостя, не трогая остальных и общую ссылку. При переносе и отмене гостю придёт письмо,
 * за 15 минут до начала — напоминание по той же ссылке.
 */
export function MeetingGuests({ eventId }: { eventId: string }) {
  const [list, setList] = useState<MeetingInvite[] | null>(null);
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const load = () => api.meetingInvites(eventId).then(setList).catch((e) => {
    setList([]);
    if (e instanceof ApiError && e.code !== 'FORBIDDEN') setErr(e.message);
  });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { void load(); }, [eventId]);

  const invite = async (e: FormEvent) => {
    e.preventDefault();
    if (!email.trim()) return;
    setBusy(true); setErr('');
    try {
      await api.meetingInvite(eventId, email.trim(), name.trim());
      toastSaved('Приглашение отправлено', email.trim());
      setEmail(''); setName('');
      void load();
    } catch (er) {
      setErr(er instanceof ApiError ? er.message : 'Не удалось пригласить');
    } finally { setBusy(false); }
  };

  const resend = async (inv: MeetingInvite) => {
    try { await api.meetingInviteResend(eventId, inv.id); toastSaved('Письмо отправлено ещё раз', inv.email); }
    catch (er) { setErr(er instanceof ApiError ? er.message : 'Не удалось отправить'); }
  };

  const revoke = async (inv: MeetingInvite) => {
    if (!window.confirm(`Отозвать приглашение ${inv.email}? Его ссылка перестанет работать.`)) return;
    try { await api.meetingInviteRevoke(eventId, inv.id); void load(); }
    catch (er) { setErr(er instanceof ApiError ? er.message : 'Не удалось отозвать'); }
  };

  const active = (list ?? []).filter((i) => i.active);
  const gone = (list ?? []).filter((i) => !i.active);

  return (
    <div className="meeting-guests">
      <div className="drawer-section-title">Гости по email</div>
      <form className="meeting-guests-add" onSubmit={invite}>
        <input className="input" type="email" placeholder="email гостя" value={email} onChange={(e) => setEmail(e.target.value)} aria-label="Email гостя" />
        <input className="input" placeholder="Имя (необязательно)" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} aria-label="Имя гостя" />
        <button className="btn btn-sm btn-primary" type="submit" disabled={busy || !email.trim()}>
          <Icon name="send" size={14} /> {busy ? 'Отправляю…' : 'Пригласить'}
        </button>
      </form>
      <div className="dim" style={{ fontSize: 12 }}>
        Гостю придёт письмо с его личной ссылкой и файлом встречи для календаря. Он войдёт через зал ожидания —
        впустит кто-то из команды.
      </div>
      {err && <div className="error-text">{err}</div>}
      {active.map((i) => (
        <div key={i.id} className="meeting-guest">
          <span className="meeting-guest-who">
            <b>{i.name || i.email}</b>{i.name && <span className="dim"> · {i.email}</span>}
            <span className="dim"> · {i.opened ? 'заходил по ссылке' : 'ещё не открывал'}</span>
          </span>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => void resend(i)} title="Отправить письмо со ссылкой ещё раз">
            <Icon name="send" size={13} />
          </button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => void revoke(i)} title="Отозвать приглашение" aria-label={`Отозвать приглашение ${i.email}`}>
            <Icon name="close" size={13} />
          </button>
        </div>
      ))}
      {gone.length > 0 && (
        <div className="dim" style={{ fontSize: 12 }}>
          Отозваны: {gone.map((i) => i.name || i.email).join(', ')}
        </div>
      )}
    </div>
  );
}
