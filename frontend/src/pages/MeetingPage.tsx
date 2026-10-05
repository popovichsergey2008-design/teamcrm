import { useCallback, useEffect, useState } from 'react';
import { Icon } from '../components/Icon';
import { EmptyState } from '../components/EmptyState';
import { DeviceCheck } from '../components/DeviceCheck';
import { api, ApiError, MeetingInfo, MeetingMe } from '../lib/api';
import { clockOffset, countdown, meetingSpan, meetingWhen } from '../lib/meeting-time';
import { API_ORIGIN } from '../lib/origin';
import { navigate } from '../lib/router';
import { toastSaved } from '../lib/notifications';

const ROLE_LABEL: Record<string, string> = { organizer: 'организатор', co_organizer: 'соорганизатор', participant: 'участник' };
const POLICY_LABEL: Record<string, string> = {
  trusted: 'участники входят сразу, остальные — через зал ожидания',
  waiting_room: 'все входят через зал ожидания',
  host_required: 'участники ждут, пока не войдёт организатор',
};

/** Адрес встречи для «Скопировать» и «Поделиться»: в приложении — адрес сайта, а не локальный. */
export function meetingUrl(publicId: string): string {
  return `${API_ORIGIN || window.location.origin}/meet/${publicId}`;
}

/** Скопировать или отдать системному «Поделиться». */
export async function shareMeeting(publicId: string, title: string): Promise<'shared' | 'copied' | 'failed'> {
  const url = meetingUrl(publicId);
  const nav = navigator as Navigator & { share?: (d: { title?: string; text?: string; url?: string }) => Promise<void> };
  if (nav.share) {
    try { await nav.share({ title, text: `Встреча «${title}»`, url }); return 'shared'; } catch { /* отменили — скопируем */ }
  }
  try { await navigator.clipboard.writeText(url); return 'copied'; } catch { return 'failed'; }
}

/**
 * Страница встречи по постоянной ссылке `/meet/{publicId}` — для сотрудника (ТЗ-14).
 *
 * Ссылка — постоянный вход во встречу, а не в живую комнату: она открывается всегда и
 * говорит, что сейчас — «скоро», «ранний вход», «идёт», «завершена», «отменена». Отсчёт
 * по часам сервера. Войти — одной кнопкой, а пускать ли сразу или через зал ожидания,
 * решает сервер по правилам встречи.
 */
