import { pointerTap } from '../test/pointer';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountsPage } from './AccountsPage';
import type { ItemView, PagedTargets, TargetFilter, TargetRow } from '../lib/types';

/**
 * 账号中心（S 轮照原型改成主从两栏）的测试基准：
 * 左栏一次取满后端上限、右栏跟着当前系统取账号，筛选与分页都在右栏本地做。
 * 原型的类型胶囊、分组/标签下拉、统计条、回收站与最近访问这一轮从界面撤下（源文件保留），
 * 所以这里既守"新结构按后端真实边界取数"，也守"撤下的那些入口和命令不再出现在这一页"。
 */
const mocks = vi.hoisted(() => ({
  listTargetsPaged: vi.fn(),
  targetItems: vi.fn(),
  setFavorite: vi.fn(),
  setDefaultCredential: vi.fn(),
  openAndFill: vi.fn(),
  connectTerminal: vi.fn(),
  targetDetail: vi.fn(),
  recentAccess: vi.fn(),
  listDeletedItems: vi.fn(),
  listGroups: vi.fn(),
  createTarget: vi.fn(),
  updateTarget: vi.fn(),
  itemDetail: vi.fn(),
  updateItem: vi.fn(),
  // 左栏三颗钮带进来的这几条：本文件只验入口与界面状态，真正的导入/导出流程由 SystemIODialog.test.tsx 打
  importPreview: vi.fn(),
  importCommit: vi.fn(),
  importTemplate: vi.fn(),
  exportCommit: vi.fn(),
  reauthenticate: vi.fn(),
}));

vi.mock('../lib/api', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../lib/api')>();
  return { ...mod, api: { ...mod.api, ...mocks } };
});

// 后端 page_size 夹取 1..=200（src-tauri/src/commands/accounts.rs:126-127）
const LIST_LIMIT = 200;
// 右栏每页 10 行：原型页脚只有「共 N 条数据 + 页码」，没有每页条数下拉
const PAGE_SIZE = 10;

const ISO = '2026-01-01T00:00:00Z';

function target(i: number): TargetRow {
  return {
    id: `t-${i}`,
    targetType: i === 2 ? 'database' : 'web',
    displayName: `系统-${i}`,
    groupId: null,
    status: 'active',
    createdAt: ISO,
    updatedAt: ISO,
    credentialCount: i === 1 ? 12 : 0,
  };
}

function item(n: number, over: Partial<ItemView> = {}): ItemView {
  return {
    id: `i-${n}`,
    targetId: 't-1',
    accountAlias: `账号-${n}`,
    itemType: 'web',
    status: 'active',
    favorite: false,
    tags: [],
    createdAt: ISO,
    updatedAt: ISO,
    version: 1,
    isDefaultForCurrentUser: false,
    usernameMasked: `u${n}****`,
    hasPassword: true,
    hasToken: false,
    hasPrivateKey: false,
    canReveal: true,
    ...over,
  };
}

/** t-1 下 12 条：跨过一页，才能同时验分页与"筛选后页数变少"。 */
const T1_ITEMS: ItemView[] = Array.from({ length: 12 }, (_, k) =>
  item(k + 1, {
    favorite: k + 1 === 3,
    isDefaultForCurrentUser: k + 1 === 1,
    itemType: k + 1 === 5 ? 'terminal' : 'web',
    status: k + 1 === 7 ? 'disabled' : 'active',
  }),
);

const TARGETS: TargetRow[] = [target(1), target(2)];

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <AccountsPage />
    </QueryClientProvider>,
  );
}

/** 表格本体（role=table 那一片），用它把行查询限定在当前视图里。 */
function table() {
  return screen.getByRole('table', { name: '当前系统的托管账号' });
}

function rows() {
  return within(table()).getAllByRole('row').slice(1);
}

