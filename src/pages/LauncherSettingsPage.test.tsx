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
  setLauncherShortcut: vi.fn(),
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
    syntax: [{ group: '写法', pattern: 'oa，web', desc: '两个条件同时命中' }],
  };
}

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={qc}>
      <LauncherSettingsPage />
    </QueryClientProvider>,
  );
}

const sw = async (name: string) => await screen.findByRole('switch', { name });

beforeEach(() => {
  mocks.launcherPreferences.mockReset();
  mocks.updateSetting.mockReset();
  mocks.setLauncherEnabled.mockReset();
  mocks.setLauncherShortcut.mockReset();
  mocks.launcherPreferences.mockResolvedValue(prefs(true));
  mocks.updateSetting.mockResolvedValue(undefined);
  mocks.setLauncherEnabled.mockResolvedValue({ hint: '已提交' });
  mocks.setLauncherShortcut.mockResolvedValue({ registered: true, hint: '已注册' });
  useNotify.setState({ items: [] });
});

describe('页头与顶部概览（BC 轮：当前值抬到概览条，修改入口落到卡片）', () => {
  it('本页只有一枚 h1，副标题跟在其下且不依赖后端返回值', async () => {
    const { container } = renderPage();
    const h1 = screen.getAllByRole('heading', { level: 1 });
    expect(h1).toHaveLength(1);
    expect(h1[0]).toHaveTextContent('快速启动器');
    expect(container.querySelector('.page-header .page-desc')?.textContent).toContain('快捷键由 Rust 后端注册');
    // 页名只出现一次：顶栏已经不承载页名，搬回页头不等于两处各写一份
    expect(screen.getAllByText('快速启动器')).toHaveLength(1);
    await screen.findByRole('button', { name: '应用' });
  });

  it('概览条四格读后端当前值：两枚键名、唤起状态与结果条数上限', async () => {
    renderPage();
    await screen.findByRole('switch', { name: '启用全局唤起' });
    expect(screen.getAllByText('CmdOrCtrl+Alt+Space')).toHaveLength(2);
    expect(screen.getByText('启用')).toBeInTheDocument();
    expect(screen.getByText('20')).toBeInTheDocument();
    expect(screen.getByText('条 · 在安全策略页改')).toBeInTheDocument();
  });

  it('改过快捷键后两格各说各的：当前值与默认值不再重复成同一串', async () => {
    mocks.launcherPreferences.mockResolvedValue({ ...prefs(true), shortcut: 'Ctrl+Shift+U' });
    renderPage();
    await screen.findByRole('switch', { name: '启用全局唤起' });
    expect(screen.getByText('Ctrl+Shift+U')).toBeInTheDocument();
    expect(screen.getByText('CmdOrCtrl+Alt+Space')).toBeInTheDocument();
  });

  it('后端还没注册上快捷键时概览写「未设置」而不是留一个空格子', async () => {
    mocks.launcherPreferences.mockResolvedValue({ ...prefs(true), shortcut: '' });
    renderPage();
    await screen.findByRole('switch', { name: '启用全局唤起' });
    expect(screen.getByText('未设置')).toBeInTheDocument();
  });
});

describe('启用全局唤起（唯一必须走 set_launcher_enabled 的开关）', () => {
  it('勾选状态跟着后端值，拨动提交布尔值而不是改设置行——那条命令还要负责注册/注销快捷键', async () => {
    renderPage();
    const toggle = await sw('启用全局唤起');
    expect(toggle).toBeChecked();
    fireEvent.click(toggle);
    await waitFor(() => expect(mocks.setLauncherEnabled).toHaveBeenCalledWith(false));
    expect(mocks.updateSetting).not.toHaveBeenCalled();
  });

  it('提交成功后重新读取：概览里的状态随之翻转', async () => {
    mocks.launcherPreferences.mockResolvedValueOnce(prefs(true)).mockResolvedValue({ ...prefs(true), enabled: false });
    renderPage();
    fireEvent.click(await sw('启用全局唤起'));
    await waitFor(() => expect(mocks.launcherPreferences).toHaveBeenCalledTimes(2));
    expect(await sw('启用全局唤起')).not.toBeChecked();
    expect(screen.getByText('停用')).toBeInTheDocument();
  });
});

