import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TopBar } from './TopBar';
import { useShellSearch } from '../state/shellSearch';
import { useTheme } from '../state/theme';

const mocks = vi.hoisted(() => ({
  theme: vi.fn(),
  setTheme: vi.fn(),
  setReduceMotion: vi.fn(),
}));

vi.mock('../lib/api', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../lib/api')>();
  return { ...mod, api: { ...mod.api, ...mocks } };
});

/**
 * 顶栏搜索框在收起态只有 36px，实测输入框本体只剩 2px 宽（图标 14px + 左右各 10px padding 把它挤没了）。
 * 展开靠 `:focus-within`，所以「点得着输入框」是这条链路唯一的一环——容器是 div 时鼠标无从聚焦，
 * 框就永远停在 36px，看上去是一颗图标按钮而不是搜索框。
 * 这里守的是结构（容器必须是 label、图标必须在 label 内、可及名不能被抢走）：
 * 「点 label 即聚焦输入框」是 HTML 原生激活行为，Chromium 实测三点（5%/50%/95%，正中是图标）
 * 全部聚焦成功并把框撑到 280px，但 jsdom 没实现这条激活行为、也不做层叠，所以断言不到那一半。
 */
describe('顶栏搜索框（TopBar）', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((fn) => fn.mockReset());
    mocks.theme.mockResolvedValue({ style: 'enterprise-blue', mode: 'system', glassIntensity: 60, reduceMotion: false });
    useTheme.setState({ style: 'enterprise-blue', mode: 'system', glassIntensity: 60, reduceMotion: false, loaded: true });
    useShellSearch.getState().clear();
  });

  it('搜索框的容器是 label，且图标在 label 内（点框内任意一处都由原生激活行为换成聚焦）', () => {
    const { container } = render(<TopBar />);
    const box = container.querySelector('.topbar-search');
    expect(box?.tagName).toBe('LABEL');
    const icon = container.querySelector('.topbar-search-icon');
    expect(box?.contains(icon as Node)).toBe(true);
  });

  it('包进 label 后输入框的可及名仍来自 aria-label，没被空标签抢走', () => {
    render(<TopBar />);
    const input = screen.getByRole('textbox', { name: '搜索系统与账号台账' });
    // label 自身没有文字节点，此时若可及名变成空串，上面那句就查不到东西——这里再钉一次取值
    expect(input.getAttribute('aria-label')).toBe('搜索系统与账号台账');
  });

  it('键入即写进共享 keyword，清空走 clear', () => {
    render(<TopBar />);
    const input = screen.getByRole('textbox', { name: '搜索系统与账号台账' });
    fireEvent.change(input, { target: { value: 'OA' } });
    expect(useShellSearch.getState().keyword).toBe('OA');
    fireEvent.change(input, { target: { value: '' } });
    expect(useShellSearch.getState().keyword).toBe('');
  });

  it('用户区只显示昵称，不再出现「本软件用户：」这段前缀', () => {
    render(<TopBar />);
    expect(screen.queryByText(/本软件用户/)).toBeNull();
    expect(screen.getByRole('textbox', { name: '搜索系统与账号台账' })).toBeInTheDocument();
  });
});
