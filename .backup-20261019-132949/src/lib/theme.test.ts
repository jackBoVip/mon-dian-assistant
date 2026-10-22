import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyTheme, THEME_STYLES, type ThemeState } from './theme';

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
