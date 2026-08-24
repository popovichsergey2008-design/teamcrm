import { FormEvent, useEffect, useState } from 'react';
import { CallPanel } from '../components/CallPanel';
import { Icon } from '../components/Icon';
import { api, ApiError } from '../lib/api';

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

  useEffect(() => {
    let alive = true;
    api.guestLinkInfo(token)
      .then((r) => {
        if (!alive) return;
        if (r.ok) setInfo({ orgName: r.orgName, label: r.label, roomActive: r.roomActive, hostPresent: r.hostPresent });
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
      setAdmission({ token: r.token, roomId: r.roomId, userId: r.userId, iceServers: r.iceServers });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось подключиться');
    } finally {
      setBusy(false);
    }
  }

  if (admission) {
    return (
      <CallPanel
        meetingId={admission.roomId}
        guest={{ token: admission.token, iceServers: admission.iceServers, userId: admission.userId }}
        onClose={() => setAdmission(null)}
      />
    );
  }

  return (
    <div className="center-screen">
      <form className="card auth-card" onSubmit={submit}>
        <div className="brand auth-brand">TEAM<span>CRM</span></div>

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
