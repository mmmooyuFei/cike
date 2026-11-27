/**
 * 站点切换墨迹过场 —— 运行时 v3（classic script，零依赖，不需要构建）。
 *
 * 形态：**旧页不动，墨洞直接开在新站的真实页面上。**
 *
 *   点站点 → 落点先起一颗墨珠（几百毫秒的加载反馈）→ 目标站以 iframe 提前加载（悬停时就开始），
 *   它首屏放行时给 parent 发一条 `jiyi-ink:ready`，源页收到才推开（拿不到就等 450ms 兜底）
 *   → 一个不规则的洞从落点长出，把新站露出来。**洞边不画任何描边/色带**，
 *   边界就是新旧两个页面的交界。
 *          → 目标站画出来后，从鼠标点推开：洞内是目标站的活页面，洞外还是当前页
 *          → 推开到满屏的同一帧 `location.assign()`，地址栏换成目标站（后退可回原页）
 *
 * 为什么不是「两段式墨迹」：那需要先把整屏盖住再等新页启动，用户会被一片静止的墨扣住，
 * 而且洞里的内容直到跳转后才可能出现。这里旧页始终是活的，洞里的内容也始终是活的。
 *
 * 为什么不截当前页的图：跨文档拿不到旧页像素；`foreignObject` 那条路会丢字体、还会多花 300ms。
 * iframe 把「旧页 + 新页」同时留在同一个文档里，两边都是真实渲染，不需要任何截图。
 *
 * 边界：
 *   - 目标站被 `X-Frame-Options` / CSP 拦掉，或 3s 内没加载完 → 不铺洞，直接普通跳转。
 *   - 目标站没登录（iframe 里被 IdP 拦住）→ 洞内会是登录页；此时推开后仍然 `location.replace`，
 *     地址栏与 Cookie 域都正确，用户在新站里照常登录。
 *   - 没有 `clip-path: polygon()` → 直接普通跳转。
 *   - `prefers-reduced-motion` → 不播过场，直接普通跳转。
 *   - 前进后退（bfcache）→ 恢复时把舞台摘掉。
 *
 * 对外 API（`window.JiyiInk`）：
 *   switchTo({ href, point })            → Promise<void>  点站点时调；内部完成加载、推开与跳转
 *   warm(href)                                            面板打开 / 行悬停时预热（预加载 iframe）
 *   cancelWarm(href)                                      面板关闭时丢掉预热
 *   sameGroup(href)                                       目标是否同一站群
 */
