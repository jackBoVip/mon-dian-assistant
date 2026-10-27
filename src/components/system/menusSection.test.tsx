import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MenusSection } from './MenusSection';
import { chooseOption, selectOptions } from '../../test/select';
import { PERM } from '../../lib/permissions';
import { useNotify } from '../../state/notify';
import { seedMenuNodes } from '../../test/menuFixtures';
import type { MenuNode } from '../../lib/types';

/**
 * 菜单管理 = menu_nodes 的表格树。这一屏现在只有三件事可判：
 * 树画得对不对（层级、落点、所需权限、状态开关）、开关打到哪条命令、
 * 以及"停用了就回不来"的那几枚是否被锁住并把理由写在 title 上。
 * 改名 / 排序 / 删除的界面入口按交付方要求撤掉了（后端三条命令仍在，所以这里不再有对应用例）。
 */
const mocks = vi.hoisted(() => ({
  listMenuNodes: vi.fn(),
  createMenuNode: vi.fn(),
  setMenuNodeStatus: vi.fn(),
  listRolesAdmin: vi.fn(),
  listPermissions: vi.fn(),
  myPermissions: vi.fn(),
}));

vi.mock('../../lib/api', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../lib/api')>();
  return { ...mod, api: { ...mod.api, ...mocks } };
});

const CUSTOM: MenuNode = {
  id: 'custom-1',
  nodeKey: 'custom.audit-alias',
  parentId: 'mn-top-system',
  label: '合规检查',
  pageKey: 'audit',
  kind: 'page',
  builtin: false,
  status: 'active',
  sortOrder: 60,
  permKey: 'menu.node.custom.audit-alias',
};

function seed(): MenuNode[] {
  return seedMenuNodes();
}

/** 多加一条"也能进菜单管理页"的路径，用来验守卫是从树推出来的、不是两枚写死的键。 */
function withMenusAlias(): MenuNode[] {
  return [
    ...seed(),
    {
      id: 'custom-menus-alias',
      nodeKey: 'custom.menus-alias',
      parentId: 'mn-top-system',
      label: '菜单备份',
      pageKey: 'menus',
      kind: 'page',
      builtin: false,
      status: 'active',
      sortOrder: 60,
      permKey: 'menu.node.custom.menus-alias',
    },
  ];
}

function renderSection() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return {
    qc,
    ...render(
      <QueryClientProvider client={qc}>
        <MenusSection />
      </QueryClientProvider>,
    ),
  };
}

/** tsconfig 的 target 还没有 Array.prototype.at，取最后一条通知一律走下标。 */
function lastNotify() {
  const items = useNotify.getState().items;
  return items[items.length - 1];
}

/** 渲染并等表格树落地；页面里唯一那张表就是菜单树。 */
async function renderTree() {
  const view = renderSection();
  const el = await screen.findByRole('table', { name: '菜单树' });
  expect(within(el).getByRole('rowheader', { name: '用户管理' })).toBeInTheDocument();
  return { el, ...view };
}

const switchOf = (el: HTMLElement, label: string) => within(el).getByRole('switch', { name: `${label} 是否启用` });

beforeEach(() => {
  Object.values(mocks).forEach((fn) => fn.mockReset());
  mocks.listMenuNodes.mockResolvedValue(seed());
  mocks.createMenuNode.mockResolvedValue('custom-new');
  mocks.setMenuNodeStatus.mockResolvedValue(undefined);
  // 赋权已迁走：本页不该再查角色与权限目录
  mocks.listRolesAdmin.mockResolvedValue([]);
  mocks.listPermissions.mockResolvedValue([]);
  mocks.myPermissions.mockResolvedValue(Object.values(PERM));
  useNotify.setState({ items: [] });
});

