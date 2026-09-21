import { createContext, useContext, useEffect, useState, ReactNode } from 'react';
import { api, SIGNED_OUT_EVENT, tokens } from '../lib/api';
import { disconnectSocket } from '../lib/socket';
import type { OrgRef, User } from '../types';

interface AuthState {
  user: User | null;
  organizations: OrgRef[];
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (b: { tenantName: string; email: string; password: string; fullName: string }) => Promise<void>;
  logout: () => Promise<void>;
  switchOrg: (tenantId: string) => Promise<void>;
  createOrg: (name: string) => Promise<void>;
  /** Переименовать текущее пространство (только создатель): панель обновится сразу. */
  renameOrg: (name: string) => Promise<void>;
}

const Ctx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [organizations, setOrganizations] = useState<OrgRef[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    (async () => {
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

  const login = async (email: string, password: string) => {
    const r = await api.login({ email, password });
    tokens.set(r.accessToken, r.refreshToken);
    setUser(r.user);
    setOrganizations(r.organizations ?? []);
  };

  const register = async (b: { tenantName: string; email: string; password: string; fullName: string }) => {
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
    <Ctx.Provider value={{ user, organizations, loading, login, register, logout, switchOrg, createOrg, renameOrg }}>
      {children}
    </Ctx.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
