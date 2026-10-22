import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi } from 'vitest';
import { LauncherSettingsPage } from './LauncherSettingsPage';
import type { LauncherPreferences } from '../lib/types';
import { useNotify } from '../state/notify';

const mocks = vi.hoisted(() => ({
  launcherPreferences: vi.fn(),
  updateSetting: vi.fn(),
  setLauncherEnabled: vi.fn(),
}));

vi.mock('../lib/api', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../lib/api')>();
  return { ...mod, api: { ...mod.api, ...mocks } };
});

function prefs(show: boolean, rank = true): LauncherPreferences {
  return {
    shortcut: 'CmdOrCtrl+Alt+Space',
    default: 'CmdOrCtrl+Alt+Space',
    enabled: true,
    showRecentWhenEmpty: show,
    rankRecentFavorite: rank,
    resultLimit: 20,
    syntax: [['oa，web', '两个条件同时命中']],
  };
}

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  render(
    <QueryClientProvider client={qc}>
      <LauncherSettingsPage />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  mocks.launcherPreferences.mockReset();
  mocks.updateSetting.mockReset();
  mocks.setLauncherEnabled.mockReset();
  mocks.launcherPreferences.mockResolvedValue(prefs(true));
  mocks.updateSetting.mockResolvedValue(undefined);
  useNotify.setState({ items: [] });
});

describe('空查询推荐的开关（需求 §285：应由设置启用）', () => {
  it('显示后端当前值，并把"关闭推荐"提交到 update_setting 的确切键值', async () => {
    renderPage();
    const toggle = await screen.findByRole('button', { name: '关闭推荐' });
    expect(screen.getByText('显示')).toBeInTheDocument();

    fireEvent.click(toggle);
    await waitFor(() => expect(mocks.updateSetting).toHaveBeenCalledWith('quick_launcher_show_recent', 'false'));
  });

  it('提交成功后重新读取设置：界面随之变成"不显示/开启推荐"，不让操作者靠猜确认生效', async () => {
    mocks.launcherPreferences.mockResolvedValueOnce(prefs(true)).mockResolvedValue(prefs(false));
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: '关闭推荐' }));

    await waitFor(() => expect(mocks.launcherPreferences).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByRole('button', { name: '开启推荐' })).toBeInTheDocument());
    expect(screen.getByText('不显示')).toBeInTheDocument();
  });

  it('当前为关闭时按钮反向提交 true', async () => {
    mocks.launcherPreferences.mockResolvedValue(prefs(false));
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: '开启推荐' }));
    await waitFor(() => expect(mocks.updateSetting).toHaveBeenCalledWith('quick_launcher_show_recent', 'true'));
  });

  it('后端拒绝（如无 SYS_SECURITY 权限）时把后端文案报出来，界面不假装已改', async () => {
    mocks.updateSetting.mockRejectedValue({ code: 'FORBIDDEN', message: '没有权限修改该设置' });
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: '关闭推荐' }));

    await waitFor(() =>
      expect(useNotify.getState().items.some((i) => i.kind === 'danger' && i.text === '没有权限修改该设置')).toBe(true),
    );
    expect(mocks.launcherPreferences).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: '关闭推荐' })).toBeInTheDocument();
  });
});

describe('排序档开关（需求 line 294：最近使用/收藏这一档可配置）', () => {
  it('显示后端当前档位，关闭时提交 quick_launcher_rank_recent_favorite=false，并在成功后跟着后端翻转', async () => {
    mocks.launcherPreferences.mockResolvedValueOnce(prefs(true, true)).mockResolvedValue(prefs(true, false));
    renderPage();
    expect(await screen.findByText('按收藏/默认/最近排序')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '关闭该排序档' }));
    await waitFor(() => expect(mocks.updateSetting).toHaveBeenCalledWith('quick_launcher_rank_recent_favorite', 'false'));
    await waitFor(() => expect(screen.getByRole('button', { name: '开启该排序档' })).toBeInTheDocument());
    expect(screen.getByText('只按匹配等级排序')).toBeInTheDocument();
  });

  it('当前关闭时反向提交 true；两个开关各写各的键，不会互相覆盖', async () => {
    mocks.launcherPreferences.mockResolvedValue(prefs(true, false));
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: '开启该排序档' }));
    await waitFor(() => expect(mocks.updateSetting).toHaveBeenCalledWith('quick_launcher_rank_recent_favorite', 'true'));
    expect(mocks.updateSetting.mock.calls.every(([k]) => k !== 'quick_launcher_show_recent')).toBe(true);
  });

  it('后端拒绝时不刷新也不假装已改', async () => {
    mocks.updateSetting.mockRejectedValue({ code: 'FORBIDDEN', message: '没有权限修改该设置' });
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: '关闭该排序档' }));

    await waitFor(() =>
      expect(useNotify.getState().items.some((i) => i.kind === 'danger' && i.text === '没有权限修改该设置')).toBe(true),
    );
    expect(mocks.launcherPreferences).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: '关闭该排序档' })).toBeInTheDocument();
  });
});