describe('表格树', () => {
  it('一级与二级各就各位，层级写在 data-depth 上（枚数由夹具推导，加一页不必人改）', async () => {
    const { el } = await renderTree();
    const body = el.querySelector('tbody') as HTMLElement;
    const nodes = seedMenuNodes();
    expect(body.querySelectorAll('tr')).toHaveLength(nodes.length);
    expect(body.querySelectorAll('tr[data-depth="1"]')).toHaveLength(nodes.filter((n) => !n.parentId).length);
    expect(body.querySelectorAll('tr[data-depth="2"]')).toHaveLength(nodes.filter((n) => n.parentId).length);
  });

  it('列居中，且没有「操作」列：四列表头，行里只剩一枚开关', async () => {
    const { el } = await renderTree();
    expect(el).toHaveClass('table', 'table-center');
    expect(within(el).getAllByRole('columnheader').map((node) => node.textContent)).toEqual([
      '菜单名称',
      '落点页面',
      '所需权限',
      '状态',
    ]);
    expect(within(el).queryByRole('button', { name: /^重命名|^上移|^下移|^删除/ })).toBeNull();
  });

  it('页顶那句提示与「N 个一级 · M 个二级」那行统计都不上屏（交付方：不需要）', async () => {
    await renderTree();
    expect(screen.queryByText(/本页维护菜单结构与启停/)).toBeNull();
    expect(screen.queryByText(/个一级 ·/)).toBeNull();
    expect(screen.getByRole('button', { name: '新增菜单' })).toBeInTheDocument();
  });

  it('表格自己滚：卡片 → 滚动层 → 吸顶表头这张表，三层结构钉住（jsdom 不做层叠，只能钉结构）', async () => {
    const { el } = await renderTree();
    expect(el).toHaveClass('table', 'table-sticky-head');
    const scroll = el.parentElement as HTMLElement;
    expect(scroll).toHaveClass('overflow-auto', 'overscroll-contain', 'min-h-0', 'flex-1');
    expect(scroll.parentElement).toHaveClass('table-wrap', 'flex', 'min-h-0', 'flex-1');
  });

  it('落点列给页面名与页键，分组根写「—（分组）」', async () => {
    const { el } = await renderTree();
    expect(within(el).getAllByText('users').length).toBeGreaterThan(0);
    expect(within(el).getAllByText('—（分组）')).toHaveLength(3);
  });

  it('所需权限列就是 PAGE_REQUIRES 那一行：多枚用「且」连接，空集写无需额外权限', async () => {
    const { el } = await renderTree();
    expect(within(el).getByRole('cell', { name: PERM.SYS_USER_READ })).toBeInTheDocument();
    expect(
      within(el).getByRole('cell', { name: `${PERM.MENU_QUICK_LAUNCHER} 且 ${PERM.SYS_SECURITY_CONFIG}` }),
    ).toBeInTheDocument();
    expect(within(el).getAllByRole('cell', { name: '无需额外权限' }).length).toBeGreaterThan(0);
    // 分组根不给结论，只说明由子项决定
    expect(within(el).getAllByRole('cell', { name: '由子项决定' })).toHaveLength(3);
  });

  it('一级行有折叠钮，收起后二级行整批消失', async () => {
    const { el } = await renderTree();
    const toggle = within(el).getByRole('button', { name: '收起 系统管理' });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');

    fireEvent.click(toggle);
    expect(within(el).getByRole('button', { name: '展开 系统管理' })).toHaveAttribute('aria-expanded', 'false');
    expect(within(el).queryByRole('rowheader', { name: /用户管理/ })).toBeNull();
    expect(within(el).getByRole('rowheader', { name: /安全策略/ })).toBeInTheDocument();

    fireEvent.click(within(el).getByRole('button', { name: '展开 系统管理' }));
    expect(within(el).getByRole('rowheader', { name: /用户管理/ })).toBeInTheDocument();
  });

  it('账号中心那枚一级没有子项，因此不给折叠钮', async () => {
    const { el } = await renderTree();
    const toggles = within(el)
      .getAllByRole('button')
      .filter((b) => /^(展开|收起) /.test(b.getAttribute('aria-label') ?? ''));
    expect(toggles.map((b) => b.getAttribute('aria-label'))).toEqual(['收起 系统管理', '收起 设置', '收起 快捷入口']);
  });

  it('赋权能力已迁走：本页不再查角色与权限目录', async () => {
    await renderTree();
    expect(mocks.listRolesAdmin).not.toHaveBeenCalled();
    expect(mocks.listPermissions).not.toHaveBeenCalled();
  });
});

