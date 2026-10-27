import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PermissionsSection } from './PermissionsSection';
import type { PermissionRow, RoleAdminSummary } from '../../lib/types';
import { seedMenuNodes } from '../../test/menuFixtures';
import { useNotify } from '../../state/notify';
import { pointerTap } from '../../test/pointer';

const mocks = vi.hoisted(() => ({
  listRolesAdmin: vi.fn(),
  listPermissions: vi.fn(),
  listMenuNodes: vi.fn(),
  setRoleActionPermissions: vi.fn(),
  setRoleMenuPermissions: vi.fn(),
}));

vi.mock('../../lib/api', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../lib/api')>();
  return { ...mod, api: { ...mod.api, ...mocks } };
});

function permOf(nodeKey: string): string {
  const node = seedMenuNodes().find((n) => n.nodeKey === nodeKey);
  if (!node) throw new Error(`夹具里没有 ${nodeKey}`);
  return node.permKey;
}

const ADMIN: RoleAdminSummary = {
  id: 'r1',
  code: 'system_admin',
  name: '系统管理员',
  description: '全部权限，含安全策略、更新与备份',
  status: 'active',
  builtin: true,
  userCount: 1,
  permissions: ['menu.accounts', 'accounts.read', 'accounts.create', 'system.audit.read', 'system.role.manage'],
};

const AUDITOR: RoleAdminSummary = {
  id: 'r2',
  code: 'auditor',
  name: '审计员',
  description: '',
  status: 'active',
  builtin: false,
  userCount: 0,
  permissions: ['menu.accounts', 'system.audit.read'],
};

const CATALOG: PermissionRow[] = [
  { key: 'menu.accounts', name: '账号中心', type: 'menu', description: null },
  { key: 'accounts.read', name: '读取账号', type: 'action', description: '查看账号台账' },
  { key: 'accounts.create', name: '新建账号', type: 'action', description: null },
  { key: 'system.audit.read', name: '查看审计日志', type: 'action', description: null },
  { key: 'system.role.manage', name: '管理角色', type: 'action', description: null },
];

/**
 * 计数一律由夹具推出来，不手写数字：夹具本身已被 `menuTree.test.ts` 钉成等于迁移种子，
 * 所以再加一页入口时，这里不会靠"少算一页也算绿"蒙过去。
 */
const MENU_KEYS = seedMenuNodes().length;
const TOTAL_KEYS = MENU_KEYS + CATALOG.filter((row) => row.type === 'action').length;
/** 授权覆盖率那一格显示的是四舍五入后的整数百分比。 */
const pct = (selected: number) => String(Math.round((selected / TOTAL_KEYS) * 100));

/** tsconfig 的 target 还没有 Array.prototype.at，取最后一条通知一律走下标。 */
function lastNotify() {
  const items = useNotify.getState().items;
  return items[items.length - 1];
}

function renderSection() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={qc}>
      <PermissionsSection />
    </QueryClientProvider>,
  );
}

/** 渲染并等第一个角色上屏；后续一律按可及名取，避免裸 query 撞车。 */
async function openSection() {
  renderSection();
  await screen.findByRole('tab', { name: '系统管理员' });
  return screen.getByRole('tabpanel', { name: '系统管理员 的权限' });
}

function checkbox(name: string) {
  return screen.getByRole('checkbox', { name });
}

function cardOf(name: string): HTMLElement {
  const card = checkbox(name).closest('label');
  if (!(card instanceof HTMLElement)) throw new Error(`${name} 不在卡片里`);
  return card;
}

function saveButton(role = '系统管理员') {
  return screen.getByRole('button', { name: `保存 ${role} 的权限` });
}

function resetButton(role = '系统管理员') {
  return screen.getByRole('button', { name: `还原 ${role} 的权限` });
}

beforeEach(() => {
  Object.values(mocks).forEach((fn) => fn.mockReset());
  mocks.listRolesAdmin.mockResolvedValue([ADMIN, AUDITOR]);
  mocks.listPermissions.mockResolvedValue(CATALOG);
  mocks.listMenuNodes.mockResolvedValue(seedMenuNodes());
  mocks.setRoleActionPermissions.mockResolvedValue(undefined);
  mocks.setRoleMenuPermissions.mockResolvedValue(undefined);
  useNotify.setState({ items: [] });
});

