import { useEffect, useMemo, useState } from "react";
import { api, errorText } from "./api";
import { useAuth } from "./auth";
import { LogoMark, Picker, RecordForm, ReviewForm, Sheet } from "./components";
import { Access } from "./pages/Access";
import { Account } from "./pages/Account";
import { Dashboard } from "./pages/Dashboard";
import { ModulePage } from "./pages/Modules";
import { Todos } from "./pages/Todos";
import type { AppContextValue, Brand, RecordItem } from "./types";

type NavItem = {
  key: string;
  label: string;
  group: string;
  title: string;
  sub: string;
  module?: string;
  admin?: boolean;
};

const NAV: NavItem[] = [
  { key: "dashboard", label: "驾驶舱", group: "今天", title: "今天要推进什么？", sub: "先看一眼今天的量，做了多少记多少。", module: "dashboard" },
  { key: "todos", label: "待办", group: "今天", title: "今天要处理什么？", sub: "没做完的会一直留在这里提醒你。", module: "todos" },
  { key: "milestones", label: "里程碑", group: "推进", title: "这一年想做成什么？", sub: "只写真正在乎的，五件起。", module: "milestones" },
  { key: "daily", label: "每日日志", group: "记录", title: "今天怎么样？", sub: "三个框：今天做了什么、明天打算、卡在哪。", module: "daily" },
  { key: "sleep", label: "睡眠", group: "记录", title: "昨晚睡得怎么样？", sub: "凌晨 0–6 点的睡前打卡自动归到前一天。", module: "sleep" },
  { key: "focus", label: "专注学习", group: "记录", title: "这段时间在做什么？", sub: "一段一记，45 分钟起算。", module: "focus" },
  { key: "workouts", label: "健身", group: "记录", title: "这个月练了几次？", sub: "一周三次就够，别追满勤。", module: "workouts" },
  { key: "money", label: "资金", group: "钱", title: "这个月钱多了还是少了？", sub: "按账户记：月底填期初和期末。", module: "money" },
  { key: "account", label: "账号设置", group: "个人", title: "账号设置", sub: "管理资料、安全与访问范围。", module: "account" },
  { key: "access", label: "权限管理", group: "个人", title: "权限管理", sub: "按 Casdoor 角色 / 群组限制模块可见与可编辑。", admin: true },
];

function dateLabel(): string {
  const now = new Date();
  const week = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
  return `${now.getMonth() + 1} 月 ${now.getDate()} 日 · ${week[now.getDay()]}`;
}

