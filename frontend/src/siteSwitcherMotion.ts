/**
 * 站点切换面板的弹簧与几何 —— 拾分 / 视觉工作台 / 此刻 三站共用同一份。
 *
 * 积分方式照 KnollMorphMenu：8ms 子步显式积分，到位判据 `|Δ|<0.04 && |v|<0.08` 直接取整；
 * 差别只在方向（从侧栏底部图标向上展开）和「卡组是叠加式翻牌，不是替换」。
 *
 * 几何全部由「项数 → 面板高度 → 卡面高度 → 卡面宽度」一条链推出来，
 * 所以项变多时面板长高、卡组等比放大，不需要额外配置。
 */

export interface SpringState {
  value: number;
  target: number;
  velocity: number;
  stiffness: number;
  damping: number;
}

export function spring(value: number, stiffness: number, damping: number): SpringState {
  return { value, target: value, velocity: 0, stiffness, damping };
}

/** 与参考一致的子步长（秒） */
const SUBSTEP = 0.008;
/** 到位判据 */
const EPS_VALUE = 0.04;
const EPS_VELOCITY = 0.08;

export interface TickResult {
  moving: boolean;
}

/** 推进一帧：`dtMs` 为距上一帧的毫秒数（内部会夹到 50ms 并切成 8ms 子步） */
export function stepSprings(items: SpringState[], dtMs: number): TickResult {
  const elapsed = Math.min(0.05, Math.max(0.001, dtMs / 1000));
  const steps = Math.ceil(elapsed / SUBSTEP);
  const dt = elapsed / steps;
  let moving = false;
  for (const item of items) {
    for (let i = 0; i < steps; i++) {
      const force = item.stiffness * (item.target - item.value) - item.damping * item.velocity;
      item.velocity += force * dt;
      item.value += item.velocity * dt;
    }
    if (Math.abs(item.target - item.value) < EPS_VALUE && Math.abs(item.velocity) < EPS_VELOCITY) {
      item.value = item.target;
      item.velocity = 0;
    } else {
      moving = true;
    }
  }
  return { moving };
}

/**
 * 关闭用的弹簧参数：收起比展开快得多（约 200ms 落位，展开约 500ms）。
 * 展开是一段"要看清内容"的过程，收起来只是回应一次「我不要了」，拖长会显得迟钝。
 */
export const CLOSE_STIFFNESS = 620;
export const CLOSE_DAMPING = 48;

export function applyCloseTempo(items: SpringState[]): void {
  for (const item of items) {
    item.stiffness = CLOSE_STIFFNESS;
    item.damping = CLOSE_DAMPING;
  }
}

/** reduced-motion 或者要「直接落位」时用：所有弹簧一步到目标 */
export function settleSprings(items: SpringState[]): void {
  for (const item of items) {
    item.value = item.target;
    item.velocity = 0;
  }
}

/* ---------------------------------------------------------------- 几何 */

/**
 * 展开用的弹簧参数。
 *
 * 参考值（320/36、280/32）落位约 500ms，实测在真站里显得拖 —— 这是"点一下开一张面板"的动作，
 * 不是一段要看清的过程。调到这里：落位约 220–260ms，ζ 略小于 1，收尾带一点点过冲，读起来是"弹开"。
 */
export const OPEN_NAV = { stiffness: 470, damping: 40 };
export const OPEN_BODY = { stiffness: 430, damping: 38 };
export const OPEN_CARD = { stiffness: 400, damping: 38 };

export const ROW_H = 40; // 列表行高
export const LIST_PAD = 8; // 列表上下留白
export const CARD_ASPECT = 0.645; // 卡面高宽比（参考 291:451）
export const CARD_OVER_LIST = 1.18; // 卡面比文本列宽（参考 1.074，站名短，收窄一档）
export const MIN_PANEL_H = 328; // 3 项时的面板高度
export const STACK_PANEL_W = 280; // 窄屏固定宽度
export const STACK_DECK_H = 180; // 窄屏卡面高度
export const GAP = 9; // 两列间距
export const DECK_PAD = 8; // 卡组四周内缩
export const ANCHOR_OFFSET = 8; // 面板底边离触发图标上沿的距离
export const NARROW_BREAKPOINT = 820; // 视口窄于这个直接切 stacked
export const ROOM_FOR_DESKTOP = 440; // 图标右侧剩余不足这个也切 stacked

export interface PanelGeometry {
  width: number;
  height: number;
  listWidth: number;
  deckWidth: number;
  stacked: boolean;
}

/**
 * 由项数算出面板的目标几何。
 * `triggerTop` 是触发图标到视口顶的距离 —— 面板向上展开，不能顶出视口。
 */
export function measurePanel(count: number, options: {
  triggerLeft: number;
  triggerTop: number;
  viewportWidth: number;
  forceStacked?: boolean;
}): PanelGeometry {
  const { triggerLeft, triggerTop, viewportWidth, forceStacked } = options;
  const stacked =
    Boolean(forceStacked) ||
    viewportWidth <= NARROW_BREAKPOINT ||
    viewportWidth - triggerLeft < ROOM_FOR_DESKTOP;

  if (count <= 0) {
    return { width: STACK_PANEL_W, height: 200, listWidth: STACK_PANEL_W, deckWidth: 0, stacked };
  }

  const natural = count * ROW_H + LIST_PAD * 2;
  const roomAbove = triggerTop - 20;

  if (stacked) {
    const height = Math.max(120, Math.min(natural, roomAbove - STACK_DECK_H - DECK_PAD * 2 - GAP));
    return {
      width: STACK_PANEL_W,
      height,
      listWidth: STACK_PANEL_W,
      deckWidth: STACK_PANEL_W,
      stacked: true,
    };
  }

  const height = Math.max(MIN_PANEL_H, Math.min(natural, Math.max(MIN_PANEL_H, roomAbove)));
  const deckWidth = Math.round((height - DECK_PAD * 2) * CARD_ASPECT) + DECK_PAD;
  const listWidth = Math.round((deckWidth - DECK_PAD) / CARD_OVER_LIST);
  return { width: listWidth + GAP + deckWidth, height, listWidth, deckWidth, stacked: false };
}

/** 面板的总高度：stacked 还要加上卡面那一块（`geometry.height` 只是列表部分） */
export function panelTotalHeight(geometry: PanelGeometry): number {
  return geometry.stacked ? geometry.height + STACK_DECK_H + DECK_PAD * 2 + GAP : geometry.height;
}

export interface PanelAnchor {
  left: number;
  top: number;
  bottom: number;
}

/**
 * 面板落点：默认从触发图标上沿**向上**展开（侧栏在底部）。
 * 触发器本身在视口上方（手机顶部品牌条）时改向下 —— 否则面板会顶出屏幕外。
 */
export function panelPosition(
  geometry: PanelGeometry,
  anchor: PanelAnchor,
  viewportWidth: number,
  viewportHeight: number,
) {
  const left = Math.max(8, Math.min(anchor.left, viewportWidth - geometry.width - 12));
  const roomAbove = anchor.top - ANCHOR_OFFSET;
  const roomBelow = viewportHeight - anchor.bottom - ANCHOR_OFFSET;
  if (roomAbove < panelTotalHeight(geometry) + 8 && roomBelow > roomAbove) {
    return { left, top: anchor.bottom + ANCHOR_OFFSET, bottom: null as number | null };
  }
  return { left, top: null as number | null, bottom: viewportHeight - anchor.top + ANCHOR_OFFSET };
}