describe('角色是 tabs，下面是当前角色的权限卡片', () => {
  it('角色排成一排 tab，默认落在第一个角色上', async () => {
    await openSection();
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent?.trim())).toEqual([
      '系统管理员',
      '审计员',
    ]);
    expect(screen.getByRole('tab', { name: '系统管理员' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: '审计员' })).toHaveAttribute('aria-selected', 'false');
  });

  it('切到另一枚 tab，卡片换成那个角色的勾选状态', async () => {
    await openSection();
    expect(checkbox('系统管理员 · 账号中心')).toBeChecked();

    pointerTap(screen.getByRole('tab', { name: '审计员' }));
    expect(screen.getByRole('tabpanel', { name: '审计员 的权限' })).toBeInTheDocument();
    expect(checkbox('审计员 · 账号中心')).toBeChecked();
    expect(checkbox('审计员 · 新建账号')).not.toBeChecked();
    expect(screen.queryByRole('checkbox', { name: '系统管理员 · 账号中心' })).toBeNull();
    expect(screen.getByRole('status').textContent).toContain(`已选 2 / ${TOTAL_KEYS} 项`);
  });

  it('每枚权限是一张卡片，不再是表格矩阵', async () => {
    await openSection();
    expect(screen.queryByRole('columnheader')).toBeNull();
    // 每一枚菜单节点 + 每一项操作权限各一枚卡片，枚数跟着夹具走
    expect(screen.getAllByRole('checkbox')).toHaveLength(TOTAL_KEYS);
    expect(document.querySelectorAll('label[data-selected]')).toHaveLength(TOTAL_KEYS);
  });

  it('菜单权限按一级/二级分区，二级卡片挂在父级分组里', async () => {
    await openSection();
    const titles = Array.from(document.querySelectorAll('h2')).map((el) => el.textContent);
    expect(titles).toEqual(['菜单权限', '操作权限']);
    const subgroups = Array.from(document.querySelectorAll('h3')).map((el) => el.childNodes[0]?.textContent);
    expect(subgroups).toEqual(['账号台账操作', '系统管理操作']);

    const system = screen.getByRole('group', { name: '系统管理 菜单' });
    expect(within(system).getByRole('checkbox', { name: '系统管理员 · 系统管理' })).toBeInTheDocument();
    for (const label of ['用户管理', '角色管理', '菜单管理', '权限管理', '审计日志']) {
      expect(within(system).getByRole('checkbox', { name: `系统管理员 · ${label}` })).toBeInTheDocument();
    }
    expect(within(system).getAllByText('一级')).toHaveLength(1);
    expect(within(system).getAllByText('二级')).toHaveLength(5);
    // 每一枚菜单键都来自节点自己的 permKey
    expect(screen.getByText('menu.node.system.permissions')).toBeInTheDocument();
    expect(screen.getByText('menu.accounts')).toBeInTheDocument();
  });

  it('统计卡与角色卡落在滚动区外，数值随勾选实时变化', async () => {
    await openSection();
    const role = screen.getByRole('group', { name: '当前角色' });
    expect(within(role).getByText('系统管理员')).toBeInTheDocument();
    expect(within(role).getByText('system_admin')).toBeInTheDocument();
    expect(within(role).getByText(/全部权限/)).toBeInTheDocument();

    const menu = screen.getByRole('group', { name: '菜单入口' });
    const actions = screen.getByRole('group', { name: '操作权限' });
    const coverage = screen.getByRole('group', { name: '授权覆盖率' });
    expect(within(menu).getByText('1')).toBeInTheDocument();
    expect(within(menu).getByText(`/ ${MENU_KEYS}`)).toBeInTheDocument();
    expect(within(actions).getByText('4')).toBeInTheDocument();
    expect(within(actions).getByText('/ 4')).toBeInTheDocument();
    expect(within(coverage).getByText(pct(5))).toBeInTheDocument();
    expect(within(coverage).getByText('%')).toBeInTheDocument();

    fireEvent.click(checkbox('系统管理员 · 账号中心'));
    expect(within(menu).getByText('0')).toBeInTheDocument();
    expect(within(coverage).getByText(pct(4))).toBeInTheDocument();
  });

  it('计数随勾选实时变化', async () => {
    await openSection();
    expect(screen.getByRole('status').textContent).toContain(`已选 5 / ${TOTAL_KEYS} 项`);
    fireEvent.click(checkbox('系统管理员 · 账号中心'));
    expect(screen.getByRole('status').textContent).toContain(`已选 4 / ${TOTAL_KEYS} 项`);
  });
});

