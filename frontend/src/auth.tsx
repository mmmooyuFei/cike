import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { api } from "./api";
import type { SessionData } from "./types";

type AuthContextValue = {
  session: SessionData;
  loading: boolean;
  loginDev: (role: "admin" | "user") => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
};

const emptySession: SessionData = { user: null, is_admin: false, modules: [] };
const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<SessionData>(emptySession);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    const data = await api.get<SessionData>("/auth/session");
    setSession(data);
  }, []);

  useEffect(() => {
    refresh()
      .catch(() => setSession(emptySession))
      .finally(() => setLoading(false));
  }, [refresh]);

  const loginDev = useCallback(async (role: "admin" | "user") => {
    await api.post("/auth/dev-login", { role });
    await refresh();
  }, [refresh]);

  const logout = useCallback(async () => {
    // RP-initiated logout：结束本站会话，并让 IdP 结束 SSO 会话。
    window.location.href = "/api/auth/oidc/logout";
  }, []);

  return (
    <AuthContext.Provider value={{ session, loading, loginDev, logout, refresh }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error("useAuth must be used inside AuthProvider");
  return value;
}
