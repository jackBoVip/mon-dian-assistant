import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactElement } from 'react';
import type { ContainerPreview, ExportPreview, ImportCommitResult, ImportPreview, PasswordAssessment, TargetRow } from '../../lib/types';

/**
 * 数据导入/导出面板测试：api 与对话框模块全部 mock。
 * 覆盖：模板保存、预览行错误呈现、提交携带所选冲突策略、
 * 加密容器来源（口令 → 预览 → 二次认证 → 提交，含 STALE 与口令不留存）、
 * 含秘密导出先二次认证再 export_preview 并如实呈现失败、无权限状态块、
 * 容器口令的实时强度提示（只在含秘密且非空时请求、弱口令只提示不禁用导出、失败时不谎报）。
 */

vi.mock('../../lib/dialogs', () => ({
  openFile: vi.fn(),
  saveFileDialog: vi.fn(),
  saveTextFile: vi.fn(),
}));

const apiMock = vi.hoisted(() => ({
  importTemplate: vi.fn(),
  importPreview: vi.fn(),
  importCommit: vi.fn(),
  containerPreview: vi.fn(),
  containerCommit: vi.fn(),
  exportPreview: vi.fn(),
  exportCommit: vi.fn(),
  reauthenticate: vi.fn(),
  passwordStrength: vi.fn(),
  listTargets: vi.fn(),
  listGroups: vi.fn(),
}));

vi.mock('../../lib/api', () => {
  class ApiError extends Error {}
  return { api: apiMock, ApiError, isTauri: () => false };
});

import { openFile, saveFileDialog, saveTextFile } from '../../lib/dialogs';
import { ImportPanel } from './ImportPanel';
import { ExportPanel } from './ExportPanel';

function backendError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code, message });
}

const previewFixture: ImportPreview = {
  jobId: 'job-1',
  filename: '台账.csv',
  fileFormat: 'csv',
  totalRows: 10,
  validRows: 7,
  errorRows: 2,
  conflictRows: 1,
  newTargets: 3,
  columns: ['目标名称', '目标类型', '账号别名', '用户名', '密码'],
  errors: [
    { rowNo: 3, code: 'MISSING_NAME', message: '目标名称缺失，无法定位系统', field: '目标名称' },
    { rowNo: 6, code: 'UNKNOWN_TYPE', message: '目标类型不在允许列表内', field: '目标类型' },
  ],
  conflicts: [{ rowNo: 8, targetName: '营销系统', reason: '同名目标已存在' }],
  truncated: false,
  message: '预览完成。',
};

const exportPreviewFixture: ExportPreview = {
  targets: 4,
  items: 12,
  includeSecrets: false,
  format: 'csv',
  columns: ['目标名称', '目标类型'],
  warning: '不含秘密导出：仅结构与地址信息。',
};

/** password_strength 的两种返回：满足策略 / 长度不足且不满足策略。 */
const strongAssessment: PasswordAssessment = {
  acceptable: true,
  score: 4,
  lengthOk: true,
  hasClassVariation: true,
  notCommon: true,
  // 与 policy::assess_with 的实际输出一致：score>=4 时 hint 为"强度良好"
  hint: '强度良好',
};

const weakAssessment: PasswordAssessment = {
  acceptable: false,
  score: 1,
  lengthOk: false,
  hasClassVariation: false,
  notCommon: true,
  // 与 policy::assess_with 的实际输出一致：长度不达标时 hint 先报下限
  hint: '至少 12 个字符',
};

const targetRows: TargetRow[] = [
  {
    id: 't1',
    targetType: 'web',
    displayName: '营销系统',
    groupId: null,
    status: 'active',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    credentialCount: 2,
  },
];

function renderWithClient(ui: ReactElement) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