describe('卡片状态：未选灰面，选中主色染色面', () => {
  it('未选中与选中各自带 perm-card，状态挂在 data-selected 上', async () => {
    await openSection();
    const on = cardOf('系统管理员 · 账号中心');
    expect(on).toHaveAttribute('data-selected', 'true');
    expect(on).toHaveClass('perm-card', 'border-primary');
    expect(on).not.toHaveClass('border-line');

    const off = cardOf('系统管理员 · 系统管理');
    expect(off).toHaveAttribute('data-selected', 'false');
    expect(off).toHaveClass('perm-card', 'border-line');
    expect(off).not.toHaveClass('border-primary');

    fireEvent.click(checkbox('系统管理员 · 系统管理'));
    expect(off).toHaveAttribute('data-selected', 'true');
    expect(off).toHaveClass('border-primary');
  });

  it('灰面、主色面与左侧细轨写在 .perm-card 里，由正文/主色令牌派生', () => {
    const css = readFileSync(resolve('src/styles/global.css'), 'utf8');
    const base = /\.perm-card \{([\s\S]*?)\}/.exec(css)?.[1] ?? '';
    const hoverRule = /(\.perm-card:hover[^{]*)\{([\s\S]*?)\}/.exec(css);
    const selected = /\.perm-card\[data-selected='true'\] \{([\s\S]*?)\}/.exec(css)?.[1] ?? '';
    expect(base).toContain('color-mix(in oklab, var(--t-text-muted) 7%, transparent)');
    expect(hoverRule?.[1]).toContain(":not([data-selected='true'])");
    expect(hoverRule?.[1]).toContain(":not([data-disabled='true'])");
    expect(hoverRule?.[2]).toContain('color-mix(in oklab, var(--t-text-muted) 12%, transparent)');
    expect(selected).toContain('color-mix(in oklab, var(--t-primary) 11%, transparent)');
    expect(selected).toContain('border-color: color-mix(in oklab, var(--t-primary) 45%, var(--t-border))');
    expect(selected).toContain('box-shadow: inset 2px 0 0 0 var(--t-primary)');
  });

  it('一级入口带整棵子树：勾选与取消都同步到五枚二级项', async () => {
    await openSection();
    const root = checkbox('系统管理员 · 系统管理');
    const child = checkbox('系统管理员 · 用户管理');
    expect(root).not.toBeChecked();
    expect(child).toBeDisabled();

    fireEvent.click(root);
    expect(root).toBeChecked();
    for (const label of ['用户管理', '角色管理', '菜单管理', '权限管理', '审计日志']) {
      expect(checkbox(`系统管理员 · ${label}`)).toBeChecked();
      expect(checkbox(`系统管理员 · ${label}`)).toBeEnabled();
    }
    expect(screen.getByRole('status').textContent).toContain(`已选 11 / ${TOTAL_KEYS} 项`);

    fireEvent.click(child);
    expect(child).not.toBeChecked();
    expect(root).toBeChecked();

    fireEvent.click(root);
    expect(root).not.toBeChecked();
    expect(child).toBeDisabled();
    for (const label of ['用户管理', '角色管理', '菜单管理', '权限管理', '审计日志']) {
      expect(checkbox(`系统管理员 · ${label}`)).not.toBeChecked();
    }
  });
});

describe('保存按"哪一类脏了"分开提交', () => {
  it('只改了菜单，就只调菜单命令，操作权限那组一个键都不写', async () => {
    await openSection();
    fireEvent.click(checkbox('系统管理员 · 设置'));

    expect(saveButton()).toBeEnabled();
    fireEvent.click(saveButton());

    await waitFor(() => expect(mocks.setRoleMenuPermissions).toHaveBeenCalled());
    const sent = mocks.setRoleMenuPermissions.mock.calls[0][1] as string[];
    expect(sent).toEqual(
      expect.arrayContaining([
        'menu.accounts',
        permOf('gear.settings'),
        permOf('settings.security'),
        permOf('settings.appearance'),
        permOf('settings.backup'),
        permOf('settings.update'),
        permOf('settings.tools'),
      ]),
    );
    // 「设置」那一棵子树（一级 + 它的各枚二级）连同已经勾着的账号中心
    const settingsTree = seedMenuNodes().filter(
      (node) => node.nodeKey === 'gear.settings' || node.nodeKey.startsWith('settings.'),
    );
    expect(sent).toHaveLength(settingsTree.length + 1);
    expect(sent).not.toContain('accounts.read');
    expect(mocks.setRoleActionPermissions).not.toHaveBeenCalled();
    await waitFor(() => expect(lastNotify()?.text).toBe('权限已保存'));
  });

  it('只改了操作权限，就只调操作权限命令，菜单那组一个键都不写', async () => {
    await openSection();
    fireEvent.click(checkbox('系统管理员 · 新建账号'));
    fireEvent.click(saveButton());

    await waitFor(() =>
      expect(mocks.setRoleActionPermissions).toHaveBeenCalledWith('r1', [
        'accounts.read',
        'system.audit.read',
        'system.role.manage',
      ]),
    );
    expect(mocks.setRoleActionPermissions.mock.calls[0][1]).not.toContain('menu.accounts');
    expect(mocks.setRoleMenuPermissions).not.toHaveBeenCalled();
  });

  it('两类都改：两个端点各收自己那一类', async () => {
    await openSection();
    fireEvent.click(checkbox('系统管理员 · 系统管理'));
    fireEvent.click(checkbox('系统管理员 · 新建账号'));
    fireEvent.click(saveButton());

    await waitFor(() => expect(mocks.setRoleMenuPermissions).toHaveBeenCalled());
    await waitFor(() =>
      expect(mocks.setRoleActionPermissions).toHaveBeenCalledWith('r1', [
        'accounts.read',
        'system.audit.read',
        'system.role.manage',
      ]),
    );
    const menus = mocks.setRoleMenuPermissions.mock.calls[0][1] as string[];
    expect(menus).toContain('menu.node.system.audit');
  });

  it('保存成功后草稿清空，两颗钮回到禁用', async () => {
    await openSection();
    fireEvent.click(checkbox('系统管理员 · 设置'));
    fireEvent.click(saveButton());

    await waitFor(() => expect(mocks.setRoleMenuPermissions).toHaveBeenCalled());
    await waitFor(() => expect(checkbox('系统管理员 · 设置')).not.toBeChecked());
    expect(saveButton()).toBeDisabled();
  });

  it('保存失败时草稿留在界面上', async () => {
    mocks.setRoleMenuPermissions.mockRejectedValue({
      code: 'FORBIDDEN',
      message: '未授权：当前使用者无权执行该操作',
    });
    await openSection();
    fireEvent.click(checkbox('系统管理员 · 设置'));
    fireEvent.click(saveButton());

    await waitFor(() => expect(lastNotify()?.kind).toBe('danger'));
    expect(checkbox('系统管理员 · 设置')).toBeChecked();
  });
});

describe('草稿与还原', () => {
  it('无改动时两颗钮都禁用；还原丢掉草稿', async () => {
    await openSection();
    expect(saveButton()).toBeDisabled();
    expect(resetButton()).toBeDisabled();

    fireEvent.click(checkbox('系统管理员 · 设置'));
    expect(saveButton()).toBeEnabled();
    expect(checkbox('系统管理员 · 设置')).toBeChecked();

    fireEvent.click(resetButton());
    expect(checkbox('系统管理员 · 设置')).not.toBeChecked();
    expect(saveButton()).toBeDisabled();
  });

  it('切角色不丢另一个角色没保存的勾选', async () => {
    await openSection();
    fireEvent.click(checkbox('系统管理员 · 设置'));
    pointerTap(screen.getByRole('tab', { name: '审计员' }));
    expect(screen.getByRole('button', { name: '保存 审计员 的权限' })).toBeDisabled();

    pointerTap(screen.getByRole('tab', { name: '系统管理员' }));
    expect(checkbox('系统管理员 · 设置')).toBeChecked();
    expect(saveButton()).toBeEnabled();
  });

  it('点卡片文字也能切换：命中区是整张卡片', async () => {
    await openSection();
    fireEvent.click(screen.getByText('设置'));
    expect(checkbox('系统管理员 · 设置')).toBeChecked();
    fireEvent.click(screen.getByText('设置'));
    expect(checkbox('系统管理员 · 设置')).not.toBeChecked();
  });
});

describe('布局守卫：统计条与页脚钉在滚动区外，权限按两块面板排', () => {
  it('统计卡、页脚与保存钮都在滚动区外面，两块面板标题在里面', async () => {
    await openSection();
    const scroller = document.querySelector('.overscroll-contain');
    expect(scroller).not.toBeNull();
    expect(scroller!.contains(screen.getByRole('status'))).toBe(false);
    expect(scroller!.contains(saveButton())).toBe(false);
    expect(scroller!.contains(screen.getByRole('group', { name: '菜单入口' }))).toBe(false);
    expect(scroller!.contains(screen.getByRole('group', { name: '当前角色' }))).toBe(false);
    const headings = screen.getAllByRole('heading', { level: 2 });
    expect(headings.map((el) => el.textContent)).toEqual(['菜单权限', '操作权限']);
    for (const title of headings) {
      expect(scroller!.contains(title)).toBe(true);
    }
  });

  it('统计卡、统计条与一级分组壳的样式都在 global.css 里按主题令牌派生', () => {
    const css = readFileSync(resolve('src/styles/global.css'), 'utf8');
    expect(css).toMatch(/\.perm-kpi \{[\s\S]*?background: var\(--t-surface\)/);
    expect(css).toMatch(/\.perm-kpi--role \{[\s\S]*?var\(--t-primary\) 6%, var\(--t-surface\)/);
    expect(css).toMatch(/\.perm-meter > span \{[\s\S]*?var\(--t-primary\)/);
    expect(css).toMatch(/\.perm-root-kids \{[\s\S]*?repeat\(2, minmax\(0, 1fr\)\)/);
  });
});
