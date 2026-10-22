import type { ThemeStyle } from './types';

/** 与 Rust settings::THEME_STYLES 完全一致的字面量（顺序也要一致，选择器按它渲染）。 */
export const THEME_STYLES: ThemeStyle[] = ['glass', 'minimal', 'obsidian', 'cyber'];

/**
 * S 轮起只剩一条轴：选哪套主题。四套各自把明暗身份、模糊值、玻璃透明度钉死在自己的
 * [data-theme] 块里，所以没有 data-mode、也没有玻璃强度。reduceMotion 是唯一的外加开关。
 */
export interface ThemeState {
  style: ThemeStyle;
  reduceMotion: boolean;
}

/**
 * 换主题的那一帧全站同时补间颜色会糊成一片（每个组件都有 color 类 transition），
 * 所以只在改属性这一帧里把 transition 压掉：注入规则 → 改 → 强制回流让规则生效 →
 * 下一帧移除。压的是"切换瞬间"，不是常态——移除后悬停与按压的动效照旧。
 */
export function applyTheme(root: HTMLElement, state: ThemeState, system: { reduceMotion: boolean }): void {
  const doc = root.ownerDocument;
  const guard = doc.createElement('style');
  guard.textContent = '*,*::before,*::after{transition:none!important}';
  doc.head?.appendChild(guard);
  try {
    root.dataset.theme = state.style;
    root.dataset.reduceMotion = state.reduceMotion || system.reduceMotion ? 'true' : 'false';
  } finally {
    void doc.documentElement.offsetHeight;
    const drop = () => guard.remove();
    if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
      window.requestAnimationFrame(drop);
    } else {
      drop();
    }
  }
}

export function systemPreferences(): { reduceMotion: boolean } {
  const canQuery = typeof window !== 'undefined' && typeof window.matchMedia === 'function';
  return { reduceMotion: canQuery ? window.matchMedia('(prefers-reduced-motion: reduce)').matches : false };
}
