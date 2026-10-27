import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ExternalToolsSection } from './ExternalToolsSection';
import type { ExternalTool } from '../../lib/types';
import { useNotify } from '../../state/notify';

const mocks = vi.hoisted(() => ({
  externalTools: vi.fn(),
  setExternalTool: vi.fn(),
  upsertDatabaseTool: vi.fn(),
  deleteExternalTool: vi.fn(),
  openFile: vi.fn(),
}));

vi.mock('../../lib/api', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../lib/api')>();
  return { ...mod, api: { ...mod.api, ...mocks } };
});

// jsdom 里没有 Tauri 壳：不 mock 就会拿到 NOT_TAURI 错误，对话框那条路压根走不到
vi.mock('../../lib/dialogs', () => ({ openFile: mocks.openFile }));

const BROWSER: ExternalTool = {
  id: 'et-browser',
  kind: 'browser',
  engine: '',
  label: '浏览器',
  appPath: '/Applications/Google Chrome.app',
  pathExists: true,
};
const TERMINAL: ExternalTool = {
  id: 'et-terminal',
  kind: 'terminal',
  engine: '',
  label: '终端工具',
  appPath: '',
  pathExists: false,
};
const MYSQL: ExternalTool = {
  id: '018f6b00-0000-7000-8000-000000000001',
  kind: 'database',
  engine: 'mysql',
  label: 'DBeaver（MySQL）',
  appPath: '/Applications/MySQLWorkbench.app',
  pathExists: false,
};

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ExternalToolsSection />
    </QueryClientProvider>,
  );
}

function lastToast(): string {
  const items = useNotify.getState().items;
  return items[items.length - 1]?.text ?? '';
}

beforeEach(() => {
  vi.clearAllMocks();
  useNotify.setState({ items: [] });
  mocks.externalTools.mockResolvedValue([BROWSER, TERMINAL, MYSQL]);
  mocks.setExternalTool.mockImplementation((_kind: string, appPath: string) =>
    Promise.resolve({ ...BROWSER, appPath, pathExists: appPath !== '' })
  );
  mocks.upsertDatabaseTool.mockResolvedValue({ ...MYSQL, engine: 'mysql', pathExists: true });
  mocks.deleteExternalTool.mockResolvedValue(undefined);
  mocks.openFile.mockResolvedValue(null);
});

describe('固定两档', () => {
  it('三档都在，状态各说各话：已配置 / 未配置 / 路径已失效', async () => {
    renderPage();
    const browser = await screen.findByLabelText('浏览器应用路径');
    expect(browser).toHaveValue(BROWSER.appPath);
    expect(screen.getByLabelText('终端工具应用路径')).toHaveValue('');
    expect(screen.getByText('已配置')).toBeInTheDocument();
    expect(screen.getByText('未配置（用系统默认）')).toBeInTheDocument();
    expect(screen.getByText('路径已失效（将回退系统默认）')).toBeInTheDocument();
  });

  it('手输路径后失焦即保存，成功后重取清单', async () => {
    renderPage();
    const input = await screen.findByLabelText('浏览器应用路径');
    fireEvent.change(input, { target: { value: '/Applications/Safari.app' } });
    fireEvent.blur(input);
    await waitFor(() => expect(mocks.setExternalTool).toHaveBeenCalledWith('browser', '/Applications/Safari.app'));
    await waitFor(() => expect(mocks.externalTools.mock.calls.length).toBeGreaterThan(1));
  });

  it('相对路径在前端就挡下：不发请求，并说要填绝对路径', async () => {
    renderPage();
    const input = await screen.findByLabelText('浏览器应用路径');
    fireEvent.change(input, { target: { value: 'Safari.app' } });
    fireEvent.blur(input);
    expect(mocks.setExternalTool).not.toHaveBeenCalled();
    expect(lastToast()).toContain('绝对路径');
  });

  it('「选择应用」拿到的路径直接提交；取消对话框什么都不改', async () => {
    mocks.openFile.mockResolvedValueOnce('/Applications/iTerm.app');
    renderPage();
    await screen.findByLabelText('终端工具应用路径');
    fireEvent.click(screen.getAllByRole('button', { name: '选择应用' })[1]);
    await waitFor(() => expect(mocks.setExternalTool).toHaveBeenCalledWith('terminal', '/Applications/iTerm.app'));

    mocks.setExternalTool.mockClear();
    mocks.openFile.mockResolvedValueOnce(null);
    fireEvent.click(screen.getAllByRole('button', { name: '选择应用' })[1]);
    await waitFor(() => expect(mocks.openFile).toHaveBeenCalledTimes(2));
    expect(mocks.setExternalTool).not.toHaveBeenCalled();
  });

  it('「改用系统默认」提交的是空串，按钮只在已有路径时出现', async () => {
    renderPage();
    await screen.findByLabelText('浏览器应用路径');
    fireEvent.click(screen.getByRole('button', { name: '改用系统默认' }));
    await waitFor(() => expect(mocks.setExternalTool).toHaveBeenCalledWith('browser', ''));
    // 终端档本来就是空的，那一行不该再给一颗"改用系统默认"
    expect(screen.getAllByRole('button', { name: '改用系统默认' })).toHaveLength(1);
  });

  it('后端拒绝时把原因说给用户，不静默改成看起来已保存', async () => {
    mocks.setExternalTool.mockRejectedValueOnce(Object.assign(new Error('本机找不到这个应用'), { code: 'EXTERNAL_TOOL_REJECTED' }));
    renderPage();
    const input = await screen.findByLabelText('浏览器应用路径');
    fireEvent.change(input, { target: { value: '/Applications/Nope.app' } });
    fireEvent.blur(input);
    await waitFor(() => expect(lastToast()).toContain('本机找不到这个应用'));
  });
});

