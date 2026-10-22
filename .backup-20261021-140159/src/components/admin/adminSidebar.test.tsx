import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AdminSidebar } from './AdminSidebar';
import { PERM } from '../../lib/permissions';
import { PAGE_META } from '../../lib/pageMeta';

const FULL = new Set<string>(Object.values(PERM));

describe('系统管理左栏', () => {
  it('全量权限下五项按确认稿顺序排列', () => {
    render(<AdminSidebar active="users" perms={FULL} onNavigate={vi.fn()} />);
    expect(screen.getAllByRole('button').map((el) => el.textContent)).toEqual([
      PAGE_META.users.label,
      PAGE_META.roles.label,
      PAGE_META.menus.label,
      PAGE_META.permissions.label,
      PAGE_META.audit.label,
    ]);
  });

  it('按权限裁剪：只有用户读权限时只剩用户管理', () => {
    render(<AdminSidebar active="users" perms={new Set([PERM.SYS_USER_READ])} onNavigate={vi.fn()} />);
    expect(screen.getAllByRole('button').map((el) => el.textContent)).toEqual([PAGE_META.users.label]);
  });

  it('当前页那颗带 aria-current=page', () => {
    render(<AdminSidebar active="audit" perms={FULL} onNavigate={vi.fn()} />);
    expect(screen.getByRole('button', { name: PAGE_META.audit.label })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('button', { name: PAGE_META.users.label })).not.toHaveAttribute('aria-current');
  });

  it('点击交给 onNavigate，传的是二级页键', () => {
    const onNavigate = vi.fn();
    render(<AdminSidebar active="users" perms={FULL} onNavigate={onNavigate} />);
    fireEvent.click(screen.getByRole('button', { name: PAGE_META.permissions.label }));
    expect(onNavigate).toHaveBeenCalledWith('permissions');
  });

  it('导航有独立可及名，读屏不会与顶栏主导航混为一谈', () => {
    render(<AdminSidebar active="users" perms={FULL} onNavigate={vi.fn()} />);
    expect(screen.getByRole('navigation', { name: '系统管理导航' })).toBeInTheDocument();
  });
});
