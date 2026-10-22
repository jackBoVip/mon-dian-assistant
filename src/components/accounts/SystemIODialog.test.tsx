import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SystemIODialog, type SystemIODialogProps } from './SystemIODialog';
import { useNotify } from '../../state/notify';
import type { ExportResult, ImportCommitResult, ImportPreview } from '../../lib/types';

/**
 * 账号中心左栏的导入 / 导出弹窗（交付方 2026-10-18：图标、格式、字段口径都照原型）。
 * 这一屏要锁的是四条链路：
 *  —— 那句"已识别为 …"说的是后端按内容嗅探出来的格式，不是文件扩展名；
 *  —— 导入提交成功后弹窗自己关闭，那四个计数只活在提示条里（交付方 2026-10-19）；
 *  —— 含明文口令的导出不设闸门：点「确认导出」直接落盘，界面上不再出现主密码二次认证（交付方 2026-10-19）；
 *  —— exportCommit 收到的就是 format + shape:browser + 左栏当前那一个系统；
 *  —— 冲突行只在识别那行报数，不再向用户解释本弹窗按什么策略提交。
 */

const dialogs = vi.hoisted(() => ({
  openFile: vi.fn(),
  saveFileDialog: vi.fn(),
  saveTextFile: vi.fn(),
}));

vi.mock('../../lib/dialogs', () => ({
  openFile: (opts: unknown) => dialogs.openFile(opts),
  saveFileDialog: (opts: unknown) => dialogs.saveFileDialog(opts),
  saveTextFile: (opts: unknown, contents: string) => dialogs.saveTextFile(opts, contents),
}));

const apiMock = vi.hoisted(() => ({
  importPreview: vi.fn(),
  importCommit: vi.fn(),
  importTemplate: vi.fn(),
  exportCommit: vi.fn(),
  reauthenticate: vi.fn(),
}));

vi.mock('../../lib/api', () => ({
  api: apiMock,
  ApiError: class ApiError extends Error {},
  isTauri: () => false,
}));

function backendError(message: string, code = 'FILE_FORMAT_INVALID'): Error {
  return Object.assign(new Error(message), { code, message });
}

function preview(over: Partial<ImportPreview> = {}): ImportPreview {
  return {
    jobId: 'job-1',
    filename: '凭据.xlsx',
    fileFormat: 'xlsx',
    totalRows: 8,
    validRows: 6,
    errorRows: 1,
    conflictRows: 1,
    newTargets: 0,
    columns: ['name', 'url', 'username', 'password', 'note'],
    errors: [{ rowNo: 4, code: 'MISSING_NAME', message: 'name 缺失，无法定位系统', field: 'name' }],
    conflicts: [{ rowNo: 6, targetName: '蒙电OA', reason: '同名目标已存在' }],
    truncated: false,
    message: '预览完成。',
    ...over,
  };
}

function commitResult(over: Partial<ImportCommitResult> = {}): ImportCommitResult {
  return {
    jobId: 'job-1',
    importedRows: 6,
    createdTargets: 0,
    createdItems: 5,
    skippedRows: 1,
    conflictRows: 1,
    errors: [],
    message: '导入完成。',
    ...over,
  };
}

function exportResult(over: Partial<ExportResult> = {}): ExportResult {
  return {
    path: '/Users/me/Desktop/系统-1.xlsx',
    bytes: 20480,
    items: 5,
    format: 'xlsx',
    encrypted: false,
    sha256: 'a'.repeat(64),
    message: '已导出浏览器形状文件（含明文口令）：请核对后立即删除',
    ...over,
  };
}

const DROP_ZONE = '选择要导入的 CSV 或 Excel 文件';

