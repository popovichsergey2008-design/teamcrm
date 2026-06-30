import { createContext, useContext, useEffect, useState, ReactNode } from 'react';
import { api, tokens } from '../lib/api';
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
    <Ctx.Provider value={{ user, organizations, loading, login, register, logout, switchOrg, createOrg }}>
      {children}
    </Ctx.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