beforeEach(() => {
  Object.values(mocks).forEach((fn) => fn.mockReset());
  mocks.listTargetsPaged.mockImplementation(
    (_f: TargetFilter, p: number, ps: number): Promise<PagedTargets> =>
      Promise.resolve({ rows: TARGETS.slice(0, ps), total: TARGETS.length, page: p, pageSize: ps }),
  );
  mocks.targetItems.mockImplementation((id: string) =>
    Promise.resolve(id === 't-1' ? T1_ITEMS : []),
  );
  mocks.setFavorite.mockResolvedValue(undefined);
  mocks.setDefaultCredential.mockResolvedValue(undefined);
  mocks.openAndFill.mockResolvedValue({ ok: true, message: '已打开' });
  mocks.connectTerminal.mockResolvedValue({ ok: true, message: '已连接终端' });
  mocks.targetDetail.mockImplementation((id: string) =>
    Promise.resolve({
      target: { ...target(1), id },
      meta: { url: '', allowedOrigin: '', host: '', port: '', databaseName: '', tenant: '', vendor: '', protocol: '', extra: {} },
      items: [],
      insecureProtocol: false,
      fillAvailable: false,
    }),
  );
  mocks.listGroups.mockResolvedValue([]);
  mocks.updateTarget.mockImplementation((id: string) => Promise.resolve({ ...target(1), id }));
  mocks.itemDetail.mockImplementation((id: string) =>
    Promise.resolve({
      ...item(2, { id }),
      username: 'ops-2',
      note: '',
      authMethod: 'password',
      browserHint: '',
      loginUrlOverride: '',
      confirmBeforeFill: false,
      canUpdate: true,
    }),
  );
  mocks.updateItem.mockImplementation((id: string) => Promise.resolve({ ...item(2, { id }) }));
});

describe('主从两栏的取数与选中', () => {
  it('左栏按第 1 页 / 每页 200 条取一次系统，右栏跟着第一个系统取账号', async () => {
    renderPage();
    await screen.findByText('账号-1');

    expect(mocks.listTargetsPaged).toHaveBeenCalledTimes(1);
    const [filter, page, pageSize] = mocks.listTargetsPaged.mock.calls[0] as [TargetFilter, number, number];
    expect(page).toBe(1);
    expect(pageSize).toBe(LIST_LIMIT);
    // 左栏不带任何条件：筛选那一整组控件已撤，命令不能再被多发键（Rust 侧 deny_unknown_fields）
    expect(filter).toEqual({});

    expect(mocks.targetItems).toHaveBeenCalledWith('t-1');
    // 默认选中第一项要让人看得见，而不只是"逻辑上选中了"
    const first = screen.getByRole('button', { name: /系统-1/ });
    expect(first).toHaveAttribute('aria-current', 'true');
    // 术语免责那句钉在真正上屏的那一行：PAGE_META.accounts.desc 这一轮没有渲染落点，
    // 只断言那枚常量会放过"把界面上这句话改没了"，所以这里读的是右栏副标题本身。
    const subtitle = screen.getByRole('heading', { level: 2 }).parentElement;
    expect(subtitle?.textContent).toContain('不是本软件的登录凭据');
  });

  it('点左栏另一个系统：右栏换 id 取数，页码回到第 1 页', async () => {
    renderPage();
    await screen.findByText('账号-1');
    fireEvent.click(screen.getByRole('button', { name: '下一页' }));
    await screen.findByText('账号-11');

    fireEvent.click(screen.getByRole('button', { name: /系统-2/ }));
    await waitFor(() => expect(mocks.targetItems).toHaveBeenCalledWith('t-2'));
    // t-2 一条账号也没有，右栏必须落到"这个系统下还没有账号"那句，而不是停在第 2 页的空气上
    expect(await screen.findByText(/该系统下还没有账号/)).toBeInTheDocument();
  });

  it('系统数超过载入数时如实播报缺口，句里是 260 与 200 这两个真数', async () => {
    const many = Array.from({ length: 260 }, (_, k) => target(k + 1));
    mocks.listTargetsPaged.mockResolvedValue({ rows: many.slice(0, LIST_LIMIT), total: 260, page: 1, pageSize: LIST_LIMIT });
    renderPage();
    const note = await screen.findByText(/本页载入 200 个系统/);
    expect(note.textContent).toContain('260');
    expect(note.textContent).toContain('单次最多取 200 个');
    // 没有翻页可翻，就绝不能说这是"全部"
    expect(note.textContent).not.toContain('全部');
  });

  it('后端系统数为 0 时只给左栏空态，右栏不给账号表的数据', async () => {
    mocks.listTargetsPaged.mockResolvedValue({ rows: [], total: 0, page: 1, pageSize: LIST_LIMIT });
    renderPage();
    expect(await screen.findByText(/还没有接入系统/)).toBeInTheDocument();
    expect(mocks.targetItems).not.toHaveBeenCalled();
    expect(screen.getByRole('heading', { name: '未选择系统' })).toBeInTheDocument();
  });
});

