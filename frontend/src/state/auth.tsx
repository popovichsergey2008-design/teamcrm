import { createContext, useContext, useEffect, useState, ReactNode } from 'react';
import { api, SIGNED_OUT_EVENT, tokens } from '../lib/api';
import { disconnectSocket } from '../lib/socket';
import { forgetRegisteredDevice, registeredDeviceId } from '../hooks/useDeviceRegistration';
import { isMfaChallenge, type AuthResult, type LoginResponse, type OrgRef, type User } from '../types';

interface AuthState {
  user: User | null;
  organizations: OrgRef[];
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (b: { tenantName: string; email: string; password: string; fullName: string; acceptPrivacy: boolean; website?: string }) => Promise<void>;
  /** Принять ответ входа: так заходят через Google и Telegram — пароля там нет. */
  applySession: (r: LoginResponse) => void;
  /** Пароль принят, ждём код второго фактора — экран входа показывает поле для кода. */
  mfaPending: boolean;
  completeMfa: (code: string) => Promise<void>;
  cancelMfa: () => void;
  logout: () => Promise<void>;
  switchOrg: (tenantId: string) => Promise<void>;
  createOrg: (name: string) => Promise<void>;
  /** Переименовать текущее пространство (только создатель): панель обновится сразу. */
  renameOrg: (name: string) => Promise<void>;
}

const Ctx = createContext<AuthState | null>(null);

/** #4619: почему не сработала ссылка входа из Telegram-бота — экран входа покажет. */
export let authNotice = '';

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [organizations, setOrganizations] = useState<OrgRef[]>([]);
  const [loading, setLoading] = useState(true);
  /** Токен второго шага: живёт только в памяти, пять минут — на ввод шести цифр. */
  const [mfaToken, setMfaToken] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    (async () => {
      // вход из Telegram-бота: код одноразовый — сразу убираем его из адреса и истории
      const tg = new URLSearchParams(location.search).get('tglogin');
      if (tg) {
        history.replaceState(history.state, '', location.pathname);
        try {
          const r = await api.telegramCode(tg);
          if (isMfaChallenge(r)) setMfaToken(r.mfaToken);
          else tokens.set(r.accessToken, r.refreshToken);
        } catch (e) { authNotice = (e as Error).message; }
      }
      if (tokens.access) {
        try {
          const me = await api.me();
          if (active) {
            setUser(me);
            api.organizations().then((o) => active && setOrganizations(o)).catch(() => undefined);
          }
        } catch {
          tokens.clear();
        }
      }
      if (active) setLoading(false);
    })();
    return () => {
      active = false;
    };
  }, []);

  /**
   * Сессия кончилась во время работы.
   *
   * Раньше в этот момент человек видел поверх интерфейса английскую «Invalid or expired
   * token» и оставался в приложении, где ничего не грузится. Возвращаем на экран входа:
   * это единственное, что он может сделать.
   */
  useEffect(() => {
    const onSignedOut = () => { setUser(null); setOrganizations([]); };
    window.addEventListener(SIGNED_OUT_EVENT, onSignedOut);
    return () => window.removeEventListener(SIGNED_OUT_EVENT, onSignedOut);
  }, []);

  const take = (r: AuthResult) => {
    setMfaToken(null);
    tokens.set(r.accessToken, r.refreshToken);
    setUser(r.user);
    setOrganizations(r.organizations ?? []);
  };

  const applySession = (r: LoginResponse) => {
    if (isMfaChallenge(r)) setMfaToken(r.mfaToken);
    else take(r);
  };

  const login = async (email: string, password: string) => applySession(await api.login({ email, password }));

  const completeMfa = async (code: string) => {
    if (!mfaToken) throw new Error('Войдите заново');
    take(await api.loginMfa(mfaToken, code));
  };

  const register = async (b: { tenantName: string; email: string; password: string; fullName: string; acceptPrivacy: boolean; website?: string }) => {
    const r = await api.register(b);
    tokens.set(r.accessToken, r.refreshToken);
    setUser(r.user);
    setOrganizations(r.organizations ?? []);
  };

  const switchOrg = async (tenantId: string) => {
    const r = await api.switchOrg(tenantId);
    tokens.set(r.accessToken, r.refreshToken);
    disconnectSocket(); // переподключим сокет под новый токен/организацию
    setUser(r.user);
  };

  const createOrg = async (name: string) => {
    const r = await api.createOrg(name);
    tokens.set(r.accessToken, r.refreshToken);
    disconnectSocket();
    setUser(r.user);
    api.organizations().then(setOrganizations).catch(() => undefined);
  };

  const renameOrg = async (name: string) => {
    const r = await api.renameOrg(name);
    setOrganizations((list) => list.map((o) => (o.tenantId === r.tenantId ? { ...o, name: r.name } : o)));
  };

  const logout = async () => {
    // Телефон снимается с учёта до выхода: после выхода токена уже нет (ТЗ-9)
    const device = registeredDeviceId();
    if (device) { await api.unregisterDevice(device).catch(() => undefined); forgetRegisteredDevice(); }
    try {
      await api.logout();
    } catch {
      /* ignore */
    }
    tokens.clear();
    disconnectSocket();
    setUser(null);
    setOrganizations([]);
  };

  return (
    <Ctx.Provider value={{
      user, organizations, loading, login, register, applySession, logout, switchOrg, createOrg, renameOrg,
      mfaPending: !!mfaToken, completeMfa, cancelMfa: () => setMfaToken(null),
    }}>
      {children}
    </Ctx.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
