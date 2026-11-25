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
    // 退出后不要在本标签页立刻自动 SSO 回来；用户主动点击登录时再清除。
    sessionStorage.setItem("cike_skip_auto_login", "1");
    try {
      await api.post("/auth/logout");
    } finally {
      setSession(emptySession);
    }
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
