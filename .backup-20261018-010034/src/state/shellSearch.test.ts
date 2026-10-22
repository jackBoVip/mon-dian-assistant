import { vi } from 'vitest';
import { useShellSearch } from './shellSearch';

/**
 * 顶栏搜索的防抖语义：输入逐字符进 keyword（AppShell 靠它立刻跳回台账页），
 * 进 debouncedKeyword 要等 250ms——这条节奏原本是 AccountsPage 里的定时器，
 * 搜索框搬到顶栏后收在这里，所以单独验它。
 */
beforeEach(() => {
  vi.useFakeTimers();
  useShellSearch.setState({ keyword: '', debouncedKeyword: '' });
});

afterEach(() => {
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
});

describe('顶栏搜索的防抖（state/shellSearch）', () => {
  it('250ms 内不产出防抖值，到点才产出', () => {
    useShellSearch.getState().setKeyword('OA');
    expect(useShellSearch.getState().keyword).toBe('OA');
    expect(useShellSearch.getState().debouncedKeyword).toBe('');

    vi.advanceTimersByTime(249);
    expect(useShellSearch.getState().debouncedKeyword).toBe('');
    vi.advanceTimersByTime(1);
    expect(useShellSearch.getState().debouncedKeyword).toBe('OA');
  });

  it('逐字符输入只在停手后产出一次：前一次定时器被覆盖', () => {
    useShellSearch.getState().setKeyword('O');
    vi.advanceTimersByTime(200);
    useShellSearch.getState().setKeyword('OA');
    vi.advanceTimersByTime(200);
    expect(useShellSearch.getState().debouncedKeyword).toBe('');
    vi.advanceTimersByTime(50);
    expect(useShellSearch.getState().debouncedKeyword).toBe('OA');
  });

  it('产出前 trim：尾随空格不会变成一个非空关键字', () => {
    useShellSearch.getState().setKeyword('  计费  ');
    vi.advanceTimersByTime(250);
    expect(useShellSearch.getState().debouncedKeyword).toBe('计费');
  });

  it('清空把两个值一起归零，并取消还没到点的定时器', () => {
    useShellSearch.getState().setKeyword('OA');
    useShellSearch.getState().clear();
    expect(useShellSearch.getState().keyword).toBe('');
    vi.advanceTimersByTime(1000);
    expect(useShellSearch.getState().debouncedKeyword).toBe('');
  });
});
