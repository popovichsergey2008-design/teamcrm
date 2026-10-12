import { useCallback, useEffect, useState } from 'react';
import './guest.css';
import { Icon } from '../Icon';
import { api, ApiError, GuestCred, GuestPostcall as Data } from '../../lib/api';
import { apiUrl } from '../../lib/origin';

const T = {
  ru: {
    thanks: (n: string) => `Спасибо за встречу${n ? `, ${n}` : ''}.`,
    processing: (c: string) => `${c || 'Организатор'} готовит итоговый протокол…`,
    processingHint: 'Страницу можно не закрывать — итоги появятся здесь сами. Ссылка останется рабочей.',
    fixed: 'Договорённости зафиксированы',
    updated: 'Итоги обновлены',
    brief: 'Кратко',
    agreed: 'Договорились',
    next: 'Следующая встреча',
    files: 'Материалы',
    confirm: 'Подтвердить договорённости',
    confirmed: 'Вы подтвердили договорённости',
    clarify: 'Есть уточнение',
    send: 'Отправить',
    cancel: 'Отмена',
    sent: 'Отправлено — организатор получил уведомление.',
    kinds: { correction: 'Уточнение', question: 'Вопрос', comment: 'Комментарий' },
    placeholder: 'Что поправить или уточнить?',
    sides: { ours: 'Мы', client: 'Вы', both: 'Вместе', unassigned: '' } as Record<string, string>,
    until: 'до',
    expired: 'Срок показа итогов истёк',
    expiredHint: 'Напишите организатору — он пришлёт итоги ещё раз.',
    none: 'Итогов этой встречи пока нет.',
    rejoin: 'Вернуться во встречу',
    madeIn: 'Встреча организована в QEVO',
    learn: 'Узнать, что такое QEVO',
    ics: 'Файл .ics',
  },
  en: {
    thanks: (n: string) => `Thank you for the meeting${n ? `, ${n}` : ''}.`,
    processing: (c: string) => `${c || 'The organizer'} is preparing the meeting notes…`,
    processingHint: 'You can keep this page open — the notes will appear here. The link stays valid.',
    fixed: 'Agreements recorded',
    updated: 'Notes updated',
    brief: 'Summary',
    agreed: 'Agreed',
    next: 'Next meeting',
    files: 'Materials',
    confirm: 'Confirm agreements',
    confirmed: 'You confirmed the agreements',
    clarify: 'I have a correction',
    send: 'Send',
    cancel: 'Cancel',
    sent: 'Sent — the organizer has been notified.',
    kinds: { correction: 'Correction', question: 'Question', comment: 'Comment' },
    placeholder: 'What should be corrected or clarified?',
    sides: { ours: 'We', client: 'You', both: 'Both', unassigned: '' } as Record<string, string>,
    until: 'by',
    expired: 'These notes are no longer available',
    expiredHint: 'Please contact the organizer to receive them again.',
    none: 'There are no notes for this meeting yet.',
    rejoin: 'Back to the meeting',
    madeIn: 'This meeting was organized with QEVO',
    learn: 'Learn about QEVO',
    ics: '.ics file',
  },
};

