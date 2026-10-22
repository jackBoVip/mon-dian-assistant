import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSession } from '../state/session';
import { api } from '../lib/api';
import { queryKeys } from '../lib/queryClient';
import { PAGE_META, capsuleItems, secondaryItems, type PageKey } from '../lib/pageMeta';
import { notify } from '../state/notify';
import { toNormalisedError } from '../lib/errors';
import { ThemeMenu } from './ThemeMenu';
import { ProfileModal } from './shell/ProfileModal';
import { ChangePasswordModal } from './shell/ChangePasswordModal';
import { DropdownDivider, DropdownItem, Menu } from './ui/dropdown-menu';
import { Button } from './ui/Button';
import { Icon } from './ui/Icon';
import { BrandLogo } from './ui/BrandLogo';
import type { IconName } from './ui/icons';

export interface TopBarProps {
  active: PageKey;
  onNavigate: (page: PageKey) => void;
}

/**
 * 顶栏（原型 .top-navbar，80px 单行）：品牌 + 胶囊导航 + 右侧图标组。
 *
 * 导航项完全由后端 `visible_menus` 推导（lib/pageMeta::capsuleItems），前端不凭空加业务项；
 * 页名与说明已经回到各页自己的页头，这里不再承载标题。
 * 右侧四颗：全局搜索 / 界面风格 / 设置 / 当前使用者。搜索那颗唤起的是快速查找浮层
 * （Rust launcher_visibility，与全局快捷键打开的是同一个窗口），不在这里另造一个搜索框。
 */
export function TopBar({ active, onNavigate }: TopBarProps) {
  const menus = useQuery({ queryKey: queryKeys.menus, queryFn: () => api.menus() });
  const nickname = useSession((s) => s.status?.nickname ?? '未知');
  const lock = useSession((s) => s.lock);
  const [profileOpen, setProfileOpen] = useState(false);
  const [passwordOpen, setPasswordOpen] = useState(false);

  function openSearch() {
    void api.launcherVisibility(true).catch((raw) => notify('danger', toNormalisedError(raw).message));
  }

  return (
    <header className="top-navbar">
      <div className="nav-left">
        <BrandLogo size={30} className="brand-mark" />
        <div className="brand-text">蒙电信产助手</div>
      </div>

      <nav className="nav-center" aria-label="主导航">
        <div className="nav-capsule">
          {capsuleItems(menus.data).map((page) => (
            <button
              key={page}
              type="button"
              className="nav-item"
              aria-current={active === page ? 'page' : undefined}
              onClick={() => onNavigate(page)}
            >
              {PAGE_META[page].label}
            </button>
          ))}
        </div>
      </nav>

      <div className="nav-right">
        <Button variant="bare" className="icon-btn" aria-label="全局搜索" title="全局搜索（快速查找浮层）" onClick={openSearch}>
          <Icon name="search" />
        </Button>

        <ThemeMenu />

        <Menu label="设置" icon="settings">
          {secondaryItems(menus.data).map((page) => (
            <DropdownItem
              key={page}
              icon={SECONDARY_ICONS[page]}
              onPick={() => onNavigate(page)}
            >
              {PAGE_META[page].label}
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
          {/* 昵称从胶囊里搬进下拉第一行：胶囊只留头像 + 箭头，名字长（设备名）时不再撑宽顶栏 */}
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
      </div>

      <ProfileModal open={profileOpen} onClose={() => setProfileOpen(false)} />
      <ChangePasswordModal open={passwordOpen} onClose={() => setPasswordOpen(false)} />
    </header>
  );
}

const SECONDARY_ICONS: Record<'launcher' | 'data', IconName> = { launcher: 'zap', data: 'database' };
