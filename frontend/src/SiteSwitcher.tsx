import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { NAV_MENU_FALLBACK, fetchNavMenu, openMenuSite, type MenuSite, type NavMenu } from "./menu";
import {
  ANCHOR_OFFSET,
  OPEN_BODY,
  OPEN_CARD,
  OPEN_NAV,
  applyCloseTempo,
  GAP,
  LIST_PAD,
  STACK_DECK_H,
  DECK_PAD,
  measurePanel,
  panelPosition,
  settleSprings,
  spring,
  stepSprings,
  type PanelGeometry,
  type SpringState,
} from "./siteSwitcherMotion";

/**
 * 侧栏底部 / 手机顶部品牌条里的「站点切换」。
 *
 * 面板从触发图标那一侧展开：左边站名、右边封面卡组，hover 到哪一项那张卡就翻到最前。
 * 三站同一套手感（`siteSwitcherMotion.ts`），这边没有 UI 库，样式走 `styles.css` 的令牌。
 *
 * 三点约定：
 * 1. 面板挂到 body 上（Portal）：侧栏是 `overflow:hidden` 的，而且面板要溢出侧栏压住正文。
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

/**
 * 卡组要 200×310，而导航台给的是 64px 派生件（`xxx-64.webp`）。
 * 去掉尺寸后缀换成同名大图；命名不符就原样用 thumb —— 这张卡糊一点，但不会裂图。
 * 导航台补上 `cover` 字段后删掉这里。
 */
