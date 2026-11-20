import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyTheme, customThemeRulePresent, syncCustomThemeStyles, THEME_STYLES, customThemeTokens, type ThemeState } from './theme';
import { customThemeStyle } from './types';
import { THEME_TOKEN_NAMES } from './themeTokens';

const SYS = { reduceMotion: false };

function state(over: Partial<ThemeState> = {}): ThemeState {
  return { style: 'glass', reduceMotion: false, ...over };
}

/**
 * applyTheme 会在改属性的那一帧注入一条 `transition:none` 规则，下一帧撤掉。
 * 这条测试守的是"撤掉"：漏撤就等于全站永久没有悬停/按压动效，而那正是换皮想要的东西。
 */
describe('applyTheme 切主题时压掉补间，且只压一帧', () => {
  const root = document.documentElement;

  afterEach(() => {
    vi.restoreAllMocks();
    document.head.querySelectorAll('style').forEach((s) => s.remove());
  });

  it('改属性期间 head 里有 transition:none 的守卫，回调没跑之前不移除', () => {
    const queued: Array<FrameRequestCallback> = [];
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      queued.push(cb);
      return queued.length;
    });

    applyTheme(root, state({ style: 'obsidian' }), SYS);

    expect(root.dataset.theme).toBe('obsidian');
    // 明暗与玻璃两轴在 S 轮作废：applyTheme 不得再往根元素写回这两个属性
    expect(root.hasAttribute('data-mode')).toBe(false);
    expect(root.hasAttribute('data-glass')).toBe(false);
    expect(queued).toHaveLength(1);
    const guard = [...document.head.querySelectorAll('style')].filter((s) =>
      s.textContent?.includes('transition:none'),
    );
    expect(guard).toHaveLength(1);

    queued[0](0);
    expect(guard[0].isConnected).toBe(false);
  });

  it('重复调用不会攒下一堆守卫：每次调用结束时都只留待撤的那一条', () => {
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      cb(0);
      return 1;
    });
    for (const style of THEME_STYLES) {
      applyTheme(root, state({ style }), SYS);
    }
    expect(
      [...document.head.querySelectorAll('style')].filter((s) => s.textContent?.includes('transition:none')),
    ).toHaveLength(0);
    expect(root.dataset.theme).toBe(THEME_STYLES[THEME_STYLES.length - 1]);
  });

  it('没有 requestAnimationFrame 的环境里同步移除，不留残余样式', () => {
    const original = window.requestAnimationFrame;
    delete (window as { requestAnimationFrame?: unknown }).requestAnimationFrame;
    try {
      applyTheme(root, state(), SYS);
    } finally {
      window.requestAnimationFrame = original;
    }
    expect(
      [...document.head.querySelectorAll('style')].filter((s) => s.textContent?.includes('transition:none')),
    ).toHaveLength(0);
    expect(root.dataset.theme).toBe('glass');
  });
});

/** 减少动态效果有两个来源：本机设置里的开关，和操作系统的 prefers-reduced-motion。任一为真就要压掉动效。 */
describe('applyTheme 的 reduceMotion 取两路或值', () => {
  const root = document.documentElement;

  afterEach(() => {
    vi.restoreAllMocks();
    document.head.querySelectorAll('style').forEach((s) => s.remove());
  });

  it.each([
    [true, false, 'true'],
    [false, true, 'true'],
    [false, false, 'false'],
  ] as const)('state=%s system=%s → data-reduce-motion=%s', (fromState, fromSystem, expected) => {
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      cb(0);
      return 1;
    });
    applyTheme(root, state({ reduceMotion: fromState }), { reduceMotion: fromSystem });
    expect(root.dataset.reduceMotion).toBe(expected);
  });
});

/**
 * `themeTokens.customThemeId` 是构造器、`types.customThemeId` 是提取器，两枚同名而语义相反。
 * 2026-11-20 立主题守卫时发现 lib/theme.ts 从前者引了它，于是 customThemeTokens 一直在拿
 * `t.id` 和 'custom-custom-x' 比——永远不等，预览色块静默读不到自己那套令牌。
 * 这两条守的就是"引对那一枚"，换 import 时忘了会直接红。
 */
describe('自定义主题 id 的两枚同名函数不许用混', () => {
  const full = (over: Record<string, string> = {}) => ({
    ...Object.fromEntries(THEME_TOKEN_NAMES.map((n) => [n, '#101010'])),
    '--blur': 'blur(12px)',
    ...over,
  });

  it('customThemeTokens 取得到那一档自己的令牌（内置档返回 null）', () => {
    const themes = [{ id: 'brand', name: '本单位', tokens: JSON.stringify(full({ '--t-primary': '#ff0000' })) }];
    expect(customThemeTokens(themes as never, customThemeStyle('brand'))).toMatchObject({ '--t-primary': '#ff0000' });
    expect(customThemeTokens(themes as never, 'glass')).toBeNull();
    expect(customThemeTokens(themes as never, customThemeStyle('nope'))).toBeNull();
  });

  it('customThemeRulePresent：注入成功才算在，缺规则/内置档各自的答', () => {
    document.head.querySelectorAll('style').forEach((el) => el.remove());
    const style = customThemeStyle('brand');
    expect(customThemeRulePresent(document, style)).toBe(false);
    syncCustomThemeStyles(document, [{ id: 'brand', name: '本单位', tokens: JSON.stringify(full()) }] as never);
    expect(customThemeRulePresent(document, style)).toBe(true);
    // 内置档不需要运行时规则，"在不在"这个问题对它无意义
    expect(customThemeRulePresent(document, 'obsidian')).toBe(true);
    document.head.querySelectorAll('style').forEach((el) => el.remove());
  });
});