/** 一份 QueryClient 从头用到尾：换 provider 会让 react-query 重新订阅，复位测试要的是"组件没被重挂"。 */
function renderDialog(over: Partial<SystemIODialogProps> = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const props: SystemIODialogProps = {
    open: true,
    mode: 'export',
    format: 'xlsx',
    targetId: 't-1',
    targetName: '系统-1',
    onClose: vi.fn(),
    ...over,
  };
  const view = (next: Partial<SystemIODialogProps>) => (
    <QueryClientProvider client={qc}>
      <SystemIODialog {...props} {...next} />
    </QueryClientProvider>
  );
  const utils = render(view({}));
  return {
    ...utils,
    props,
    card: (): HTMLElement => screen.getByRole('dialog'),
    rerenderWith: (next: Partial<SystemIODialogProps>) => utils.rerender(view(next)),
  };
}

function lastNotify() {
  return useNotify.getState().items.slice(-1)[0];
}

/**
 * 选保存路径中间隔着一个 await：不等它落回 state 就点「确认导出」，
 * 会被自己那句"请先选择保存路径"拦住——那是这一串用例最容易被自己绊倒的地方。
 */
async function pickPath() {
  fireEvent.click(screen.getByRole('button', { name: /选择保存路径/ }));
  await screen.findByText('已选：系统-1.xlsx');
}

beforeEach(() => {
  useNotify.setState({ items: [] });
  Object.values(dialogs).forEach((fn) => fn.mockReset());
  Object.values(apiMock).forEach((fn) => fn.mockReset());
  dialogs.saveFileDialog.mockResolvedValue('/Users/me/Desktop/系统-1.xlsx');
  dialogs.saveTextFile.mockResolvedValue({ path: '/Users/me/Desktop/导入模板.csv', fileName: '导入模板.csv' });
  apiMock.reauthenticate.mockResolvedValue(undefined);
  apiMock.exportCommit.mockResolvedValue(exportResult());
});

