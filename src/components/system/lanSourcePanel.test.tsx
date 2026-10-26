import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LAN_SCAN_GRACE_MS, LanSourcePanel, lanUiState } from './LanSourcePanel';
import type { LanSourceView, LanStatus, UpdateInfo } from '../../lib/types';
import { useNotify } from '../../state/notify';

const mocks = vi.hoisted(() => ({
  lanStatus: vi.fn(),
  lanCheck: vi.fn(),
  lanDownload: vi.fn(),
  lanSetServe: vi.fn(),
  installUpdate: vi.fn(),
  updateSetting: vi.fn(),
  myPermissions: vi.fn(),
}));

vi.mock('../../lib/api', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../lib/api')>();
  return { ...mod, api: { ...mod.api, ...mocks } };
});

vi.mock('../../lib/dialogs', () => ({
  openDirectory: vi.fn(),
}));

const SOURCE: LanSourceView = {
  instance: 'inst-a',
  host: 'MBP-01',
  ip: '10.8.3.21',
  version: '0.2.0',
  platform: 'macos',
  arch: 'aarch64',
  port: 8765,
  newerThanLocal: true,
};

const STATUS: LanStatus = {
  discoveryEnabled: true,
  discoveryError: null,
  elapsedMs: 30_000,
  sources: [SOURCE],
  serving: false,
  servePort: null,
  serveDir: null,
  serveError: null,
  manualSource: null,
  localVersion: '0.1.0',
};

const DOWNLOADED: UpdateInfo = {
  currentVersion: '0.1.0',
  latestVersion: '0.2.0',
  channel: 'stable',
  sourceUrl: 'http://10.8.3.21:8765/manifest',
  releaseDate: null,
  notes: null,
  platform: 'macos',
  arch: 'aarch64',
  packageSize: 1024,
  signatureValid: 'ok',
  signer: null,
  available: true,
  downloaded: true,
  installed: false,
  lanSource: 'MBP-01（http://10.8.3.21:8765）',
  opened: false,
  message: '更新包下载完成（1024 字节），SHA-256 与签名清单一致。下一步需手动打开安装包。',
};

function renderPanel() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={qc}>
      <LanSourcePanel progress={null} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  Object.values(mocks).forEach((fn) => fn.mockReset());
  mocks.lanStatus.mockResolvedValue(STATUS);
  mocks.lanCheck.mockResolvedValue({ ...DOWNLOADED, downloaded: false, message: '发现可用更新' });
  mocks.lanDownload.mockResolvedValue(DOWNLOADED);
  mocks.installUpdate.mockResolvedValue({ ...DOWNLOADED, opened: true, message: '已打开安装包，请拖入「应用程序」后手动重启应用。' });
  mocks.lanSetServe.mockResolvedValue({ ...STATUS, serving: true, servePort: 8765, serveDir: '/tmp/lan' });
  mocks.updateSetting.mockResolvedValue(undefined);
  mocks.myPermissions.mockResolvedValue([
    'system.update.config',
    'system.update.install',
    'system.update.serve',
  ]);
  useNotify.setState({ items: [] });
});

describe('lanUiState', () => {
  const base = {
    enabled: true,
    discoveryError: null,
    elapsedMs: LAN_SCAN_GRACE_MS * 4,
    sourceCount: 0,
    newerCount: 0,
    manualSource: null,
  };

  it('关闭发现时如实说明，并给出手填入口', () => {
    const s = lanUiState({ ...base, enabled: false });
    expect(s.kind).toBe('off');
    expect(s.showManual).toBe(true);
  });

  it('组播监听失败优先于「没有源」：不能把故障说成没人开托管', () => {
    const s = lanUiState({ ...base, discoveryError: 'bind 失败' });
    expect(s.kind).toBe('unavailable');
    expect(s.hint).toContain('bind 失败');
    expect(s.showManual).toBe(true);
  });

  it('有更高的源才算「已发现」，全都比本机旧时明说不升级', () => {
    expect(lanUiState({ ...base, sourceCount: 2, newerCount: 1 }).kind).toBe('found');
    const stale = lanUiState({ ...base, sourceCount: 2, newerCount: 0 });
    expect(stale.kind).toBe('stale');
    expect(stale.hint).toContain('不高于本机');
  });

  it('宽限期内显示扫描中，超过后才报未发现', () => {
    expect(lanUiState({ ...base, elapsedMs: LAN_SCAN_GRACE_MS - 1 }).kind).toBe('scanning');
    expect(lanUiState({ ...base, elapsedMs: LAN_SCAN_GRACE_MS }).kind).toBe('empty');
  });

  it('有手填地址时优先于「未发现」', () => {
    expect(lanUiState({ ...base, manualSource: 'http://10.0.0.5:8765' }).kind).toBe('manual');
  });
});

describe('局域网更新源面板', () => {
  it('低于本机的源照常列出，但按钮禁用成「低于本机」', async () => {
    mocks.lanStatus.mockResolvedValue({ ...STATUS, sources: [{ ...SOURCE, newerThanLocal: false }] });
    renderPanel();
    expect(await screen.findByText('MBP-01')).toBeInTheDocument();
    expect(screen.getByText('低于本机')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '从局域网更新' })).not.toBeInTheDocument();
  });

  it('点「从局域网更新」先验签拉清单再下载，成功后出现「打开安装包」', async () => {
    renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: '从局域网更新' }));
    await waitFor(() => expect(mocks.lanCheck).toHaveBeenCalledWith('inst-a'));
    await waitFor(() => expect(mocks.lanDownload).toHaveBeenCalledTimes(1));
    const open = await screen.findByRole('button', { name: '打开安装包' });
    fireEvent.click(open);
    await waitFor(() => expect(mocks.installUpdate).toHaveBeenCalledTimes(1));
  });

  it('源版本不高于本机时只检查、不下载，并说明原因', async () => {
    mocks.lanCheck.mockResolvedValue({ ...DOWNLOADED, available: false, downloaded: false, message: '当前已是最新可用版本（或通道不匹配）。' });
    renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: '从局域网更新' }));
    await waitFor(() => expect(mocks.lanCheck).toHaveBeenCalledTimes(1));
    expect(mocks.lanDownload).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: '打开安装包' })).not.toBeInTheDocument();
  });

  it('没有托管目录时开关不会开启，先提示选目录', async () => {
    renderPanel();
    const toggle = await screen.findByRole('switch', { name: '在本机提供更新' });
    fireEvent.click(toggle);
    await waitFor(() => expect(mocks.lanSetServe).not.toHaveBeenCalled());
    expect(useNotify.getState().items.some((n) => n.text.includes('托管目录'))).toBe(true);
  });

  it('没有 serve 权限时不渲染托管开关', async () => {
    mocks.myPermissions.mockResolvedValue(['system.update.config', 'system.update.install']);
    renderPanel();
    await screen.findByText('MBP-01');
    expect(screen.queryByRole('switch', { name: '在本机提供更新' })).not.toBeInTheDocument();
  });

  it('没有安装权限时按钮禁用并说明原因', async () => {
    mocks.myPermissions.mockResolvedValue(['system.update.config']);
    renderPanel();
    expect(await screen.findByRole('button', { name: '从局域网更新' })).toBeDisabled();
    expect(screen.getByText(/当前角色只能查看源/)).toBeInTheDocument();
  });
});
