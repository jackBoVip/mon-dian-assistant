import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyTheme, type ThemeState } from './theme';

const SYS = { prefersDark: false, reduceMotion: false };

function state(over: Partial<ThemeState> = {}): ThemeState {
  return {
    style: 'enterprise-blue',
    mode: 'dark',
    glassIntensity: 60,
    reduceMotion: false,
    ...over,
  } as ThemeState;
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

    applyTheme(root, state({ style: 'graphite-dark', mode: 'light' }), SYS);

    expect(root.dataset.theme).toBe('graphite-dark');
    expect(root.dataset.mode).toBe('light');
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
    for (const style of ['enterprise-blue', 'liquid-glass', 'high-contrast'] as const) {
      applyTheme(root, state({ style }), SYS);
    }
    expect(
      [...document.head.querySelectorAll('style')].filter((s) => s.textContent?.includes('transition:none')),
    ).toHaveLength(0);
    expect(root.dataset.theme).toBe('high-contrast');
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
    expect(root.dataset.theme).toBe('enterprise-blue');
  });
});
