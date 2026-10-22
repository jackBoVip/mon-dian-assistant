import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { queryKeys } from '../lib/queryClient';
import { useShell } from '../state/shell';
import { Loading, ErrorState } from './ui/StateBlocks';
import { Icon } from './ui/Icon';
import { PAGE_ICONS } from './ui/icons';
import type { MenuEntry } from '../lib/types';

export type PageKey = 'accounts' | 'system' | 'launcher' | 'data';

/** 后端菜单 key/label → 前端页面解析。未知项不猜测、不渲染为可点业务页。 */
export function resolvePage(entry: MenuEntry): PageKey | null {
  const k = entry.key.toLowerCase();
  const l = entry.label;
  if (k === 'accounts' || k.includes('account') || l.includes('账号管理')) return 'accounts';
  if (k === 'system' || k.includes('system') || l.includes('系统管理')) return 'system';
  return null;
}

export interface SideMenuProps {
  active: PageKey | null;
  onNavigate: (page: PageKey) => void;
}

/**
 * 左侧菜单：业务项完全来自 api.menus()（后端 RBAC 计算），前端不新增/隐藏业务项。
 *
 * 收起态（64px 图标轨）用 `.nav-text/.brand-text/.nav-group-label` 的
 * opacity:0 + width:0 隐文字，**不是 display:none**：标签留在 DOM 里，
 * 可及名才算得出「账号管理」，收起态的键盘路径才有名字。视觉提示走 title 属性，
 * 不做稿里那个 :hover::after —— 纯 CSS 伪元素内容不进程序播报，收起态就没人知道那是什么。
 */
export function SideMenu({ active, onNavigate }: SideMenuProps) {
  const menus = useQuery({ queryKey: queryKeys.menus, queryFn: () => api.menus() });
  const collapsed = useShell((s) => s.collapsed);

  const sorted = menus.data ? [...menus.data].sort((a, b) => a.order - b.order) : [];

  return (
    <nav className="sidebar" id="app-sidebar" aria-label="主导航">
      <div className="brand-row">
        {/* 正式品牌 Logo 需授权资源；未提供前为可替换占位区域，不仿制官方标志 */}
        <span aria-hidden className="brand-mark">
          电
        </span>
        <div className="brand-text">
          <div className="brand-name">蒙电信产助手</div>
          {/* 全应用唯一常驻的术语提示位：这是外部凭据库，不是登录口令库 */}
          <div className="brand-sub">本地凭据保险库</div>
        </div>
      </div>

      <div className="nav-scroll">
        {menus.isLoading ? <Loading label="加载菜单…" /> : null}
        {menus.isError ? <ErrorState raw={menus.error} onRetry={() => void menus.refetch()} /> : null}
        {menus.data ? (
          <div className="nav-group">
            <div className="nav-group-label">业务</div>
            <ul className="nav-list">
              {sorted.map((entry) => {
                const page = resolvePage(entry);
                if (!page) {
                  return (
                    <li key={entry.key}>
                      <span className="nav-disabled" title={collapsed ? entry.label : undefined}>
                        <span className="nav-text">
                          {entry.label}（本版本未提供界面）
                        </span>
                      </span>
                    </li>
                  );
                }
                return (
                  <li key={entry.key}>
                    <button
                      type="button"
                      onClick={() => onNavigate(page)}
                      aria-current={active === page ? 'page' : undefined}
                      title={collapsed ? entry.label : undefined}
                      className="nav-item"
                    >
                      <Icon name={PAGE_ICONS[page]} className="nav-icon" />
                      <span className="nav-text">{entry.label}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        ) : null}

        {/* 次级设置入口（非后端业务菜单）：快速启动器与台账 CSV 搬运，稿里的分组名是「设置」 */}
        <div className="nav-group">
          <div className="nav-group-label">设置</div>
          <ul className="nav-list">
            <li>
              <button
                type="button"
                onClick={() => onNavigate('launcher')}
                aria-current={active === 'launcher' ? 'page' : undefined}
                title={collapsed ? '快速启动器' : undefined}
                className="nav-item"
              >
                <Icon name={PAGE_ICONS.launcher} className="nav-icon" />
                <span className="nav-text">快速启动器</span>
              </button>
            </li>
            {/* 数据搬运入口（台账 CSV 导入/导出）：权限由后端命令级校验，这里不预判 */}
            <li>
              <button
                type="button"
                onClick={() => onNavigate('data')}
                aria-current={active === 'data' ? 'page' : undefined}
                title={collapsed ? '导入/导出' : undefined}
                className="nav-item"
              >
                <Icon name={PAGE_ICONS.data} className="nav-icon" />
                <span className="nav-text">导入/导出</span>
              </button>
            </li>
          </ul>
        </div>
      </div>
    </nav>
  );
}
