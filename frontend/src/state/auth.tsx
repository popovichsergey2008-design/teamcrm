import { createContext, useContext, useEffect, useState, ReactNode } from 'react';
import { api, tokens } from '../lib/api';
import { disconnectSocket } from '../lib/socket';
import type { User } from '../types';

interface AuthState {
  user: User | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (b: { tenantName: string; email: string; password: string; fullName: string }) => Promise<void>;
  logout: () => Promise<void>;
}

const Ctx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    (async () => {
      if (tokens.access) {
        try {
          const me = await api.me();
          if (active) setUser(me);
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
  };

  const register = async (b: { tenantName: string; email: string; password: string; fullName: string }) => {
    const r = await api.register(b);
    tokens.set(r.accessToken, r.refreshToken);
    setUser(r.user);
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
  };

  return <Ctx.Provider value={{ user, loading, login, register, logout }}>{children}</Ctx.Provider>;
}

export function useAuth() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
