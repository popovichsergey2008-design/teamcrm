import { FormEvent, useEffect, useState } from 'react';
import { CallPanel } from '../components/CallPanel';
import { Icon } from '../components/Icon';
import { api, ApiError } from '../lib/api';
import { GuestChat } from '../components/GuestChat';
import { Logo } from '../components/Logo';

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
}

interface Admission {
  token: string;
  roomId: string;
  userId: string;
  iceServers: RTCIceServer[];
  /** Разговор, ради которого выдана ссылка. Пусто — ссылка только на созвон. */
  chatId: string | null;
}

/** «завтра в 09:00», «2 октября в 09:00» — время гостя, по его часовому поясу. */
function meetingWhen(iso: string): string {
  const d = new Date(iso);
  const day = new Date(d); day.setHours(0, 0, 0, 0);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const diff = Math.round((day.getTime() - today.getTime()) / 86_400_000);
  const time = d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  const date = diff === 0 ? 'сегодня' : diff === 1 ? 'завтра'
    : d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', weekday: 'long' });
  return `${date} в ${time}`;
}

/** Сколько осталось: «через 2 дн. 3 ч», «через 1 ч 05 мин», «через 4 мин». */
function countdown(ms: number): string {
  const min = Math.max(1, Math.ceil(ms / 60_000));
  const d = Math.floor(min / 1440); const h = Math.floor((min % 1440) / 60); const m = min % 60;
  if (d) return `через ${d} дн.${h ? ` ${h} ч` : ''}`;
  if (h) return `через ${h} ч ${String(m).padStart(2, '0')} мин`;
  return `через ${m} мин`;
}

const REFUSAL: Record<string, string> = {
  unknown: 'Такой ссылки нет. Проверьте, что скопировали её целиком.',
  revoked: 'Ссылку отозвали — попросите новую у организатора.',
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
export function GuestMeetPage({ token }: { token: string }) {
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
  const opensAtMs = info?.opensAt ? new Date(info.opensAt).getTime() : 0;
  const early = opensAtMs > now;
  useEffect(() => {
    if (!opensAtMs || opensAtMs <= Date.now()) return;
    const t = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => window.clearInterval(t);
  }, [opensAtMs]);

  useEffect(() => {
    let alive = true;
    api.guestLinkInfo(token)
      .then((r) => {
        if (!alive) return;
        if (r.valid) {
          setInfo({
            orgName: r.orgName, label: r.label, roomActive: r.roomActive, hostPresent: r.hostPresent,
            startsAt: r.startsAt ?? null, opensAt: r.opensAt ?? null, hasChat: !!r.hasChat,
          });
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
      const r = await api.guestJoin(token, name.trim());
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
            {info.label && <p className="dim" style={{ marginTop: -4 }}>{info.label}</p>}

            {/* Встреча назначена на время: показать его крупно — ради этого гость и открыл ссылку */}
            {info.startsAt && (
              <div className="guest-when" role="status">
                <Icon name="calendar" size={18} />
                <div>
                  <div className="guest-when-time">{meetingWhen(info.startsAt)}</div>
                  <div className="dim guest-when-sub">
                    {early
                      ? `Начало ${countdown(new Date(info.startsAt).getTime() - now)} · время указано по вашим часам`
                      : 'Встреча скоро начнётся или уже идёт'}
                  </div>
                </div>
              </div>
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
                  ? `Войти можно будет за 15 минут до начала — ${countdown(opensAtMs - now)}. Страницу можно не закрывать: кнопка откроется сама.`
                  : '')
                : info.hostPresent
                  ? 'Встреча идёт — организатор увидит вашу заявку и впустит.'
                  : 'Можно войти и подождать — организатору придёт уведомление, и он вас впустит.'}
            </p>

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
          </>
        )}
      </form>
    </div>
  );
}
