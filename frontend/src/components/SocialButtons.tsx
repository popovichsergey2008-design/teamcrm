import { useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../state/auth';
import type { AuthProviders, SocialAuthResult } from '../types';

/**
 * Вход через Google и Telegram (ТЗ-11, разд. 11-12).
 *
 * Ничего не рисуется, пока сервер не скажет, что провайдер настроен. Ключи появятся
 * после переезда на новый домен — до тех пор экран входа выглядит ровно как сегодня, и
 * чужие скрипты в страницу не грузятся.
 */

declare global {
  interface Window {
    google?: any;
    onTelegramAuth?: (user: Record<string, string>) => void;
  }
}

const GOOGLE_SDK = 'https://accounts.google.com/gsi/client';

/** Один тег на документ: экран входа могут открыть и закрыть несколько раз. */
function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const have = document.querySelector<HTMLScriptElement>(`script[src="${src}"]`);
    if (have) {
      if (have.dataset.ready === '1') resolve();
      else have.addEventListener('load', () => resolve());
      have.addEventListener('error', () => reject(new Error('не загрузился')));
      return;
    }
    const el = document.createElement('script');
    el.src = src;
    el.async = true;
    el.onload = () => { el.dataset.ready = '1'; resolve(); };
    el.onerror = () => reject(new Error('не загрузился'));
    document.head.appendChild(el);
  });
}

export function SocialButtons() {
  const { applySession } = useAuth();
  const [providers, setProviders] = useState<AuthProviders | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  /* Человек пришёл впервые: сервер вернул needsWorkspace, и мы спрашиваем название. */
  const [pending, setPending] = useState<{ idToken: string; email: string } | null>(null);
  const [tenantName, setTenantName] = useState('');
  const googleBox = useRef<HTMLDivElement>(null);
  const tgBox = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    api.authProviders()
      .then((p) => alive && setProviders(p))
      // Ручка новая: на старом сервере её может не быть — молча живём без кнопок.
      .catch(() => alive && setProviders(null));
    return () => { alive = false; };
  }, []);

  function accept(r: SocialAuthResult, idToken: string) {
    // Адрес берём из ответа: человека, который только что пришёл, надо показать ему
    // самому — под каким именно аккаунтом он заводит организацию.
    if ('needsWorkspace' in r) setPending({ idToken, email: r.email });
    else applySession(r);
  }

  function fail(e: unknown) {
    setError(e instanceof ApiError ? e.message : 'Войти не получилось');
  }

  /*
    Чужие кнопки рисуются один раз и держат нашу функцию обратного вызова у себя. Если
    подписку пересобирать на каждый наш рендер, кнопка будет мигать, а у Google — ещё и
    заново ходить за своим скриптом. Поэтому свежие обработчики кладём в ref, а эффекты
    зависят только от набора провайдеров.
  */
  const now = useRef({ accept, applySession, fail });
  now.current = { accept, applySession, fail };

  // ── Google ──
  useEffect(() => {
    if (!providers?.google || !providers.googleClientId || !googleBox.current) return;
    let alive = true;
    loadScript(GOOGLE_SDK).then(() => {
      if (!alive || !window.google || !googleBox.current) return;
      window.google.accounts.id.initialize({
        client_id: providers.googleClientId,
        callback: async (res: { credential: string }) => {
          setError('');
          setBusy(true);
          try {
            now.current.accept(await api.googleLogin(res.credential), res.credential);
          } catch (e) { now.current.fail(e); } finally { setBusy(false); }
        },
      });
      window.google.accounts.id.renderButton(googleBox.current, {
        theme: 'outline', size: 'large', width: 280, locale: 'ru', text: 'continue_with',
      });
    }).catch(() => alive && setError('Google не загрузился'));
    return () => { alive = false; };
  }, [providers]);

  // ── Telegram ──
  useEffect(() => {
    if (!providers?.telegram || !providers.telegramBot || !tgBox.current) return;
    const box = tgBox.current;
    window.onTelegramAuth = async (user) => {
      setError('');
      setBusy(true);
      try {
        // Telegram почты не даёт, поэтому needsWorkspace тут не бывает — сервер
        // отправит привязываться в профиле, и это будет видно в тексте ошибки.
        const r = await api.telegramLogin(user);
        if (!('needsWorkspace' in r)) now.current.applySession(r);
      } catch (e) { now.current.fail(e); } finally { setBusy(false); }
    };
    const el = document.createElement('script');
    el.src = 'https://telegram.org/js/telegram-widget.js?22';
    el.async = true;
    el.setAttribute('data-telegram-login', providers.telegramBot);
    el.setAttribute('data-size', 'large');
    el.setAttribute('data-radius', '8');
    el.setAttribute('data-onauth', 'onTelegramAuth(user)');
    el.setAttribute('data-request-access', 'write');
    box.appendChild(el);
    return () => {
      box.innerHTML = '';
      delete window.onTelegramAuth;
    };
  }, [providers]);

  async function createWorkspace() {
    if (!pending || tenantName.trim().length < 2) return;
    setError('');
    setBusy(true);
    try {
      const r = await api.googleLogin(pending.idToken, tenantName.trim());
      if (!('needsWorkspace' in r)) applySession(r);
    } catch (e) { fail(e); } finally { setBusy(false); }
  }

  if (!providers || (!providers.google && !providers.telegram)) return null;

  if (pending) {
    return (
      /* Не форма: эта разметка живёт внутри формы входа, а форму в форму вкладывать нельзя. */
      <div className="social-block">
        <div className="dim social-sep"><span>{pending.email}</span></div>
        <div className="field">
          <label>Как называется ваша организация?</label>
          <input
            className="input"
            value={tenantName}
            onChange={(ev) => setTenantName(ev.target.value)}
            minLength={2}
            autoFocus
            onKeyDown={(ev) => { if (ev.key === 'Enter') { ev.preventDefault(); void createWorkspace(); } }}
          />
        </div>
        <div className="error-text">{error}</div>
        <button
          className="ui-btn ui-btn-primary ui-btn-md auth-submit"
          disabled={busy || tenantName.trim().length < 2}
          type="button"
          onClick={() => void createWorkspace()}
        >
          {busy ? '...' : 'Создать'}
        </button>
      </div>
    );
  }

  return (
    <div className="social-block">
      <div className="dim social-sep"><span>или</span></div>
      {providers.google && <div ref={googleBox} className="social-btn" />}
      {providers.telegram && <div ref={tgBox} className="social-btn" />}
      <div className="error-text">{error}</div>
    </div>
  );
}
