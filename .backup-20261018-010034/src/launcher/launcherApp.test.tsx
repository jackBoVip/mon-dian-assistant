import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi } from 'vitest';
import { LauncherApp } from './LauncherApp';
import type { ActionReply, LauncherPreferences, QuickAction, QuickResult, SearchReply } from '../lib/types';

const mocks = vi.hoisted(() => ({
  launcherPreferences: vi.fn(),
  quickSearch: vi.fn(),
  quickAction: vi.fn(),
  launcherVisibility: vi.fn(),
}));
const bus = vi.hoisted(() => ({ handlers: {} as Record<string, () => void>, unlisteners: {} as Record<string, ReturnType<typeof vi.fn>> }));

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn((name: string, cb: () => void) => {
    bus.handlers[name] = cb;
    bus.unlisteners[name] = vi.fn();
    return Promise.resolve(bus.unlisteners[name]);
  }),
}));

vi.mock('../lib/api', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../lib/api')>();
  return { ...mod, api: { ...mod.api, ...mocks } };
});

const row: QuickResult = {
  targetId: 't-1',
  itemId: 'i-1',
  systemName: 'OA办公系统',
  itemType: 'web',
  accountAlias: '日常办公',
  usernameMasked: 'l***',
  addressSummary: 'https://oa.nmgdl.cn',
  tags: ['门户'],
  isDefault: true,
  favorite: true,
  credentialCountOnTarget: 1,
  actions: ['open_and_fill', 'copy_username'],
  matchKind: 'contains',
};

function reply(results: QuickResult[], locked = false): SearchReply {
  return { locked, results, elapsedMs: 1200, indexed: 42 };
}

/** 后端 allowed_actions() 在扩展就绪、允许复制密码时给出的真实顺序（open_and_fill 被插到最前）。 */
const keyRow: QuickResult = {
  ...row,
  actions: ['open_and_fill', 'view_detail', 'copy_username', 'open_target', 'copy_password'],
};

/** 同一目标下的第二条凭据（非默认、非网页动作集：数据库目标不会有 open_and_fill）。 */
const keyRowOther: QuickResult = {
  ...keyRow,
  itemId: 'i-2',
  accountAlias: '运维账号',
  itemType: 'database',
  isDefault: false,
  favorite: false,
  actions: ['view_detail', 'copy_username', 'open_target', 'copy_password', 'set_default'],
};

function ok(action: QuickAction): ActionReply {
  return { action, ok: true, message: `已执行 ${action}` };
}

function preferences(show: boolean): LauncherPreferences {
  return {
    shortcut: 'CmdOrCtrl+Alt+Space',
    default: 'CmdOrCtrl+Alt+Space',
    enabled: true,
    showRecentWhenEmpty: show,
    rankRecentFavorite: true,
    resultLimit: 20,
    syntax: [['系统:OA', '按目标名包含匹配']],
  };
}

function renderApp() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={qc}>
      <LauncherApp />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  mocks.launcherPreferences.mockReset();
  mocks.quickSearch.mockReset();
  mocks.quickAction.mockReset();
  mocks.launcherPreferences.mockResolvedValue(preferences(true));
  mocks.quickSearch.mockResolvedValue(reply([]));
  mocks.quickAction.mockResolvedValue(ok('open_and_fill'));
  bus.handlers = {};
  bus.unlisteners = {};
});

