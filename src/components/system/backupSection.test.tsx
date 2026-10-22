import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BackupSection } from './BackupSection';
import type { BackupInfo } from '../../lib/types';
import { useNotify } from '../../state/notify';
import { useSession } from '../../state/session';

const mocks = vi.hoisted(() => ({
  listBackups: vi.fn(),
  createBackup: vi.fn(),
  verifyBackup: vi.fn(),
  restoreBackup: vi.fn(),
}));

vi.mock('../../lib/api', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../lib/api')>();
  return { ...mod, api: { ...mod.api, ...mocks } };
});

const DATED: BackupInfo = {
  id: '01a1622c-84ac-73e8-90d7-d4b229d11882',
  fileName: '01a1622c-84ac-73e8-90d7-d4b229d11882.mdbak',
  createdAt: '2026-10-22T05:54:07Z',
  sizeBytes: 671744,
  schemaVersion: 10,
  encrypted: true,
  sha256: 'aa',
  verifiedAt: '2026-10-22T06:00:00Z',
};

const UNVERIFIED: BackupInfo = {
  id: '01a16000-0000-7000-8000-000000000001',
  fileName: '01a16000-0000-7000-8000-000000000001.mdbak',
  createdAt: '2026-10-21T01:00:00Z',
  sizeBytes: 1048576,
  schemaVersion: 10,
  encrypted: false,
  sha256: 'bb',
  verifiedAt: null,
};

function renderSection() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={qc}>
      <BackupSection />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  Object.values(mocks).forEach((fn) => fn.mockReset());
  mocks.listBackups.mockResolvedValue([DATED, UNVERIFIED]);
  mocks.createBackup.mockResolvedValue(DATED);
  mocks.verifyBackup.mockResolvedValue(DATED);
  mocks.restoreBackup.mockResolvedValue(undefined);
  useNotify.setState({ items: [] });
  useSession.setState({ bootstrap: vi.fn(async () => {}) });
});

describe('备份与恢复', () => {
  it('概览统计来自备份列表，表格列居中且不再重复显示标识与文件名', async () => {
    renderSection();
    const table = await screen.findByRole('table');
    expect(table).toHaveClass('table', 'table-center');

    expect(screen.getByRole('columnheader', { name: '备份文件' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: '创建时间' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: '库结构' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: '最近校验' })).toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: '标识' })).not.toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: '文件' })).not.toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: 'schema' })).not.toBeInTheDocument();

    // 2 份、合计 1.6 MB
    expect(screen.getAllByText('2 份').length).toBeGreaterThan(0);
    expect(screen.getAllByText('1.6 MB').length).toBeGreaterThan(0);

    // 短标识上屏，完整 id 与文件名留在 title 里
    expect(screen.getByTitle(`${DATED.id} · ${DATED.fileName}`).textContent).toBe('01a1622c.mdbak');
    expect(screen.getAllByText('v10', { selector: 'td' })).toHaveLength(2);
    expect(screen.getByText('已加密', { selector: '.badge' })).toBeInTheDocument();
    expect(screen.getByText('未校验')).toBeInTheDocument();
  });

  it('校验按钮把对应备份 id 交给后端，并回显成功提示', async () => {
    renderSection();
    const row = await screen.findByRole('row', { name: /01a1622c/ });
    fireEvent.click(within(row).getByRole('button', { name: '校验' }));
    await waitFor(() => expect(mocks.verifyBackup).toHaveBeenCalledWith(DATED.id));
    await waitFor(() => expect(useNotify.getState().items[0]?.text).toMatch(/校验通过/));
  });

  it('恢复先弹确认框，取消不发请求，确认后带 confirmed=true 调用后端', async () => {
    renderSection();
    const row = await screen.findByRole('row', { name: /01a1622c/ });
    fireEvent.click(within(row).getByRole('button', { name: '恢复' }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(DATED.fileName)).toBeInTheDocument();
    expect(within(dialog).getByText(/回滚备份/)).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole('button', { name: '取消' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(mocks.restoreBackup).not.toHaveBeenCalled();

    fireEvent.click(within(row).getByRole('button', { name: '恢复' }));
    const reopened = await screen.findByRole('dialog');
    fireEvent.click(within(reopened).getByRole('button', { name: '确认覆盖并恢复' }));
    await waitFor(() => expect(mocks.restoreBackup).toHaveBeenCalledWith(DATED.id, true));
  });

  it('立即备份调用创建命令并刷新列表', async () => {
    renderSection();
    await screen.findByRole('table');
    fireEvent.click(screen.getByRole('button', { name: '立即备份' }));
    await waitFor(() => expect(mocks.createBackup).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(useNotify.getState().items[0]?.text).toContain(DATED.id));
  });

  it('尚无备份时显示空态与 0 份概览，不渲染表格', async () => {
    mocks.listBackups.mockResolvedValue([]);
    renderSection();
    expect(await screen.findByText(/尚无备份文件/)).toBeInTheDocument();
    expect(screen.getByText('0 份')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });
});