function coverOf(thumb: string): string {
  if (!thumb) return "";
  return thumb.replace(/-64(\.(?:webp|jpe?g|png))(?:[?#].*)?$/i, "$1");
}

interface Motion {
  navWidth: SpringState;
  navHeight: SpringState;
  progress: SpringState;
  body: SpringState;
  iconX: SpringState;
  cards: SpringState[];
  layer: number;
  zLayers: number[];
  phase: "open" | "closing";
  geometry: PanelGeometry;
  anchor: { left: number; top: number; bottom: number; width: number; height: number };
  raf: number;
  last: number;
}

function applyPosition(node: HTMLDivElement | null, pos: { left: number; top: number | null; bottom: number | null }) {
  if (!node) return;
  node.style.left = `${Math.round(pos.left)}px`;
  if (pos.top === null) {
    node.style.top = "";
    node.style.bottom = `${Math.round(pos.bottom ?? 0)}px`;
  } else {
    node.style.bottom = "";
    node.style.top = `${Math.round(pos.top)}px`;
  }
}

export function SiteSwitcher({ mobile = false }: { mobile?: boolean }) {
  const [mounted, setMounted] = useState(false);
  const [open, setOpen] = useState(false);
  const [menu, setMenu] = useState<NavMenu | null>(null);
  const [failed, setFailed] = useState(false);
  const [active, setActive] = useState(0);

  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const iconRef = useRef<HTMLSpanElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const deckRef = useRef<HTMLDivElement | null>(null);
  const cardRefs = useRef<(HTMLDivElement | null)[]>([]);
  const motion = useRef<Motion | null>(null);
  const activeRef = useRef(0);
  const openRef = useRef(false);

  /**
   * 逻辑上的开合意图：连点时立刻翻转，不等弹簧落位。
   *
   * 只看 `open`（渲染态）的话，收起动画里每一次点击都会再走一遍「关闭」——
   * 表现就是「连点只有一次响应」。意图在这里是唯一判据。
   */
  const intentRef = useRef(false);

  const reducedRef = useRef(false);

  activeRef.current = active;
  openRef.current = open;

  const sites = menu?.sites ?? [];
  const mode = menu?.openMode ?? "newTab";

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

  const host = typeof window === "undefined" ? "" : window.location.host;
  const isCurrent = (site: MenuSite) => {
    try {
      return Boolean(host) && new URL(site.href).host === host;
    } catch {
      return false;
    }
  };

  /* ------------------------------------------------------------ 渲染一帧 */

  const paint = useCallback(() => {
    const m = motion.current;
    if (!m || !panelRef.current) return;
    const g = m.geometry;
    const w = Math.max(m.anchor.width, m.navWidth.value);
    const h = Math.max(m.anchor.height, m.navHeight.value);
    const p = Math.min(1, Math.max(0, m.progress.value));
    const deckWidth = g.deckWidth * p;
    const gap = g.stacked ? 0 : GAP * Math.min(1, deckWidth / 24);

    panelRef.current.style.width = `${Math.round(g.stacked ? w : w + gap + deckWidth)}px`;
    panelRef.current.style.height = `${Math.round(g.stacked ? h + (STACK_DECK_H + DECK_PAD * 2 + gap) * p : h)}px`;
    panelRef.current.style.opacity = String(Math.min(1, p * 3));

    const list = listRef.current;
    if (list) {
      list.style.width = `${Math.round(w)}px`;
      list.style.height = `${Math.round(h)}px`;
      const room = Math.max(0, h - LIST_PAD * 2);
      const overflows = sites.length * 40 > room + 0.5;
      // 弹簧没落位时不许出滚动条：否则每帧都可能闪一条，还把站名挤去截断
      list.style.overflowY = p > 0.999 && overflows ? "auto" : "hidden";
      const body = Math.min(1, Math.max(0, m.body.value));
      list.style.opacity = String(body);
      list.style.transform = `translate3d(0, ${10 * (1 - body)}px, 0)`;
    }
    const deck = deckRef.current;
    if (deck) {
      deck.style.width = `${Math.round(g.stacked ? w : deckWidth)}px`;
      deck.style.height = `${Math.round(g.stacked ? STACK_DECK_H + DECK_PAD * 2 : h)}px`;
      deck.style.padding = g.stacked ? `${DECK_PAD}px` : `${DECK_PAD}px ${DECK_PAD}px ${DECK_PAD}px 0`;
      deck.style.marginLeft = g.stacked ? "0px" : `${Math.round(gap)}px`;
      deck.style.marginBottom = g.stacked ? `${Math.round(gap)}px` : "0px";
      deck.style.opacity = String(Math.min(1, p * 1.6));
    }
    if (iconRef.current) {
      iconRef.current.style.transform = `translate3d(0, ${-2 * Math.min(1, m.iconX.value)}px, 0)`;
    }

    const activeIndex = activeRef.current;
    m.cards.forEach((item, index) => {
      // 旧卡原地不动：等新卡基本落位（<0.6）后一次性压回 102%，此刻它已被完全盖住
      if (index !== activeIndex && item.target === 0 && m.cards[activeIndex] && m.cards[activeIndex].value < 0.6) {
        item.value = 102;
        item.target = 102;
        item.velocity = 0;
      }
      const card = cardRefs.current[index];
      if (!card) return;
      const ratio = Math.min(1, Math.max(0, item.value / 102));
      card.style.transform = `translate3d(0, ${item.value}%, 0)`;
      card.style.zIndex = String(m.zLayers[index] ?? 0);
      card.style.setProperty("--deck-scale", `${1 + 0.055 * ratio}`);
    });
  }, [sites.length]);

  const stopLoop = useCallback(() => {
    const m = motion.current;
    if (m && m.raf) cancelAnimationFrame(m.raf);
    if (m) m.raf = 0;
  }, []);

  const tick = useCallback(
    (now: number) => {
      const m = motion.current;
      if (!m) return;
      m.raf = 0;
      const dt = m.last ? now - m.last : 16;
      m.last = now;
      const { moving } = stepSprings([m.navWidth, m.navHeight, m.progress, m.body, m.iconX, ...m.cards], dt);
      paint();
      if (moving) {
        m.raf = requestAnimationFrame(tick);
      } else if (m.phase === "closing") {
        setMounted(false);
        setOpen(false);
      }
    },
    [paint],
  );

  const run = useCallback(
    (immediate = false) => {
      const m = motion.current;
      if (!m) return;
      if (immediate || reducedRef.current) {
        stopLoop();
        settleSprings([m.navWidth, m.navHeight, m.progress, m.body, m.iconX, ...m.cards]);
        paint();
        if (m.phase === "closing") {
          setMounted(false);
          setOpen(false);
        }
        return;
      }
      if (!m.raf) {
        m.last = 0;
        m.raf = requestAnimationFrame(tick);
      }
    },
    [paint, stopLoop, tick],
  );

  const applyTargets = useCallback(() => {
    const m = motion.current;
    const trigger = triggerRef.current;
    if (!m || !trigger) return;
    const rect = trigger.getBoundingClientRect();
    m.anchor = { left: rect.left, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height };
    m.geometry = measurePanel(sites.length, {
      triggerLeft: rect.left,
      triggerTop: rect.top,
      viewportWidth: window.innerWidth,
    });
    applyPosition(panelRef.current, panelPosition(m.geometry, rect, window.innerWidth, window.innerHeight));
    m.navWidth.target = m.geometry.listWidth;
    m.navHeight.target = m.geometry.height;
    m.progress.target = 1;
    m.body.target = 1;
    m.iconX.target = 1;
  }, [sites.length]);

  /** 从「正在收起」转回展开：把弹簧参数调回展开那一档（收起用的是更硬的一组）。 */
  const applyOpenTempo = useCallback((m: Motion) => {
    m.navWidth.stiffness = OPEN_NAV.stiffness;
    m.navWidth.damping = OPEN_NAV.damping;
    m.navHeight.stiffness = OPEN_NAV.stiffness;
    m.navHeight.damping = OPEN_NAV.damping;
    m.progress.stiffness = OPEN_NAV.stiffness;
    m.progress.damping = OPEN_NAV.damping;
    m.iconX.stiffness = OPEN_NAV.stiffness;
    m.iconX.damping = OPEN_NAV.damping;
    m.body.stiffness = OPEN_BODY.stiffness;
    m.body.damping = OPEN_BODY.damping;
    for (const card of m.cards) {
      card.stiffness = OPEN_CARD.stiffness;
      card.damping = OPEN_CARD.damping;
    }
  }, []);

  /**
   * 前进/后退回到本页时把面板状态清干净。
   *
   * 点击站点是 `location.assign`，离开时面板往往还停在"正在收起"，浏览器把这份内存状态
   * 一起冻住了（含弹簧里那个 `requestAnimationFrame` id）。回来之后：
   * - `open` / `mounted` 还是 true → `openPanel()` 直接提前返回；
   * - 就算走"继续展开"这条路，`run()` 看到 `m.raf` 非 0 也不会重新起循环。
   * 两者叠在一起就是"点按钮没反应"。所以恢复时把状态归零，下一次点击从头建面板。
   */
  useEffect(() => {
    const reset = () => {
      stopLoop();
      motion.current = null;
      intentRef.current = false;
      setMounted(false);
      setOpen(false);
    };
    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted) reset();
    };
    window.addEventListener("pageshow", onPageShow);
    window.addEventListener("pagehide", reset);
    return () => {
      window.removeEventListener("pageshow", onPageShow);
      window.removeEventListener("pagehide", reset);
    };
  }, [stopLoop]);

  const openPanel = useCallback(() => {
    // 正在收起、且还没卸载时又点开：不重建弹簧，把目标改回展开值，视觉上接着走。
    // 必须带 `mounted`：收起已经落位（portal 已卸载）时 motion 里的 phase 仍是 closing，
    // 只按 phase 判断会走进「接着展开」这条路，面板却永远不再挂回来。
    const active = motion.current;
    if (active && active.phase === "closing" && mounted) {
      intentRef.current = true;
      active.phase = "open";
      applyOpenTempo(active);
      applyTargets();
      setOpen(true);
      run();
      return;
    }
    intentRef.current = true;
    const trigger = triggerRef.current;
    if (!trigger) return;
    reducedRef.current = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const rect = trigger.getBoundingClientRect();
    const geometry = measurePanel(sites.length, {
      triggerLeft: rect.left,
      triggerTop: rect.top,
      viewportWidth: window.innerWidth,
    });
    const initialActive = Math.max(0, sites.findIndex((site) => isCurrent(site)));
    motion.current = {
      navWidth: spring(rect.width, OPEN_NAV.stiffness, OPEN_NAV.damping),
      navHeight: spring(rect.height, OPEN_NAV.stiffness, OPEN_NAV.damping),
      progress: spring(0, OPEN_NAV.stiffness, OPEN_NAV.damping),
      body: spring(0, OPEN_BODY.stiffness, OPEN_BODY.damping),
      iconX: spring(0, OPEN_NAV.stiffness, OPEN_NAV.damping),
      cards: sites.map((_, i) => spring(i === initialActive ? 0 : 102, OPEN_CARD.stiffness, OPEN_CARD.damping)),
      layer: 1,
      zLayers: sites.map((_, i) => (i === initialActive ? 1 : 0)),
      phase: "open",
      geometry,
      anchor: { left: rect.left, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height },
      raf: 0,
      last: 0,
    };
    setActive(initialActive);
    activeRef.current = initialActive;
    setMounted(true);
    setOpen(true);
  }, [applyOpenTempo, applyTargets, run, sites]);

  const closePanel = useCallback(() => {
    intentRef.current = false;
    const m = motion.current;
    const trigger = triggerRef.current;
    if (!m || !trigger) {
      setOpen(false);
      setMounted(false);
      return;
    }
    const rect = trigger.getBoundingClientRect();
    m.phase = "closing";
    applyCloseTempo([m.navWidth, m.navHeight, m.progress, m.body, m.iconX, ...m.cards]);
    m.navWidth.target = rect.width;
    m.navHeight.target = rect.height;
    m.progress.target = 0;
    m.body.target = 0;
    m.iconX.target = 0;
    run();
  }, [run]);

  // 打开后：定位、设目标、动画开始、焦点落到当前站
  useEffect(() => {
    if (!mounted) return;
    applyTargets();
    if (motion.current) motion.current.phase = "open";
    run();
    const index = Math.max(
      0,
      sites.findIndex((site) => {
        try {
          return Boolean(host) && new URL(site.href).host === host;
        } catch {
          return false;
        }
      }),
    );
    const node = listRef.current?.querySelectorAll<HTMLButtonElement>("[data-site-row]")[index];
    node?.focus({ preventScroll: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mounted]);

  // 卡片上的说明文字：只有最前面那一张亮起
  useEffect(() => {
    cardRefs.current.forEach((node, index) => {
      node?.classList.toggle("is-text-on", index === active);
    });
  }, [active, sites.length]);

  useEffect(() => {
    if (!open) return;
    const onResize = () => {
      applyTargets();
      paint();
    };
    const onDown = (event: PointerEvent) => {
      if (panelRef.current?.contains(event.target as Node)) return;
      if (triggerRef.current?.contains(event.target as Node)) return;
      closePanel();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      closePanel();
      triggerRef.current?.focus({ preventScroll: true });
    };
    window.addEventListener("resize", onResize);
    window.addEventListener("scroll", applyTargets, { passive: true });
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("resize", onResize);
      window.removeEventListener("scroll", applyTargets);
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, applyTargets, paint, closePanel]);

  useEffect(() => () => stopLoop(), [stopLoop]);

  const highlight = useCallback(
    (index: number) => {
      const m = motion.current;
      if (!m || !m.cards[index] || index === activeRef.current) return;
      activeRef.current = index;
      setActive(index);
      m.cards[index].target = 0;
      m.zLayers[index] = ++m.layer;
      run();
    },
    [run],
  );

  /**
   * 点站点：关面板，然后按设置打开（同标签直达 / 新标签）。
   *
   * 当前站那一行不跳 —— 点了等于原地刷新。
   */
  const pick = useCallback(
    (site: MenuSite) => {
      closePanel();
      if (isCurrent(site)) return;
      warmOrigin(site.href);
      prerenderSite(site.href);
      openMenuSite(site, mode);
    },
    [closePanel, isCurrent, mode],
  );

  const rows = sites.map((site, index) => {
    const current = isCurrent(site);
    return (
      <button
        key={site.id}
        type="button"
        role="menuitem"
        data-site-row
        className={`site-row${index === active ? " is-active" : ""}`}
        aria-current={current ? "true" : undefined}
        onPointerEnter={() => {
          highlight(index);
          warmOrigin(site.href);
          // 这一行最可能要去的那个站：让浏览器在后台把它完整渲染好
          prerenderSite(site.href);
        }}
        onFocus={() => highlight(index)}
        onClick={() => pick(site)}
      >
        <span className="site-names">
          <b>{site.title}</b>
          {site.subtitle ? <small>{site.subtitle}</small> : null}
        </span>
        {current ? <span className="site-dot" aria-label="当前" /> : null}
      </button>
    );
  });

  const cards = sites.map((site, index) => {
    const cover = coverOf(site.thumb);
    return (
      <div
        key={site.id}
        ref={(node) => {
          cardRefs.current[index] = node;
        }}
        className="site-card"
        aria-hidden="true"
      >
        {cover ? (
          <img
            src={cover}
            alt=""
            loading="lazy"
            decoding="async"
            draggable={false}
            onError={(event) => {
              const node = event.currentTarget;
              if (node.dataset.fallback === "1" || node.src === site.thumb) return;
              node.dataset.fallback = "1";
              node.src = site.thumb;
            }}
          />
        ) : null}
        <span className="site-card-cap">
          <small>{site.subtitle}</small>
          <b>{site.title}</b>
        </span>
      </div>
    );
  });

  const loading = open && !menu;

  return (
    <>
      <span className={`site-wrap${mobile ? " is-mobile" : ""}`}>
        <button
          ref={triggerRef}
          type="button"
          className="icon-btn"
          aria-label="切换站点"
          aria-expanded={open}
          title="切换站点"
          onClick={() => (intentRef.current ? closePanel() : openPanel())}
        >
          <span ref={iconRef}>{ICON_SWAP}</span>
        </button>
      </span>

      {mounted
        ? createPortal(
            <div
              ref={panelRef}
              className="site-panel"
              role="dialog"
              aria-label="切换站点"
              style={{ width: 0, height: 0, opacity: 0 }}
            >
              <div ref={listRef} className="site-list" role="menu">
                {loading ? <p className="site-empty">正在取站点列表…</p> : null}
                {rows}
                {menu && sites.length === 0 ? (
                  <p className="site-empty">菜单里还没有别的站点，去导航台的「设置 → 站点」里勾选。</p>
                ) : null}
                {failed ? <p className="site-note">没取到站点列表，先用内置的三个入口。</p> : null}
              </div>
              <div ref={deckRef} className="site-deck">
                <div className="site-deck-inner">{cards}</div>
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

export const SITE_SWITCHER_ANCHOR_OFFSET = ANCHOR_OFFSET;

/**
 * 让「点站点」那一跳尽可能快：悬停/打开面板时就把目标源的连接建好。
 *
 * 点击本身仍然是**一次普通导航**（`location.assign` / 新标签），这里只做减速项里
 * 最便宜也最有效的那个 —— `preconnect` 省掉 DNS + TCP + TLS（线上通常 100–300ms）。
 *
 * 不预取 HTML：站点是跨源的，浏览器的 HTTP 缓存按顶层站点分区，源站预取的响应
 * 到目标站用不上，白费流量。
 */
const warmedOrigins = new Set<string>();

function warmOrigin(href: string): void {
  let origin: string;
  try {
    origin = new URL(href, window.location.href).origin;
  } catch {
    return;
  }
  if (!origin || warmedOrigins.has(origin) || origin === window.location.origin) return;
  warmedOrigins.add(origin);
  const link = document.createElement("link");
  link.rel = "preconnect";
  link.href = origin;
  link.crossOrigin = "";
  document.head.appendChild(link);
}

/** Speculation Rules 的规则脚本：同一时刻只留一条（只预渲染"最可能要去的"那个站）。 */
let prerenderScript: HTMLScriptElement | null = null;

function supportsPrerender(): boolean {
  const element = window.HTMLScriptElement as
    | (typeof HTMLScriptElement & { supports?: (type: string) => boolean })
    | undefined;
  return typeof element?.supports === "function" && element.supports("speculationrules");
}

/**
 * 悬停时让浏览器把这个站**在后台完整渲染好**（Speculation Rules 的 `prerender`）。
 *
 * 点击后浏览器直接接管那份已经渲染好、也跑完首屏请求的页面 —— 等于零等待，
 * 不再有"白屏 / 转圈圈"那一段。
 *
 * 前提：目标站要回 `Supports-Loading-Mode: credentialed-prerender`（三站后端都已加）。
 * 缺这个头时浏览器拒绝跨源带凭据预渲染，这里静默失效、退回普通跳转，功能不受影响。
 * 浏览器不支持（非 Chromium 系）时同样静默跳过。
 */
function prerenderSite(href: string): void {
  if (!supportsPrerender()) return;
  let url: string;
  try {
    url = new URL(href, window.location.href).href;
  } catch {
    return;
  }
  if (url === window.location.href) return;
  try {
    prerenderScript?.remove();
    const script = document.createElement("script");
    script.type = "speculationrules";
    script.textContent = JSON.stringify({ prerender: [{ source: "list", urls: [url] }] });
    document.head.appendChild(script);
    prerenderScript = script;
  } catch {
    /* 规则不合法就算了，最多慢一点 */
  }
}