function readHash(): string {
  return window.location.hash.replace(/^#/, "") || "dashboard";
}

export default function App() {
  const { session, loading, loginDev, logout, refresh: refreshSession } = useAuth();
  const [route, setRoute] = useState(readHash);
  const [refreshKey, setRefreshKey] = useState(0);
  const [brand, setBrand] = useState<Brand>({ name: "此刻", logo_url: "" });
  const [sheet, setSheet] = useState<
    | null
    | { kind: "picker" }
    | { kind: "form"; module: string; item?: RecordItem }
    | { kind: "review" }
  >(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [toastState, setToastState] = useState<{ message: string; action?: { label: string; run: () => void } } | null>(null);
  const [loginMode, setLoginMode] = useState<{ dev_auth: boolean; oidc: boolean } | null>(null);

  const toast = (message: string, action?: { label: string; run: () => void }) => setToastState({ message, action });

  const loadBrand = async () => {
    try {
      setBrand(await api.get<Brand>("/settings/brand"));
    } catch {
      /* keep default */
    }
  };

  const refresh = () => {
    setRefreshKey((value) => value + 1);
    void refreshSession();
    void loadBrand();
  };

  useEffect(() => {
    void loadBrand();
  }, []);

  useEffect(() => {
    if (!toastState) return;
    const timer = window.setTimeout(() => setToastState(null), toastState.action ? 6000 : 2400);
    return () => window.clearTimeout(timer);
  }, [toastState]);

  useEffect(() => {
    document.title = `${brand.name} · 个人工作台`;
  }, [brand.name]);

  useEffect(() => {
    api.get<{ dev_auth: boolean; oidc: boolean }>("/auth/login-mode").then(setLoginMode).catch(() => setLoginMode({ dev_auth: false, oidc: false }));
  }, []);

  useEffect(() => {
    const onHash = () => setRoute(readHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPaletteOpen((open) => !open);
      }
      if (event.key === "Escape") {
        setPaletteOpen(false);
        setMoreOpen(false);
        setSheet(null);
      }
      if (!event.metaKey && !event.ctrlKey && event.key === "n" && !(event.target as HTMLElement)?.closest("input,textarea,select")) {
        event.preventDefault();
        setSheet({ kind: "picker" });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const allowed = useMemo(() => {
    if (!session.user) return new Set<string>();
    const keys = NAV.filter((item) => {
      if (item.admin && !session.is_admin) return false;
      if (item.module && item.module !== "account" && !session.modules.includes(item.module)) return false;
      return true;
    }).map((item) => item.key);
    return new Set(keys);
  }, [session]);

  const defaultRoute = session.modules.includes("dashboard") ? "dashboard" : session.modules[0] || "account";

  useEffect(() => {
    if (!session.user) return;
    if (!allowed.has(route)) {
      window.location.hash = defaultRoute;
    }
  }, [allowed, defaultRoute, route, session.user]);

  if (loading) {
    return <div className="boot">正在载入…</div>;
  }

  if (!session.user) {
    return <Login brand={brand} mode={loginMode} onDevLogin={loginDev} />;
  }

  const go = (key: string) => {
    if (!allowed.has(key)) return;
    window.location.hash = key;
    setPaletteOpen(false);
    setMoreOpen(false);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const openForm = (module: string, item?: RecordItem) => {
    setSheet({ kind: "form", module, item });
  };

  const openReview = () => setSheet({ kind: "review" });

  const closeSheet = () => setSheet(null);

  const ctx: AppContextValue = {
    session,
    brand,
    refreshKey,
    refresh,
    toast,
    openForm,
    openReview,
  };

  const meta = NAV.find((item) => item.key === route) || NAV[0];
  const visibleNav = NAV.filter((item) => allowed.has(item.key));
  const groups = Array.from(new Set(visibleNav.map((item) => item.group)));
  const mobileKeys = ["dashboard", "todos", "focus", "money"];

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          {brand.logo_url ? <img className="brand-logo" src={brand.logo_url} alt="" /> : <LogoMark />}
          <div>
            <b>{brand.name}</b>
            <small>个人工作台</small>
          </div>
        </div>
        <nav className="nav-list">
          {groups.map((group) => (
            <div className="nav-group" key={group}>
              <div className="nav-cap">{group}</div>
              {visibleNav.filter((item) => item.group === group).map((item) => (
                <button
                  type="button"
                  key={item.key}
                  className={`nav-item ${route === item.key ? "on" : ""}`}
                  onClick={() => go(item.key)}
                >
                  <span className="dot" />
                  {item.label}
                </button>
              ))}
            </div>
          ))}
        </nav>
        <div className="nav-foot">
          <span className="pulse" />
          <span>{session.is_admin ? "站点管理员" : "个人账号"}</span>
        </div>
        <button type="button" className="account-chip" onClick={() => go("account")}>
          <span className="avatar">{(session.user.display_name || "此").slice(0, 1)}</span>
          <span>
            {session.user.display_name}
            <small>{session.user.username}</small>
          </span>
        </button>
      </aside>

      <main className="main">
        <div className="mobile-head">
          <div className="mobile-brand">
            {brand.logo_url ? <img className="brand-logo" src={brand.logo_url} alt="" /> : <LogoMark size={30} />}
            <div>
              <b>{brand.name}</b>
              <small>个人工作台</small>
            </div>
          </div>
          <div className="btn-row">
            <button type="button" onClick={() => setPaletteOpen(true)}>⌘K</button>
            <button type="button" className="primary" onClick={() => setSheet({ kind: "picker" })}>＋ 记一笔</button>
          </div>
        </div>

        <div className="topbar">
          <div>
            <div className="eyebrow">{meta.group} · {dateLabel()}</div>
            <h1>{meta.title}</h1>
            <p>{meta.sub}</p>
          </div>
          <div className="actions">
            <span className="sync-inline"><i />已登录</span>
            <button type="button" className="ghost" onClick={() => setPaletteOpen(true)}>⌘K</button>
            <button type="button" className="primary" onClick={() => setSheet({ kind: "picker" })}>＋ 记一笔</button>
          </div>
        </div>

        {route === "dashboard" ? <Dashboard ctx={ctx} /> : null}
        {route === "todos" ? <Todos ctx={ctx} /> : null}
        {["milestones", "daily", "sleep", "focus", "workouts", "money"].includes(route) ? <ModulePage module={route} ctx={ctx} /> : null}
        {route === "account" ? <Account ctx={ctx} /> : null}
        {route === "access" && session.is_admin ? <Access ctx={ctx} /> : null}

        <p className="prototype-note">此刻 · 个人工作台 · 数据按登录用户隔离</p>
      </main>

      <nav className="tabbar">
        {mobileKeys.filter((key) => allowed.has(key)).map((key) => {
          const item = NAV.find((entry) => entry.key === key)!;
          return (
            <button type="button" key={key} className={`tab ${route === key ? "on" : ""}`} onClick={() => go(key)}>
              <i>{key === "dashboard" ? "◎" : key === "todos" ? "✓" : key === "focus" ? "◐" : "¥"}</i>
              <span>{item.label === "驾驶舱" ? "今天" : item.label}</span>
            </button>
          );
        })}
        <button type="button" className="tab" onClick={() => setMoreOpen(true)}>
          <i>⋯</i>
          <span>更多</span>
        </button>
      </nav>

      {moreOpen ? (
        <div className="more-back" onClick={() => setMoreOpen(false)}>
          <div className="more-panel" onClick={(event) => event.stopPropagation()}>
            <div className="more-head">
              <h3>去哪个板块？</h3>
              <button type="button" onClick={() => setMoreOpen(false)}>关闭</button>
            </div>
            {visibleNav.filter((item) => !mobileKeys.includes(item.key)).map((item) => (
              <button type="button" className="pick" key={item.key} onClick={() => go(item.key)}>
                <b>{item.label}</b>
                <span>{item.title}</span>
              </button>
            ))}
          </div>
        </div>
      ) : null}

      <Sheet
        open={Boolean(sheet)}
        title={sheet?.kind === "picker" ? "记一笔" : sheet?.kind === "review" ? "本周回顾" : sheet ? `新增 · ${labelOf(sheet.module)}` : ""}
        sub={sheet?.kind === "picker" ? "选一类，填两三个空就够" : sheet?.kind === "review" ? "3 个问题，5 分钟" : ""}
        onClose={closeSheet}
      >
        {sheet?.kind === "picker" ? <Picker onPick={(module) => setSheet({ kind: "form", module })} /> : null}
        {sheet?.kind === "form" ? (
          <RecordForm
            module={sheet.module}
            item={sheet.item}
            onCancel={closeSheet}
            onError={(message) => toast(message)}
            onDone={(message) => {
              closeSheet();
              toast(message);
              refresh();
            }}
          />
        ) : null}
        {sheet?.kind === "review" ? (
          <ReviewForm
            onCancel={closeSheet}
            onError={(message) => toast(message)}
            onDone={(message) => {
              closeSheet();
              toast(message);
              refresh();
            }}
          />
        ) : null}
      </Sheet>

      {paletteOpen ? (
        <Palette
          onClose={() => setPaletteOpen(false)}
          nav={visibleNav}
          onGo={go}
          onNew={() => {
            setPaletteOpen(false);
            setSheet({ kind: "picker" });
          }}
          onReview={() => {
            setPaletteOpen(false);
            setSheet({ kind: "review" });
          }}
          onExport={() => window.open("/api/export", "_blank")}
          onAccess={() => go("access")}
          isAdmin={session.is_admin}
        />
      ) : null}

      {toastState ? (
        <div className="toast" role="status">
          <span>{toastState.message}</span>
          {toastState.action ? (
            <button type="button" onClick={() => { toastState.action?.run(); setToastState(null); }}>
              {toastState.action.label}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function labelOf(module: string): string {
  return (
    {
      todos: "待办",
      milestones: "里程碑",
      daily: "每日日志",
      sleep: "睡眠",
      focus: "专注学习",
      workouts: "健身",
      money: "月度余额",
    } as Record<string, string>
  )[module] || module;
}

function Login({
  brand,
  mode,
  onDevLogin,
}: {
  brand: Brand;
  mode: { dev_auth: boolean; oidc: boolean } | null;
  onDevLogin: (role: "admin" | "user") => Promise<void>;
}) {
  const [error, setError] = useState("");
  const params = new URLSearchParams(window.location.search);
  const loginError = params.get("login_error");
  const loginErrorText: Record<string, string> = {
    oidc_code_expired: "登录凭证已失效，请重新点击登录",
    oidc_state_invalid: "登录状态已过期，请重试",
    oidc_token_exchange_failed: "登录服务暂时不可用，请重试",
    oidc_discovery_failed: "无法连接统一登录服务",
  };
  useEffect(() => {
    if (loginError) setError(loginErrorText[loginError] || `登录失败：${loginError}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loginError]);

  const dev = async (role: "admin" | "user") => {
    setError("");
    try {
      await onDevLogin(role);
    } catch (err) {
      setError(errorText(err));
    }
  };

  return (
    <div className="login">
      <div className="login-card">
        <div className="brand big">
          <LogoMark size={44} />
          <div>
            <b>{brand.name}</b>
            <small>个人工作台</small>
          </div>
        </div>
        <h1>先记下此刻。</h1>
        <p>待办、日志、睡眠、专注、健身与资金，按天收好；数据只属于登录的人。</p>
        {error ? <div className="login-error">{error}</div> : null}
        {mode?.dev_auth ? (
          <div className="dev-login">
            <div className="muted">本地开发身份切换器</div>
            <button type="button" className="primary" onClick={() => void dev("admin")}>以管理员进入</button>
            <button type="button" onClick={() => void dev("user")}>以普通用户进入</button>
            <div className="tip">生产环境会关闭这个入口，改走 Casdoor OIDC。</div>
          </div>
        ) : mode?.oidc ? (
          <a className="primary btn" href="/api/auth/oidc/login">使用 Casdoor 登录</a>
        ) : (
          <div className="login-error">未配置登录方式，请检查服务端 OIDC 配置。</div>
        )}
      </div>
    </div>
  );
}

function Palette({
  onClose,
  nav,
  onGo,
  onNew,
  onReview,
  onExport,
  onAccess,
  isAdmin,
}: {
  onClose: () => void;
  nav: NavItem[];
  onGo: (key: string) => void;
  onNew: () => void;
  onReview: () => void;
  onExport: () => void;
  onAccess: () => void;
  isAdmin: boolean;
}) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const actions = [
    ...nav.map((item) => ({ label: item.label, hint: item.group, run: () => onGo(item.key) })),
    { label: "记一笔", hint: "n", run: onNew },
    { label: "本周回顾", hint: "5 min", run: onReview },
    { label: "导出数据", hint: "JSON", run: onExport },
    ...(isAdmin ? [{ label: "权限管理", hint: "admin", run: onAccess }] : []),
  ];
  const visible = actions.filter((item) => !query || item.label.includes(query) || item.hint.includes(query));
  const current = Math.min(index, Math.max(0, visible.length - 1));

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setIndex((value) => Math.min(value + 1, visible.length - 1));
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        setIndex((value) => Math.max(value - 1, 0));
      } else if (event.key === "Enter") {
        event.preventDefault();
        visible[current]?.run();
        onClose();
      } else if (event.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [current, onClose, visible]);

  return (
    <div className="palette-back" onMouseDown={onClose}>
      <div className="palette" onMouseDown={(event) => event.stopPropagation()}>
        <input
          autoFocus
          placeholder="搜索页面、动作…"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setIndex(0);
          }}
        />
        <div className="palette-list">
          {visible.length === 0 ? <div className="empty small"><b>没有匹配的入口</b><p>换个关键词试试。</p></div> : null}
          {visible.map((item, position) => (
            <button
              type="button"
              className={`p-item ${position === current ? "on" : ""}`}
              key={item.label}
              onMouseEnter={() => setIndex(position)}
              onClick={() => {
                item.run();
                onClose();
              }}
            >
              <span>{item.label}</span>
              <span className="k">{item.hint}</span>
            </button>
          ))}
        </div>
        <div className="palette-foot">
          <span>↑ ↓ 选择　↵ 执行　Esc 关闭</span>
          <span>⌘K / Ctrl+K</span>
        </div>
      </div>
    </div>
  );
}
