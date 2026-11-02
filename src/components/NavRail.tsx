import type { PageKey } from '../lib/pageMeta';
import type { NavEntry } from '../lib/menuTree';
import { Icon } from './ui/Icon';

export interface NavRailProps {
  /** 读屏用的独立可及名：系统管理导航 / 任务中心导航，不与顶栏主导航混为一谈。 */
  label: string;
  active: PageKey;
  /** 已按 menu_nodes 顺序与权限裁剪好的二级入口。 */
  items: NavEntry[];
  onNavigate: (page: PageKey) => void;
}

/** 二级页的左侧竖排图标导航：系统管理与任务中心共用同一份观感。 */
export function NavRail({ label, active, items, onNavigate }: NavRailProps) {
  return (
    <nav className="nav-rail" aria-label={label}>
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          className="nav-rail-item"
          aria-current={active === item.page ? 'page' : undefined}
          onClick={() => onNavigate(item.page)}
        >
          <Icon name={item.icon} size={20} />
          <span>{item.label}</span>
        </button>
      ))}
    </nav>
  );
}
