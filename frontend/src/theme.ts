/**
 * 日夜主题：状态、持久化、「首帧前落值」三件事。
 *
 * 与导航页同一套约定：
 * - 存在 `localStorage: cike:theme`，值只有 `day` / `night`；
 * - **没存过就是 day** —— 这个产品的底子一直是暖纸色，默认翻黑会吓人一跳；
 * - 首帧之前由 `index.html` 里那段内联脚本把 `data-theme` 写到 `<html>`，
 *   避免「先白一下再变黑」。
 *
 * 颜色全部由 `styles.css` 的令牌驱动（`:root[data-theme="night"]` 那一组），
 * 所以这里只管属性，不碰样式。
 */

export type Theme = "day" | "night";

const KEY = "cike:theme";

export function readTheme(): Theme {
  try {
    const saved = localStorage.getItem(KEY);
    return saved === "night" || saved === "day" ? saved : "day";
  } catch {
    // 隐私模式下 localStorage 会抛异常：退回亮色，而不是白屏。
    return "day";
  }
}

export function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme === "night" ? "dark" : "light";
  // 移动端地址栏颜色跟着主题走；与 index.html 里的静态值保持一致。
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", theme === "night" ? "#101210" : "#f7f5ee");
}

export function saveTheme(theme: Theme): void {
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    /* 存不了就只在本次会话生效 */
  }
}