describe('右栏的关键字、只看关注与分页', () => {
  it('搜索钮展开输入框，关键字同时匹配账号名称与脱敏用户名，页脚把两个数都说出来', async () => {
    renderPage();
    await screen.findByText('账号-1');

    fireEvent.click(screen.getByRole('button', { name: '搜索账号名称' }));
    const input = screen.getByPlaceholderText('搜索账号名称...');
    fireEvent.change(input, { target: { value: '账号-11' } });

    await waitFor(() => expect(within(table()).getAllByRole('row')).toHaveLength(2));
    expect(within(table()).getByRole('row', { name: /账号-11/ })).toBeInTheDocument();
    const info = within(table()).getByRole('status');
    expect(info.textContent).toContain('共 1 条数据');
    expect(info.textContent).toContain('本系统合计 12 条');
  });

  it('收起搜索钮顺手清空关键字，列表不会被一个看不见的条件继续收窄', async () => {
    renderPage();
    await screen.findByText('账号-1');
    fireEvent.click(screen.getByRole('button', { name: '搜索账号名称' }));
    fireEvent.change(screen.getByPlaceholderText('搜索账号名称...'), { target: { value: '账号-11' } });
    await waitFor(() => expect(within(table()).getAllByRole('row')).toHaveLength(2));

    fireEvent.click(screen.getByRole('button', { name: '搜索账号名称' }));
    await waitFor(() => expect(within(table()).getAllByRole('row')).toHaveLength(1 + PAGE_SIZE));
    // 收起后回到整册 12 条：页脚那两个数得跟着变，第 2 页的两条靠翻页而不是靠残留的关键字
    expect(within(table()).getByRole('status').textContent).toContain('共 12 条数据');
    expect(within(table()).getByRole('status').textContent).not.toContain('本系统合计');
    expect(screen.queryByPlaceholderText('搜索账号名称...')).toBeNull();
  });

  it('「只看关注」pressed 状态与结果集一致：只有关注那条留下', async () => {
    renderPage();
    await screen.findByText('账号-1');
    const star = screen.getByRole('button', { name: '只看关注' });
    expect(star).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(star);
    expect(star).toHaveAttribute('aria-pressed', 'true');
    await waitFor(() => expect(within(table()).getAllByRole('row')).toHaveLength(2));
    expect(within(table()).getByRole('row', { name: /账号-3/ })).toBeInTheDocument();
    expect(within(table()).queryByText('账号-1')).toBeNull();
  });

  it('12 条按每页 10 条翻页，当前页码带 aria-current，第二页只剩 2 条', async () => {
    renderPage();
    await screen.findByText('账号-1');
    expect(rows()).toHaveLength(PAGE_SIZE);
    expect(screen.getByRole('status').textContent).toContain('共 12 条数据');

    const next = screen.getByRole('button', { name: '下一页' });
    fireEvent.click(next);
    await screen.findByText('账号-11');
    expect(rows()).toHaveLength(12 - PAGE_SIZE);
    expect(screen.getByRole('button', { name: '2' })).toHaveAttribute('aria-current', 'page');
    // 到末页了，下一页必须是禁用而不是绕回第 1 页
    expect(next).toBeDisabled();
    expect(screen.getByRole('button', { name: '上一页' })).not.toBeDisabled();
  });

  it('先翻到第 2 页再收窄条件：页码回落到末页，不会停在越界处显示空表', async () => {
    renderPage();
    await screen.findByText('账号-1');
    fireEvent.click(screen.getByRole('button', { name: '下一页' }));
    await screen.findByText('账号-11');

    fireEvent.click(screen.getByRole('button', { name: '只看关注' }));
    await waitFor(() => expect(within(table()).getAllByRole('row')).toHaveLength(2));
    expect(within(table()).getByRole('row', { name: /账号-3/ })).toBeInTheDocument();
  });

  it('筛不到账号时，空态要点出「只看关注」这一条件还开着（系统下本来没账号是另一句）', async () => {
    renderPage();
    await screen.findByText('账号-1');
    fireEvent.click(screen.getByRole('button', { name: '搜索账号名称' }));
    fireEvent.change(screen.getByPlaceholderText('搜索账号名称...'), { target: { value: '不存在' } });
    const tip = await screen.findByText(/未找到匹配的账号/);
    expect(tip.textContent).not.toContain('只看关注');

    fireEvent.click(screen.getByRole('button', { name: '只看关注' }));
    // 两个条件同时开着时，那句必须点出「只看关注」，否则人会以为只有关键字没用上
    await waitFor(() =>
      expect(screen.getByText(/未找到匹配的账号/).textContent).toContain('（已开启「只看关注」）'),
    );
    expect(screen.getByText(/未找到匹配的账号/)).toBe(tip);
  });
});

