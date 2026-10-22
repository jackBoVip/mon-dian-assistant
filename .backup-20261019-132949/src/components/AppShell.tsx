import { useState } from 'react';
import { TopBar } from './TopBar';
import { AccountsPage } from '../pages/AccountsPage';
import { SystemPage } from '../pages/SystemPage';
import { LauncherSettingsPage } from '../pages/LauncherSettingsPage';
import { DataPage } from '../pages/DataPage';
import { NotifyHost } from './ui/NotifyHost';
import type { PageKey } from '../lib/pageMeta';

/**
 * 主窗口壳层：满幅的玻璃容器（内容与窗口边缘齐平）。
 *
 * 三层从外到内：body 上铺的光斑（fixed，z-index -1，现在只从玻璃面**背后**透出来，
 * 不再从容器边缘外面透出来）→ .app-container（玻璃面 + 模糊，无圆角无边框）→ 顶栏 + 内容列。
 * 原型那版是"窗口里嵌一块 32px 圆角的玻璃、外圈留 24px"，交付方看过真机图后要求撤掉那圈留白，
 * 圆角与外阴影随之一起撤（它们只为让那块玻璃看着像浮在光斑上）；口径见 global.css 壳层那段。
 * 侧栏（SideMenu）与底部「此刻」条（GlancePanel）在 S 轮从界面撤下：导航改由顶栏那枚胶囊
 * 承担，导入/导出与快速启动器从「设置」下拉进入。两个组件的源文件仍在仓库里，只是不再被引用。
 */
export function AppShell() {
  const [page, setPage] = useState<PageKey>('accounts');

  return (
    <div className="app-root">
      <div className="bg-blobs" aria-hidden>
        <span className="blob blob-1" />
        <span className="blob blob-2" />
        <span className="blob blob-3" />
      </div>

      <div className="app-container">
        <TopBar active={page} onNavigate={setPage} />
        <main className="main-content">
          <div className="content-layout">
            {page === 'accounts' ? <AccountsPage /> : null}
            {page === 'members' ? <SystemPage section="members" /> : null}
            {page === 'audit' ? <SystemPage section="audit" /> : null}
            {page === 'settings' ? <SystemPage section="settings" /> : null}
            {page === 'launcher' ? <LauncherSettingsPage /> : null}
            {page === 'data' ? <DataPage /> : null}
          </div>
        </main>
      </div>

      <NotifyHost />
    </div>
  );
}
