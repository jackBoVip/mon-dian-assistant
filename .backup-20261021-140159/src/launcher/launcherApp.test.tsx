import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
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
  theme: vi.fn(),
  setTheme: vi.fn(),
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
    syntax: [
      { group: '字段', pattern: '系统:OA', desc: '目标名称' },
      { group: '写法', pattern: '运维，数据库', desc: '逗号或分号即 AND，半角全角都切分' },
    ],
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
  mocks.theme.mockReset();
  // 默认回 glass：与 FALLBACK 同值，所以除那条专门的用例外，其余用例的观察面不变。
  mocks.theme.mockResolvedValue({ style: 'glass', reduceMotion: false });
  mocks.setTheme.mockReset();
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
    expect(screen.getByText('写法')).toBeInTheDocument();
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

    expect(await screen.findByText('保险库已锁定')).toBeInTheDocument();
    expect(screen.getByText('结果已全部清除，请在主窗口解锁后重新查询')).toBeInTheDocument();
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

  it('主窗换了主题后，下一次唤起就把浮层的外观追平（交付方 2026-10-20 报的背景不跟主题）', async () => {
    renderApp();
    await waitFor(() => expect(mocks.theme).toHaveBeenCalledTimes(1));
    expect(document.documentElement).toHaveAttribute('data-theme', 'glass');

    // 主题菜单在置顶浮层显示时根本点不到，所以能换主题的时刻一定是浮层隐藏中：
    // 下一次 shown 事件重读一次 get_theme 就够了，不需要跨窗广播。
    mocks.theme.mockResolvedValue({ style: 'obsidian', reduceMotion: false });
    await act(async () => {
      bus.handlers['launcher://shown']();
    });
    await waitFor(() => expect(mocks.theme).toHaveBeenCalledTimes(2));
    expect(document.documentElement).toHaveAttribute('data-theme', 'obsidian');
  });

  it('浮层的骨架是原型那枚弹窗的四块，顺序与类名一起钉住', async () => {
    mocks.quickSearch.mockResolvedValue(reply([row]));
    const { container } = renderApp();
    await waitFor(() => expect(screen.getByText('OA办公系统')).toBeInTheDocument());

    const modal = container.querySelector('.search-overlay > .search-modal');
    expect(modal, '遮罩里只能有一块 600px 本体').not.toBeNull();
    const regions = Array.from(modal!.children).map((el) => el.className);
    expect(regions).toEqual(['search-input-wrap', 'search-meta', 'search-body', 'search-footer']);
    // 输入行三件套：放大镜 + 输入框 + 可点击的 Esc 芯片（原型那枚 span 的 button 版）
    expect(container.querySelector('.search-input-wrap svg')).not.toBeNull();
    expect(screen.getByRole('button', { name: '关闭' })).toHaveTextContent('Esc');
  });

  it('点 Esc 芯片与按 Esc 走同一条关闭路径', async () => {
    renderApp();
    await waitFor(() => expect(mocks.launcherPreferences).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: '关闭' }));
    await waitFor(() => expect(mocks.launcherVisibility).toHaveBeenCalledWith(false));
  });

  it('空输入且没有推荐时，内容区给的是两行式引导语 + 后端下发的语法表', async () => {
    mocks.launcherPreferences.mockResolvedValue(preferences(false));
    renderApp();
    expect(await screen.findByText('输入关键字检索保险库')).toBeInTheDocument();
    expect(screen.getByText('可直接键入关键词，也可按字段限定检索')).toBeInTheDocument();
    expect(screen.queryAllByRole('option')).toHaveLength(0);
  });

  it('语法表按后端组名分带：一组一条标题，写法与说明成对出现，界面里不出现"来自后端"这类实现口径', async () => {
    mocks.launcherPreferences.mockResolvedValue(preferences(false));
    const { container } = renderApp();
    await screen.findByText('系统:OA');
    expect(screen.getAllByText('字段')).toHaveLength(1);
    expect(screen.getAllByText('写法')).toHaveLength(1);
    expect(container.querySelector('.search-help-pattern')?.textContent).toBe('系统:OA');
    expect(container.querySelector('.search-help-desc')?.textContent).toBe('目标名称');
    // 说明文案里不许混进"来自后端 / syntax 字段"这种只有写代码的人才关心的话
    expect(container.querySelector('.search-help')?.textContent).not.toMatch(/后端|syntax/);
  });

  it('后端未就绪读不到设置时只说一句人话，不伪造一份语法表', async () => {
    mocks.launcherPreferences.mockRejectedValue(new Error('ipc 未就绪'));
    renderApp();
    expect(await screen.findByText('检索语法说明暂时读取失败，重新唤起浮层会再试一次。')).toBeInTheDocument();
    expect(screen.queryByText('字段')).toBeNull();
    expect(screen.getByText('输入关键字检索保险库')).toBeInTheDocument();
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

    // 这一条能做的事全部作为按钮摆在操作条上（提示句里不再重列一遍名字）
    for (const label of ['打开并填充', '查看详情', '复制用户名', '打开目标', '复制密码']) {
      expect(screen.getByRole('button', { name: label })).toBeInTheDocument();
    }
    // 提示句只报"当前 Enter 要执行的那一枚 + 共几项"，不再把五个名字铺成一行冲出卡片
    expect(screen.getByText(/切换 5 项操作/)).toBeInTheDocument();

    fireEvent.keyDown(input, { key: 'Tab' });
    expect(await screen.findByText(/执行「查看详情」/)).toBeInTheDocument();
    fireEvent.keyDown(input, { key: 'Tab' });
    expect(await screen.findByText(/执行「复制用户名」/)).toBeInTheDocument();
    expect(mocks.quickAction).not.toHaveBeenCalled();

    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(mocks.quickAction).toHaveBeenCalledWith('copy_username', 'i-1', 't-1', 'i-1'));
  });

  it('不渲染「选择其他账号」：后端下发了也不上屏、Tab 与项数都按可见动作算', async () => {
    // 交付方 2026-10-21：「全局搜索结果中取消选择其他账号的按钮」——
    // 这个动作的回执只是一句"请选择要使用的账号"，浮层里没有可挑的账号列表。
    const input = await renderWithResults([
      { ...keyRow, actions: ['open_and_fill', 'view_detail', 'copy_username', 'open_target', 'copy_password', 'select_other_account'] },
    ]);

    expect(screen.queryByRole('button', { name: '选择其他账号' })).toBeNull();
    expect(screen.getByText(/切换 5 项操作/)).toBeInTheDocument();

    // 隐掉的那条不占 Tab 位：转 5 次正好回到主操作
    for (let i = 0; i < 5; i += 1) fireEvent.keyDown(input, { key: 'Tab' });
    expect(await screen.findByText(/执行「打开并填充」/)).toBeInTheDocument();
    expect(mocks.quickAction).not.toHaveBeenCalled();
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

  it('操作条只在选中的那一行出现：名称与元信息不再被右列挤掉', async () => {
    await renderWithResults([keyRow, keyRowOther]);
    const options = screen.getAllByRole('option');
    expect(options).toHaveLength(2);
    // 旧版式（1fr auto 两列 + 长提示塞在右列）在这一步会看到名称被挤成一两个字；
    // 现在名称与元信息各占一整行，两条命中都完整渲染。
    expect(screen.getAllByText('OA办公系统')).toHaveLength(2);
    for (const li of options) {
      expect(li.textContent).toContain('https://oa.nmgdl.cn');
    }
    // 只有选中那一行有按钮与提示句；另一行的动作要先把选中位推过去（划过或按 ↓）才出现
    expect(screen.getAllByRole('button', { name: '复制密码' })).toHaveLength(1);
    expect(screen.getAllByText(/执行「/)).toHaveLength(1);
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

/**
 * 浮层是一扇独立窗口，而原型那套尺寸是按"整屏视口"给的。本体最高处 = 60px 输入行 + 命中摘要 +
 * 320px 内容区 + 页脚，窗口高度不够就把页脚推出窗外——原型里不存在这种情况，因为它会跟着页面一起滚动。
 * 顶部让位原本抄的是 15vh，交付方 2026-10-18 19:5x「这个弹窗有问题,外面有个大片空白」之后换成固定 24px，
 * 所以留给本体的空间是「窗高 - 上下留白」而不是「窗高 × 85%」。
 * 这条守卫读的是源文件里的字面值：改原型档位、改留白或改窗口尺寸，都得先让它算得过。
 */
describe('浮层窗口尺寸撑得住照抄下来的原型档位', () => {
  const css = readFileSync(resolve(process.cwd(), 'src/styles/global.css'), 'utf8');
  const rs = readFileSync(resolve(process.cwd(), 'src-tauri/src/launcher.rs'), 'utf8');

  const block = (sel: string) => {
    const m = css.match(new RegExp(`\\.${sel}\\s*\\{[^}]*\\}`));
    if (!m) throw new Error(`global.css 里找不到 .${sel}`);
    return m[0];
  };
  const num = (re: RegExp, where: string) => {
    const m = css.match(re);
    if (!m) throw new Error(`global.css 里找不到${where}`);
    return Number(m[1]);
  };

  it('原型那三档本体字面值没被改掉', () => {
    expect(num(/\.search-modal\s*\{[^}]*?max-width:\s*(\d+)px/, '本体宽度上限')).toBe(600);
    expect(num(/\.search-body\s*\{[^}]*?max-height:\s*(\d+)px/, '内容区高度上限')).toBe(320);
    expect(num(/\.search-input-wrap input\s*\{[^}]*?height:\s*(\d+)px/, '输入行高度')).toBe(60);
  });

  /**
   * 后端语法提示的行数直接决定内容区要不要出滚动条。探针（dist 的 global-*.css + 复刻 DOM，
   * 视口 648×580）实测：6 行 3 带 = 内容区 306px（上限 320，留 14px 余量），
   * 而"每字段一行"的 11 行表要 440px、溢出 120px。所以行数与带数在这里钉住，
   * 后端再加一行就得先重新量一次并动这条预算。
   */
  it('后端语法提示的行数与分带数装得下 320px 内容区', () => {
    const parser = readFileSync(resolve(process.cwd(), 'src-tauri/src/quick_launcher/parser.rs'), 'utf8');
    const at = parser.indexOf('pub fn syntax_help');
    const body = parser.slice(at, parser.indexOf('\n}', at));
    const rows = [...body.matchAll(/SyntaxHint \{/g)].length;
    const bands = new Set([...body.matchAll(/group: "([^"]+)"/g)].map((m) => m[1]));
    expect(rows, '语法提示行数超了预算').toBeLessThanOrEqual(6);
    expect(bands.size, '分带数超了预算（每带一条标题行）').toBeLessThanOrEqual(3);
    expect(rows).toBeGreaterThan(0);
  });

  it('大片空白那三处染色已随遮罩一起撤掉（反向守卫）', () => {
    const overlay = block('search-overlay');
    const modal = block('search-modal');
    const body = block('launcher-body');
    // 遮罩染色、两层 backdrop-filter、视口相对单位：三条都不许回来，它们合起来就是那圈死灰。
    expect(overlay).not.toContain('overlay-veil');
    expect(overlay).not.toContain('backdrop-filter');
    expect(overlay).not.toMatch(/\d+v[hw]/);
    expect(modal).not.toContain('backdrop-filter');
    // 窗底一旦重新落上主题底色，透明窗就被填回成一整块矩形。
    expect(body).toContain('background: transparent');
    expect(body).not.toContain('var(--t-bg)');
    // 撤的只是浮层这一处的引用：两枚遮罩令牌还在令牌层，主窗的 Drawer / Modal 用着。
    const tokens = readFileSync(resolve(process.cwd(), 'src/styles/tokens.css'), 'utf8');
    expect(tokens).toMatch(/--overlay-veil:\s*rgba\(0, 0, 0, 0\.4\)/);
    expect(tokens).toMatch(/--blur-overlay:\s*blur\(8px\)/);
    expect(css).toMatch(/\.overlay-veil\s*\{[^}]*var\(--overlay-veil\)/);
  });

  it('窗口高到装得下这三块，宽到装得下 600px 本体', () => {
    const h = Number(rs.match(/LAUNCHER_HEIGHT: f64 = ([\d.]+)/)?.[1]);
    const w = Number(rs.match(/LAUNCHER_WIDTH: f64 = ([\d.]+)/)?.[1]);
    const pad = block('search-overlay').match(/padding:\s*(\d+)px\s+(\d+)px\s+(\d+)px/);
    if (!pad) throw new Error('.search-overlay 的 padding 得写成「上 左右 下」三档，守卫按这个解析');
    const padTop = Number(pad[1]);
    const padSide = Number(pad[2]);
    const padBottom = Number(pad[3]);
    expect(w).toBeGreaterThanOrEqual(600 + padSide * 2);
    const room = h - padTop - padBottom;
    // 本体最坏一档实测 506.2 = 输入行 61 + 命中摘要 39 + 内容区 320（clamp）+ 两行页脚 84.2 + 本体上下描边 2。
    // 这四档是 21:5x 那台一次性探针（把 dist 的 global-*.css 直接 <link> 进一个复刻 LauncherApp DOM 的本地
    // html，视口按 648×580 摆）逐块量出来的：内容区放满 9 条把 scrollHeight 顶到 523，才逼出 320 那一档 clamp。
    // 探针本身用完即删（在 /tmp，不进仓库），改任何一档都要重新量一次再动这里。
    const needs = 61 + 39 + 320 + 84.2 + 2;
    expect(room, `窗高 ${h} 扣掉上下留白只剩 ${room}px，装不下 ${needs}px`).toBeGreaterThanOrEqual(needs);
  });

  it('浮层那扇窗是透明窗且关掉系统阴影（矩形投影会重新造出一条空白边）', () => {
    expect(rs).toMatch(/\.transparent\(true\)/);
    expect(rs).toMatch(/\.shadow\(false\)/);
  });
});
