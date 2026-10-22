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

  it('空输入且没有推荐时，内容区给的是原型的空态文案', async () => {
    mocks.launcherPreferences.mockResolvedValue(preferences(false));
    renderApp();
    expect(await screen.findByText('输入关键字以快速检索全局加密保险库。')).toBeInTheDocument();
    expect(screen.queryAllByRole('option')).toHaveLength(0);
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
    expect(body).not.toContain('var(--color-bg)');
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