export function MeetingPage({ publicId, onJoin, inCall }: { publicId: string; onJoin: (roomId: string) => void; inCall: boolean }) {
  const [info, setInfo] = useState<MeetingInfo | null>(null);
  const [me, setMe] = useState<MeetingMe | null>(null);
  const [offset, setOffset] = useState(0);
  const [now, setNow] = useState(Date.now());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const load = useCallback(async () => {
    try {
      const [i, m] = await Promise.all([api.meetingInfo(publicId), api.meetingMe(publicId).catch(() => null)]);
      setInfo(i);
      setMe(m);
      if (i.valid) setOffset(clockOffset(i.serverNow));
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Не удалось открыть встречу');
    }
  }, [publicId]);

  // Состояние живёт на сервере; страницу держим свежей сами — перенос и отмена видны без перезагрузки (§98–99).
  useEffect(() => {
    void load();
    const t = window.setInterval(() => { void load(); }, 20_000);
    const onVis = () => { if (document.visibilityState === 'visible') void load(); };
    document.addEventListener('visibilitychange', onVis);
    return () => { window.clearInterval(t); document.removeEventListener('visibilitychange', onVis); };
  }, [load]);
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);

  const enter = async () => {
    setBusy(true); setErr('');
    try {
      const r = await api.meetingEnter(publicId);
      onJoin(r.roomId);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Не удалось войти');
      void load();
    } finally { setBusy(false); }
  };

  const share = async () => {
    if (!info?.valid) return;
    const r = await shareMeeting(publicId, info.title);
    if (r === 'copied') toastSaved('Ссылка скопирована', meetingUrl(publicId));
  };

  if (err && !info) return <div className="page"><EmptyState icon="phone" title="Встреча не открылась" hint={err} /></div>;
  if (!info) return <div className="page"><div className="dim" style={{ padding: 24 }}>Открываю встречу…</div></div>;
  if (!info.valid) {
    return (
      <div className="page">
        <EmptyState icon="phone" title="Такой встречи нет" hint="Проверьте, что ссылку скопировали целиком." />
      </div>
    );
  }

  const serverNow = now + offset;
  const role = me && me.member ? me.role : 'employee';
  const host = role === 'organizer' || role === 'co_organizer';
  const startsMs = info.startsAt ? Date.parse(info.startsAt) : 0;
  const opensMs = info.opensAt ? Date.parse(info.opensAt) : 0;
  const s = info.state;

  // что сказать и что предложить — по состоянию и роли (ТЗ-14, §93–97)
  let headline = ''; let hint = ''; let action: { label: string; icon: 'phone' | 'clock' } | null = null;
  if (s === 'cancelled') { headline = 'Встреча отменена'; hint = 'Организатор отменил встречу. Если её перенесут, придёт новое приглашение.'; }
  else if (s === 'unavailable') { headline = 'Созвона у встречи больше нет'; hint = 'Организатор выключил созвон для этой встречи.'; }
  else if (s === 'ended') {
    headline = 'Встреча завершена';
    hint = host ? 'Можно открыть её снова — участники смогут войти по этой же ссылке.' : 'Итоги появятся в разделе «Встречи», если шла запись.';
    if (host) action = { label: 'Открыть встречу снова', icon: 'phone' };
  } else if (s === 'live') {
    headline = `Встреча идёт · в созвоне ${info.people}`;
    action = { label: 'Присоединиться', icon: 'phone' };
  } else if (s === 'open') {
    headline = 'Встреча открыта';
    hint = info.hostPresent ? '' : 'Пока никого нет — вы будете первым.';
    action = { label: 'Войти', icon: 'phone' };
  } else if (s === 'early') {
    headline = `Ранний вход открыт · начало ${countdown(startsMs - serverNow)}`;
    hint = host ? 'Вы можете начать раньше — участники смогут войти сразу.' : 'Можно войти в зал ожидания: вас впустят, когда встреча начнётся.';
    action = host ? { label: 'Начать встречу', icon: 'phone' } : { label: 'Войти в зал ожидания', icon: 'clock' };
  } else {
    headline = `Встреча начнётся ${countdown(startsMs - serverNow)}`;
    hint = host
      ? 'Ссылка уже рабочая — её можно отправлять. Начать раньше вы можете в любой момент.'
      : `Ссылка правильная — возвращаться за новой не нужно. Мы напомним перед началом. Войти можно будет в ${new Date(opensMs).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}.`;
    if (host) action = { label: 'Начать раньше', icon: 'phone' };
  }

  return (
    <div className="page meeting-page">
      <div className="meeting-card">
        <div className="meeting-head">
          <span className="meeting-badge"><Icon name="video" size={20} /></span>
          <div>
            <h2 className="meeting-title">{info.title}</h2>
            <div className="dim">
              {info.startsAt ? `${meetingWhen(info.startsAt, serverNow)}${info.endsAt ? ` · ${meetingSpan(info.startsAt, info.endsAt)}` : ''}` : 'Без времени'}
              {info.organizer ? ` · организатор ${info.organizer}` : ''}
            </div>
          </div>
        </div>

        <div className={`meeting-state meeting-state-${s}`} role="status">
          <b>{headline}</b>
          {hint && <div className="dim">{hint}</div>}
        </div>

        {err && <div className="error-text">{err}</div>}
        <div className="meeting-actions">
          {action && (
            <button className="btn btn-primary" onClick={() => void enter()} disabled={busy || inCall}>
              <Icon name={action.icon} size={16} /> {inCall ? 'Вы уже в созвоне' : busy ? 'Подключаюсь…' : action.label}
            </button>
          )}
          {s !== 'cancelled' && s !== 'unavailable' && (
            <button className="btn btn-sm" onClick={() => void share()} title={meetingUrl(publicId)}>
              <Icon name="link" size={14} /> Поделиться ссылкой
            </button>
          )}
          {s === 'ended' && (
            <button className="btn btn-ghost btn-sm" onClick={() => navigate({ section: 'chat', view: 'meetings' })}>
              <Icon name="record" size={14} /> Итоги встреч
            </button>
          )}
          <button className="btn btn-ghost btn-sm" onClick={() => navigate({ section: 'calendar' })}>
            <Icon name="calendar" size={14} /> В календарь
          </button>
        </div>

        {(s === 'scheduled' || s === 'early' || s === 'open' || s === 'live') && <DeviceCheck />}

        {me?.member && me.people.length > 0 && (
          <div className="meeting-people">
            <div className="drawer-section-title">Участники · {me.people.length}</div>
            {me.people.map((p) => (
              <div key={p.userId} className="meeting-person">
                <span>{p.name}</span>
                <span className="dim">
                  {ROLE_LABEL[p.role] ?? ''}{p.status === 'declined' ? ' · отказался' : p.status === 'invited' && p.role === 'participant' ? ' · не ответил' : ''}
                </span>
              </div>
            ))}
          </div>
        )}
        <div className="dim meeting-policy">
          Вход: {POLICY_LABEL[info.accessPolicy] ?? ''}. {info.guestsAllowed ? 'Гости по ссылке — через зал ожидания.' : 'Гостей по ссылке не пускаем.'}
          {info.earlyJoinMin ? ` Ранний вход — за ${info.earlyJoinMin} мин.` : ''}
        </div>
      </div>
    </div>
  );
}
