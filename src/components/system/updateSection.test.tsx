import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { UpdateSection, describeProgress } from './UpdateSection';
import type { UpdateInfo } from '../../lib/types';
import { useNotify } from '../../state/notify';

const mocks = vi.hoisted(() => ({
  checkUpdate: vi.fn(),
  downloadUpdate: vi.fn(),
  installUpdate: vi.fn(),
  lanStatus: vi.fn(),
  myPermissions: vi.fn(),
}));

const LAN_IDLE = {
  discoveryEnabled: true,
  discoveryError: null,
  elapsedMs: 0,
  sources: [],
  serving: false,
  servePort: null,
  serveDir: null,
  serveError: null,
  manualSource: null,
  localVersion: '0.1.0',
};

vi.mock('../../lib/api', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../lib/api')>();
  return { ...mod, api: { ...mod.api, ...mocks } };
});

const OFFLINE: UpdateInfo = {
  currentVersion: '0.1.0',
  latestVersion: null,
  channel: 'stable',
  sourceUrl: '',
  releaseDate: null,
  notes: null,
  platform: 'macos',
  arch: 'aarch64',
  packageSize: null,
  signatureValid: 'unknown',
  signer: null,
  available: false,
  downloaded: false,
  installed: false,
  lanSource: null,
  opened: false,
  message: '未配置内网更新源，当前为离线状态（未发起任何网络请求）。',
};

const AVAILABLE: UpdateInfo = {
  ...OFFLINE,
  latestVersion: '0.2.0',
  sourceUrl: 'https://updates.example.com/manifest.json',
  releaseDate: '2026-10-20',
  notes: '修复：备份恢复后的会话锁定。',
  packageSize: 12 * 1024 * 1024,
  signatureValid: 'ok',
  signer: 'MDA Release',
  available: true,
  downloaded: true,
  message: '',
};

function renderSection() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={qc}>
      <UpdateSection />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  Object.values(mocks).forEach((fn) => fn.mockReset());
  mocks.checkUpdate.mockResolvedValue(OFFLINE);
  mocks.downloadUpdate.mockResolvedValue({ message: '下载完成' });
  mocks.installUpdate.mockResolvedValue({ message: '已打开安装包' });
  mocks.lanStatus.mockResolvedValue(LAN_IDLE);
  mocks.myPermissions.mockResolvedValue(['system.update.config', 'system.update.install']);
  useNotify.setState({ items: [] });
});

describe('系统更新', () => {
  it('离线时如实显示「未获取到版本」与「未校验」，不把 unknown 当成安全态', async () => {
    renderSection();
    expect(await screen.findByText('未获取到版本')).toBeInTheDocument();
    expect(screen.getByText('未校验')).toBeInTheDocument();
    expect(screen.getByText('未配置公钥')).toBeInTheDocument();
    expect(screen.getByText(/未配置内网更新源/)).toBeInTheDocument();
    expect(screen.queryByText(/unknown/)).not.toBeInTheDocument();
    expect(screen.getByText('v0.1.0')).toBeInTheDocument();
    expect(screen.getByText(/稳定版通道/)).toBeInTheDocument();

    expect(screen.getByRole('button', { name: '下载更新' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '打开安装包' })).toBeDisabled();
  });

  it('有更新且已下载时可下载并打开安装包，详情列出签名、来源与说明', async () => {
    mocks.checkUpdate.mockResolvedValue(AVAILABLE);
    renderSection();
    expect(await screen.findByText('有更新')).toBeInTheDocument();
    expect(screen.getByText('有效')).toBeInTheDocument();
    expect(screen.getByText('v0.2.0')).toBeInTheDocument();
    expect(screen.getByText('MDA Release')).toBeInTheDocument();
    expect(screen.getByText('https://updates.example.com/manifest.json')).toBeInTheDocument();
    expect(screen.getByText('修复：备份恢复后的会话锁定。')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '下载更新' }));
    await waitFor(() => expect(mocks.downloadUpdate).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: '打开安装包' }));
    await waitFor(() => expect(mocks.installUpdate).toHaveBeenCalledTimes(1));
  });

  it('拿到远端版本号但没有更新时显示「已是最新」', async () => {
    mocks.checkUpdate.mockResolvedValue({ ...AVAILABLE, latestVersion: '0.1.0', available: false, downloaded: false });
    renderSection();
    expect(await screen.findByText('已是最新')).toBeInTheDocument();
    expect(screen.queryByText('有更新')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '下载更新' })).toBeDisabled();
  });

  it('没有安装权限时只留「重新检查」并说明原因', async () => {
    mocks.myPermissions.mockResolvedValue(['system.update.config']);
    renderSection();
    expect(await screen.findByText(/当前角色只能检查更新/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '重新检查' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '下载更新' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '打开安装包' })).not.toBeInTheDocument();
  });
});

describe('describeProgress', () => {
  it('有百分比时报百分比，没有百分比时如实报已下载量', () => {
    expect(describeProgress({ percent: 42 })).toBe('42%');
    expect(describeProgress({ received: 1024, total: 2048 })).toBe('1.0 KB / 2.0 KB（清单未给大小）');
    expect(describeProgress({ received: 512 })).toBe('512 B（清单未给大小）');
  });
});
