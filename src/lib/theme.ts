import type { BuiltinThemeStyle, CustomTheme, ThemeStyle } from './types';
import { buildThemeRule, customThemeId } from './themeTokens';

/** 内置四套：与 Rust settings::THEME_STYLES 完全一致的字面量（顺序也要一致，选择器按它渲染）。
 *  自定义档不在这里——它们由用户在「界面外观」里新增，id 与令牌都存在库里。 */
export const THEME_STYLES: BuiltinThemeStyle[] = ['glass', 'minimal', 'obsidian', 'cyber'];

const CUSTOM_STYLE_TAG = 'mda-custom-themes';

/**
 * 把已存的自定义主题写成一条运行时规则挂进 <head>。
 *
 * 为什么是注入而不是编译进 tokens.css：那些值是用户粘的，构建期根本不知道会有什么。
 * 为什么安全：`buildThemeRule` 只接受白名单令牌名与逐枚校验过的字面量，输出保证是一行、
 * 只有一对花括号，用户原文从不参与拼接（见 themeTokens.ts）。
 * 每次整块重建，不做增量——留量最容易出的错是"删掉的主题还在生效"。
 */
export function syncCustomThemeStyles(doc: Document, themes: CustomTheme[]): void {
  const head = doc.head;
  if (!head) return;
  let tag = doc.getElementById(CUSTOM_STYLE_TAG);
  if (!themes.length) {
    tag?.remove();
    return;
  }
  if (!tag) {
    tag = doc.createElement('style');
    tag.id = CUSTOM_STYLE_TAG;
    head.appendChild(tag);
  }
  tag.textContent = themes
    .map((t) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(t.tokens);
      } catch {
        return '';
      }
      const partial = (parsed && typeof parsed === 'object' ? parsed : {}) as Record<string, string>;
      return buildThemeRule(t.id, partial);
    })
    .filter(Boolean)
    .join('\n');
}

/** 从注入用的那条规则里读回某一档自定义主题的令牌（预览色块要用它自己的颜色）。 */
export function customThemeTokens(themes: CustomTheme[], style: ThemeStyle): Record<string, string> | null {
  const id = customThemeId(style);
  if (!id) return null;
  const found = themes.find((t) => t.id === id);
  if (!found) return null;
  try {
    return JSON.parse(found.tokens) as Record<string, string>;
  } catch {
    return null;
  }
}

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