/** importPreview 默认实现：探针（.txt）回 INVALID_INPUT（=RBAC 通过），正式 .csv 回预览数据。 */
function importPreviewImpl(path: string): Promise<ImportPreview> {
  if (path.endsWith('.csv')) return Promise.resolve(previewFixture);
  return Promise.reject(backendError('INVALID_INPUT', '仅接受 .csv 文件'));
}

beforeEach(() => {
  vi.mocked(openFile).mockReset();
  vi.mocked(saveFileDialog).mockReset();
  vi.mocked(saveTextFile).mockReset();
  Object.values(apiMock).forEach((fn) => fn.mockReset());
  apiMock.importPreview.mockImplementation(importPreviewImpl);
  apiMock.exportPreview.mockResolvedValue(exportPreviewFixture);
  apiMock.passwordStrength.mockResolvedValue(strongAssessment);
  apiMock.listTargets.mockResolvedValue(targetRows);
});

describe('ImportPanel', () => {
  it('下载模板：取回后端 CSV 并经保存对话框落盘', async () => {
    apiMock.importTemplate.mockResolvedValue({
      csv: '目标名称,目标类型\n示例,web\n',
      columns: ['目标名称', '目标类型'],
      note: '模板不含任何真实凭据。',
    });
    vi.mocked(saveTextFile).mockResolvedValue({ path: '/tmp/导入模板.csv', fileName: '导入模板.csv' });

    renderWithClient(<ImportPanel />);
    fireEvent.click(await screen.findByRole('button', { name: '下载/保存导入模板（CSV）' }));

    await waitFor(() => expect(saveTextFile).toHaveBeenCalledTimes(1));
    const [opts, contents] = vi.mocked(saveTextFile).mock.calls[0];
    expect(contents).toBe('目标名称,目标类型\n示例,web\n');
    expect(opts.defaultPath).toBe('导入模板.csv');
    expect(opts.filters?.[0]?.extensions).toEqual(['csv']);
    await screen.findByText(/模板文件「导入模板\.csv」已生成/);
  });

  it('预览呈现 RowError 的行号与中文错误信息', async () => {
    vi.mocked(openFile).mockResolvedValue('/tmp/台账.csv');

    renderWithClient(<ImportPanel />);
    fireEvent.click(await screen.findByRole('button', { name: '选择 CSV 文件并预览' }));

    expect(await screen.findByText(/第 3 行/)).toBeInTheDocument();
    expect(screen.getByText('目标名称缺失，无法定位系统')).toBeInTheDocument();
    expect(screen.getByText('目标类型不在允许列表内')).toBeInTheDocument();
    expect(screen.getByText('营销系统 · 同名目标已存在')).toBeInTheDocument();
  });

  it('提交时携带所选冲突策略（更新=update），未选默认类型则不发 defaults', async () => {
    vi.mocked(openFile).mockResolvedValue('/tmp/台账.csv');
    apiMock.importCommit.mockResolvedValue({
      jobId: 'job-1',
      importedRows: 7,
      createdTargets: 3,
      createdItems: 7,
      skippedRows: 2,
      conflictRows: 1,
      errors: [],
      message: '导入完成。',
    });

    renderWithClient(<ImportPanel />);
    fireEvent.click(await screen.findByRole('button', { name: '选择 CSV 文件并预览' }));
    await screen.findByText('预览 · 台账.csv');

    fireEvent.click(screen.getByRole('radio', { name: /更新/ }));
    fireEvent.click(screen.getByRole('button', { name: '按上方策略提交导入' }));

    await waitFor(() => expect(apiMock.importCommit).toHaveBeenCalledTimes(1));
    expect(apiMock.importCommit).toHaveBeenCalledWith('job-1', 'update', undefined);
    expect(await screen.findByText('导入结果')).toBeInTheDocument();
  });

  it('无 accounts.import 权限时呈现「无权限」状态块', async () => {
    apiMock.importPreview.mockRejectedValue(backendError('FORBIDDEN', '当前角色无权执行该操作'));

    renderWithClient(<ImportPanel />);

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('无权限');
    expect(alert.textContent).toContain('FORBIDDEN');
    expect(screen.queryByRole('button', { name: '选择 CSV 文件并预览' })).not.toBeInTheDocument();
  });
});

