import { useEffect, useState } from 'react';
import { ApiError } from '../../lib/api';
import { navigate } from '../../lib/router';
import { Icon } from '../Icon';
import { mailApi } from './mail-api';
import type { MailFirstSummary, MailOAuthProvider, MailOAuthProviderId } from './mail-api';
import './mail-connect.css';

/** Порядок кнопок: в России чаще Яндекс, потом Google и Mail.ru. */
const BUTTONS: { id: MailOAuthProviderId; title: string }[] = [
  { id: 'yandex', title: 'Яндекс' },
  { id: 'google', title: 'Google' },
  { id: 'mailru', title: 'Mail.ru' },
];

/** Что пришло в адресе после возврата от почтовика (сервер кладёт mail_connected, resume, mail_error). */
export interface MailReturn { connected: boolean; resume: string | null; error: string | null }

/** Прочитать итог входа из адреса. Ничего не пришло — null. */
export function readMailReturn(search: string = window.location.search): MailReturn | null {
  const q = new URLSearchParams(search);
  const v = q.get('mail_connected');
  if (v === null) return null;
  return { connected: v === '1', resume: q.get('resume') || null, error: q.get('mail_error') || null };
}

/**
 * Убрать итог входа из адреса: иначе обновление страницы снова выполнит просьбу и
 * снова покажет «подключено». replaceState — шаг в историю класть незачем.
 */
export function clearMailReturn(): void {
  const u = new URL(window.location.href);
  ['mail_connected', 'mail_error', 'resume'].forEach((k) => u.searchParams.delete(k));
  window.history.replaceState(window.history.state, '', u.pathname + u.search + u.hash);
}

/**
 * Первый итог по ящику: сразу после входа письма ещё забираются — спрашиваем несколько
 * раз с паузой, пока сервер не скажет, что первый забор прошёл (pending = false).
 */
export async function waitFirstSummary(tries = 8, pauseMs = 2500): Promise<MailFirstSummary | null> {
  for (let i = 0; i < tries; i++) {
    const s = await mailApi.firstSummary().catch(() => null);
    if (s && !s.pending) return s;
    if (i < tries - 1) await new Promise((r) => setTimeout(r, pauseMs));
  }
  return mailApi.firstSummary().catch(() => null);
}

/**
 * «Подключите почту — 20 секунд, без пароля» (#4893, п. 2).
 *
 * Если для просьбы нужна почта, бот показывает эту карточку вместо инструкции: кнопка
 * почтовика → его экран входа → обратно в QEVO, и бот сам выполняет исходную просьбу
 * (resume уходит через сервер в адрес возврата). Пароль приложения — только в «Другая почта».
 */
export function MailConnectCard({ resume, onConnected, from = 'bot', onOtherMail }: {
  /** Исходная просьба человека: после входа бот выполнит её сам, повторять не нужно. */
  resume?: string;
  /** Вход прошёл (карточка открыта на возврате с mail_connected=1) — с первым итогом, если он уже есть. */
  onConnected?: (summary: MailFirstSummary | null) => void;
  /** Куда вернуть после входа: в чат бота (по умолчанию) или в «Настройки → Почта». */
  from?: 'bot' | 'settings';
  /** «Другая почта»: по умолчанию — форма с паролем приложения в «Настройки → Почта». */
  onOtherMail?: () => void;
}) {
  const [providers, setProviders] = useState<MailOAuthProvider[] | null>(null);
  const [busy, setBusy] = useState<MailOAuthProviderId | null>(null);
  const [note, setNote] = useState('');
  const [back] = useState(() => readMailReturn());
  const [summary, setSummary] = useState<MailFirstSummary | null>(null);

  useEffect(() => {
    void mailApi.oauthProviders().then(setProviders).catch(() => setProviders([]));
  }, []);

  // Карточку открыли на возврате от почтовика: показываем итог и сообщаем наверх один раз
  useEffect(() => {
    if (!back?.connected) return;
    let alive = true;
    void waitFirstSummary().then((s) => {
      if (!alive) return;
      setSummary(s);
      onConnected?.(s);
    });
    return () => { alive = false; };
    // onConnected — колбэк родителя, повторно звать его на каждый рендер нельзя
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [back]);

  const other = () => {
    if (onOtherMail) onOtherMail();
    else navigate('/settings/mail?other=1');
  };

  const start = async (id: MailOAuthProviderId, title: string) => {
    setNote('');
    // ключей приложения нет на сервере — кнопку всё равно показываем, но честно объясняем
    if (providers && !providers.find((p) => p.id === id)?.configured) {
      setNote(`Вход через ${title} ещё не включён администратором. Пока можно подключить ящик через «Другая почта».`);
      return;
    }
    setBusy(id);
    try {
      const { url } = await mailApi.oauthStart(id, { resume, from });
      // весь браузер, а не окно: в приложении и на телефоне всплывающие окна режутся
      window.location.assign(url);
    } catch (e) {
      setNote(e instanceof ApiError ? e.message : 'Не удалось открыть вход — попробуйте ещё раз');
      setBusy(null);
    }
  };

  if (back?.connected) {
    return (
      <div className="mail-connect" role="status">
        <p className="mail-connect-done"><Icon name="check-circle" size={18} /> Почта подключена</p>
        <p className="mail-connect-sum">{summary ? summary.text : 'Разбираю письма…'}</p>
      </div>
    );
  }

  return (
    <div className="mail-connect">
      <p className="mail-connect-title"><Icon name="mail" size={18} /> Подключите почту — 20 секунд, без пароля</p>
      <p className="mail-connect-sub">Войдите в свой ящик — секретарь сразу разберёт письма{resume ? ' и выполнит вашу просьбу' : ''}.</p>
      {back && !back.connected && <p className="error-text mail-connect-note">{back.error || 'Подключить не получилось — попробуйте ещё раз'}</p>}
      <div className="mail-connect-row">
        {BUTTONS.map((b) => (
          <button
            key={b.id}
            className={`ui-btn ui-btn-md ${b.id === 'yandex' ? 'ui-btn-primary' : 'ui-btn-secondary'}`}
            disabled={!!busy}
            onClick={() => { void start(b.id, b.title); }}
          >
            {busy === b.id ? 'Открываю…' : b.title}
          </button>
        ))}
      </div>
      {note && <p className="mail-connect-note">{note}</p>}
      <button className="ui-btn ui-btn-link ui-btn-sm mail-connect-other" onClick={other}>Другая почта</button>
    </div>
  );
}
