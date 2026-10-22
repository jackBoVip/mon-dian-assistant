import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { vi } from 'vitest';
import { ThemeMenu } from './ThemeMenu';
import { useTheme } from '../state/theme';
import { useNotify } from '../state/notify';
import { ApiError } from '../lib/api';
import { THEME_LABELS, type ThemeStyle } from '../lib/types';

/**
 * 顶栏「切换界面风格」下拉的测试基准。
 * S 轮照原型收敛成严格四套主题：没有明暗第三轴、没有玻璃强度档、也没有高对比度那一档。
 * 二批按交付方口径改成**选中即存**：菜单里只剩四行，既没有"保存"那一行，也不弹成功/失败提示，
 * 所以这一份既要钉"四套全在且只有当前那套打勾"，也要钉"撤下的那三组控件与保存行不再出现"——
 * 界面上少一颗钮不代表状态里少一个字段，两处得一起对上，否则点一行会往 set_theme 发一个后端不认识的值。
 */
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
  fireEvent.click(screen.getByRole('button', { name: '切换界面风格' }));
  return screen.getByRole('menu', { name: '切换界面风格' });
}

const checked = (name: string) => screen.getByRole('menuitemradio', { name }).getAttribute('aria-checked');

beforeEach(() => {
  Object.values(mocks).forEach((fn) => fn.mockReset());
  mocks.theme.mockResolvedValue({ style: 'glass', reduceMotion: false });
  mocks.setTheme.mockResolvedValue(undefined);
  mocks.setReduceMotion.mockResolvedValue(undefined);
  useTheme.setState({ style: 'glass', reduceMotion: false, loaded: true });
  document.documentElement.removeAttribute('data-theme');
  useNotify.setState({ items: [] });
});

describe('主题下拉就是原型那四套', () => {
  it('只有四行风格，面板角色是 menu；保存那一行与分隔线都撤了', () => {
    expect(STYLES).toEqual(['glass', 'minimal', 'obsidian', 'cyber']);
    const menu = open();
    expect(within(menu).getAllByRole('menuitemradio')).toHaveLength(4);
    expect(screen.queryAllByRole('menuitem')).toHaveLength(0);
    expect(screen.queryByRole('separator')).toBeNull();
    expect(screen.queryByText('保存界面风格')).toBeNull();
  });

  it('每套各有名片且名字唯一，只有当前那套 aria-checked=true', () => {
    open();
    STYLES.forEach((s) => expect(checked(THEME_LABELS[s])).toBe(String(s === 'glass')));
    // 名片是纯视觉件：色块不能进可及名，否则按钮名会变成"色块 极光液态玻璃"
    STYLES.forEach((s) => {
      const swatch = document.querySelector(`.theme-preview[data-preview="${s}"]`);
      expect(swatch?.getAttribute('aria-hidden')).toBe('true');
    });
  });

  it('点一套即时改 DOM 主题并落库，不收起菜单（要连着比几套）', async () => {
    const menu = open();
    fireEvent.click(within(menu).getByRole('menuitemradio', { name: THEME_LABELS.obsidian }));
    expect(useTheme.getState().style).toBe('obsidian');
    expect(document.documentElement.getAttribute('data-theme')).toBe('obsidian');
    await waitFor(() => expect(mocks.setTheme).toHaveBeenCalledWith('obsidian'));
    expect(screen.getByRole('menu')).toBeInTheDocument();
    expect(checked(THEME_LABELS.obsidian)).toBe('true');
    expect(checked(THEME_LABELS.glass)).toBe('false');
  });

  it('明暗第三轴、玻璃强度档、高对比度这一轮全撤，菜单里不该还留着入口', () => {
    const menu = open();
    ['深色', '浅色', '跟随系统', '关闭', '半透明', '满'].forEach((n) =>
      expect(within(menu).queryByRole('menuitemradio', { name: n })).toBeNull(),
    );
    expect(within(menu).queryByRole('group', { name: /当前 \d+%/ })).toBeNull();
    expect(within(menu).queryByRole('slider')).toBeNull();
    expect(within(menu).queryByRole('menuitemradio', { name: /减少动态/ })).toBeNull();
    // 状态里也没有这三个字段：落库时只会发出后端认识的 style
    expect(useTheme.getState()).not.toHaveProperty('mode');
    expect(useTheme.getState()).not.toHaveProperty('glassIntensity');
  });
});

describe('选中即存，一声不吭', () => {
  it('连点两套各发一次 set_theme，不发 set_reduce_motion（那条要会话，会撞 SESSION_LOCKED）', async () => {
    const menu = open();
    fireEvent.click(within(menu).getByRole('menuitemradio', { name: THEME_LABELS.cyber }));
    await waitFor(() => expect(mocks.setTheme).toHaveBeenCalledWith('cyber'));
    fireEvent.click(within(menu).getByRole('menuitemradio', { name: THEME_LABELS.minimal }));
    await waitFor(() => expect(mocks.setTheme).toHaveBeenCalledWith('minimal'));
    expect(mocks.setTheme).toHaveBeenCalledTimes(2);
    expect(mocks.setReduceMotion).not.toHaveBeenCalled();
  });

  it('成功不弹提示；后端拒了也不弹，本窗口的外观照样已经变了', async () => {
    const menu = open();
    fireEvent.click(within(menu).getByRole('menuitemradio', { name: THEME_LABELS.cyber }));
    await waitFor(() => expect(mocks.setTheme).toHaveBeenCalled());
    expect(useNotify.getState().items).toHaveLength(0);

    mocks.setTheme.mockRejectedValue(new ApiError({ code: 'SESSION_LOCKED', message: '保险库已锁定' }));
    fireEvent.click(within(menu).getByRole('menuitemradio', { name: THEME_LABELS.obsidian }));
    await waitFor(() => expect(mocks.setTheme).toHaveBeenCalledWith('obsidian'));
    expect(document.documentElement.getAttribute('data-theme')).toBe('obsidian');
    expect(useNotify.getState().items).toHaveLength(0);
  });
});