const containerPreviewFixture: ContainerPreview = {
  filename: '台账.mdaexport',
  fingerprint: 'f'.repeat(64),
  totalRows: 3,
  validRows: 3,
  errorRows: 0,
  conflictRows: 1,
  newTargets: 2,
  containsSecrets: true,
  errors: [],
  conflicts: [{ rowNo: 2, targetName: '机房终端B', reason: '台账中已存在同名或同地址目标；可选择复用该目标继续导入凭据' }],
  truncated: false,
  message: '容器共 3 行：可导入 3 行，错误 0 行，冲突 1 行。含秘密字段只在提交时用本机保险库密钥重新加密后落库，不会出现在预览里。',
};

const containerCommitFixture: ImportCommitResult = {
  jobId: 'f'.repeat(64),
  importedRows: 3,
  createdTargets: 2,
  createdItems: 3,
  skippedRows: 0,
  conflictRows: 1,
  errors: [],
  message: '容器导入完成：新建目标 2 个，写入凭据 3 条，跳过 0 行，冲突 1 行，用时 41 毫秒。',
};

describe('ImportPanel · 加密容器来源', () => {
  /** 切到容器来源并等到口令输入出现。 */
  async function toContainerMode() {
    renderWithClient(<ImportPanel />);
    fireEvent.click(await screen.findByRole('radio', { name: /口令加密容器/ }));
    return screen.findByLabelText(/容器口令/);
  }

  it('未填口令时不给打开文件对话框，也不发请求', async () => {
    const pw = await toContainerMode();
    expect(pw).toBeInTheDocument();
    // 容器来源没有"默认目标类型"下拉：导出的每行都自带类型，留着它就是个不起作用的控件
    expect(screen.queryByText('默认目标类型（可选）')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '输入口令后选择容器并预览' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('请先输入容器口令'));
    expect(openFile).not.toHaveBeenCalled();
    expect(apiMock.containerPreview).not.toHaveBeenCalled();
  });

  it('口令随路径一起发给 container_preview，预览如实标出含秘密与文件摘要', async () => {
    vi.mocked(openFile).mockResolvedValue('/tmp/台账.mdaexport');
    apiMock.containerPreview.mockResolvedValue(containerPreviewFixture);

    const pw = await toContainerMode();
    fireEvent.change(pw, { target: { value: 'Contain#Pass2026!' } });
    fireEvent.click(screen.getByRole('button', { name: '输入口令后选择容器并预览' }));

    await waitFor(() => expect(apiMock.containerPreview).toHaveBeenCalledTimes(1));
    expect(apiMock.containerPreview).toHaveBeenCalledWith('/tmp/台账.mdaexport', 'Contain#Pass2026!');
    // 文件对话框只放开 .mdaexport，避免选到 CSV 白等一次 KDF
    expect(vi.mocked(openFile).mock.calls[0]?.[0]?.filters?.[0]?.extensions).toEqual(['mdaexport']);

    await screen.findByText('预览 · 台账.mdaexport');
    expect(screen.getByText('含秘密字段')).toBeInTheDocument();
    expect(screen.getByText(new RegExp(`文件 sha256：${'f'.repeat(12)}`))).toBeInTheDocument();
    expect(screen.getByText('机房终端B · 台账中已存在同名或同地址目标；可选择复用该目标继续导入凭据')).toBeInTheDocument();
    // 容器路径不回显 CSV 列头
    expect(screen.queryByLabelText('模板列')).not.toBeInTheDocument();
    // 预览成功后口令仍在（提交还要用），但只存在于这一次流程里
    expect((pw as HTMLInputElement).value).toBe('Contain#Pass2026!');
  });

  it('提交前必须主密码二次认证，认证通过才带指纹与策略调用 container_commit', async () => {
    vi.mocked(openFile).mockResolvedValue('/tmp/台账.mdaexport');
    apiMock.containerPreview.mockResolvedValue(containerPreviewFixture);
    apiMock.reauthenticate.mockResolvedValue(undefined);
    apiMock.containerCommit.mockResolvedValue(containerCommitFixture);

    const pw = await toContainerMode();
    fireEvent.change(pw, { target: { value: 'Contain#Pass2026!' } });
    fireEvent.click(screen.getByRole('button', { name: '输入口令后选择容器并预览' }));
    await screen.findByText('预览 · 台账.mdaexport');

    fireEvent.click(screen.getByRole('radio', { name: /更新/ }));
    fireEvent.click(screen.getByRole('button', { name: '二次认证后提交容器导入' }));

    // 认证面板出现时，主提交按钮必须处于不可用状态：不能绕过 require_reauth 闸门
    const commitBtn = screen.getByRole('button', { name: '验证主密码并提交导入' }) as HTMLButtonElement;
    expect(commitBtn.disabled).toBe(true);
    const master = await screen.findByLabelText('主密码');
    fireEvent.change(master, { target: { value: 'Master#2026x' } });
    fireEvent.click(screen.getByRole('button', { name: '验证并提交导入' }));

    await waitFor(() => expect(apiMock.containerCommit).toHaveBeenCalledTimes(1));
    expect(apiMock.reauthenticate).toHaveBeenCalledWith('Master#2026x');
    expect(apiMock.reauthenticate.mock.invocationCallOrder[0]).toBeLessThan(
      apiMock.containerCommit.mock.invocationCallOrder[0],
    );
    expect(apiMock.containerCommit.mock.calls[0][0]).toEqual({
      path: '/tmp/台账.mdaexport',
      passphrase: 'Contain#Pass2026!',
      fingerprint: 'f'.repeat(64),
      conflictPolicy: 'update',
    });
    expect(await screen.findByText('导入结果')).toBeInTheDocument();
    // 容器口令不留存：提交尝试后输入框已清空
    expect((pw as HTMLInputElement).value).toBe('');
    // 认证面板在成功那一刻收起，主密码输入框不再存在
    expect(screen.queryByLabelText('主密码')).not.toBeInTheDocument();
  });

  it('二次认证失败则不写库，容器口令照样清空', async () => {
    vi.mocked(openFile).mockResolvedValue('/tmp/台账.mdaexport');
    apiMock.containerPreview.mockResolvedValue(containerPreviewFixture);
    apiMock.reauthenticate.mockRejectedValue(backendError('WRONG_PASSWORD', '主密码不正确'));

    const pw = await toContainerMode();
    fireEvent.change(pw, { target: { value: 'Contain#Pass2026!' } });
    fireEvent.click(screen.getByRole('button', { name: '输入口令后选择容器并预览' }));
    await screen.findByText('预览 · 台账.mdaexport');

    fireEvent.click(screen.getByRole('button', { name: '二次认证后提交容器导入' }));
    const master = await screen.findByLabelText('主密码');
    fireEvent.change(master, { target: { value: 'nope' } });
    fireEvent.click(screen.getByRole('button', { name: '验证并提交导入' }));

    await screen.findByText(/二次认证未通过：主密码不正确/);
    expect(apiMock.containerCommit).not.toHaveBeenCalled();
    // 主密码同样不留存：认证失败后输入框已清空
    expect((master as HTMLInputElement).value).toBe('');
    // 预览结果仍在：认证失败不该把用户退回第一步
    expect(screen.getByText('预览 · 台账.mdaexport')).toBeInTheDocument();
  });

  it('CONTAINER_STALE（预览后文件被改动）如实呈现且清空口令，不静默重试', async () => {
    vi.mocked(openFile).mockResolvedValue('/tmp/台账.mdaexport');
    apiMock.containerPreview.mockResolvedValue(containerPreviewFixture);
    apiMock.reauthenticate.mockResolvedValue(undefined);
    apiMock.containerCommit.mockRejectedValue(
      backendError('CONTAINER_STALE', '容器文件在预览之后被改动过（内容摘要与预览时不一致）：请重新预览确认后再导入'),
    );

    const pw = await toContainerMode();
    fireEvent.change(pw, { target: { value: 'Contain#Pass2026!' } });
    fireEvent.click(screen.getByRole('button', { name: '输入口令后选择容器并预览' }));
    await screen.findByText('预览 · 台账.mdaexport');

    fireEvent.click(screen.getByRole('button', { name: '二次认证后提交容器导入' }));
    fireEvent.change(await screen.findByLabelText('主密码'), { target: { value: 'Master#2026x' } });
    fireEvent.click(screen.getByRole('button', { name: '验证并提交导入' }));

    await screen.findByText(/容器导入失败：容器文件在预览之后被改动过/);
    expect(apiMock.containerCommit).toHaveBeenCalledTimes(1);
    expect((pw as HTMLInputElement).value).toBe('');
    expect(screen.queryByText('导入结果')).not.toBeInTheDocument();
  });

  it('切换回 CSV 来源会丢掉容器预览与口令', async () => {
    vi.mocked(openFile).mockResolvedValue('/tmp/台账.mdaexport');
    apiMock.containerPreview.mockResolvedValue(containerPreviewFixture);

    const pw = await toContainerMode();
    fireEvent.change(pw, { target: { value: 'Contain#Pass2026!' } });
    fireEvent.click(screen.getByRole('button', { name: '输入口令后选择容器并预览' }));
    await screen.findByText('预览 · 台账.mdaexport');

    fireEvent.click(screen.getByRole('radio', { name: /CSV 文件/ }));
    await waitFor(() => expect(screen.queryByText('预览 · 台账.mdaexport')).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: '按上方策略提交导入' })).toBeDisabled();
    expect(screen.queryByLabelText(/容器口令/)).not.toBeInTheDocument();
    expect(screen.getByText('默认目标类型（可选）')).toBeInTheDocument();
  });
});

