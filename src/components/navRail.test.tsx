import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { NavRail } from './NavRail';
import { PERM } from '../lib/permissions';
import { PAGE_META } from '../lib/pageMeta';
import { buildNav } from '../lib/menuTree';
import { seedMenuNodes } from '../test/menuFixtures';

const FULL = new Set<string>([
  ...Object.values(PERM),
  ...seedMenuNodes().map((node) => node.permKey),
]);

function adminItems() {
  return buildNav(seedMenuNodes(), FULL).admin;
}

describe('二级页左栏', () => {
  it('按传入的 items 顺序渲染：全量种子下五项照确认稿排列', () => {
    render(<NavRail label="系统管理导航" active="users" items={adminItems()} onNavigate={vi.fn()} />);
    expect(screen.getAllByRole('button').map((el) => el.textContent)).toEqual([
      PAGE_META.users.label,
      PAGE_META.roles.label,
      PAGE_META.menus.label,
      PAGE_META.permissions.label,
      PAGE_META.audit.label,
    ]);
  });

  it('顺序由节点 sortOrder 决定，不在组件里写死', () => {
    const nodes = seedMenuNodes().map((node) =>
      node.id === 'mn-system-roles' ? { ...node, sortOrder: 5 } : node,
    );
    const items = buildNav(nodes, FULL).admin;
    render(<NavRail label="系统管理导航" active="roles" items={items} onNavigate={vi.fn()} />);
    expect(screen.getAllByRole('button').map((el) => el.textContent).slice(0, 2)).toEqual([
      PAGE_META.roles.label,
      PAGE_META.users.label,
    ]);
  });

  it('名称读节点自己的 label：改名后左栏跟着变', () => {
    const nodes = seedMenuNodes().map((node) =>
      node.id === 'mn-system-audit' ? { ...node, label: '操作留痕' } : node,
    );
    render(
      <NavRail label="系统管理导航" active="audit" items={buildNav(nodes, FULL).admin} onNavigate={vi.fn()} />,
    );
    expect(screen.getByRole('button', { name: '操作留痕' })).toBeInTheDocument();
  });

  it('当前页那颗带 aria-current=page', () => {
    render(<NavRail label="系统管理导航" active="audit" items={adminItems()} onNavigate={vi.fn()} />);
    expect(screen.getByRole('button', { name: PAGE_META.audit.label })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('button', { name: PAGE_META.users.label })).not.toHaveAttribute('aria-current');
  });

  it('点击交给 onNavigate，传的是二级页键', () => {
    const onNavigate = vi.fn();
    render(<NavRail label="系统管理导航" active="users" items={adminItems()} onNavigate={onNavigate} />);
    fireEvent.click(screen.getByRole('button', { name: PAGE_META.permissions.label }));
    expect(onNavigate).toHaveBeenCalledWith('permissions');
  });

  it('导航有独立可及名，读屏不会与顶栏主导航混为一谈', () => {
    render(<NavRail label="系统管理导航" active="users" items={adminItems()} onNavigate={vi.fn()} />);
    expect(screen.getByRole('navigation', { name: '系统管理导航' })).toBeInTheDocument();
  });

  it('任务中心复用同一组件：传入自己的可及名与二级入口', () => {
    render(
      <NavRail label="任务中心导航" active="release" items={buildNav(seedMenuNodes(), FULL).tasks} onNavigate={vi.fn()} />,
    );
    expect(screen.getByRole('navigation', { name: '任务中心导航' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: PAGE_META.release.label })).toHaveAttribute('aria-current', 'page');
  });
});