describe('行内四颗动作钮只说后端做得到的事', () => {
  it('普通凭据「打开」走 openAndFill(当前系统, 该账号)', async () => {
    renderPage();
    await screen.findByText('账号-1');
    fireEvent.click(screen.getByRole('button', { name: '打开并填充 账号-2' }));
    await waitFor(() => expect(mocks.openAndFill).toHaveBeenCalledWith('t-1', 'i-2'));
  });

  it('终端类凭据的「打开」是连终端，不走填充', async () => {
    renderPage();
    await screen.findByText('账号-1');
    fireEvent.click(screen.getByRole('button', { name: '连接终端 账号-5' }));
    await waitFor(() => expect(mocks.connectTerminal).toHaveBeenCalledWith('i-5'));
    expect(mocks.openAndFill).not.toHaveBeenCalled();
  });

  it('停用账号：徽标写停用，打开钮禁用并说明要先启用', async () => {
    renderPage();
    await screen.findByText('账号-7');
    const row = within(table()).getByRole('row', { name: /账号-7/ });
    expect(within(row).getByText('停用')).toHaveClass('is-disabled');
    const open = within(row).getByRole('button', { name: '打开并填充 账号-7' });
    expect(open).toBeDisabled();
    expect(open.getAttribute('title')).toContain('先启用');
  });

  it('设为默认带上当前系统与账号 id', async () => {
    renderPage();
    await screen.findByText('账号-1');
    fireEvent.click(screen.getByRole('button', { name: '设为默认 账号-2' }));
    await waitFor(() => expect(mocks.setDefaultCredential).toHaveBeenCalledWith('t-1', 'i-2'));
  });

  it('当前默认那颗禁用，且 title 说出"再设别的即取消本条"——界面上不出现「取消默认」这种兑不出来的承诺', async () => {
    renderPage();
    await screen.findByText('账号-1');
    const btn = screen.getByRole('button', { name: '设为默认 账号-1' });
    expect(btn).toBeDisabled();
    expect(btn).toHaveAttribute('aria-pressed', 'true');
    expect(btn.getAttribute('title')).toContain('把其它账号设为默认即取消本条');
    expect(document.body.textContent).not.toContain('取消默认');
  });

  it('关注钮双向：未关注传 true，已关注传 false', async () => {
    renderPage();
    await screen.findByText('账号-1');
    fireEvent.click(screen.getByRole('button', { name: '关注 账号-1' }));
    await waitFor(() => expect(mocks.setFavorite).toHaveBeenCalledWith('i-1', true));

    fireEvent.click(screen.getByRole('button', { name: '取消关注 账号-3' }));
    await waitFor(() => expect(mocks.setFavorite).toHaveBeenCalledWith('i-3', false));
  });

  it('「打开默认账号」在没有默认时禁用，title 指回行内那颗钮', async () => {
    mocks.targetItems.mockResolvedValue([item(1, { isDefaultForCurrentUser: false })]);
    renderPage();
    await screen.findByText('账号-1');
    const btn = screen.getByRole('button', { name: '打开默认账号' });
    expect(btn).toBeDisabled();
    expect(btn.getAttribute('title')).toContain('先在账号行上点「设为默认」');
  });

  it('账号名那颗钮打开明细抽屉，并按当前系统取明细', async () => {
    renderPage();
    await screen.findByText('账号-1');
    fireEvent.click(screen.getByRole('button', { name: '账号-2' }));
    await waitFor(() => expect(mocks.targetDetail).toHaveBeenCalledWith('t-1'));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
  });
});