describe('状态开关', () => {
  it('开关的当前值就是服务端状态：启用=checked，停用=unchecked', async () => {
    mocks.listMenuNodes.mockResolvedValue(
      seed().map((node) => (node.id === 'mn-settings-backup' ? { ...node, status: 'disabled' } : node)),
    );
    const { el } = await renderTree();
    expect(switchOf(el, '备份与恢复')).not.toBeChecked();
    expect(switchOf(el, '用户管理')).toBeChecked();
  });

  it('拨一下即时提交 disabled，成功后 toast 说明做了什么', async () => {
    const { el } = await renderTree();
    fireEvent.click(switchOf(el, '角色管理'));
    await waitFor(() => expect(mocks.setMenuNodeStatus).toHaveBeenCalledWith('mn-system-roles', 'disabled'));
    await waitFor(() => expect(lastNotify()?.text).toBe('菜单已停用'));
  });

  it('已停用的那枚拨回去提交 active', async () => {
    mocks.listMenuNodes.mockResolvedValue(
      seed().map((node) => (node.id === 'mn-system-roles' ? { ...node, status: 'disabled' } : node)),
    );
    const { el } = await renderTree();
    fireEvent.click(switchOf(el, '角色管理'));
    await waitFor(() => expect(mocks.setMenuNodeStatus).toHaveBeenCalledWith('mn-system-roles', 'active'));
    await waitFor(() => expect(lastNotify()?.text).toBe('菜单已启用'));
  });

  it('后端拒绝时开关不"假装已改"：值仍由服务端数据决定，错误原文进 toast', async () => {
    mocks.setMenuNodeStatus.mockRejectedValue({
      code: 'MENU_PROTECTED',
      message: '停用后就没有入口能回到菜单管理页，这一项不能停用',
    });
    const { el } = await renderTree();
    fireEvent.click(switchOf(el, '账号中心'));
    await waitFor(() => expect(lastNotify()?.kind).toBe('danger'));
    expect(lastNotify()?.text).toContain('停用后就没有入口能回到菜单管理页');
    expect(switchOf(el, '账号中心')).toBeChecked();
  });

  it('自定义项带「自定义」徽标（现在只能加不能删，更要让人看清哪几枚是加出来的）', async () => {
    mocks.listMenuNodes.mockResolvedValue([...seed(), CUSTOM]);
    const { el } = await renderTree();
    expect(within(el).getByRole('rowheader', { name: /合规检查/ })).toHaveTextContent('自定义');
    expect(within(el).getByRole('rowheader', { name: /用户管理/ })).not.toHaveTextContent('自定义');
  });
});

describe('回不来的那几枚被锁住（守卫从树上推，不写死节点键）', () => {
  it('菜单管理自己、以及它的上级"系统管理"都不许停用，理由写在 title 上', async () => {
    const { el } = await renderTree();
    for (const label of ['系统管理', '菜单管理']) {
      const box = switchOf(el, label);
      expect(box).toBeChecked();
      expect(box).toBeDisabled();
      expect(box).toHaveAttribute('title', '停用后就没有入口能回到菜单管理页，这一项不能停用');
    }
    // 与本页无关的入口不受影响
    expect(switchOf(el, '账号中心')).toBeEnabled();
  });

  it('多一条能进菜单管理页的路径后，原来那枚就允许停用了', async () => {
    mocks.listMenuNodes.mockResolvedValue(withMenusAlias());
    const { el } = await renderTree();
    expect(switchOf(el, '菜单管理')).toBeEnabled();
    // 但两条路径共同的祖先仍然锁着：停了它等于两条一起消失
    expect(switchOf(el, '系统管理')).toBeDisabled();
  });

  it('唯一路径是自定义别名时，别名也被锁住（锁的是"回得来的路"，不是"内置项"）', async () => {
    mocks.listMenuNodes.mockResolvedValue(
      withMenusAlias().map((node) => (node.id === 'mn-system-menus' ? { ...node, status: 'disabled' } : node)),
    );
    const { el } = await renderTree();
    expect(switchOf(el, '菜单备份')).toBeDisabled();
  });
});

