import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { vi } from 'vitest';
import { ThemeMenu } from './ThemeMenu';
import { useTheme } from '../state/theme';
import { useNotify } from '../state/notify';
import { ApiError } from '../lib/api';
import { THEME_LABELS, type ThemeStyle } from '../lib/types';

const mocks = vi.hoisted(() => ({
  theme: vi.fn(),
  setTheme: vi.fn(),
  setReduceMotion: vi.fn(),
}));

vi.mock('../lib/api', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../lib/api')>();
  return { ...mod, api: { ...mod.api, ...mocks } };
});

const STYLES = Object.keys(THEME_LABELS) as ThemeStyle[];

function open() {
  render(<ThemeMenu />);
  fireEvent.click(screen.getByRole('button', { name: '主题与外观' }));
}

const checked = (name: string) => screen.getByRole('menuitemradio', { name }).getAttribute('aria-checked');

beforeEach(() => {
  Object.values(mocks).forEach((fn) => fn.mockReset());
  mocks.theme.mockResolvedValue({ style: 'enterprise-blue', mode: 'system', glassIntensity: 60, reduceMotion: false });
  mocks.setTheme.mockResolvedValue(undefined);
  mocks.setReduceMotion.mockResolvedValue(undefined);
  useTheme.setState({ style: 'enterprise-blue', mode: 'system', glassIntensity: 60, reduceMotion: false, loaded: true });
  useNotify.setState({ items: [] });
});

describe('顶栏主题下拉菜单（ThemeMenu）', () => {
  it('是一列菜单：8 风格 + 3 模式 + 3 玻璃档 + 1 保存，共 15 项，且面板角色是 menu', () => {
    open();
    expect(screen.getByRole('menu', { name: '主题与外观' })).toBeInTheDocument();
    expect(screen.getAllByRole('menuitemradio')).toHaveLength(STYLES.length + 3 + 3);
    expect(screen.getAllByRole('menuitem')).toHaveLength(1);
  });

  it('八枚风格档全在，且只有当前那枚 aria-checked=true', () => {
    open();
    // getByRole 在"找不到"或"找到多于一颗"时都会抛，这一轮 forEach 就是"八枚全在且不重名"
    STYLES.forEach((s) => expect(checked(THEME_LABELS[s])).toBe(String(s === 'enterprise-blue')));
  });

  it('点风格档即时改 DOM，不偷偷落库，也不收起菜单', () => {
    open();
    fireEvent.click(screen.getByRole('menuitemradio', { name: THEME_LABELS['graphite-dark'] }));
    expect(useTheme.getState().style).toBe('graphite-dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('graphite-dark');
    expect(mocks.setTheme).not.toHaveBeenCalled();
    expect(mocks.setReduceMotion).not.toHaveBeenCalled();
    expect(screen.getByRole('menu')).toBeInTheDocument();
  });

  it('明暗三档与玻璃三档预设都改的是同一枚状态', () => {
    open();
    fireEvent.click(screen.getByRole('menuitemradio', { name: '深色' }));
    expect(useTheme.getState().mode).toBe('dark');
    expect(document.documentElement.getAttribute('data-mode')).toBe('dark');

    expect(checked('半透明')).toBe('true');
    fireEvent.click(screen.getByRole('menuitemradio', { name: '满' }));
    expect(useTheme.getState().glassIntensity).toBe(100);
    expect(checked('满')).toBe('true');
    expect(checked('半透明')).toBe('false');
  });

  it('当前玻璃值不在档位上时，三档一个都不打勾，组标题如实报当前值', () => {
    useTheme.setState({ glassIntensity: 45 });
    open();
    ['关闭', '半透明', '满'].forEach((n) => expect(checked(n)).toBe('false'));
    expect(screen.getByRole('group', { name: /当前 45%/ })).toBeInTheDocument();
  });

  it('滑杆与「减少动态效果」都不在这个菜单里', () => {
    open();
    expect(screen.queryByRole('slider')).toBeNull();
    expect(screen.queryByRole('menuitemradio', { name: /减少动态/ })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: /减少动态/ })).toBeNull();
  });

  it('保存外观把三枚值提交给 set_theme，并报成功、收起菜单', async () => {
    open();
    fireEvent.click(screen.getByRole('menuitemradio', { name: THEME_LABELS['power-grid-green'] }));
    fireEvent.click(screen.getByRole('menuitemradio', { name: '浅色' }));
    fireEvent.click(screen.getByRole('menuitemradio', { name: '关闭' }));
    fireEvent.click(screen.getByRole('menuitem', { name: '保存外观' }));
    await waitFor(() => expect(mocks.setTheme).toHaveBeenCalledWith('power-grid-green', 'light', 0));
    await waitFor(() => expect(mocks.setReduceMotion).toHaveBeenCalledWith(false));
    await waitFor(() =>
      expect(useNotify.getState().items.some((i) => i.kind === 'success' && i.text === '外观已保存并即时生效')).toBe(true),
    );
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('会话锁定时如实说"仅本窗口生效"，不报已保存', async () => {
    mocks.setTheme.mockRejectedValue(new ApiError({ code: 'SESSION_LOCKED', message: '保险库已锁定' }));
    open();
    fireEvent.click(screen.getByRole('menuitem', { name: '保存外观' }));
    await waitFor(() =>
      expect(
        useNotify.getState().items.some(
          (i) => i.kind === 'danger' && i.text === '外观需解锁后才能保存到后端：当前更改仅在本窗口即时生效。',
        ),
      ).toBe(true),
    );
    expect(useNotify.getState().items.some((i) => i.kind === 'success')).toBe(false);
  });
});