describe('编辑入口摆在这一页上（交付方 2026-10-19：原先只有点名称→抽屉→卡片，用户找不到）', () => {
  it('行内「编辑」直接打开那条账号的编辑弹窗，改别名后只提交改过的那一栏', async () => {
    renderPage();
    await screen.findByText('账号-1');

    fireEvent.click(screen.getByRole('button', { name: '编辑 账号-2' }));
    // 弹窗先渲染"加载账号原值…"，等到表单那栏出现才算真打开
    await screen.findByLabelText('账号别名');
    const card = screen.getByRole('dialog', { name: '编辑外部系统账号（账号-2）' });
    expect(mocks.itemDetail).toHaveBeenCalledWith('i-2');

    fireEvent.change(within(card).getByLabelText('账号别名'), { target: { value: '账号-2改' } });
    fireEvent.click(within(card).getByRole('button', { name: '保存改动（1 项）' }));

    await waitFor(() => expect(mocks.updateItem).toHaveBeenCalledWith('i-2', { accountAlias: '账号-2改' }));
    // 只改别名不许把已存密码一起提交出去——password 这个键压根不在补丁里
    expect(mocks.updateItem.mock.calls[0][1]).not.toHaveProperty('password');
  });

  it('停用账号那一行的「编辑」照样可用：改内容和启不启用是两条命令', async () => {
    renderPage();
    await screen.findByText('账号-7');
    const row = within(table()).getByRole('row', { name: /账号-7/ });
    expect(within(row).getByRole('button', { name: '打开并填充 账号-7' })).toBeDisabled();
    expect(within(row).getByRole('button', { name: '编辑 账号-7' })).toBeEnabled();
  });

  it('右栏「编辑系统」带着当前系统打开那张表：初值回显，保存走 update_target', async () => {
    mocks.targetDetail.mockImplementation((id: string) =>
      Promise.resolve({
        target: { ...target(1), id },
        meta: {
          url: 'https://oa.example.cn',
          allowedOrigin: 'https://oa.example.cn',
          host: 'oa.example.cn',
          port: '',
          databaseName: '',
          tenant: '',
          vendor: '',
          protocol: 'https',
          extra: {},
        },
        items: [],
        insecureProtocol: false,
        fillAvailable: true,
      }),
    );
    renderPage();
    await screen.findByText('账号-1');

    fireEvent.click(screen.getByRole('button', { name: '编辑当前系统' }));
    await screen.findByLabelText('系统名称');
    const card = screen.getByRole('dialog', { name: '编辑系统' });
    expect(mocks.targetDetail).toHaveBeenCalledWith('t-1');
    expect(within(card).getByLabelText('系统名称')).toHaveValue('系统-1');
    expect(within(card).getByLabelText('登录地址 (URL)')).toHaveValue('https://oa.example.cn');

    fireEvent.change(within(card).getByLabelText('系统名称'), { target: { value: '蒙电OA' } });
    fireEvent.click(within(card).getByRole('button', { name: '保存修改' }));

    await waitFor(() =>
      expect(mocks.updateTarget).toHaveBeenCalledWith('t-1', expect.objectContaining({ displayName: '蒙电OA' })),
    );
    expect(mocks.createTarget).not.toHaveBeenCalled();
  });

  it('一个系统都没选中时「编辑系统」禁用，title 说明要先选系统', async () => {
    mocks.listTargetsPaged.mockResolvedValue({ rows: [], total: 0, page: 1, pageSize: LIST_LIMIT });
    renderPage();
    await screen.findByText(/还没有接入系统/);

    const btn = screen.getByRole('button', { name: '编辑当前系统' });
    expect(btn).toBeDisabled();
    expect(btn.getAttribute('title')).toContain('请先选择一个系统');
  });
});

