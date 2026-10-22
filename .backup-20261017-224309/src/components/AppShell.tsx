import { useState } from 'react';
import { SideMenu, type PageKey } from './SideMenu';
import { TopBar } from './TopBar';
import { AccountsPage } from '../pages/AccountsPage';
import { SystemPage } from '../pages/SystemPage';
import { LauncherSettingsPage } from '../pages/LauncherSettingsPage';
import { DataPage } from '../pages/DataPage';
import { GlancePanel } from './GlancePanel';
import { NotifyHost } from './ui/NotifyHost';

const TITLES: Record<PageKey, string> = {
  accounts: '账号管理',
  system: '系统管理',
  launcher: '快速启动器',
  data: '导入/导出',
};

/** 主窗口壳层：左侧菜单 + 顶栏 + 内容区 + 底部居中的常驻「此刻」面板。默认进入账号管理。 */
export function AppShell() {
  const [page, setPage] = useState<PageKey>('accounts');

  return (
    <div className="app-shell flex h-full">
      <SideMenu active={page} onNavigate={setPage} />
      <div className="app-canvas flex min-w-0 flex-1 flex-col">
        <TopBar title={TITLES[page]} onOpenLauncher={() => setPage('launcher')} />
        <main className="app-main min-h-0 flex-1 overflow-y-auto">
          {page === 'accounts' ? <AccountsPage /> : null}
          {page === 'system' ? <SystemPage /> : null}
          {page === 'launcher' ? <LauncherSettingsPage /> : null}
          {page === 'data' ? <DataPage /> : null}
        </main>
        <GlancePanel />
      </div>
      <NotifyHost />
    </div>
  );
}
