import { FormEvent, useEffect, useState } from 'react';
import { CallPanel } from '../components/CallPanel';
import { Icon } from '../components/Icon';
import { api, ApiError } from '../lib/api';
import { GuestChat } from '../components/GuestChat';
import { Logo } from '../components/Logo';
import { DeviceCheck } from '../components/DeviceCheck';
import { clockOffset, countdown, meetingSpan, meetingWhen } from '../lib/meeting-time';

interface LinkInfo {
  orgName: string;
  label: string | null;
  roomActive: boolean;
  hostPresent: boolean;
  /** Время встречи; null — ссылка без времени, входить можно сразу. */
  startsAt: string | null;
  /** С какого момента пускают в созвон. */
  opensAt: string | null;
  /** За ссылкой есть переписка — в неё пускают и до встречи. */
  hasChat: boolean;
  /** Персональное приглашение по email: «Вы приглашены как …». */
  invitedAs?: string | null;
  /** Постоянная ссылка встречи (ТЗ-14): её название, конец, состояние и пускают ли гостей. */
  title?: string;
  endsAt?: string | null;
  organizer?: string | null;
  state?: string;
  guestsAllowed?: boolean;
}

interface Admission {
  token: string;
  roomId: string;
  userId: string;
  iceServers: RTCIceServer[];
  /** Разговор, ради которого выдана ссылка. Пусто — ссылка только на созвон. */
  chatId: string | null;
}

const REFUSAL: Record<string, string> = {
  unknown: 'Такой ссылки нет. Проверьте, что скопировали её целиком.',
  revoked: 'Ссылку отозвали — попросите новую у организатора.',
  'invite-revoked': 'Ваше приглашение больше не активно. Если это ошибка — напишите организатору.',
  cancelled: 'Встреча отменена организатором. Если её перенесут, вам пришлют новое приглашение.',
  expired: 'Срок действия ссылки истёк — попросите новую.',
  'used-up': 'Ссылкой уже воспользовались.',
};

/**
 * Вход внешнего гостя по ссылке `/meet/<токен>`.
 *
 * Живёт ВНЕ оболочки приложения: ни сайдбара, ни разделов, ни требования войти —
 * у гостя нет учётной записи и заводить её ради одного разговора незачем. Всё, что
 * он делает на этом экране, — называет себя и стучится в дверь.
 */
