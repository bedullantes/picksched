import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, ApiError } from '../api/client';
import type { Role, User } from '../api/types';

interface AuthState {
  user: User | null;
  /** True until the initial session check finishes. */
  checking: boolean;
  /** Set when the session check failed for a reason other than "not signed in". */
  checkError: ApiError | null;
  retryCheck: () => void;
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string, role: Role, phone?: string) => Promise<void>;
  /** Sets or clears (empty string) the mobile number for SMS confirmations. */
  updatePhone: (phone: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [checking, setChecking] = useState(true);
  const [checkError, setCheckError] = useState<ApiError | null>(null);

  const check = useCallback(async () => {
    setChecking(true);
    setCheckError(null);
    try {
      setUser((await api<{ user: User }>('/api/auth/me')).user);
    } catch (err) {
      setUser(null);
      if (err instanceof ApiError && err.status !== 401) setCheckError(err);
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    void check();
  }, [check]);

  const value = useMemo<AuthState>(() => ({
    user,
    checking,
    checkError,
    retryCheck: () => void check(),
    async login(email, password) {
      setUser((await api<{ user: User }>('/api/auth/login', { method: 'POST', body: { email, password } })).user);
    },
    async register(email, password, role, phone) {
      setUser((await api<{ user: User }>('/api/auth/register', {
        method: 'POST', body: { email, password, role, ...(phone?.trim() ? { phone } : {}) },
      })).user);
    },
    async updatePhone(phone) {
      setUser((await api<{ user: User }>('/api/auth/me', { method: 'PATCH', body: { phone } })).user);
    },
    async logout() {
      await api('/api/auth/logout', { method: 'POST' }).catch(() => undefined);
      setUser(null);
    },
  }), [user, checking, checkError, check]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