describe('空查询推荐的开关（需求 §285：应由设置启用）', () => {
  it('显示后端当前值，并把"关闭推荐"提交到 update_setting 的确切键值', async () => {
    renderPage();
    const toggle = await sw('空查询时显示最近/收藏');
    expect(toggle).toBeChecked();

    fireEvent.click(toggle);
    await waitFor(() => expect(mocks.updateSetting).toHaveBeenCalledWith('quick_launcher_show_recent', 'false'));
  });

  it('提交成功后重新读取设置：开关随之翻转，不让操作者靠猜确认生效', async () => {
    mocks.launcherPreferences.mockResolvedValueOnce(prefs(true)).mockResolvedValue(prefs(false));
    renderPage();
    fireEvent.click(await sw('空查询时显示最近/收藏'));

    await waitFor(() => expect(mocks.launcherPreferences).toHaveBeenCalledTimes(2));
    expect(await sw('空查询时显示最近/收藏')).not.toBeChecked();
  });

  it('当前为关闭时开关反向提交 true', async () => {
    mocks.launcherPreferences.mockResolvedValue(prefs(false));
    renderPage();
    const toggle = await sw('空查询时显示最近/收藏');
    expect(toggle).not.toBeChecked();
    fireEvent.click(toggle);
    await waitFor(() => expect(mocks.updateSetting).toHaveBeenCalledWith('quick_launcher_show_recent', 'true'));
  });

  it('后端拒绝（如无 SYS_SECURITY 权限）时把后端文案报出来，界面不假装已改', async () => {
    mocks.updateSetting.mockRejectedValue({ code: 'FORBIDDEN', message: '没有权限修改该设置' });
    renderPage();
    fireEvent.click(await sw('空查询时显示最近/收藏'));

    await waitFor(() =>
      expect(useNotify.getState().items.some((i) => i.kind === 'danger' && i.text === '没有权限修改该设置')).toBe(true),
    );
    expect(mocks.launcherPreferences).toHaveBeenCalledTimes(1);
    expect(await sw('空查询时显示最近/收藏')).toBeChecked();
  });
});

describe('排序档开关（需求 line 294：最近使用/收藏这一档可配置）', () => {
  it('显示后端当前档位，关闭时提交 quick_launcher_rank_recent_favorite=false，并在成功后跟着后端翻转', async () => {
    mocks.launcherPreferences.mockResolvedValueOnce(prefs(true, true)).mockResolvedValue(prefs(true, false));
    renderPage();
    const toggle = await sw('同级结果按收藏/最近优先');
    expect(toggle).toBeChecked();

    fireEvent.click(toggle);
    await waitFor(() => expect(mocks.updateSetting).toHaveBeenCalledWith('quick_launcher_rank_recent_favorite', 'false'));
    await waitFor(() => expect(mocks.launcherPreferences).toHaveBeenCalledTimes(2));
    expect(await sw('同级结果按收藏/最近优先')).not.toBeChecked();
  });

  it('当前关闭时反向提交 true；两个开关各写各的键，不会互相覆盖', async () => {
    mocks.launcherPreferences.mockResolvedValue(prefs(true, false));
    renderPage();
    fireEvent.click(await sw('同级结果按收藏/最近优先'));
    await waitFor(() => expect(mocks.updateSetting).toHaveBeenCalledWith('quick_launcher_rank_recent_favorite', 'true'));
    expect(mocks.updateSetting.mock.calls.every(([k]) => k !== 'quick_launcher_show_recent')).toBe(true);
  });

  it('后端拒绝时不刷新也不假装已改', async () => {
    mocks.updateSetting.mockRejectedValue({ code: 'FORBIDDEN', message: '没有权限修改该设置' });
    renderPage();
    fireEvent.click(await sw('同级结果按收藏/最近优先'));

    await waitFor(() =>
      expect(useNotify.getState().items.some((i) => i.kind === 'danger' && i.text === '没有权限修改该设置')).toBe(true),
    );
    expect(mocks.launcherPreferences).toHaveBeenCalledTimes(1);
    expect(await sw('同级结果按收藏/最近优先')).toBeChecked();
  });
});

describe('修改全局快捷键（注册与冲突检测在后端）', () => {
  it('空输入时应用钮不可点，填了就提交去掉首尾空白的值', async () => {
    const { container } = renderPage();
    await screen.findByRole('switch', { name: '启用全局唤起' });
    const submit = screen.getByRole('button', { name: '应用' });
    expect(submit).toBeDisabled();

    const input = container.querySelector<HTMLInputElement>('input[type="text"], input:not([type])');
    fireEvent.change(input!, { target: { value: '  Ctrl+Shift+U  ' } });
    expect(submit).toBeEnabled();
    fireEvent.click(submit);
    await waitFor(() => expect(mocks.setLauncherShortcut).toHaveBeenCalledWith('Ctrl+Shift+U'));
  });

  it('说明里那句"前端不自行注册"落在修改卡片上：注册失败由后端回滚旧键并提示', async () => {
    renderPage();
    await screen.findByRole('switch', { name: '启用全局唤起' });
    expect(screen.getByText(/前端不自行注册/)).toBeInTheDocument();
    expect(screen.getByText(/注册失败时后端会回滚旧键并提示/)).toBeInTheDocument();
  });
});
