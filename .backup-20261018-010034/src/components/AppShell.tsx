import { useEffect, useState } from 'react';
import { SideMenu, type PageKey } from './SideMenu';
import { TopBar } from './TopBar';
import { AccountsPage } from '../pages/AccountsPage';
import { SystemPage } from '../pages/SystemPage';
import { LauncherSettingsPage } from '../pages/LauncherSettingsPage';
import { DataPage } from '../pages/DataPage';
import { GlancePanel } from './GlancePanel';
import { NotifyHost } from './ui/NotifyHost';
import { useShell } from '../state/shell';
import { useShellSearch } from '../state/shellSearch';

/**
 * 主窗口壳层：贴边左侧菜单 + 贴边顶栏 + 居中内容列 + 底部居中的常驻状态条。
 * 页面标题不在这里了——顶栏改平后只放工具，标题由各页的 PageHeader 自带。默认进入账号管理。
 */
export function AppShell() {
  const [page, setPage] = useState<PageKey>('accounts');
  const collapsed = useShell((s) => s.collapsed);
  const keyword = useShellSearch((s) => s.keyword);

  // 顶栏那颗搜索框查的是账号台账：一开始输入就跳过去。
  // 用原始 keyword 而不是防抖后的值——停在别的页面敲第一个字符也该有反应。
  useEffect(() => {
    if (keyword.trim()) setPage('accounts');
  }, [keyword]);

  return (
    <div className="app-shell flex h-full" data-nav-collapsed={collapsed}>
      <SideMenu active={page} onNavigate={setPage} />
      <div className="app-canvas flex min-w-0 flex-1 flex-col">
        <TopBar />
        <main className="app-main min-h-0 flex-1 overflow-y-auto">
          <div className="content-inner">
            {page === 'accounts' ? <AccountsPage /> : null}
            {page === 'system' ? <SystemPage /> : null}
            {page === 'launcher' ? <LauncherSettingsPage /> : null}
            {page === 'data' ? <DataPage /> : null}
          </div>
        </main>
        <GlancePanel />
      </div>
      <NotifyHost />
    </div>
  );
}