(function (global, doc) {
  "use strict";

  /* ============================================================ 常量 */

  /** 覆盖层与 iframe 的层级：压过站内一切浮层。 */
  var Z_INDEX = 2147483000;
  /** 推开时长。 */
  var REVEAL_MS = 700;
  /** 预热开始后最多等这么久就必须推开（到点没加载完就按普通跳转收场）。 */
  var READY_TIMEOUT_MS = 3000;
  /**
   * 拿不到「目标站首屏就绪」握手时的兜底等待。
   *
   * iframe 的 `load` 只代表资源到齐，不代表应用画好了（登录态、主题同步都在这之后）。
   * 三站都会在首屏放行时给 parent 发 `jiyi-ink:ready`；没发的目标（老构建、导航台）
   * 就等这么久再推开 —— 宁可晚一点，也不要洞里先闪一下“加载中”。
   */
  var PAINT_SETTLE_MS = 450;
  /** 墨环轮廓的采样条数：越少越方，越多越贵；96 条在 60fps 下没有压力。 */
  var RAYS = 96;

  /** 浅色底上用暖黑墨，深色底上用米白墨。 */
  var INK_ON_LIGHT = { base: "#171310", wash: "#3d3226", grain: "#2a231b" };
  var INK_ON_DARK = { base: "#efe6d4", wash: "#c8b795", grain: "#fffaf0" };

  /* ============================================================ 基础工具 */

  function clamp01(value) {
    return value < 0 ? 0 : value > 1 ? 1 : value;
  }

  function reduced() {
    try {
      return !!(global.matchMedia && global.matchMedia("(prefers-reduced-motion: reduce)").matches);
    } catch (error) {
      return false;
    }
  }

  /** 站点组：取主机名最后两段（`a.example.com` 与 `b.example.com` 同组）。 */
  function siteGroup(hostname) {
    var parts = String(hostname || "").toLowerCase().split(".");
    return parts.length <= 2 ? parts.join(".") : parts.slice(-2).join(".");
  }

  function sameGroup(href) {
    try {
      return siteGroup(new URL(href, doc.baseURI).hostname) === siteGroup(global.location.hostname);
    } catch (error) {
      return false;
    }
  }

  function luminance(color) {
    var match = String(color || "").match(/\d+(\.\d+)?/g);
    if (!match || match.length < 3) return 1;
    return (0.2126 * +match[0] + 0.7152 * +match[1] + 0.0722 * +match[2]) / 255;
  }

  function isDarkPage() {
    var element = doc.documentElement;
    if (element.dataset.theme) {
      return element.dataset.theme === "night" || element.dataset.theme === "dark";
    }
    if (element.classList.contains("dark")) return true;
    if (!doc.body) return false;
    try {
      return luminance(global.getComputedStyle(doc.body).backgroundColor) < 0.35;
    } catch (error) {
      return false;
    }
  }

  function inkPalette(dark) {
    return dark ? INK_ON_DARK : INK_ON_LIGHT;
  }

  /** 支持 CSS mask（软边的前提）时用蒙版，否则退回硬边裁切。 */
  function supportsMask() {
    return !!(
      global.CSS &&
      global.CSS.supports &&
      (global.CSS.supports("mask-image", "linear-gradient(#fff,#fff)") ||
        global.CSS.supports("-webkit-mask-image", "linear-gradient(#fff,#fff)"))
    );
  }

  function supportsClipPath() {
    return typeof global.CSS !== "undefined" && global.CSS.supports && global.CSS.supports("clip-path", "polygon(0 0, 1px 0, 0 1px)");
  }

  /* ============================================================ 噪声（与着色器同一条公式） */

  function hash2(x, y) {
    var value = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
    return value - Math.floor(value);
  }

  function noise2(x, y) {
    var xi = Math.floor(x);
    var yi = Math.floor(y);
    var xf = x - xi;
    var yf = y - yi;
    var u = xf * xf * (3 - 2 * xf);
    var v = yf * yf * (3 - 2 * yf);
    var a = hash2(xi, yi);
    var b = hash2(xi + 1, yi);
    var c = hash2(xi, yi + 1);
    var d = hash2(xi + 1, yi + 1);
    return (a + (b - a) * u) * (1 - v) + (c + (d - c) * u) * v;
  }

  /** 5 阶 fbm：矩阵与衰减照搬着色器里的 `field()`。 */
  function field(x, y) {
    var total = 0;
    var amplitude = 0.55;
    for (var i = 0; i < 5; i += 1) {
      total += amplitude * noise2(x, y);
      var nx = 1.6 * x - 1.2 * y + 3.7;
      var ny = 1.2 * x + 1.6 * y + 3.7;
      x = nx;
      y = ny;
      amplitude *= 0.47;
    }
    return total;
  }

  /* ============================================================ 预热：把目标站先拉起来 */

  /** 预热好的 iframe（按 href 缓存，面板关掉时才丢）。 */
  var warmFrames = {};

  function createTargetFrame(href) {
    var frame = doc.createElement("iframe");
    frame.setAttribute("aria-hidden", "true");
    frame.tabIndex = -1;
    frame.title = "";
    frame.dataset.jiyiInkTarget = "1";
    // 必须按最终尺寸布局：目标站的响应式断点、vh 单位都按这个尺寸算，
    // 尺寸给错的话推开那一刻布局会跳一下。
    frame.style.cssText =
      "position:fixed;left:0;top:0;width:100vw;height:100vh;border:0;z-index:" +
      (Z_INDEX + 1) +
      ";display:none;background:transparent;opacity:0;pointer-events:none";
    frame.src = href;
    var state = { frame: frame, loaded: false, failed: false };
    frame.addEventListener("load", function () {
      if (frame.dataset.jiyiInkDropped === "1") return;
      state.loaded = true;
    });
    frame.addEventListener("error", function () {
      state.failed = true;
    });
    doc.body.appendChild(frame);
    return state;
  }

  /** 预热某个目标站（幂等）。面板打开或行悬停时调。 */
  function warm(href) {
    if (!href || !sameGroup(href) || warmFrames[href]) return;
    warmFrames[href] = createTargetFrame(href);
  }

  function cancelWarm(href) {
    var state = warmFrames[href];
    if (!state) return;
    state.frame.dataset.jiyiInkDropped = "1";
    state.frame.remove();
    delete warmFrames[href];
  }

  function dropAllWarm() {
    Object.keys(warmFrames).forEach(cancelWarm);
  }

  /* ============================================================ 舞台 */

  var stage = null;

  /**
   * 舞台：一个铺满视口的 iframe + 一层挡交互的透明遮罩。
   *
   * **洞边只有淡羽化，没有任何描边/色带**：支持 CSS mask 时，用一张小画布逐帧画
   * 「白色多边形 + 高斯模糊」，把它的 alpha 当蒙版（纯透明度，不带颜色）；
   * 不支持 mask 时退回硬边 `clip-path`。
   */
  function createStage(state) {
    var frame = state.frame;
    var shield = doc.createElement("div");
    shield.dataset.jiyiInkStage = "1";
    shield.setAttribute("aria-hidden", "true");
    shield.style.cssText =
      "position:fixed;inset:0;z-index:" +
      (Z_INDEX + 1) +
      ";pointer-events:auto;touch-action:none;background:transparent";
    frame.style.display = "block";
    frame.style.opacity = "1";
    frame.style.pointerEvents = "none";
    var soft = supportsMask();
    var mask = null;
    if (soft) {
      mask = createMaskSvg(state.width || global.innerWidth, state.height || global.innerHeight);
      // 引用内联 SVG 蒙版：不加载资源，CSP 拦不到
      var ref = "url(#" + MASK_ID + ")";
      frame.style.maskImage = ref;
      frame.style.webkitMaskImage = ref;
      frame.style.maskSize = "100% 100%";
      frame.style.webkitMaskSize = "100% 100%";
      frame.style.maskRepeat = "no-repeat";
      frame.style.webkitMaskRepeat = "no-repeat";
      frame.style.maskPosition = "0 0";
      frame.style.webkitMaskPosition = "0 0";
      frame.style.maskMode = "alpha";
      frame.style.webkitMaskMode = "alpha";
    }
    // 硬边兜底：无论蒙版是否可用，都先把洞裁出来（蒙版只是把这条边羽化掉）
    frame.style.clipPath = "polygon(0 0, 0 0, 0 0)";
    doc.body.appendChild(shield);
    return { frame: frame, shield: shield, soft: soft, mask: mask };
  }

  /**
   * 墨洞轮廓：与着色器同一条膨胀曲线 + 同一支 fbm。
   * 返回 `[{x,y}...]`，单位是视口像素。
   *
   * 与着色器的差别（**必须守住**）：着色器逐像素算 alpha，边界自交也不影响观感；
   * 这里是**一个多边形**，一旦半径出现负值或相邻射线交叉，clip-path 的洞就退化成
   * 一条自交的细线（洞里几乎没有面积，iframe 等于被完全裁掉）。
   * 所以三条硬约束：
   *   1. 半径恒正 —— 角度递增 + 半径为正的多边形天然不自交；
   *   2. 噪声走低频（3.2/4.4，不是着色器的 7.8/10.6），相邻射线不会来回穿插；
   *   3. 半径序列做一遍环形平滑，消掉尖刺。
   * 抖动的幅度再乘一个「长大比例」，起手是一颗圆点，不会一开始就带锯齿。
   */
  function holePolygon(progress, geometry) {
    var width = geometry.width;
    var height = geometry.height;
    var aspect = width / Math.max(1, height);
    var origin = geometry.origin;
    var originX = origin[0] * width;
    var originY = origin[1] * height;
    var farX = Math.max(origin[0], 1 - origin[0]) * aspect;
    var farY = Math.max(origin[1], 1 - origin[1]);
    var reach = Math.sqrt(farX * farX + farY * farY);
    var growth = -0.12 + (reach + 0.22 + 0.12) * progress;
    var grown = Math.max(0, growth);
    // 长大比例：0 → 1 之间夹住，起手不抖，涨到约 1/3 屏宽后给满抖动
    var ramp = Math.min(1, grown / 0.35);
    var amplitude = (0.14 + geometry.roughness * 0.34) * Math.sin(progress * Math.PI) * ramp;

    var raw = new Array(RAYS);
    for (var i = 0; i < RAYS; i += 1) {
      var angle = (i / RAYS) * Math.PI * 2;
      var sampleX = origin[0] + (Math.cos(angle) * grown) / aspect;
      var sampleY = origin[1] + Math.sin(angle) * grown;
      raw[i] = field(sampleX * 3.2 + geometry.seed, sampleY * 4.4 + geometry.seed * 0.71);
    }
    // 环形平滑：一遍 [1,2,1]/4 就够（两遍会把墨迹磨成圆）
    for (var pass = 0; pass < 1; pass += 1) {
      var smoothed = new Array(RAYS);
      for (var j = 0; j < RAYS; j += 1) {
        var prev = raw[(j + RAYS - 1) % RAYS];
        var next = raw[(j + 1) % RAYS];
        smoothed[j] = (prev + raw[j] * 2 + next) / 4;
      }
      raw = smoothed;
    }

    var points = [];
    for (var k = 0; k < RAYS; k += 1) {
      var theta = (k / RAYS) * Math.PI * 2;
      // 半径恒正：负的一律压到 0（洞还没开到那里）
      var radius = Math.max(0, growth + (raw[k] - 0.5) * amplitude);
      points.push([originX + Math.cos(theta) * radius * height, originY + Math.sin(theta) * radius * height]);
    }
    return points;
  }

  var SVG_NS = "http://www.w3.org/2000/svg";
  var MASK_ID = "jiyi-ink-mask";
  var MASK_PATH_ID = "jiyi-ink-mask-path";
  var MASK_BLUR_ID = "jiyi-ink-mask-blur";

  /**
   * 羽化半径（CSS px）：蒙版用它做模糊，硬边兜底用它外扩。
   *
   * **硬边兜底是必需的**：蒙版要是没生效（浏览器不支持 `mask-image: url(#id)`、
   * 或者站点 CSP / 扩展把它拦了），只留 mask 的话 iframe 整块不可见，
   * 用户看到的就是"点一下、黑点闪一下、页面直接跳走"。外扩一点点再裁一刀，
   * 至少洞还会长出来。
   */
  function featherPx(width, height) {
    return Math.max(4, Math.min(14, Math.min(width, height) * 0.011));
  }

  /**
   * 软边蒙版：一段内联 SVG —— 白色路径 `d` 每帧更新，外面套一个高斯模糊。
   *
   * 为什么不用 `mask-image: url("data:image/png;…")`：`data:` 属于图片资源，
   * 站点的 CSP 里 `img-src` 不放开就会把蒙版整张拦掉 —— 表现是洞完全不可见、
   * 只剩"点一下就跳走"，而且不报错。内联 SVG 引用（`url(#id)`）不加载任何资源，
   * CSP 拦不到，也省掉每帧一次 PNG 编码。
   */
  function createMaskSvg(width, height) {
    var holder = doc.createElementNS(SVG_NS, "svg");
    holder.dataset.jiyiInkStage = "1";
    holder.setAttribute("aria-hidden", "true");
    holder.style.cssText = "position:fixed;left:0;top:0;width:0;height:0;overflow:hidden;pointer-events:none";
    var mask = doc.createElementNS(SVG_NS, "mask");
    mask.setAttribute("id", MASK_ID);
    mask.setAttribute("maskUnits", "userSpaceOnUse");
    mask.setAttribute("x", "0");
    mask.setAttribute("y", "0");
    mask.setAttribute("width", String(width));
    mask.setAttribute("height", String(height));
    var filter = doc.createElementNS(SVG_NS, "filter");
    filter.setAttribute("id", MASK_BLUR_ID);
    filter.setAttribute("x", "-15%");
    filter.setAttribute("y", "-15%");
    filter.setAttribute("width", "130%");
    filter.setAttribute("height", "130%");
    var blur = doc.createElementNS(SVG_NS, "feGaussianBlur");
    // 羽化半径按视口短边算（0.55%，夹 2–7px），这是标准差，视觉过渡带约两倍
    var sigma = featherPx(width, height) * 0.5;
    blur.setAttribute("stdDeviation", sigma.toFixed(2));
    filter.appendChild(blur);
    var path = doc.createElementNS(SVG_NS, "path");
    path.setAttribute("id", MASK_PATH_ID);
    path.setAttribute("fill", "#fff");
    path.setAttribute("d", "");
    path.setAttribute("filter", "url(#" + MASK_BLUR_ID + ")");
    mask.appendChild(filter);
    mask.appendChild(path);
    holder.appendChild(mask);
    doc.body.appendChild(holder);
    return { holder: holder, path: path };
  }

  /** 把洞的轮廓沿半径方向外扩 `pad` 像素（给硬边兜底留出羽化宽度）。 */
  function expandPoints(points, pad, geometry) {
    if (!pad || !geometry) return points;
    var originX = geometry.origin[0] * geometry.width;
    var originY = geometry.origin[1] * geometry.height;
    var out = new Array(points.length);
    for (var i = 0; i < points.length; i += 1) {
      var dx = points[i][0] - originX;
      var dy = points[i][1] - originY;
      var len = Math.sqrt(dx * dx + dy * dy);
      if (len < 0.001) {
        out[i] = points[i];
        continue;
      }
      out[i] = [points[i][0] + (dx / len) * pad, points[i][1] + (dy / len) * pad];
    }
    return out;
  }

  function maskPathData(points) {
    if (!points.length) return "";
    var d = "M" + points[0][0].toFixed(1) + " " + points[0][1].toFixed(1);
    for (var i = 1; i < points.length; i += 1) d += "L" + points[i][0].toFixed(1) + " " + points[i][1].toFixed(1);
    return d + "Z";
  }

  function polygonCss(points) {
    var parts = [];
    for (var i = 0; i < points.length; i += 1) {
      parts.push(Math.round(points[i][0]) + "px " + Math.round(points[i][1]) + "px");
    }
    return "polygon(" + parts.join(",") + ")";
  }

  /** 墨环：沿洞边画一圈湿墨，把 iframe 的硬裁切边盖掉。 */
  /**
   * 落点的墨珠：点击那一刻先给一个反馈。
   *
   * 目标站还没在 iframe 里画出来时（没预热到、或者网络慢），什么都不显示会像"点了没反应"。
   * 这颗珠子只表示"墨已经从这儿出来了"：350ms 后自己散掉，舞台铺开的那一刻也会被摘掉。
   */
  function createBead(point, ink) {
    var size = 30;
    var bead = doc.createElement("div");
    bead.dataset.jiyiInkStage = "1";
    bead.setAttribute("aria-hidden", "true");
    bead.style.cssText =
      "position:fixed;left:" +
      Math.round(point.x - size / 2) +
      "px;top:" +
      Math.round(point.y - size / 2) +
      "px;width:" +
      size +
      "px;height:" +
      size +
      "px;border-radius:50%;z-index:" +
      Z_INDEX +
      ";pointer-events:none;opacity:0;transform:scale(.55);" +
      "background:radial-gradient(circle at 48% 42%," +
      ink.grain +
      " 0%," +
      ink.base +
      " 38%," +
      ink.wash +
      " 72%,rgba(0,0,0,0) 74%);" +
      "transition:opacity 300ms linear,transform 520ms cubic-bezier(.2,.72,.28,1)";
    doc.body.appendChild(bead);
    global.requestAnimationFrame(function () {
      bead.style.opacity = "0.92";
      bead.style.transform = "scale(1)";
    });
    global.setTimeout(function () {
      bead.style.opacity = "0";
      bead.style.transform = "scale(2.2)";
    }, 350);
    global.setTimeout(function () {
      bead.remove();
    }, 900);
    return bead;
  }

  function commit(href) {
    // 告诉目标页：这一跳是站点切换来的，落地先盖住自己的 loading 壳
    try {
      global.name = ENTER_FLAG;
    } catch (error) {
      /* 写不了就算了，最多照旧闪一下 */
    }
    // 必须用 assign 而不是 replace：replace 会把当前页从历史里顶掉，浏览器的「后退」就废了。
    // 也不能先摘 iframe 再跳 —— 那样会有一帧退回旧页；iframe 交给浏览器随文档一起回收。
    global.location.assign(href);
  }

  /**
   * 点站点：推开墨洞 → 满屏的同一帧跳转。
   *
   * @param {object} options
   * @param {string} options.href              目标地址
   * @param {{x:number,y:number}} options.point 鼠标点（视口 px）
     * @param {number} [options.roughness]       墨边粗糙度 0..1
   * @param {number} [options.duration]        推开时长
   * @returns {Promise<{skipped?: string}>}
   */
  function switchTo(options) {
    var settings = options || {};
    var href = String(settings.href || "");
    if (!href) return Promise.resolve({ skipped: "no-href" });
    // 站群外、减少动效、没有 clip-path：一律普通跳转
    if (!sameGroup(href) || reduced() || !supportsClipPath()) {
      note("退化为普通跳转", {
        sameGroup: sameGroup(href),
        reduced: reduced(),
        clip: supportsClipPath(),
        href: href,
      });
      commit(href);
      return Promise.resolve({ skipped: "plain" });
    }
    if (stage) return Promise.resolve({ skipped: "busy" });

    var dark = settings.dark != null ? !!settings.dark : isDarkPage();
    var width = global.innerWidth;
    var height = global.innerHeight;
    var point = settings.point || { x: width / 2, y: height / 2 };
    var seed = settings.seed != null ? settings.seed : Math.round(Math.random() * 1e6) / 1e6 + 0.37;
    var roughness = settings.roughness != null ? clamp01(settings.roughness) : 0.6;
    var duration = settings.duration != null ? settings.duration : REVEAL_MS;

    // 目标站 iframe：优先用预热的，没有就现拉
    var state = warmFrames[href];
    if (!state) {
      state = createTargetFrame(href);
      warmFrames[href] = state;
    }

    var bead = createBead(point, inkPalette(dark));

    return new Promise(function (resolve) {
      var settled = false;
      var readyTimer = 0;
      var pollTimer = 0;

      function finish(skipped) {
        if (settled) return;
        settled = true;
        if (readyTimer) global.clearTimeout(readyTimer);
        if (pollTimer) global.clearInterval(pollTimer);
        resolve({ skipped: skipped });
      }

      function start() {
        if (settled) return;
        pendingStart = null;
        if (bead) bead.remove();
        var stageRef = createStage(state);
        stage = stageRef;
        var geometry = {
          width: width,
          height: height,
          origin: [clamp01(point.x / Math.max(1, width)), clamp01(point.y / Math.max(1, height))],
          roughness: roughness,
          seed: seed,
        };

        var previous = 0;
        var elapsed = 0;
        function frame(timestamp) {
          if (settled) return;
          if (previous) elapsed += Math.min(50, timestamp - previous);
          previous = timestamp;
          var t = duration <= 0 ? 1 : clamp01(elapsed / Math.max(1, duration));
          var progress = 1 - Math.pow(1 - t, 1.35);
          var points = holePolygon(progress, geometry);
          // 外扩一点点再裁：蒙版生效时这条边被羽化吃掉，蒙版失效时它就是洞口
          var pad = stageRef.soft ? featherPx(width, height) : 0;
          stageRef.frame.style.clipPath = polygonCss(expandPoints(points, pad, geometry));
          if (stageRef.soft && stageRef.mask) {
            stageRef.mask.path.setAttribute("d", maskPathData(points));
          }
          if (t >= 1) {
            // 满屏的同一帧跳转：地址栏换成目标站，页面内容已经是它
            finish(undefined);
            commit(href);
            return;
          }
          global.requestAnimationFrame(frame);
        }
        global.requestAnimationFrame(frame);
      }

      var settleTimer = 0;

      function beginPending() {
        pendingStart = null;
        if (settleTimer) {
          global.clearTimeout(settleTimer);
          settleTimer = 0;
        }
        if (!settled) start();
      }

      function waitForPaint() {
        if (settled) return;
        // 已经收到过握手（预热够久）：立刻推开
        if (state.signaled) {
          start();
          return;
        }
        pendingStart = { frame: state.frame, start: beginPending };
        settleTimer = global.setTimeout(beginPending, PAINT_SETTLE_MS);
      }

      if (state.loaded) {
        waitForPaint();
      } else {
        readyTimer = global.setTimeout(function () {
          if (settled) return;
          // 超时：不铺洞，普通跳转（总比点了没反应好）
          note("目标站 3s 内未就绪，退化为普通跳转", href);
          if (bead) bead.remove();
          finish("timeout");
          commit(href);
        }, READY_TIMEOUT_MS);
        pollTimer = global.setInterval(function () {
          if (settled) return;
          if (state.failed) {
            note("目标站 iframe 加载失败，退化为普通跳转", href);
            finish("failed");
            if (bead) bead.remove();
            commit(href);
            return;
          }
          if (state.loaded) {
            global.clearInterval(pollTimer);
            pollTimer = 0;
            if (readyTimer) {
              global.clearTimeout(readyTimer);
              readyTimer = 0;
            }
            waitForPaint();
          }
        }, 40);
      }

    });
  }

  /** 交接标记：写在 `window.name` 里，同标签页跨站跳转也能带过去。 */
  var ENTER_FLAG = "jiyi-ink|enter";

  /** 当前页底色：优先 `html`，其次 `body`，都读不到就白。 */
  function pageColor() {
    try {
      var html = global.getComputedStyle(doc.documentElement).backgroundColor;
      if (html && html !== "rgba(0, 0, 0, 0)" && html !== "transparent") return html;
      var body = doc.body ? global.getComputedStyle(doc.body).backgroundColor : "";
      if (body && body !== "rgba(0, 0, 0, 0)" && body !== "transparent") return body;
    } catch (error) {
      /* 读不到就用默认 */
    }
    return "#ffffff";
  }

  /**
   * 落地页的接续：上一步是站点切换过来的话，先盖一层和页面底色相同的整屏遮罩，
   * 等首屏放行（`ready()`）再淡出。
   *
   * 解决的是"墨推开之后还要闪一下目标站自己的 loading 壳"：盖住这一小段，
   * 观感上变成"底色 → 内容直接出现"。
   */
  function installEnterCover() {
    var flagged = false;
    try {
      flagged = global.name === ENTER_FLAG;
      if (flagged) global.name = "";
    } catch (error) {
      return null;
    }
    if (!flagged || !doc.documentElement) return null;
    var cover = doc.createElement("div");
    cover.dataset.jiyiInkEnter = "1";
    cover.setAttribute("aria-hidden", "true");
    cover.style.cssText =
      "position:fixed;inset:0;z-index:" +
      (Z_INDEX + 4) +
      ";pointer-events:none;opacity:1;transition:opacity 240ms linear;background:" +
      pageColor();
    (doc.body || doc.documentElement).appendChild(cover);
    return cover;
  }

  var enterCover = installEnterCover();
  if (enterCover) {
    global.setTimeout(function () {
      clearEnterCover();
    }, 1400);
  }

  function clearEnterCover() {
    if (!enterCover) return;
    var cover = enterCover;
    enterCover = null;
    cover.style.opacity = "0";
    global.setTimeout(function () {
      cover.remove();
    }, 280);
  }

  /** 目标站首屏就绪：在 iframe 里被调用时通知外层，可以推开墨洞了；顶层页面是空调用。 */
  function ready() {
    clearEnterCover();
    if (!global.parent || global.parent === global) return;
    try {
      global.parent.postMessage({ type: "jiyi-ink:ready" }, "*");
    } catch (error) {
      /* 跨源写不了就算了，外层会走兜底等待 */
    }
  }

  /** 正在等某个目标站的握手（同一时刻只可能有一个）。 */
  var pendingStart = null;

  global.addEventListener("message", function (event) {
    var data = event.data;
    if (!data || typeof data !== "object" || data.type !== "jiyi-ink:ready") return;
    Object.keys(warmFrames).forEach(function (key) {
      var item = warmFrames[key];
      if (item && item.frame.contentWindow === event.source) item.signaled = true;
    });
    if (pendingStart && pendingStart.frame.contentWindow === event.source) {
      var run = pendingStart.start;
      pendingStart = null;
      run();
    }
  });

  /**
   * 退化路径的诊断：只在"本该播过场却没播"时打一行 `[jiyi-ink]`。
   *
   * 线上排查时按 F12 看 Console：这一行会说明是哪条分支
   * （站群外 / 减少动效 / 不支持裁切 / 目标站加载失败 / 3s 未就绪）。正常播过场时不打日志。
   */
  function note(reason, detail) {
    try {
      global.console.info("[jiyi-ink]", reason, detail || "");
    } catch (error) {
      /* 没有 console 就算了 */
    }
  }

  /* ============================================================ 守卫 */

  global.addEventListener("pageshow", function (event) {
    if (!event.persisted) return;
    var nodes = doc.querySelectorAll("[data-jiyi-ink-stage],[data-jiyi-ink-target]");
    for (var i = 0; i < nodes.length; i += 1) nodes[i].remove();
    stage = null;
    warmFrames = {};
  });

  /* ============================================================ 导出 */

  global.JiyiInk = {
    version: 3,
    ready: ready,
    switchTo: switchTo,
    warm: warm,
    cancelWarm: cancelWarm,
    dropWarm: dropAllWarm,
    reduced: reduced,
    isDarkPage: isDarkPage,
    inkPalette: inkPalette,
    sameGroup: sameGroup,
    // 自测用
    _internal: {
      holePolygon: holePolygon,
      field: field,
      debugState: function () {
        return Object.keys(warmFrames).map(function (key) {
          var item = warmFrames[key];
          return { key: key, loaded: item.loaded, signaled: !!item.signaled, failed: item.failed };
        }).concat([{ pending: !!pendingStart, stage: !!stage }]);
      },
    },
  };
})(window, document);
