import type { AppearanceMode, ThemeStyle } from './types';

/** 与 Rust settings::THEME_STYLES 完全一致的字面量（顺序也要一致，选择器按它渲染）。 */
export const THEME_STYLES: ThemeStyle[] = [
  'enterprise-blue',
  'power-grid-green',
  'light-clean',
  'graphite-dark',
  'liquid-glass',
  'fluent-mica',
  'material-3',
  'high-contrast',
];

export const APPEARANCE_MODES: AppearanceMode[] = ['system', 'light', 'dark'];

const GLASS_STYLES: ThemeStyle[] = ['liquid-glass', 'fluent-mica'];

/** 主题“风格”与外观“模式”分离：写入 data-* 属性，由 tokens.css 消费。 */
export interface ThemeState {
  style: ThemeStyle;
  mode: AppearanceMode;
  glassIntensity: number;
  reduceMotion: boolean;
}

export function resolveMode(mode: AppearanceMode, systemPrefersDark: boolean): 'light' | 'dark' {
  if (mode === 'light') return 'light';
  if (mode === 'dark') return 'dark';
  return systemPrefersDark ? 'dark' : 'light';
}

/**
 * 玻璃效果降级：强度为 0、或系统开启“减少透明度”、或主题本身非玻璃主题时，
 * 使用完全不透明回退（data-glass=off），避免文字可读性受损。
 *
 * 换主题的那一帧全站同时补间颜色会糊成一片（每个组件都有 color 类 transition），
 * 所以只在改属性这一帧里把 transition 压掉：注入规则 → 改 → 强制回流让规则生效 →
 * 下一帧移除。压的是"切换瞬间"，不是常态——移除后悬停与按压的动效照旧。
 */
export function applyTheme(root: HTMLElement, state: ThemeState, system: { prefersDark: boolean; reduceMotion: boolean }): void {
  const doc = root.ownerDocument;
  const guard = doc.createElement('style');
  guard.textContent = '*,*::before,*::after{transition:none!important}';
  doc.head?.appendChild(guard);
  try {
    root.dataset.theme = state.style;
    root.dataset.mode = resolveMode(state.mode, system.prefersDark);

    const intensity = clampIntensity(state.glassIntensity);
    const glassOn = GLASS_STYLES.includes(state.style) && intensity > 0 && !system.reduceMotion;
    root.dataset.glass = glassOn ? 'on' : 'off';
    root.style.setProperty('--glass-intensity', String(intensity));
    root.style.setProperty('--glass-alpha', String(0.55 + (100 - intensity) * 0.0045));

    const motionOff = state.reduceMotion || system.reduceMotion;
    root.dataset.reduceMotion = motionOff ? 'true' : 'false';
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

export function clampIntensity(value: number): number {
  if (!Number.isFinite(value)) return 60;
  return Math.min(100, Math.max(0, Math.round(value)));
}

export function systemPreferences(): { prefersDark: boolean; reduceMotion: boolean } {
  const canQuery = typeof window !== 'undefined' && typeof window.matchMedia === 'function';
  return {
    prefersDark: canQuery ? window.matchMedia('(prefers-color-scheme: dark)').matches : false,
    reduceMotion: canQuery ? window.matchMedia('(prefers-reduced-motion: reduce)').matches : false,
  };
}
