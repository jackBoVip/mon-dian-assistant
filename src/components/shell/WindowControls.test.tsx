import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WindowControls } from './WindowControls';
import type { WindowChrome } from '../../lib/types';

const mocks = vi.hoisted(() => ({
  windowChrome: vi.fn(),
  minimize: vi.fn(),
  toggleMaximize: vi.fn(),
  close: vi.fn(),
  isMaximized: vi.fn(),
  onResized: vi.fn(),
}));

vi.mock('../../lib/api', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../lib/api')>();
  return { ...mod, api: { ...mod.api, windowChrome: mocks.windowChrome } };
});

// jsdom 里没有真窗口：@tauri-apps/api/window 必须整枚换掉，否则 getCurrentWindow() 会去读
// Tauri 注入的内部对象。
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    minimize: mocks.minimize,
    toggleMaximize: mocks.toggleMaximize,
    close: mocks.close,
    isMaximized: mocks.isMaximized,
    onResized: mocks.onResized,
  }),
}));

function renderControls() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={qc}>
      <WindowControls />
    </QueryClientProvider>,
  );
}

const FRAMELESS: WindowChrome = { customControls: true, platform: 'windows' };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.isMaximized.mockResolvedValue(false);
  mocks.onResized.mockResolvedValue(() => undefined);
  for (const fn of [mocks.minimize, mocks.toggleMaximize, mocks.close]) fn.mockResolvedValue(undefined);
});

describe('窗口三颗钮只在去框的那两端出现', () => {
  it('macOS（customControls=false）一颗都不渲染', async () => {
    mocks.windowChrome.mockResolvedValue({ customControls: false, platform: 'macos' });
    renderControls();
    await waitFor(() => expect(mocks.windowChrome).toHaveBeenCalled());
    expect(screen.queryByRole('group', { name: '窗口控制' })).toBeNull();
    expect(screen.queryByRole('button', { name: '最小化' })).toBeNull();
    expect(screen.queryByRole('button', { name: '关闭窗口' })).toBeNull();
  });

  /** 浏览器预览与 jsdom 里 api 会抛 NOT_TAURI：那里没有窗口，必须安静地什么都不画。 */
  it('问不到形态时按"没有窗口"处理，不抛错也不画出假按钮', async () => {
    mocks.windowChrome.mockRejectedValue(new Error('NOT_TAURI'));
    renderControls();
    await waitFor(() => expect(mocks.windowChrome).toHaveBeenCalled());
    expect(screen.queryByRole('group', { name: '窗口控制' })).toBeNull();
  });

  it('Windows 去框后三颗都在，各自打到对应命令', async () => {
    mocks.windowChrome.mockResolvedValue(FRAMELESS);
    renderControls();
    fireEvent.click(await screen.findByRole('button', { name: '最小化' }));
    fireEvent.click(screen.getByRole('button', { name: '最大化' }));
    fireEvent.click(screen.getByRole('button', { name: '关闭窗口' }));
    await waitFor(() => {
      expect(mocks.minimize).toHaveBeenCalledTimes(1);
      expect(mocks.toggleMaximize).toHaveBeenCalledTimes(1);
      expect(mocks.close).toHaveBeenCalledTimes(1);
    });
  });

  /** 最大化态必须换说法与画法：那一颗在最大化时是"还原"，不是第二个"最大化"。 */
  it('已最大化时中间那颗改叫还原、换还原图标', async () => {
    mocks.isMaximized.mockResolvedValue(true);
    mocks.windowChrome.mockResolvedValue(FRAMELESS);
    renderControls();
    const restore = await screen.findByRole('button', { name: '还原' });
    expect(screen.queryByRole('button', { name: '最大化' })).toBeNull();
    expect(restore.querySelector('svg')).not.toBeNull();
  });
});