describe('导入面（原型 819-841）', () => {
  it('文案逐字照原型，「开始导入」在识别出文件之前是禁的', async () => {
    renderDialog({ mode: 'import' });
    const card = await screen.findByRole('dialog', { name: '导入系统与账号' });
    expect(within(card).getByText('点击或将文件拖拽至此区域')).toBeInTheDocument();
    expect(card.textContent).toContain('支持 CSV / XLSX 格式导入，格式按文件内容自动识别');
    expect(within(card).getByRole('button', { name: '开始导入' })).toBeDisabled();
    expect(within(card).getByRole('button', { name: '下载模板' })).toBeEnabled();
  });

  it('选了文件就按后端回的文件格式播报，并带上那四个计数', async () => {
    dialogs.openFile.mockResolvedValue('/tmp/凭据.xlsx');
    apiMock.importPreview.mockResolvedValue(preview({ fileFormat: 'xlsx' }));
    renderDialog({ mode: 'import' });
    fireEvent.click(screen.getByRole('button', { name: DROP_ZONE }));

    expect(await screen.findByRole('status')).toHaveTextContent('已识别为 xlsx：共 8 行，可导入 6 行，错误 1 行，冲突 1 行。');
    expect(dialogs.openFile).toHaveBeenCalledWith({
      title: '选择要导入的文件（CSV 或 Excel）',
      filters: [{ name: '表格文件', extensions: ['csv', 'xlsx'] }],
    });
    expect(apiMock.importPreview).toHaveBeenCalledWith('/tmp/凭据.xlsx');
    // 后端把 .xlsx 内容的扩展名写错的表也认得出来：界面播报的是内容，不是文件名
    expect(screen.getByRole('button', { name: '开始导入' })).toBeEnabled();
  });

  it('选了文件后，框里换成大图标 + 文件名，引导语让位（交付方 2026-10-19：否则看着像没选中）', async () => {
    dialogs.openFile.mockResolvedValue('/tmp/台账导出-2026年10月19日-全量.xlsx');
    apiMock.importPreview.mockResolvedValue(preview());
    renderDialog({ mode: 'import' });
    fireEvent.click(screen.getByRole('button', { name: DROP_ZONE }));

    const zone = await screen.findByRole('button', { name: '已选择 台账导出-2026年10月19日-全量.xlsx，点击可换一份文件' });
    expect(within(zone).getByText('台账导出-2026年10月19日-全量.xlsx')).toBeInTheDocument();
    expect(zone.querySelector('svg')).not.toBeNull();
    expect(within(zone).queryByText('点击或将文件拖拽至此区域')).toBeNull();
    // 交付方 2026-10-20：识别回执落在框里、顶掉那句"点击或拖入另一份文件可替换"，引导语不再出现
    expect(within(zone).getByRole('status')).toHaveTextContent('已识别为 xlsx：共 8 行，可导入 6 行，错误 1 行，冲突 1 行。');
    expect(within(zone).queryByText('点击或拖入另一份文件可替换')).toBeNull();
    // 而且整屏只有这一处，框外不再重复一遍
    expect(screen.getAllByRole('status')).toHaveLength(1);
  });

  it('识别失败时文件名仍留在框里：报错要说得出是哪一份出的问题', async () => {
    dialogs.openFile.mockResolvedValue('/tmp/伪造.csv');
    apiMock.importPreview.mockRejectedValue(backendError('不是可解析的表格文件'));
    renderDialog({ mode: 'import' });
    fireEvent.click(screen.getByRole('button', { name: DROP_ZONE }));

    expect(await screen.findByText('不是可解析的表格文件')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /已选择 伪造\.csv/ })).toBeInTheDocument();
  });

  it('提交成功就自己关窗：弹窗不再等人手点关闭，计数由那句 toast 报（交付方 2026-10-19）', async () => {
    dialogs.openFile.mockResolvedValue('/tmp/凭据.csv');
    apiMock.importPreview.mockResolvedValue(preview({ fileFormat: 'csv' }));
    apiMock.importCommit.mockResolvedValue(commitResult({ createdTargets: 2 }));
    const { props } = renderDialog({ mode: 'import' });
    fireEvent.click(screen.getByRole('button', { name: DROP_ZONE }));
    await screen.findByText(/已识别为 csv/);

    fireEvent.click(screen.getByRole('button', { name: '开始导入' }));
    await waitFor(() => expect(props.onClose).toHaveBeenCalledTimes(1));
    expect(lastNotify()?.text).toBe('导入完成：新增 2 个系统、5 条凭据，跳过 1 行，冲突 1 行。');
    // 关窗那一刻内部状态已经清干净：父级哪怕不改 open，框里也不会残留上一份文件
    expect(screen.getByRole('button', { name: DROP_ZONE })).toBeInTheDocument();
    expect(screen.getByText('点击或将文件拖拽至此区域')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '开始导入' })).toBeDisabled();
    // 结果段落随弹窗一起没了：这些数字只报一次，不在界面里留第二份
    expect(screen.queryByText(/^导入完成：/)).toBeNull();
  });

  it('有行没写进库时，toast 里必须跟着报出来', async () => {
    dialogs.openFile.mockResolvedValue('/tmp/凭据.csv');
    apiMock.importPreview.mockResolvedValue(preview({ fileFormat: 'csv' }));
    apiMock.importCommit.mockResolvedValue(
      commitResult({
        errors: [
          { rowNo: 3, code: 'MISSING_USERNAME', message: '缺少用户名', field: 'username' },
          { rowNo: 7, code: 'BAD_URL', message: '地址不合法', field: 'url' },
        ],
      }),
    );
    renderDialog({ mode: 'import' });
    fireEvent.click(screen.getByRole('button', { name: DROP_ZONE }));
    await screen.findByText(/已识别为 csv/);

    fireEvent.click(screen.getByRole('button', { name: '开始导入' }));
    await waitFor(() => expect(lastNotify()?.text).toContain('行有错误未写入'));
    expect(lastNotify()?.text).toContain('其中 2 行有错误未写入。');
  });

  it('同样的字节流被后端判成 csv 时，播报跟着改口', async () => {
    dialogs.openFile.mockResolvedValue('/tmp/其实.csv');
    apiMock.importPreview.mockResolvedValue(preview({ fileFormat: 'csv' }));
    renderDialog({ mode: 'import' });
    fireEvent.click(screen.getByRole('button', { name: DROP_ZONE }));
    expect(await screen.findByRole('status')).toHaveTextContent('已识别为 csv');
  });

  it('文件读不成表只报错，「开始导入」回到禁用', async () => {
    dialogs.openFile.mockResolvedValue('/tmp/伪造.csv');
    apiMock.importPreview.mockRejectedValue(backendError('不是可解析的表格文件'));
    renderDialog({ mode: 'import' });
    fireEvent.click(screen.getByRole('button', { name: DROP_ZONE }));

    expect(await screen.findByText('不是可解析的表格文件')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '开始导入' })).toBeDisabled();
    expect(apiMock.importCommit).not.toHaveBeenCalled();
  });

  it('取消文件选择是一句状态而不是错误，也不会去要预览', async () => {
    dialogs.openFile.mockResolvedValue(null);
    renderDialog({ mode: 'import' });
    fireEvent.click(screen.getByRole('button', { name: DROP_ZONE }));

    expect(await screen.findByRole('status')).toHaveTextContent('已取消文件选择。');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(apiMock.importPreview).not.toHaveBeenCalled();
  });

  it('冲突行一律按「跳过」提交，成功后弹窗关闭，同一份作业不会被点两遍', async () => {
    dialogs.openFile.mockResolvedValue('/tmp/凭据.csv');
    apiMock.importPreview.mockResolvedValue(preview({ fileFormat: 'csv' }));
    apiMock.importCommit.mockResolvedValue(commitResult());
    const { props } = renderDialog({ mode: 'import' });
    fireEvent.click(screen.getByRole('button', { name: DROP_ZONE }));
    await screen.findByText(/已识别为 csv/);

    fireEvent.click(screen.getByRole('button', { name: '开始导入' }));
    await waitFor(() => expect(apiMock.importCommit).toHaveBeenCalledWith('job-1', 'skip'));
    await waitFor(() => expect(props.onClose).toHaveBeenCalledTimes(1));
    expect(lastNotify()?.text).toContain('导入完成');
    // preview 已清空：就算父级没关窗，那颗钮也点不动，第二遍提交发不出去
    expect(screen.getByRole('button', { name: '开始导入' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '开始导入' }));
    expect(apiMock.importCommit).toHaveBeenCalledTimes(1);
  });

  it('下载模板把后端那段 CSV 原样交给系统下载通道，界面上不自己拼表头', async () => {
    apiMock.importTemplate.mockResolvedValue({ csv: 'name,url,username,password,note\n', columns: ['name'], note: '第一行是表头' });
    renderDialog({ mode: 'import' });
    fireEvent.click(screen.getByRole('button', { name: '下载模板' }));

    await waitFor(() => expect(apiMock.importTemplate).toHaveBeenCalled());
    expect(dialogs.saveTextFile).toHaveBeenCalledWith(
      expect.objectContaining({ defaultPath: '导入模板.csv' }),
      'name,url,username,password,note\n',
    );
    expect(await screen.findByRole('status')).toHaveTextContent('模板已写出：导入模板.csv');
  });

  it('导入视图不放「导入导出」页那段引导（既无文案也无跳转钮）', async () => {
    renderDialog({ mode: 'import' });
    expect(await screen.findByText('点击或将文件拖拽至此区域')).toBeInTheDocument();
    expect(screen.queryByText(/那一套完整流程在「导入导出」页/)).toBeNull();
    expect(screen.queryByRole('button', { name: '到导入导出页' })).toBeNull();
  });

  it('有冲突行时也不再向用户解释「一律按跳过提交」，冲突数只留在识别那行里（交付方 2026-10-19）', async () => {
    dialogs.openFile.mockResolvedValue('/tmp/凭据.csv');
    apiMock.importPreview.mockResolvedValue(preview({ fileFormat: 'csv', conflictRows: 3 }));
    renderDialog({ mode: 'import' });
    fireEvent.click(screen.getByRole('button', { name: DROP_ZONE }));
    await screen.findByText(/已识别为 csv/);

    expect(screen.queryByText(/本弹窗一律按「跳过」提交/)).toBeNull();
    expect(screen.queryByText(/需要「更新」/)).toBeNull();
    expect(screen.queryByText(/请到「导入导出」页/)).toBeNull();
    // 撤的只是那句解释：后端计数照旧播报，提交策略也还是 skip
    expect(screen.getByText(/冲突 3 行/)).toBeInTheDocument();
  });

  it('关掉重开：上一轮的识别结果与报错都不留', async () => {
    dialogs.openFile.mockResolvedValue('/tmp/凭据.xlsx');
    apiMock.importPreview.mockResolvedValue(preview());
    const { rerenderWith } = renderDialog({ mode: 'import' });
    fireEvent.click(screen.getByRole('button', { name: DROP_ZONE }));
    await screen.findByText(/已识别为 xlsx/);

    rerenderWith({ open: false });
    expect(screen.queryByRole('dialog')).toBeNull();
    rerenderWith({ open: true });
    expect(screen.queryByText(/已识别为 xlsx/)).toBeNull();
    expect(screen.getByRole('button', { name: '开始导入' })).toBeDisabled();
  });
});