describe('新增入口', () => {
  it('名称为空时提交禁用，选了落点页面就实时提示将出现的分组', async () => {
    await renderTree();
    fireEvent.click(screen.getByRole('button', { name: '新增菜单' }));

    const dialog = await screen.findByRole('dialog', { name: '新增菜单' });
    expect(within(dialog).getByRole('button', { name: '新增菜单' })).toBeDisabled();

    fireEvent.change(within(dialog).getByLabelText('菜单名称'), { target: { value: '合规检查' } });
    expect(within(dialog).getByRole('button', { name: '新增菜单' })).toBeDisabled();

    chooseOption('落点页面', '审计日志（audit）');
    expect(within(dialog).getByText('将出现在：系统管理')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: '新增菜单' })).toBeEnabled();

    fireEvent.click(within(dialog).getByRole('button', { name: '新增菜单' }));
    await waitFor(() => expect(mocks.createMenuNode).toHaveBeenCalledWith('合规检查', 'audit'));
    await waitFor(() => expect(lastNotify()?.text).toBe('菜单已新增'));
    expect(screen.queryByRole('dialog', { name: '新增菜单' })).toBeNull();
  });

  it('下拉只有十枚现有页面，账号中心不在里面', async () => {
    await renderTree();
    fireEvent.click(screen.getByRole('button', { name: '新增菜单' }));
    await screen.findByRole('dialog', { name: '新增菜单' });

    const options = selectOptions('落点页面');
    expect(options).toHaveLength(11);
    expect(options[0]).toBe('请选择页面');
    expect(options.filter((text) => text !== '请选择页面')).toHaveLength(10);
    expect(options.some((text) => text.includes('accounts'))).toBe(false);
    expect(options).toContain('审计日志（audit）');
  });

  it('后端拒绝时把原文 toast 出来，弹窗留在原地让用户改', async () => {
    mocks.createMenuNode.mockRejectedValue({ code: 'MENU_PAGE_UNKNOWN', message: '落点页面不在可绑定范围内' });
    await renderTree();
    fireEvent.click(screen.getByRole('button', { name: '新增菜单' }));
    const dialog = await screen.findByRole('dialog', { name: '新增菜单' });
    fireEvent.change(within(dialog).getByLabelText('菜单名称'), { target: { value: '重复入口' } });
    chooseOption('落点页面', '审计日志（audit）');
    fireEvent.click(within(dialog).getByRole('button', { name: '新增菜单' }));

    await waitFor(() => expect(lastNotify()).toMatchObject({ kind: 'danger', text: '落点页面不在可绑定范围内' }));
    expect(screen.getByRole('dialog', { name: '新增菜单' })).toBeInTheDocument();
    expect(within(dialog).getByLabelText('菜单名称')).toHaveValue('重复入口');
  });
});

describe('失败与状态', () => {
  it('读取失败给错误态与重试', async () => {
    mocks.listMenuNodes.mockRejectedValue({ code: 'DB_ERROR', message: '数据库访问失败' });
    renderSection();
    expect(await screen.findByText('数据库访问失败')).toBeInTheDocument();
    expect(screen.queryByRole('table', { name: '菜单树' })).toBeNull();
  });
});