describe('ExportPanel', () => {
  it('含秘密导出：先二次认证，认证失败则不调用 export_preview 并如实呈现', async () => {
    apiMock.reauthenticate.mockRejectedValue(backendError('WRONG_PASSWORD', '主密码不正确'));

    renderWithClient(<ExportPanel />);
    await screen.findByRole('button', { name: '预览将要导出的内容' });
    // 权限探针调用过一次 exportPreview（不含秘密）
    expect(apiMock.exportPreview).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('checkbox', { name: /包含秘密字段/ }));
    fireEvent.click(screen.getByRole('button', { name: '预览将要导出的内容' }));

    const pwInput = await screen.findByLabelText('主密码');
    fireEvent.change(pwInput, { target: { value: 'master-pw' } });
    fireEvent.click(screen.getByRole('button', { name: '验证并继续' }));

    await waitFor(() => expect(apiMock.reauthenticate).toHaveBeenCalledWith('master-pw'));
    await screen.findByText(/二次认证未通过：主密码不正确/);
    // 认证失败后没有再次调用 export_preview
    expect(apiMock.exportPreview).toHaveBeenCalledTimes(1);
    // 口令不留存：输入框已清空
    expect((pwInput as HTMLInputElement).value).toBe('');
  });

  it('含秘密导出：二次认证成功后才调用 export_preview（含 includeSecrets=true）', async () => {
    apiMock.reauthenticate.mockResolvedValue(undefined);
    apiMock.exportPreview.mockImplementation((opts: { includeSecrets: boolean }) =>
      Promise.resolve({
        ...exportPreviewFixture,
        includeSecrets: opts.includeSecrets,
        format: opts.includeSecrets ? 'mdaexport (AES-256-GCM 容器)' : 'csv',
      }),
    );

    renderWithClient(<ExportPanel />);
    await screen.findByRole('button', { name: '预览将要导出的内容' });

    fireEvent.click(screen.getByRole('checkbox', { name: /包含秘密字段/ }));
    fireEvent.click(screen.getByRole('button', { name: '预览将要导出的内容' }));
    fireEvent.change(await screen.findByLabelText('主密码'), { target: { value: 'ok-pw' } });
    fireEvent.click(screen.getByRole('button', { name: '验证并继续' }));

    await waitFor(() => expect(apiMock.exportPreview).toHaveBeenCalledTimes(2));
    expect(apiMock.reauthenticate).toHaveBeenCalledTimes(1);
    // reauthenticate 先于第二次 export_preview
    expect(apiMock.reauthenticate.mock.invocationCallOrder[0]).toBeLessThan(
      apiMock.exportPreview.mock.invocationCallOrder[1],
    );
    expect(apiMock.exportPreview.mock.calls[1][0]).toEqual({ includeSecrets: true, targetIds: null });
  });

  it('不含秘密导出：选择 .csv 保存路径后调用 export_commit 并展示结果', async () => {
    vi.mocked(saveFileDialog).mockResolvedValue('/tmp/台账导出.csv');
    apiMock.exportCommit.mockResolvedValue({
      path: '/tmp/台账导出.csv',
      bytes: 2048,
      items: 12,
      format: 'csv',
      encrypted: false,
      sha256: 'ab12',
      message: '已导出不含秘密的 CSV',
    });

    renderWithClient(<ExportPanel />);
    await screen.findByRole('button', { name: '选择保存路径' });
    fireEvent.click(screen.getByRole('button', { name: '选择保存路径' }));
    await screen.findByText('已选：台账导出.csv');
    fireEvent.click(screen.getByRole('button', { name: '导出 CSV' }));

    await waitFor(() => expect(apiMock.exportCommit).toHaveBeenCalledTimes(1));
    expect(apiMock.exportCommit.mock.calls[0][0]).toEqual({
      path: '/tmp/台账导出.csv',
      includeSecrets: false,
      passphrase: null,
      targetIds: null,
    });
    expect(await screen.findByText('导出完成')).toBeInTheDocument();
    expect(screen.getByText('已导出不含秘密的 CSV')).toBeInTheDocument();
  });

  it('无 accounts.export 权限时呈现「无权限」状态块', async () => {
    apiMock.exportPreview.mockRejectedValue(backendError('FORBIDDEN', '当前角色无权执行该操作'));

    renderWithClient(<ExportPanel />);

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('无权限');
    expect(screen.queryByRole('button', { name: '预览将要导出的内容' })).not.toBeInTheDocument();
  });
});