describe('浮层空输入推荐（需求 §285：由设置启用，锁定时不得显示）', () => {
  it('开关开启时空输入就取推荐，并把后端返回的条目显示出来', async () => {
    mocks.quickSearch.mockResolvedValue(reply([row]));
    renderApp();
    await waitFor(() => expect(mocks.quickSearch).toHaveBeenCalledWith(''));
    expect(await screen.findByText('OA办公系统')).toBeInTheDocument();
    expect(screen.getByText(/最近使用 \/ 收藏推荐 1 条/)).toBeInTheDocument();
  });

  it('开关关闭时空输入不发任何请求，界面只有后端语法说明', async () => {
    mocks.launcherPreferences.mockResolvedValue(preferences(false));
    renderApp();
    await waitFor(() => expect(mocks.launcherPreferences).toHaveBeenCalledTimes(1));
    // 给防抖与可能的异步请求留出时间：这期间一次 quickSearch 都不应发生
    await act(async () => {
      await new Promise((r) => window.setTimeout(r, 300));
    });
    expect(mocks.quickSearch).not.toHaveBeenCalled();
    expect(screen.queryByText(/收藏推荐/)).toBeNull();
    expect(screen.getByText('搜索语法（来自后端）：')).toBeInTheDocument();
  });

  it('开关开启但后端返回空（管理员刚关掉）时不显示推荐摘要', async () => {
    mocks.quickSearch.mockResolvedValue(reply([]));
    renderApp();
    await waitFor(() => expect(mocks.quickSearch).toHaveBeenCalledWith(''));
    await waitFor(() => expect(screen.getByText('系统:OA')).toBeInTheDocument());
    expect(screen.queryByText(/收藏推荐/)).toBeNull();
    expect(screen.queryAllByRole('option')).toHaveLength(0);
  });

  it('输入条件后切换为条件搜索：命中摘要替代推荐摘要', async () => {
    mocks.quickSearch.mockResolvedValue(reply([row]));
    renderApp();
    await waitFor(() => expect(mocks.quickSearch).toHaveBeenCalledWith(''));

    fireEvent.change(screen.getByRole('textbox', { name: '快速查找账号' }), { target: { value: 'OA' } });
    await waitFor(() => expect(mocks.quickSearch).toHaveBeenCalledWith('OA'));
    expect(await screen.findByText(/命中 1 条 · 耗时/)).toBeInTheDocument();
    expect(screen.queryByText(/收藏推荐/)).toBeNull();
  });

  it('锁定响应下不渲染任何条目，即使之前有过推荐', async () => {
    mocks.quickSearch.mockResolvedValueOnce(reply([row])).mockResolvedValue(reply([], true));
    renderApp();
    await waitFor(() => expect(mocks.quickSearch).toHaveBeenCalledTimes(1));
    fireEvent.change(screen.getByRole('textbox', { name: '快速查找账号' }), { target: { value: 'OA' } });

    expect(await screen.findByText('保险库已锁定，快捷启动器不显示任何结果。')).toBeInTheDocument();
    expect(screen.queryByText('OA办公系统')).toBeNull();
    expect(screen.queryAllByRole('option')).toHaveLength(0);
    expect(screen.queryByText(/收藏推荐|命中/)).toBeNull();
  });

  it('浮层是隐藏不是销毁：再次被唤起时重读设置，管理员刚关掉的开关不需要等重启', async () => {
    mocks.quickSearch.mockResolvedValue(reply([row]));
    renderApp();
    await waitFor(() => expect(screen.getByText('OA办公系统')).toBeInTheDocument());

    // 管理员在系统管理里把开关关掉 → 下一次唤起时后端返回 showRecentWhenEmpty=false
    mocks.launcherPreferences.mockResolvedValue(preferences(false));
    await act(async () => {
      bus.handlers['launcher://shown']();
    });
    await waitFor(() => expect(mocks.launcherPreferences).toHaveBeenCalledTimes(2));
    expect(screen.queryByText('OA办公系统')).toBeNull();
    expect(screen.queryByText(/收藏推荐/)).toBeNull();
  });

  it('组件卸载后取消订阅：来自旧实例的事件不再触发请求', async () => {
    const view = renderApp();
    await waitFor(() => expect(bus.handlers['launcher://shown']).toBeTruthy());
    const callsBefore = mocks.launcherPreferences.mock.calls.length;
    const unlisten = bus.unlisteners['launcher://shown'];
    view.unmount();
    expect(unlisten).toHaveBeenCalled();
    expect(() => bus.handlers['launcher://shown']()).not.toThrow();
    expect(mocks.launcherPreferences.mock.calls.length).toBe(callsBefore);
  });
});

/** 把浮层带进"有结果、第 0 行高亮"的状态，返回输入框以便发键盘事件。 */
async function renderWithResults(rows: QuickResult[]) {
  mocks.quickSearch.mockResolvedValue(reply(rows));
  renderApp();
  const input = screen.getByRole('textbox', { name: '快速查找账号' });
  fireEvent.change(input, { target: { value: 'OA' } });
  await waitFor(() => expect(mocks.quickSearch).toHaveBeenCalledWith('OA'));
  // 别名和用户名、地址在同一个文本节点里拼接，只能用正则做包含匹配
  await screen.findByText(new RegExp(rows[0].accountAlias));
  return input;
}

