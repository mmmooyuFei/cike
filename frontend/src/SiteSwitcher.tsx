import { useEffect, useRef, useState } from "react";
import { NAV_MENU_FALLBACK, fetchNavMenu, openMenuSite, type MenuSite, type NavMenu } from "./menu";

/**
 * 侧栏底部的「站点切换」。和另外两个站同一个位置、同一套图标语言，
 * 区别只在这边没有 UI 库：面板是自己写的一小块，样式走 `styles.css` 的主题令牌。
 *
 * 三点约定：
 * 1. 「导航台」固定第一项 —— 其余三个站都是它的下游，不给回去的路，
 *    「当前标签」模式下等于把自己锁死。
 * 2. 取不到就退回内置清单（`NAV_MENU_FALLBACK`），入口不会变成死按钮。
 * 3. 当前站按 host 判断：同一台机器上三个站域名不同、端口相同。
 */

const ICON_SWAP = (
  <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    <path d="M7 2h10" />
    <path d="M5 6h14" />
    <rect width="18" height="12" x="3" y="10" rx="2" />
  </svg>
);

function SiteRow({
  site,
  current,
  onPick,
}: {
  site: MenuSite;
  current: boolean;
  onPick: () => void;
}) {
  return (
    <button
      type="button"
      className={`site-item${current ? " is-current" : ""}`}
      onClick={onPick}
      aria-current={current ? "true" : undefined}
    >
      <span className="site-thumb">
        {site.title.slice(0, 1)}
        {site.thumb ? (
          <img
            src={site.thumb}
            alt=""
            loading="lazy"
            decoding="async"
            onError={(event) => {
              event.currentTarget.style.display = "none";
            }}
          />
        ) : null}
      </span>
      <span className="site-names">
        <b>{site.title}</b>
        {site.subtitle ? <small>{site.subtitle}</small> : null}
      </span>
      {current ? <span className="site-badge">当前</span> : null}
    </button>
  );
}

export function SiteSwitcher({ mobile = false }: { mobile?: boolean }) {
  const [open, setOpen] = useState(false);
  const [menu, setMenu] = useState<NavMenu | null>(null);
  const [failed, setFailed] = useState(false);
  const wrapRef = useRef<HTMLSpanElement>(null);

  // 打开时才取数：这个入口不是首屏必需，别跟首屏抢带宽。
  useEffect(() => {
    if (!open || menu) return;
    let alive = true;
    void fetchNavMenu()
      .then((next) => {
        if (alive) setMenu(next);
      })
      .catch(() => {
        if (!alive) return;
        setFailed(true);
        setMenu(NAV_MENU_FALLBACK);
      });
    return () => {
      alive = false;
    };
  }, [open, menu]);

  // 点外部 / Esc 关闭。没有 portal，事件挂在 document 上判断是否落在自己身上。
  useEffect(() => {
    if (!open) return;
    const onDown = (event: PointerEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const host = typeof window === "undefined" ? "" : window.location.host;
  const isCurrent = (site: MenuSite) => {
    try {
      return Boolean(host) && new URL(site.href).host === host;
    } catch {
      return false;
    }
  };

  return (
    <span className={`site-wrap${mobile ? " is-mobile" : ""}`} ref={wrapRef}>
      <button
        type="button"
        className="icon-btn"
        aria-label="切换站点"
        aria-expanded={open}
        title="切换站点"
        onClick={() => setOpen((value) => !value)}
      >
        {ICON_SWAP}
      </button>

      {open ? (
        <div className="site-panel" role="menu">
          <div className="site-cap">JIYI · 站点</div>

          <SiteRow
            site={menu?.hub ?? NAV_MENU_FALLBACK.hub}
            current={false}
            onPick={() => openMenuSite(menu?.hub ?? NAV_MENU_FALLBACK.hub, menu?.openMode ?? "newTab")}
          />

          {menu && menu.sites.length === 0 ? (
            <p className="site-empty">菜单里还没有别的站点，去导航台的「设置 → 站点」里勾选。</p>
          ) : null}

          {menu?.sites.map((site) => (
            <SiteRow
              key={site.id}
              site={site}
              current={isCurrent(site)}
              onPick={() => openMenuSite(site, menu?.openMode ?? "newTab")}
            />
          ))}

          {failed ? <p className="site-empty">没取到站点列表，先用内置的三个入口。</p> : null}
        </div>
      ) : null}
    </span>
  );
}