const fmtDate = (iso: string, lang: string) =>
  new Date(iso).toLocaleString(lang === 'en' ? 'en-GB' : 'ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
const fmtDay = (iso: string, lang: string) =>
  new Date(iso).toLocaleDateString(lang === 'en' ? 'en-GB' : 'ru-RU', { day: 'numeric', month: 'long' });

/**
 * Экран гостя после встречи (ТЗ-28, п. 28–29): не «звонок завершён», а «спасибо» →
 * «готовим протокол» → опубликованные договорённости, материалы, следующая встреча,
 * подтверждение и уточнение. Показывается только то, что хозяин опубликовал.
 */
export default function GuestPostcall({ cred, companyName, onRejoin }: {
  cred: GuestCred;
  companyName: string | null;
  /** встреча ещё идёт — вернуться в неё по гостевой сессии */
  onRejoin?: () => void;
}) {
  const [data, setData] = useState<Data | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [asking, setAsking] = useState(false);
  const [kind, setKind] = useState<'correction' | 'question' | 'comment'>('correction');
  const [text, setText] = useState('');
  const [sent, setSent] = useState(false);

  const load = useCallback(async () => {
    try { setData(await api.guestPostcall(cred)); setErr(''); } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Не удалось открыть итоги');
    }
  }, [cred]);

  useEffect(() => { void load(); }, [load]);
  // протокол ещё готовят — переспрашиваем, полчаса, раз в 15 секунд
  const processing = data?.state === 'processing';
  useEffect(() => {
    if (!processing) return;
    const t = window.setInterval(() => void load(), 15_000);
    const stop = window.setTimeout(() => window.clearInterval(t), 30 * 60_000);
    return () => { window.clearInterval(t); window.clearTimeout(stop); };
  }, [processing, load]);

  const lang = data?.summary?.language === 'en' || (!data?.summary && navigator.language?.startsWith('en')) ? 'en' : 'ru';
  const t = T[lang];
  const company = data?.brand?.companyName ?? companyName ?? '';

  if (err && !data) return <div className="gp-card"><div className="error-text">{err}</div></div>;
  if (!data) return <div className="gp-card"><p className="dim">…</p></div>;

  const s = data.summary;
  const ack = async () => {
    if (!s) return;
    setBusy(true);
    try { await api.guestAcknowledge(cred, s.version); await load(); } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Не получилось');
      await load();
    } finally { setBusy(false); }
  };
  const sendFeedback = async () => {
    setBusy(true);
    try { await api.guestFeedback(cred, kind, text); setSent(true); setAsking(false); setText(''); } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Не получилось');
    } finally { setBusy(false); }
  };
  const openFile = async (id: string) => {
    try { const r = await api.guestFile(cred, id); window.open(apiUrl(r.url), '_blank', 'noopener'); } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Файл недоступен');
    }
  };

  return (
    <div className="gp-card" aria-live="polite">
      <h1 className="gp-thanks">{t.thanks(data.guestName)}</h1>
      <div className="gp-meeting dim">{data.meeting.title}{data.meeting.at ? ` · ${fmtDate(data.meeting.at, lang)}` : ''}</div>

      {(data.state === 'processing' || data.state === 'none') && (
        <div className="gp-processing" role="status">
          <span className="gp-spinner" aria-hidden="true" />
          <div>
            <div className="gp-strong">{data.state === 'processing' ? t.processing(company) : t.none}</div>
            {data.state === 'processing' && <div className="dim gp-small">{t.processingHint}</div>}
          </div>
        </div>
      )}

      {data.state === 'expired' && (
        <div className="gp-processing" role="status">
          <Icon name="clock" size={18} />
          <div><div className="gp-strong">{t.expired}</div><div className="dim gp-small">{t.expiredHint}</div></div>
        </div>
      )}

      {onRejoin && data.state !== 'ready' && (
        <button type="button" className="ui-btn ui-btn-outline ui-btn-md gp-rejoin" onClick={onRejoin}><Icon name="phone" size={14} /> {t.rejoin}</button>
      )}

      {s && data.state === 'ready' && (
        <>
          <div className="gp-fixed"><Icon name="check-circle" size={18} /> {t.fixed}</div>
          {s.updated && <div className="dim gp-small">{t.updated} · {fmtDate(s.publishedAt, lang)}</div>}

          {s.text && (
            <section className="gp-section">
              <h2>{t.brief}</h2>
              <p>{s.text}</p>
            </section>
          )}

          {s.agreements.length > 0 && (
            <section className="gp-section">
              <h2>{t.agreed}</h2>
              <ul className="gp-agreements">
                {s.agreements.map((a, i) => (
                  <li key={i}>
                    {t.sides[a.side] && <span className={`gp-side gp-side-${a.side}`}>{t.sides[a.side]}</span>}
                    <span>{a.text}{a.deadlineAt ? <span className="dim"> · {t.until} {fmtDay(a.deadlineAt, lang)}</span> : null}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {s.nextMeeting && (
            <section className="gp-section">
              <h2>{t.next}</h2>
              <p className="gp-strong">{s.nextMeeting.title} · {fmtDate(s.nextMeeting.at, lang)}</p>
              <div className="gp-row">
                <a className="ui-btn ui-btn-outline ui-btn-sm" href={s.nextMeeting.google} target="_blank" rel="noopener noreferrer" onClick={() => void api.guestEvent(cred, 'calendar_added')}>Google</a>
                <a className="ui-btn ui-btn-outline ui-btn-sm" href={s.nextMeeting.outlook} target="_blank" rel="noopener noreferrer" onClick={() => void api.guestEvent(cred, 'calendar_added')}>Outlook</a>
                <a className="ui-btn ui-btn-outline ui-btn-sm" href={api.guestIcsUrl(cred)} onClick={() => void api.guestEvent(cred, 'calendar_added')}>{t.ics}</a>
              </div>
            </section>
          )}

          {s.files.length > 0 && (
            <section className="gp-section">
              <h2>{t.files}</h2>
              <div className="gp-row">
                {s.files.map((f) => (
                  <button key={f.id} type="button" className="ui-btn ui-btn-outline ui-btn-sm" onClick={() => void openFile(f.id)}>
                    <Icon name="file" size={13} /> {f.name}
                  </button>
                ))}
              </div>
            </section>
          )}

          <div className="gp-actions">
            {data.acknowledgedAt ? (
              <div className="gp-acked"><Icon name="check" size={15} /> {t.confirmed} · {fmtDate(data.acknowledgedAt, lang)}</div>
            ) : (
              <button type="button" className="ui-btn ui-btn-primary ui-btn-md gp-primary" disabled={busy} onClick={() => void ack()}>
                <Icon name="check" size={15} /> {t.confirm}
              </button>
            )}
            {!asking && (
              <button type="button" className="ui-btn ui-btn-ghost ui-btn-md" onClick={() => { setAsking(true); setSent(false); }}>{t.clarify}</button>
            )}
          </div>
          {sent && <div className="dim gp-small" role="status">{t.sent}</div>}

          {asking && (
            <div className="gp-feedback">
              <div className="gp-row" role="radiogroup" aria-label={t.clarify}>
                {(['correction', 'question', 'comment'] as const).map((k) => (
                  <button key={k} type="button" role="radio" aria-checked={kind === k} className={`gp-chip${kind === k ? ' gp-chip-on' : ''}`} onClick={() => setKind(k)}>{t.kinds[k]}</button>
                ))}
              </div>
              <textarea className="input" rows={3} maxLength={2000} value={text} onChange={(e) => setText(e.target.value)} placeholder={t.placeholder} aria-label={t.placeholder} />
              <div className="gp-row">
                <button type="button" className="ui-btn ui-btn-primary ui-btn-sm gp-primary" disabled={busy || text.trim().length < 2} onClick={() => void sendFeedback()}>{t.send}</button>
                <button type="button" className="ui-btn ui-btn-ghost ui-btn-sm" onClick={() => setAsking(false)}>{t.cancel}</button>
              </div>
            </div>
          )}

          {/* Мягкий вирусный хвост (п. 13): только после подтверждения и если бренд разрешает */}
          {data.acknowledgedAt && data.brand?.poweredBy !== false && (
            <div className="gp-viral dim">
              {t.madeIn} ·{' '}
              <a href="https://qevo.one/?utm_source=guest&utm_medium=postcall" target="_blank" rel="noopener noreferrer" onClick={() => void api.guestEvent(cred, 'cta_clicked')}>{t.learn}</a>
            </div>
          )}
        </>
      )}
      {err && data && <div className="error-text">{err}</div>}
    </div>
  );
}