describe('这一轮撤下的入口不在本页留下残影', () => {
  it('类型胶囊、分组/标签下拉、统计条、回收站、最近访问都查不到，且相关命令一次都不发', async () => {
    renderPage();
    await screen.findByText('账号-1');

    expect(screen.queryByRole('tab', { name: '数据库' })).toBeNull();
    expect(screen.queryByLabelText('标签筛选')).toBeNull();
    expect(screen.queryByLabelText('分组筛选')).toBeNull();
    expect(screen.queryByLabelText('每页条数')).toBeNull();
    expect(screen.queryByText('回收站')).toBeNull();
    expect(screen.queryByText('最近访问')).toBeNull();
    expect(screen.queryByText(/本软件用户/)).toBeNull();

    await waitFor(() => expect(mocks.targetItems).toHaveBeenCalled());
    expect(mocks.recentAccess).not.toHaveBeenCalled();
    expect(mocks.listDeletedItems).not.toHaveBeenCalled();
  });

  it('导出下拉按原型展开成两行（导出 Excel / 导出 CSV），点开的是格式不同的同一张导出卡', async () => {
    renderPage();
    await screen.findByText('账号-1');
    // Popover 是展开才挂载：菜单收起时这两行不在 DOM 里
    expect(screen.queryByText('导出 Excel')).toBeNull();

    pointerTap(screen.getByRole('button', { name: '导出系统' }));
    const menu = await screen.findByRole('menu', { name: '导出系统' });
    expect(within(menu).getAllByRole('menuitem').map((el) => el.textContent)).toEqual(['导出 Excel', '导出 CSV']);

    fireEvent.click(within(menu).getByRole('menuitem', { name: '导出 Excel' }));
    const card = await screen.findByRole('dialog', { name: '导出 Excel' });
    expect(card.textContent).toContain('Excel (.xlsx)');
    expect(card.textContent).not.toContain('CSV (.csv)');
    expect(card.textContent).toContain('当前系统「系统-1」下的所有账号凭据');
    // 明文密码那一档默认勾着（原型 851 行那条 checked），勾着就必须把风险说出来
    expect(within(card).getByRole('checkbox', { name: /包含明文密码/ })).toBeChecked();
    expect(within(card).getByRole('alert').textContent).toContain('拿到文件就等于拿到全部口令');
    // 勾掉时那句风险告警必须跟着撤，换成"password 列留空"这句实话
    fireEvent.click(within(card).getByRole('checkbox', { name: /包含明文密码/ }));
    expect(within(card).queryByRole('alert')).toBeNull();
    expect(card.textContent).toContain('password 列留空');
    // 选了格式不等于选了目的地：目的地没选时点「确认导出」只会得到那句提示，不会写出半份文件
    fireEvent.click(within(card).getByRole('button', { name: '确认导出' }));
    expect(await within(card).findByText('请先选择保存路径。')).toBeInTheDocument();
  });

  it('导入那颗打开「导入系统与账号」：未识别出文件前「开始导入」是禁的', async () => {
    renderPage();
    await screen.findByText('账号-1');

    fireEvent.click(screen.getByRole('button', { name: '导入系统' }));
    const card = await screen.findByRole('dialog', { name: '导入系统与账号' });
    expect(within(card).getByText('点击或将文件拖拽至此区域')).toBeInTheDocument();
    expect(card.textContent).toContain('支持 CSV / XLSX 格式导入，格式按文件内容自动识别');
    expect(within(card).getByRole('button', { name: '开始导入' })).toBeDisabled();
    expect(mocks.importPreview).not.toHaveBeenCalled();
    expect(within(card).queryByRole('button', { name: '到导入导出页' })).toBeNull();
  });

  it('有系统时「添加账号」可用，「新增系统」点开建系统弹窗', async () => {
    renderPage();
    await screen.findByText('账号-1');
    expect(screen.getByRole('button', { name: '添加账号' })).not.toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: '新增系统' }));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
  });

  it('一个系统都没有时「添加账号」禁用，title 说明要先选系统', async () => {
    mocks.listTargetsPaged.mockResolvedValue({ rows: [], total: 0, page: 1, pageSize: LIST_LIMIT });
    renderPage();
    await screen.findByText(/还没有接入系统/);
    const plus = screen.getByRole('button', { name: '添加账号' });
    expect(plus).toBeDisabled();
    expect(plus.getAttribute('title')).toContain('请先选择一个系统');
  });
});
