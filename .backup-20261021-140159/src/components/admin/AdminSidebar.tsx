import { adminItems, type AdminPageKey } from '../../lib/pageMeta';
import { Icon } from '../ui/Icon';

export interface AdminSidebarProps {
  active: AdminPageKey;
  perms: ReadonlySet<string>;
  onNavigate: (page: AdminPageKey) => void;
}

/** 系统管理的左侧竖排图标导航：观感沿用顶栏胶囊，只把方向立起来。 */
export function AdminSidebar({ active, perms, onNavigate }: AdminSidebarProps) {
  return (
    <nav className="admin-sidebar" aria-label="系统管理导航">
      {adminItems(perms).map((item) => (
        <button
          key={item.key}
          type="button"
          className="admin-nav-item"
          aria-current={active === item.key ? 'page' : undefined}
          onClick={() => onNavigate(item.key)}
        >
          <Icon name={item.icon} size={20} />
          <span>{item.label}</span>
        </button>
      ))}
    </nav>
  );
}