describe('浮层键盘操作（需求 line 261：↑↓ 选结果、Tab 切换可用操作、Enter 执行、Esc 关闭）', () => {
  it('默认执行主操作；Tab 切换到的动作成为 Enter 的执行对象', async () => {
    const input = await renderWithResults([keyRow]);

    // 未动过 Tab：Enter 就是主操作（网页 + 扩展就绪 → 打开并填充）
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(mocks.quickAction).toHaveBeenCalledWith('open_and_fill', 'i-1', 't-1', 'i-1'));
    mocks.quickAction.mockClear();

    // 可用操作提示要把这一条能做的事全部列出来
    expect(screen.getByText(/打开并填充 \/ 查看详情 \/ 复制用户名 \/ 打开目标 \/ 复制密码/)).toBeInTheDocument();

    fireEvent.keyDown(input, { key: 'Tab' });
    expect(await screen.findByText(/执行「查看详情」/)).toBeInTheDocument();
    fireEvent.keyDown(input, { key: 'Tab' });
    expect(await screen.findByText(/执行「复制用户名」/)).toBeInTheDocument();
    expect(mocks.quickAction).not.toHaveBeenCalled();

    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(mocks.quickAction).toHaveBeenCalledWith('copy_username', 'i-1', 't-1', 'i-1'));
  });

  it('Tab 循环到末尾回到主操作，Shift+Tab 反向循环', async () => {
    const input = await renderWithResults([keyRow]);
    for (let i = 0; i < 5; i += 1) fireEvent.keyDown(input, { key: 'Tab' });
    expect(await screen.findByText(/执行「打开并填充」/)).toBeInTheDocument();

    fireEvent.keyDown(input, { key: 'Tab', shiftKey: true });
    expect(await screen.findByText(/执行「复制密码」/)).toBeInTheDocument();
  });

  it('Enter 的主操作永不落在复制密码上，即使后端把 copy_password 放在第一位', async () => {
    mocks.quickSearch.mockResolvedValue(reply([{ ...keyRow, actions: ['copy_password', 'copy_username'] }]));
    renderApp();
    const input = screen.getByRole('textbox', { name: '快速查找账号' });
    fireEvent.change(input, { target: { value: 'OA' } });
    await waitFor(() => expect(mocks.quickSearch).toHaveBeenCalledWith('OA'));
    await screen.findByText(/执行「复制用户名」/);

    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(mocks.quickAction).toHaveBeenCalledWith('copy_username', 'i-1', 't-1', 'i-1'));
    expect(mocks.quickAction).not.toHaveBeenCalledWith('copy_password', 'i-1', 't-1', 'i-1');
  });

  it('换到另一条结果时动作选择退回主操作：Enter 不会执行上一条 Tab 停住的复制密码', async () => {
    const input = await renderWithResults([keyRow, keyRowOther]);
    fireEvent.keyDown(input, { key: 'Tab' });
    fireEvent.keyDown(input, { key: 'Tab' });
    fireEvent.keyDown(input, { key: 'Tab' });
    fireEvent.keyDown(input, { key: 'Tab' });
    expect(await screen.findByText(/执行「复制密码」/)).toBeInTheDocument();

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(await screen.findByText(/执行「打开目标」/)).toBeInTheDocument();

    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(mocks.quickAction).toHaveBeenCalledWith('open_target', 'i-2', 't-1', undefined));
    expect(mocks.quickAction).not.toHaveBeenCalledWith('copy_password', 'i-2', 't-1', undefined);
  });

  it('顺序由后端决定：浮层不自行重排命中结果（排序档在 Rust 侧生效）', async () => {
    const second = { ...keyRow, itemId: 'i-2', accountAlias: '运维账号' };
    // 后端把非收藏的 i-1 排在收藏之前的顺序返回时，前端必须原样呈现
    mocks.quickSearch.mockResolvedValue(reply([{ ...second, favorite: false }, { ...keyRow, favorite: true }]));
    renderApp();
    const input = screen.getByRole('textbox', { name: '快速查找账号' });
    fireEvent.change(input, { target: { value: 'OA' } });
    await waitFor(() => expect(mocks.quickSearch).toHaveBeenCalledWith('OA'));
    await screen.findAllByRole('option');

    const options = screen.getAllByRole('option').map((li) => li.textContent ?? '');
    expect(options).toHaveLength(2);
    expect(options[0]).toContain('运维账号');
    expect(options[1]).toContain('日常办公');
  });

  it('没有可切换对象时不接管 Tab，输入框内的编辑快捷键照常工作', async () => {
    // 无结果：Tab 保持原生行为（可以走出去），Enter 也不吞事件
    renderApp();
    const input = screen.getByRole('textbox', { name: '快速查找账号' });
    fireEvent.change(input, { target: { value: 'OA' } });
    await waitFor(() => expect(mocks.quickSearch).toHaveBeenCalledWith('OA'));
    expect(fireEvent.keyDown(input, { key: 'Tab' })).toBe(true);
    expect(fireEvent.keyDown(input, { key: 'Enter' })).toBe(true);

    // 只有一个动作：无处可切，Tab 不拦截
    mocks.quickSearch.mockResolvedValue(reply([{ ...keyRow, actions: ['open_and_fill'] }]));
    fireEvent.change(input, { target: { value: 'OAB' } });
    await waitFor(() => expect(mocks.quickSearch).toHaveBeenCalledWith('OAB'));
    await screen.findByText('OA办公系统');
    expect(fireEvent.keyDown(input, { key: 'Tab' })).toBe(true);

    // 编辑快捷键（全选/复制/粘贴）与 Ctrl+Tab 一律不被 preventDefault
    expect(fireEvent.keyDown(input, { key: 'a', ctrlKey: true })).toBe(true);
    expect(fireEvent.keyDown(input, { key: 'c', metaKey: true })).toBe(true);
    expect(fireEvent.keyDown(input, { key: 'v', metaKey: true })).toBe(true);
    expect(fireEvent.keyDown(input, { key: 'Tab', ctrlKey: true })).toBe(true);
    expect(fireEvent.keyDown(input, { key: 'ArrowLeft' })).toBe(true);

    // Esc 是浮层的关闭键，必须被消费
    expect(fireEvent.keyDown(input, { key: 'Escape' })).toBe(false);
  });
});
