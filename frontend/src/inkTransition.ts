/**
 * 站点切换的墨迹过场 —— 应用侧薄封装。
 *
 * 运行时是 `public/ink-runtime.js`（classic script，由 `index.html` 加载）。它负责：
 * 把目标站放进一个全屏 iframe 提前加载 → 从鼠标点推开墨洞（洞内是目标站的**活页面**，
 * 洞外还是当前页）→ 推开到满屏的同一帧 `location.replace()` 换地址栏。
 *
 * 这里只做三件事：
 *   1. 把「跳到哪、从哪个点开始」翻译成运行时参数；
 *   2. 运行时缺失时退回普通跳转（老构建、脚本被拦都不能让点击没反应）；
 *   3. 给面板提供 `preloadTarget()` —— 悬停就预热，点下去时目标站已经画好。
 *
 * 边界：
 *   - 目标站被 `X-Frame-Options`/CSP 拦住、3s 内没加载完 → 运行时自己退回普通跳转。
 *   - `prefers-reduced-motion` → 不播过场，普通跳转。
 *   - 封面读不出像素（跨源无 CORS）→ 墨环用纯色，不影响过场。
 */

export interface InkPoint {
  x: number;
  y: number;
}

export interface InkSwitchOptions {
  /** 目标地址 */
  href: string;
  /** 鼠标点，视口坐标 px —— 墨洞的圆心 */
  point: InkPoint;
  /** 目标站封面：读得出像素就烘进墨环 */
  coverUrl?: string;
  /** 推开时长，默认 640ms */
  duration?: number;
}

interface InkRuntime {
  version: number;
  switchTo(options: InkSwitchOptions): Promise<{ skipped?: string }>;
  warm(href: string): void;
  cancelWarm(href: string): void;
  dropWarm(): void;
  sameGroup(href: string): boolean;
  reduced(): boolean;
}

function runtime(): InkRuntime | null {
  if (typeof window === "undefined") return null;
  const api = (window as unknown as { JiyiInk?: InkRuntime }).JiyiInk;
  return api && typeof api.switchTo === "function" ? api : null;
}

/** 目标是否与当前页同一站群（同一站群里才播过场）。 */
export function isSameSiteGroup(href: string): boolean {
  const api = runtime();
  if (!api || typeof api.sameGroup !== "function") return false;
  return api.sameGroup(href);
}

/** 预热：面板行悬停时调，点下去时目标站已经在 iframe 里画好了。 */
export function preloadTarget(href: string): void {
  runtime()?.warm(href);
}

/** 关面板时丢掉没用上的预热，别把三个站的 iframe 都留着。 */
export function cancelPreload(href: string): void {
  runtime()?.cancelWarm(href);
}

export function dropPreloads(): void {
  runtime()?.dropWarm();
}

/**
 * 切站：运行时内部完成「推开 → 换地址」，这里不返回也不接管跳转。
 * 运行时缺失时退回普通跳转。
 */
export function switchWebsite(options: InkSwitchOptions): void {
  const api = runtime();
  if (!api) {
    window.location.assign(options.href);
    return;
  }
  void api.switchTo(options);
}