describe('数据库工具清单', () => {
  it('列出的只有数据库档，固定两档不混进表里', async () => {
    renderPage();
    await screen.findByLabelText('浏览器应用路径');
    const grid = screen.getByText('DBeaver（MySQL）').closest('div[class*="grid"]');
    expect(grid?.textContent).toContain('mysql');
    expect(grid?.textContent).toContain('路径已失效');
    expect(screen.queryByText('浏览器', { selector: 'span.mono' })).toBeNull();
  });

  it('新增：填 jdbc:MySQL 会归一化成 mysql 再保存', async () => {
    renderPage();
    await screen.findByLabelText('浏览器应用路径');
    fireEvent.click(screen.getByRole('button', { name: '新增数据库工具' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByPlaceholderText(/mysql \/ oracle/), { target: { value: 'jdbc:MySQL' } });
    expect(within(dialog).getByText(/会存成 mysql/)).toBeInTheDocument();
    fireEvent.change(within(dialog).getByPlaceholderText('例如 DBeaver（MySQL）'), { target: { value: 'Workbench' } });
    fireEvent.change(within(dialog).getByLabelText('应用路径'), { target: { value: '/Applications/MySQLWorkbench.app' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '保存' }));
    await waitFor(() =>
      expect(mocks.upsertDatabaseTool).toHaveBeenCalledWith(null, 'mysql', 'Workbench', '/Applications/MySQLWorkbench.app')
    );
  });

  it('引擎、名称、路径缺一样都不许保存（这一档的存在意义就是指向一个应用）', async () => {
    renderPage();
    await screen.findByLabelText('浏览器应用路径');
    fireEvent.click(screen.getByRole('button', { name: '新增数据库工具' }));
    const dialog = await screen.findByRole('dialog');
    const save = within(dialog).getByRole('button', { name: '保存' });
    expect(save).toBeDisabled();
    fireEvent.change(within(dialog).getByPlaceholderText(/mysql \/ oracle/), { target: { value: 'oracle' } });
    expect(save).toBeDisabled();
    fireEvent.change(within(dialog).getByPlaceholderText('例如 DBeaver（MySQL）'), { target: { value: 'SQL Developer' } });
    expect(save).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText('应用路径'), { target: { value: 'SQLDeveloper' } });
    expect(save).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText('应用路径'), { target: { value: '/Applications/SQLDeveloper.app' } });
    await waitFor(() => expect(save).toBeEnabled());
  });

  it('编辑走的是那一条的 id，不是新增', async () => {
    renderPage();
    await screen.findByLabelText('浏览器应用路径');
    fireEvent.click(screen.getByRole('button', { name: '编辑 DBeaver（MySQL）' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByPlaceholderText(/mysql \/ oracle/)).toHaveValue('mysql');
    fireEvent.click(within(dialog).getByRole('button', { name: '保存' }));
    await waitFor(() =>
      expect(mocks.upsertDatabaseTool).toHaveBeenCalledWith(MYSQL.id, 'mysql', 'DBeaver（MySQL）', MYSQL.appPath)
    );
  });

  it('删除走两步：第一次只把「确认删除」问出来，第二次才发请求', async () => {
    renderPage();
    await screen.findByLabelText('浏览器应用路径');
    fireEvent.click(screen.getByRole('button', { name: '删除 DBeaver（MySQL）' }));
    expect(mocks.deleteExternalTool).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '确认删除' }));
    await waitFor(() => expect(mocks.deleteExternalTool).toHaveBeenCalledWith(MYSQL.id));
    expect(lastToast()).toContain('改用系统默认');
  });

  it('取消那一步把「确认删除」收回去，什么都不删', async () => {
    renderPage();
    await screen.findByLabelText('浏览器应用路径');
    fireEvent.click(screen.getByRole('button', { name: '删除 DBeaver（MySQL）' }));
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(mocks.deleteExternalTool).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: '删除 DBeaver（MySQL）' })).toBeInTheDocument();
  });
});
