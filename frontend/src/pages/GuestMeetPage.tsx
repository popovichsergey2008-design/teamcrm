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

  useEffect(() => {
    let alive = true;
    api.guestLinkInfo(token)
      .then((r) => {
        if (!alive) return;
        if (r.valid) setInfo({ orgName: r.orgName, label: r.label, roomActive: r.roomActive, hostPresent: r.hostPresent });
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
        chatId: (r as { chatId?: string | null }).chatId ?? null,
      });
      // Ссылка только на созвон — идём в комнату сразу: переписки за ней нет.
      if (!(r as { chatId?: string | null }).chatId) setInCall(true);
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
        <button className="btn btn-primary guest-call-btn" onClick={() => setInCall(true)}>
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
              {info.hostPresent
                ? 'Встреча идёт — организатор увидит вашу заявку и впустит.'
                : 'Встреча ещё не началась. Можно войти и подождать — вас впустят, как только она начнётся.'}
            </p>

            {error && <div className="error-text">{error}</div>}
            <button className="btn btn-primary auth-submit" type="submit" disabled={busy || name.trim().length < 2}>
              <Icon name="phone" size={15} /> {busy ? 'Подключаюсь…' : 'Войти во встречу'}
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
