import { useState } from 'react';
import { useSession } from '../state/session';
import { api } from '../lib/api';
import { notify } from '../state/notify';
import { toNormalisedError } from '../lib/errors';
import { isAdminPage, isGearPage, type AdminPageKey, type PageKey, type TopKey } from '../lib/pageMeta';
import { resolveAdminLanding, type NavTree } from '../lib/menuTree';
import { ThemeMenu } from './ThemeMenu';
import { ProfileModal } from './shell/ProfileModal';
import { WindowControls } from './shell/WindowControls';
import { ChangePasswordModal } from './shell/ChangePasswordModal';
import { DropdownDivider, DropdownItem, Menu } from './ui/dropdown-menu';
import { Button } from './ui/Button';
import { Icon } from './ui/Icon';
import { BrandLogo } from './ui/BrandLogo';

export interface TopBarProps {
  active: PageKey;
  lastAdminPage: AdminPageKey | null;
  /** 菜单树与权限推导的结果；未就绪时传 null，胶囊与下拉按「宁缺不猜」留空。 */
  nav: NavTree | null;
  onNavigate: (page: PageKey) => void;
}

/**
 * 顶栏（原型 .top-navbar，80px 单行）：品牌 + 胶囊导航 + 右侧图标组。
 *
 * 一级项与齿轮两组都来自 lib/menuTree 的推导结果：节点决定顺序与启停，权限决定可见性。
 * 菜单可见性只决定入口是否出现，真正的拒绝始终在后端。
 */
export function TopBar({ active, lastAdminPage, nav, onNavigate }: TopBarProps) {
  const tops = nav?.top ?? [];
  const settings = nav?.settings ?? [];
  const utilities = nav?.utilities ?? [];
  const nickname = useSession((s) => s.status?.nickname ?? '未知');
  const lock = useSession((s) => s.lock);
  const [profileOpen, setProfileOpen] = useState(false);
  const [passwordOpen, setPasswordOpen] = useState(false);

  function openSearch() {
    void api.launcherVisibility(true).catch((raw) => notify('danger', toNormalisedError(raw).message));
  }

  function pickTop(key: TopKey) {
    if (key === 'accounts' || key === 'quiz') {
      onNavigate(key);
      return;
    }
    const landing = nav ? resolveAdminLanding(nav, lastAdminPage) : null;
    if (landing) onNavigate(landing);
  }

  /** 胶囊的激活态：账号中心与题库各自认自己，系统管理认它名下任意二级页。 */
  function isTopActive(key: TopKey): boolean {
    if (key === 'accounts') return active === 'accounts';
    if (key === 'quiz') return active === 'quiz';
    return isAdminPage(active);
  }

  return (
    // 主窗是 titleBarStyle: Overlay —— 页面伸到标题栏底下、只剩红绿灯，所以这一条就是它的标题栏：
    // deep 让子树里的空白处也能拖窗，而 drag.js 碰到 button/a/input/[role=…] 会放弃拖拽，
    // 因此胶囊导航与右侧四颗照常可点。双击这一条 = 原生那套最大化/还原（macOS 在 mouseup 判移动）。
    <header className="top-navbar" data-tauri-drag-region="deep">
      <div className="nav-left">
        <BrandLogo size={30} className="brand-mark" />
        <div className="brand-text">蒙电信产助手</div>
      </div>

      <nav className="nav-center" aria-label="主导航">
        <div className="nav-capsule">
          {tops.map((entry) => (
            <button
              key={entry.id}
              type="button"
              className="nav-item"
              aria-current={isTopActive(entry.key) ? 'page' : undefined}
              onClick={() => pickTop(entry.key)}
            >
              {entry.label}
            </button>
          ))}
        </div>
      </nav>

      <div className="nav-right">
        <Button variant="bare" className="icon-btn" aria-label="全局搜索" title="全局搜索（快速查找浮层）" onClick={openSearch}>
          <Icon name="search" />
        </Button>

        <ThemeMenu />

        <Menu
          label="设置"
          icon="settings"
          triggerClassName={isGearPage(active) ? 'icon-btn is-active' : undefined}
        >
          {settings.map((item) => (
            <DropdownItem key={item.id} icon={item.icon} onPick={() => onNavigate(item.page)}>
              {item.label}
            </DropdownItem>
          ))}
          {settings.length > 0 && utilities.length > 0 ? <DropdownDivider /> : null}
          {utilities.map((item) => (
            <DropdownItem key={item.id} icon={item.icon} onPick={() => onNavigate(item.page)}>
              {item.label}
            </DropdownItem>
          ))}
        </Menu>

        <Menu
          label={`当前使用者 ${nickname}`}
          triggerClassName="user-profile"
          triggerContent={
            <>
              <span className="user-avatar" aria-hidden>
                {nickname.slice(0, 1)}
              </span>
              <Icon name="chevronDown" size={14} />
            </>
          }
        >
          {/* 昵称从胶囊里搬进下拉第一行：胶囊只留头像，名字长（设备名）时不再撑宽顶栏 */}
          <div className="user-menu-name">{nickname}</div>
          <DropdownDivider />
          <DropdownItem icon="user" onPick={() => setProfileOpen(true)}>
            个人信息
          </DropdownItem>
          <DropdownItem icon="key" onPick={() => setPasswordOpen(true)}>
            修改密码
          </DropdownItem>
          <DropdownDivider />
          <DropdownItem icon="logout" danger title="锁定保险库并回到解锁页" onPick={() => void lock()}>
            退出登录
          </DropdownItem>
        </Menu>

        {/* Windows / Linux 去框后系统不再给窗口按钮，这三颗由界面补上；
            macOS 有原生红绿灯，组件自己返回 null，一条都不渲染 */}
        <WindowControls />
      </div>

      <ProfileModal open={profileOpen} onClose={() => setProfileOpen(false)} />
      <ChangePasswordModal open={passwordOpen} onClose={() => setPasswordOpen(false)} />
    </header>
  );
}
