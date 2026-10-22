import type { AdminPageKey } from '../../lib/pageMeta';
import type { NavEntry } from '../../lib/menuTree';
import { Icon } from '../ui/Icon';

export interface AdminSidebarProps {
  active: AdminPageKey;
  /** 已按 menu_nodes 顺序与权限裁剪好的系统管理二级入口。 */
  items: NavEntry[];
  onNavigate: (page: AdminPageKey) => void;
}

/** 系统管理的左侧竖排图标导航：观感沿用顶栏胶囊，只把方向立起来。 */
export function AdminSidebar({ active, items, onNavigate }: AdminSidebarProps) {
  return (
    <nav className="admin-sidebar" aria-label="系统管理导航">
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          className="admin-nav-item"
          aria-current={active === item.page ? 'page' : undefined}
          onClick={() => onNavigate(item.page as AdminPageKey)}
        >
          <Icon name={item.icon} size={20} />
          <span>{item.label}</span>
        </button>
      ))}
    </nav>
  );
}