export function GuestMeetPage({ token, publicId, onStaffLogin }: {
  /** Гостевая ссылка (длинный токен). */
  token?: string;
  /** Постоянная ссылка встречи (ТЗ-14): та же для всех, гость входит через зал ожидания. */
  publicId?: string;
  /** «Я сотрудник — войти»: по постоянной ссылке своих пускают после входа. */
  onStaffLogin?: () => void;
}) {
  const [info, setInfo] = useState<LinkInfo | null>(null);
  const [refusal, setRefusal] = useState('');
  const [name, setName] = useState(() => localStorage.getItem('teamcrm.guest-name') ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [admission, setAdmission] = useState<Admission | null>(null);
  /**
   * Гость вошёл в переговорную.
   *
   * Отдельно от самого входа: ссылка выдана под РАЗГОВОР, и переписка доступна до
   * созвона и без него. Раньше по ссылке можно было только войти в комнату — гость,
   * пришедший раньше времени или не дозвонившийся, оставался ни с чем и писал на почту.
   */
  const [inCall, setInCall] = useState(false);
  /*
    Часы страницы: ссылку на «завтра в 9» открывают накануне, и кнопка входа должна
    открыться сама, без перезагрузки, — отсчёт идёт на глазах.
  */
  const [now, setNow] = useState(() => Date.now());
  /** Поправка на часы устройства: отсчёт — по часам сервера (ТЗ-14, §100). */
  const [offset, setOffset] = useState(0);
  const opensAtMs = info?.opensAt ? new Date(info.opensAt).getTime() : 0;
  const early = opensAtMs > now + offset;
  useEffect(() => {
    if (!opensAtMs || opensAtMs <= Date.now()) return;
    const t = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => window.clearInterval(t);
  }, [opensAtMs]);

  // Постоянная ссылка встречи: состояние с сервера, перенос и отмена видны без перезагрузки.
  useEffect(() => {
    if (!publicId) return;
    let alive = true;
    const load = () => api.meetingInfo(publicId)
      .then((r) => {
        if (!alive) return;
        if (!r.valid) { setRefusal(REFUSAL.unknown); return; }
        setOffset(clockOffset(r.serverNow));
        setInfo({
          orgName: r.orgName, label: null, roomActive: r.people > 0, hostPresent: r.hostPresent,
          startsAt: r.startsAt, opensAt: r.opensAt, hasChat: false,
          title: r.title, endsAt: r.endsAt, organizer: r.organizer, state: r.state, guestsAllowed: r.guestsAllowed,
        });
      })
      .catch((e) => alive && setRefusal(e instanceof ApiError ? e.message : 'Не удалось открыть встречу'));
    void load();
    const t = window.setInterval(load, 20_000);
    return () => { alive = false; window.clearInterval(t); };
  }, [publicId]);

  useEffect(() => {
    if (!token) return;
    let alive = true;
    api.guestLinkInfo(token)
      .then((r) => {
        if (!alive) return;
        if (r.valid) {
          setInfo({
            orgName: r.orgName, label: r.invitedAs ? null : r.label, roomActive: r.roomActive, hostPresent: r.hostPresent,
            startsAt: r.startsAt ?? null, opensAt: r.opensAt ?? null, hasChat: !!r.hasChat, invitedAs: r.invitedAs ?? null,
          });
          // приглашённого по email встречаем по имени — его и подставляем
          if (r.invitedAs && !r.invitedAs.includes('@')) setName((cur) => cur || r.invitedAs!);
        }
        else setRefusal(REFUSAL[r.reason] ?? 'Ссылка недействительна.');
      })
      .catch((e) => alive && setRefusal(e instanceof ApiError ? e.message : 'Не удалось проверить ссылку'));
    return () => { alive = false; };
  }, [token]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const r = publicId ? await api.meetingGuestJoin(publicId, name.trim()) : await api.guestJoin(String(token), name.trim());
      // имя запоминаем на этом устройстве: со второй попытки входа его не спросят заново
      localStorage.setItem('teamcrm.guest-name', r.name);
      setAdmission({
        token: r.token, roomId: r.roomId, userId: r.userId, iceServers: r.iceServers,
        chatId: r.chatId ?? null,
      });
      // Ссылка только на созвон — идём в комнату сразу: переписки за ней нет.
      if (!r.chatId) setInCall(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось подключиться');
    } finally {
      setBusy(false);
    }
  }

  if (admission && inCall) {
    return (
      <CallPanel
        meetingId={admission.roomId}
        guest={{ token: admission.token, iceServers: admission.iceServers, userId: admission.userId }}
        // Выход из созвона возвращает в переписку, а не выбрасывает со страницы:
        // разговор продолжается словами, даже когда созвон закончился.
        onClose={() => (admission.chatId ? setInCall(false) : setAdmission(null))}
      />
    );
  }

  if (admission?.chatId) {
    return (
      <div className="guest-shell">
        {/* Первое, что видит человек. Знак крупнее слова — его и запоминают. */}
        <div className="auth-logo">
          <Logo size={88} />
          <span className="logo-word">ANTHILL<span className="logo-dot">.</span>TEAM</span>
        </div>
        <p className="dim auth-sub">
          Вы в разговоре{info?.orgName ? <> · «{info.orgName}»</> : null}. Кроме него, вам ничего не видно.
        </p>
        <GuestChat token={admission.token} orgName={info?.orgName ?? null} />
        {early && info?.startsAt && (
          <p className="dim guest-when-note">
            Созвон {meetingWhen(info.startsAt)} — подключиться можно будет {countdown(opensAtMs - now)}.
          </p>
        )}
        <button className="btn btn-primary guest-call-btn" onClick={() => setInCall(true)} disabled={early}>
          <Icon name="phone" size={15} /> Подключиться к созвону
        </button>
      </div>
    );
  }

  return (
    <div className="center-screen">
      <form className="card auth-card" onSubmit={submit}>
        {/* Первое, что видит человек. Знак крупнее слова — его и запоминают. */}
        <div className="auth-logo">
          <Logo size={88} />
          <span className="logo-word">ANTHILL<span className="logo-dot">.</span>TEAM</span>
        </div>

        {refusal ? (
          <>
            <p className="dim auth-sub">Приглашение на видеовстречу</p>
            <div className="error-text">{refusal}</div>
          </>
        ) : !info ? (
          <p className="dim auth-sub">Проверяем ссылку…</p>
        ) : (
          <>
            <p className="dim auth-sub">
              Вас пригласили на видеовстречу{info.orgName ? <> · «{info.orgName}»</> : null}
            </p>
            {info.title && <p className="guest-meeting-title">{info.title}</p>}
            {info.label && <p className="dim" style={{ marginTop: -4 }}>{info.label}</p>}
            {info.organizer && <p className="dim" style={{ marginTop: -4, fontSize: 12 }}>Организатор: {info.organizer}</p>}

            {/* Встреча отменена, завершена или гостей не пускают — так и говорим, без формы входа (ТЗ-14, §93) */}
            {closedNote(info) ? (
              <>
                <div className="guest-when guest-closed" role="status">
                  <Icon name={info.state === 'cancelled' ? 'close' : 'clock'} size={18} />
                  <div>
                    <div className="guest-when-time">{closedNote(info)!.title}</div>
                    <div className="dim guest-when-sub">{closedNote(info)!.hint}</div>
                  </div>
                </div>
                {onStaffLogin && (
                  <button type="button" className="btn btn-ghost btn-sm" onClick={onStaffLogin}>Я сотрудник — войти</button>
                )}
              </>
            ) : (<>
            {/* Встреча назначена на время: показать его крупно — ради этого гость и открыл ссылку */}
            {info.startsAt && (
              <div className="guest-when" role="status">
                <Icon name="calendar" size={18} />
                <div>
                  <div className="guest-when-time">
                    {meetingWhen(info.startsAt, now + offset)}{info.endsAt ? ` · ${meetingSpan(info.startsAt, info.endsAt)}` : ''}
                  </div>
                  <div className="dim guest-when-sub">
                    {early
                      ? `Начало ${countdown(new Date(info.startsAt).getTime() - now - offset)} · время по вашим часам. Ссылка правильная — возвращаться за новой не нужно.`
                      : 'Встреча скоро начнётся или уже идёт'}
                  </div>
                </div>
              </div>
            )}

            {info.invitedAs && (
              <p className="dim" style={{ marginTop: -4 }}>Вы приглашены как <b>{info.invitedAs}</b></p>
            )}
            <div className="field">
              <label htmlFor="guest-name">Как вас представить участникам</label>
              <input
                id="guest-name"
                className="input"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Имя и компания"
                autoFocus
                maxLength={60}
              />
            </div>

            <p className="dim" style={{ fontSize: 12 }}>
              {early
                ? (info.opensAt
                  ? `Войти в зал ожидания можно будет за ${Math.round(((info.startsAt ? Date.parse(info.startsAt) : opensAtMs) - opensAtMs) / 60_000)} мин до начала — ${countdown(opensAtMs - now - offset)}. Страницу можно не закрывать: кнопка откроется сама.`
                  : '')
                : info.hostPresent
                  ? 'Встреча идёт — организатор увидит вашу заявку и впустит.'
                  : 'Можно войти и подождать — организатору придёт уведомление, и он вас впустит.'}
            </p>

            {/* Проверить камеру и микрофон заранее — разрешение браузер спросит только по нажатию */}
            <DeviceCheck />
            {error && <div className="error-text">{error}</div>}
            {/*
              До времени встречи ссылка «только на созвон» не пускает никуда — кнопка
              закрыта. Если за ссылкой есть переписка, войти в неё можно сразу.
            */}
            <button
              className="btn btn-primary auth-submit"
              type="submit"
              disabled={busy || name.trim().length < 2 || (early && !info.hasChat)}
            >
              <Icon name={early && info.hasChat ? 'chat' : 'phone'} size={15} />{' '}
              {busy ? 'Подключаюсь…' : early && info.hasChat ? 'Открыть переписку' : 'Войти во встречу'}
            </button>
            <p className="dim" style={{ fontSize: 11 }}>
              Ничего устанавливать не нужно: встреча работает прямо в браузере.
              Разрешите доступ к микрофону, когда браузер спросит.
            </p>
            {onStaffLogin && (
              <button type="button" className="btn btn-ghost btn-sm" onClick={onStaffLogin}>
                Я сотрудник ANTHILL — войти
              </button>
            )}
            </>)}
          </>
        )}
      </form>
    </div>
  );
}

/** Встреча по постоянной ссылке, в которую гостю сейчас не войти, — что ему сказать. */
function closedNote(info: { state?: string; guestsAllowed?: boolean }): { title: string; hint: string } | null {
  if (info.state === 'cancelled') return { title: 'Встреча отменена', hint: 'Организатор отменил встречу. Если её перенесут, вам пришлют новое приглашение.' };
  if (info.state === 'ended') return { title: 'Встреча завершена', hint: 'Если вы не успели — напишите организатору.' };
  if (info.state === 'unavailable') return { title: 'Созвона у встречи больше нет', hint: 'Организатор выключил созвон для этой встречи.' };
  if (info.guestsAllowed === false) return { title: 'Встреча только для приглашённых', hint: 'Гостей по этой ссылке не пускают. Попросите у организатора персональное приглашение.' };
  return null;
}
