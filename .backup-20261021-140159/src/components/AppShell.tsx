import { useEffect, useMemo, useState } from 'react';
import { TopBar } from './TopBar';
import { AccountsPage } from '../pages/AccountsPage';
import { AdminPage } from '../pages/AdminPage';
import { SettingsPage } from '../pages/SettingsPage';
import { LauncherSettingsPage } from '../pages/LauncherSettingsPage';
import { DataPage } from '../pages/DataPage';
import { AdminSidebar } from './admin/AdminSidebar';
import { NotifyHost } from './ui/sonner';
import { Loading, ErrorState } from './ui/StateBlocks';
import { useBackendEventPayload } from '../lib/vaultEvents';
import { useLauncherNav, type LauncherNavPayload } from '../state/launcherNav';
import { useMyPermissions, permissionSet } from '../lib/permissions';
import {
  firstAllowedPage,
  isAdminPage,
  isPageAllowed,
  isSettingsPage,
  type AdminPageKey,
  type PageKey,
} from '../lib/pageMeta';

/**
 * 主窗口壳层：满幅的玻璃容器（内容与窗口边缘齐平）。
 *
 * 三层从外到内：body 上铺的光斑（fixed，z-index -1）→ .app-container（玻璃面 + 模糊）
 * → 顶栏 + 内容列。系统管理下多一列左侧竖排导航，设置页与其余页面都是单栏。
 *
 * 权限未取回前内容区只给读取态：先把必然越权的那一页渲染一帧、再发出必然失败的请求，
 * 是审查里明确不接受的做法。权限变化后 effectivePage 同步回退到第一项可用页，
 * useEffect 只负责把 state 跟上，不承担"先渲染再纠正"的职责。
 */
export function AppShell() {
  const permsQuery = useMyPermissions();
  const perms = useMemo(() => permissionSet(permsQuery.data), [permsQuery.data]);
  const [page, setPage] = useState<PageKey>('accounts');
  const [lastAdminPage, setLastAdminPage] = useState<AdminPageKey | null>(null);

  function navigate(next: PageKey) {
    setPage(next);
    if (isAdminPage(next)) setLastAdminPage(next);
  }

  const effectivePage =
    permsQuery.data === undefined
      ? page
      : isPageAllowed(page, perms)
        ? page
        : firstAllowedPage(perms);

  useEffect(() => {
    if (permsQuery.data === undefined) return;
    if (!isPageAllowed(page, perms)) {
      const next = firstAllowedPage(perms);
      setPage(next);
      if (isAdminPage(next)) setLastAdminPage(next);
    }
  }, [page, perms, permsQuery.data]);

  /**
   * 浮层里点「查看详情」时，Rust 已经把浮层收起、把这一扇窗带到前台了，
   * 剩下的一步是"落到账号中心并记下要看哪一条"——具体选中由 AccountsPage 消费 store 完成。
   * 事件名与载荷键名两侧同源，判据在 src/lib/ipcContract.test.ts。
   */
  useBackendEventPayload<LauncherNavPayload>('launcher://open-detail', (payload) => {
    setPage('accounts');
    useLauncherNav.getState().open(payload);
  });

  function content() {
    if (isAdminPage(effectivePage)) {
      return (
        <div className="admin-shell">
          <AdminSidebar active={effectivePage} perms={perms} onNavigate={navigate} />
          <AdminPage section={effectivePage} />
        </div>
      );
    }
    if (isSettingsPage(effectivePage)) return <SettingsPage section={effectivePage} />;
    if (effectivePage === 'accounts') return <AccountsPage />;
    if (effectivePage === 'launcher') return <LauncherSettingsPage />;
    return <DataPage />;
  }

  return (
    <div className="app-root">
      <div className="bg-blobs" aria-hidden>
        <span className="blob blob-1" />
        <span className="blob blob-2" />
        <span className="blob blob-3" />
      </div>

      <div className="app-container">
        <TopBar active={effectivePage} lastAdminPage={lastAdminPage} onNavigate={navigate} />
        <main className="main-content">
          <div className="content-layout">
            {permsQuery.isLoading ? (
              <div className="page-panel">
                <Loading label="读取当前使用者的权限…" />
              </div>
            ) : permsQuery.isError ? (
              <div className="page-panel">
                <ErrorState raw={permsQuery.error} onRetry={() => void permsQuery.refetch()} />
              </div>
            ) : (
              content()
            )}
          </div>
        </main>
      </div>

      <NotifyHost />
    </div>
  );
}