describe('ExportPanel · 容器口令实时强度提示', () => {
  /** debounce 是真实定时器，这里用等待而不是假定时器，避免与 react-query 的异步相互干扰。 */
  async function tick(ms: number) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, ms));
    });
  }

  async function passphraseField() {
    fireEvent.click(await screen.findByRole('checkbox', { name: /包含秘密字段/ }));
    return screen.getByLabelText('容器口令（加密导出文件用）');
  }

  it('不含秘密时不存在口令输入框，也不发起强度评估请求', async () => {
    renderWithClient(<ExportPanel />);
    await screen.findByRole('button', { name: '导出 CSV' });

    expect(screen.queryByLabelText('容器口令（加密导出文件用）')).not.toBeInTheDocument();
    await tick(400);
    expect(apiMock.passwordStrength).not.toHaveBeenCalled();
  });

  it('勾选含秘密但口令为空时不发起请求', async () => {
    renderWithClient(<ExportPanel />);
    const pw = await passphraseField();
    expect((pw as HTMLInputElement).value).toBe('');

    await tick(400);
    expect(apiMock.passwordStrength).not.toHaveBeenCalled();
    expect(screen.queryByText(/后端强度评估/)).not.toBeInTheDocument();
  });

  it('连续输入只在 debounce 结束后请求一次，参数就是这枚口令', async () => {
    renderWithClient(<ExportPanel />);
    const pw = await passphraseField();

    fireEvent.change(pw, { target: { value: 'Contain#' } });
    fireEvent.change(pw, { target: { value: 'Contain#Pass2026!' } });
    await tick(400);

    expect(apiMock.passwordStrength).toHaveBeenCalledTimes(1);
    expect(apiMock.passwordStrength).toHaveBeenCalledWith('Contain#Pass2026!');
    expect(await screen.findByText(/后端强度评估：满足策略（4\/4）/)).toBeInTheDocument();
  });

  it('弱口令：提示会被拒，但不禁用导出（判定仍在后端）', async () => {
    apiMock.passwordStrength.mockResolvedValue(weakAssessment);
    vi.mocked(saveFileDialog).mockResolvedValue('/tmp/台账导出.mdaexport');

    renderWithClient(<ExportPanel />);
    const pw = await passphraseField();
    fireEvent.change(pw, { target: { value: 'aaa' } });

    expect(await screen.findByText(/暂不满足策略，导出会被拒（1\/4）/)).toBeInTheDocument();
    expect(await screen.findByText('至少 12 个字符')).toBeInTheDocument();

    // 提示只是提示：导出按钮仍然可点，流程照常走到二次认证，最终由后端决定是否拒绝
    fireEvent.click(screen.getByRole('button', { name: '选择保存路径' }));
    await screen.findByText(/已选：台账导出\.mdaexport/);
    const exportBtn = screen.getByRole('button', { name: '二次认证并导出加密容器' });
    expect(exportBtn).toBeEnabled();
    fireEvent.click(exportBtn);
    expect(await screen.findByText(/含秘密导出需要二次认证/)).toBeInTheDocument();
    expect(apiMock.exportCommit).not.toHaveBeenCalled();
  });

  it('强度评估请求失败时不显示提示，不谎报强度', async () => {
    apiMock.passwordStrength.mockRejectedValue(backendError('INTERNAL', '评估不可用'));

    renderWithClient(<ExportPanel />);
    const pw = await passphraseField();
    fireEvent.change(pw, { target: { value: 'Contain#Pass2026!' } });

    await tick(400);
    expect(apiMock.passwordStrength).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/后端强度评估/)).not.toBeInTheDocument();
    // 失败不影响导出可用性
    expect(screen.getByRole('button', { name: '二次认证并导出加密容器' })).toBeEnabled();
  });

  it('清空口令或取消含秘密后提示消失，且不再发起新请求', async () => {
    renderWithClient(<ExportPanel />);
    const pw = await passphraseField();
    fireEvent.change(pw, { target: { value: 'Contain#Pass2026!' } });
    await screen.findByText(/后端强度评估：满足策略/);
    expect(apiMock.passwordStrength).toHaveBeenCalledTimes(1);

    fireEvent.change(pw, { target: { value: '' } });
    await waitFor(() => expect(screen.queryByText(/后端强度评估/)).not.toBeInTheDocument());

    fireEvent.change(pw, { target: { value: 'Contain#Pass2026!' } });
    await screen.findByText(/后端强度评估：满足策略/);
    expect(apiMock.passwordStrength).toHaveBeenCalledTimes(2);

    fireEvent.click(screen.getByRole('checkbox', { name: /包含秘密字段/ }));
    await waitFor(() => expect(screen.queryByText(/后端强度评估/)).not.toBeInTheDocument());
    await tick(400);
    expect(apiMock.passwordStrength).toHaveBeenCalledTimes(2);
  });
});
