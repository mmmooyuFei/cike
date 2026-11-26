/**
 * 站点菜单：数据来自导航页的 `/__nav/menu`（跨域、只读、无凭据）。
 *
 * 这是全站唯一的跨域请求，所以单独成文件：清单不在这里维护，改哪几张卡进菜单、
 * 点开是新标签还是当前标签，都在导航页的「设置 → 04 站点」里配。
 *
 * 拿不到（导航页挂了 / CORS 被拦 / 离线开发）就退回下面这份内置清单 ——
 * 三个站的地址相对稳定，写死一份兜底比「入口点不动」好。
 */

/** 导航页地址。换部署域名时改这里。 */
export const NAV_ORIGIN = "https://nav.jiyi.plus:8443";

const MENU_URL = `${NAV_ORIGIN}/__nav/menu`;

export type MenuOpenMode = "newTab" | "sameTab";

export type MenuSite = {
  id: string;
  title: string;
  subtitle: string;
  href: string;
  /** 32px 方块的缩略图；空串渲染成占位。 */
  thumb: string;
};

export type NavMenu = {
  openMode: MenuOpenMode;
  /** 导航台自己，固定第一项。 */
  hub: MenuSite;
  sites: MenuSite[];
};

export const NAV_MENU_FALLBACK: NavMenu = {
  openMode: "newTab",
  hub: {
    id: "hub",
    title: "导航台",
    subtitle: "Nav Hub",
    href: `${NAV_ORIGIN}/`,
    thumb: `${NAV_ORIGIN}/navhub.svg`,
  },
  sites: [
    { id: "visual-gen", title: "视觉工作台", subtitle: "Visual Gen Studio", href: "https://vgs.jiyi.plus:8443/app/", thumb: "" },
    { id: "shifen", title: "拾分", subtitle: "Shifen", href: "https://shifen.jiyi.plus:8443/app/", thumb: "" },
    { id: "cike", title: "此刻", subtitle: "Notes · Memo", href: "https://cike.jiyi.plus:8443/", thumb: "" },
  ],
};

export async function fetchNavMenu(): Promise<NavMenu> {
  const response = await fetch(MENU_URL, { credentials: "omit", headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(`nav-menu ${response.status}`);
  const raw = (await response.json()) as Partial<NavMenu>;
  if (!raw || !Array.isArray(raw.sites)) throw new Error("nav-menu malformed");
  return {
    openMode: raw.openMode === "sameTab" ? "sameTab" : "newTab",
    hub: raw.hub && raw.hub.href ? raw.hub : NAV_MENU_FALLBACK.hub,
    sites: raw.sites.filter((site): site is MenuSite => Boolean(site && site.href && site.title)),
  };
}

/** 点一枚图标之后怎么打开。`sameTab` 就地替换当前页。 */
export function openMenuSite(site: MenuSite, mode: MenuOpenMode): void {
  if (mode === "sameTab") {
    window.location.assign(site.href);
    return;
  }
  // 不带 feature 串：`window.open(href, "_blank", "noopener")` 即使成功也返回
  // null，会让下面的兜底误判成「被拦截」。先开、再手动切断 opener。
  const opened = window.open(site.href);
  if (opened) {
    try {
      opened.opener = null;
    } catch {
      /* 跨域时写不了，浏览器已经隔离开了 */
    }
    return;
  }
  window.location.assign(site.href);
}