describe('导出面（原型 844-855，含明文口令那一档）', () => {
  it('标题与格式回显按原型：导出 Excel / Excel (.xlsx)，点名导的是左栏当前那个系统', async () => {
    const { card, rerenderWith } = renderDialog();
    await screen.findByRole('dialog', { name: '导出 Excel' });
    expect(card().textContent).toContain('当前系统「系统-1」下的所有账号凭据');
    expect(card().textContent).toContain('Excel (.xlsx)');

    rerenderWith({ format: 'csv' });
    await screen.findByRole('dialog', { name: '导出 CSV' });
    expect(card().textContent).toContain('CSV (.csv)');
  });

  it('含明文口令的导出：点「确认导出」直接落盘，不再要主密码、二次认证命令一次都不发（交付方 2026-10-19）', async () => {
    renderDialog();
    await pickPath();

    fireEvent.click(screen.getByRole('button', { name: '确认导出' }));

    await waitFor(() =>
      expect(apiMock.exportCommit).toHaveBeenCalledWith({
        path: '/Users/me/Desktop/系统-1.xlsx',
        includeSecrets: true,
        passphrase: null,
        targetIds: ['t-1'],
        format: 'xlsx',
        shape: 'browser',
      }),
    );
    expect(apiMock.reauthenticate).not.toHaveBeenCalled();
    // 那道闸门整块撤下：界面上既没有主密码输入框，也没有"二次认证"这句话
    expect(screen.queryByLabelText('主密码')).toBeNull();
    expect(screen.queryByRole('alertdialog', { name: '主密码二次认证' })).toBeNull();
    expect(document.body.textContent).not.toContain('二次认证');

    // 成功回执整块不上屏（交付方 2026-10-19「这个提示不要」）：面板里既没有那句"已导出…"，
    // 也没有字节数、凭据条数与 sha256 那一行
    expect(screen.queryByText(/已导出浏览器形状文件/)).toBeNull();
    expect(screen.queryByText(/条凭据/)).toBeNull();
    expect(screen.queryByText(/sha256/)).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
    // 后端那句 message 仍然只活在提示条里，一次
    expect(lastNotify()?.text).toContain('请核对后立即删除');
  });

  it('导出成功后弹窗自己关掉：文件已经落盘，留着一张空面板只会让人以为还没导出（对齐导入那一侧）', async () => {
    const { props } = renderDialog();
    await pickPath();

    fireEvent.click(screen.getByRole('button', { name: '确认导出' }));

    await waitFor(() => expect(props.onClose).toHaveBeenCalledTimes(1));
    // 只关一次：成功分支里 onClose 不能被 notify 之外的事再触发一遍
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it('没选保存路径就点导出：只有一句提示，不写半份文件，也不关窗（用户得在这儿补）', async () => {
    dialogs.saveFileDialog.mockResolvedValue(null);
    const { props } = renderDialog();
    fireEvent.click(screen.getByRole('button', { name: /选择保存路径/ }));
    await waitFor(() => expect(dialogs.saveFileDialog).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: '确认导出' }));

    expect(await screen.findByText('请先选择保存路径。')).toBeInTheDocument();
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(apiMock.exportCommit).not.toHaveBeenCalled();
    expect(apiMock.reauthenticate).not.toHaveBeenCalled();
    expect(props.onClose).not.toHaveBeenCalled();
  });

  it('取消勾选明文密码：直接导出，"password 列留空"那句要说出来', async () => {
    apiMock.exportCommit.mockResolvedValue(exportResult({ message: '已导出不含口令的浏览器形状文件' }));
    renderDialog();
    await pickPath();
    const box = screen.getByRole('checkbox', { name: /包含明文密码/ });
    expect(box).toBeChecked();
    fireEvent.click(box);
    expect(screen.getByText('不勾选则 password 列留空，导出的表里没有凭据内容。')).toBeInTheDocument();
    expect(screen.queryByText(/拿到文件就等于拿到全部口令/)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '确认导出' }));
    await waitFor(() => expect(apiMock.exportCommit).toHaveBeenCalledWith(expect.objectContaining({ includeSecrets: false })));
    expect(apiMock.reauthenticate).not.toHaveBeenCalled();
    expect(lastNotify()?.text).toContain('已导出不含口令的浏览器形状文件');
    expect(screen.queryByText(/已导出不含口令的浏览器形状文件/)).toBeNull();
    expect(screen.queryByText(/sha256/)).toBeNull();
    expect(screen.queryByText(/条凭据/)).toBeNull();
  });

  it('勾着明文密码时风险那句照旧说清，但不再承诺"导出要先过主密码二次认证"（这句已经做不到了）', async () => {
    renderDialog();
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('拿到文件就等于拿到全部口令');
    expect(alert.textContent).toContain('请把它与口令通过独立的安全渠道交付');
    expect(alert.textContent).not.toContain('二次认证');
  });

  it('左栏一个系统都没选中时如实拦住，不会把 targetIds 传成空数组', async () => {
    const { props } = renderDialog({ targetId: null, targetName: '' });
    expect(await screen.findByText('当前系统「未选择」下的所有账号凭据。')).toBeInTheDocument();
    await pickPath();
    fireEvent.click(screen.getByRole('button', { name: '确认导出' }));
    expect(await screen.findByText('请先在左栏选择一个系统。')).toBeInTheDocument();
    expect(apiMock.exportCommit).not.toHaveBeenCalled();
    expect(props.onClose).not.toHaveBeenCalled();
  });

  it('导出命令失败时把后端那句原话带出来，成功块不出现，弹窗留着让人看清是没导成', async () => {
    apiMock.exportCommit.mockRejectedValue(backendError('目标路径已存在同名文件', 'INVALID_INPUT'));
    const { props } = renderDialog();
    await pickPath();
    fireEvent.click(screen.getByRole('button', { name: '确认导出' }));

    expect(await screen.findByText('导出失败：目标路径已存在同名文件')).toBeInTheDocument();
    expect(screen.queryByText(/已导出浏览器形状文件/)).toBeNull();
    expect(props.onClose).not.toHaveBeenCalled();
  });
});
