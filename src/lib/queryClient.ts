import { MutationCache, QueryCache, QueryClient } from '@tanstack/react-query';
import { ApiError } from './api';
import { useSession } from '../state/session';

export const queryKeys = {
  myPermissions: ['myPermissions'] as const,
  stats: ['stats'] as const,
  targets: (filter: unknown) => ['targets', filter] as const,
  /** 作废整族：增删改目标后，列表页、抽屉、导入导出面板都要重取。
   *  invalidate 走这条前缀，取数走上面那条带 filter 的，两边同源，不会再各写一份字面量。 */
  targetsAll: ['targets'] as const,
  /** 主列表那一族的作废前缀。见下面 invalidateTargetLists 的说明：`['targets']`
   *  **不是** `['targetsPaged', …]` 的前缀，只作废前者时主列表收不到任何重取。 */
  targetsPagedAll: ['targetsPaged'] as const,
  quickSearch: (term: string) => ['quickSearch', term] as const,
  quickSearchAll: ['quickSearch'] as const,
  keystoreDiagnostics: ['keystoreDiagnostics'] as const,
  targetsPaged: (filter: unknown, page: number, pageSize: number) =>
    ['targetsPaged', filter, page, pageSize] as const,
  targetDetail: (id: string) => ['targetDetail', id] as const,
  targetItems: (id: string) => ['targetItems', id] as const,
  itemDetail: (id: string) => ['itemDetail', id] as const,
  deletedItems: ['deletedItems'] as const,
  groups: ['groups'] as const,
  itemTags: ['itemTags'] as const,
  recentAccess: ['recentAccess'] as const,
  similar: (addr: string) => ['similar', addr] as const,
  security: ['security'] as const,
  settings: ['settings'] as const,
  roles: ['roles'] as const,
  rolesAdmin: ['rolesAdmin'] as const,
  permissionsCatalog: ['permissionsCatalog'] as const,
  menuNodes: ['menuNodes'] as const,
  audit: (limit: number) => ['audit', limit] as const,
  backups: ['backups'] as const,
  update: ['update'] as const,
  users: ['users'] as const,
  launcherPrefs: ['launcherPrefs'] as const,
  channelStatus: ['channelStatus'] as const,
  systemInfo: ['systemInfo'] as const,
};

/**
 * 台账"目标列表"有两族取数键，作废必须两族一起发：
 * - `ExportPanel.tsx` 用 `targets({})`（选目标那一栏）
 * - `AccountsPage.tsx` 用 `targetsPaged({}, 1, LIST_LIMIT)`（左栏主列表）
 *
 * react-query 的 `invalidateQueries({ queryKey: ['targets'] })` 只匹配以 `['targets']`
 * 开头的键，**`['targetsPaged', …]` 不在其列**——审查 F5：八个写动作的作废点全部只发了前者，
 * 所以新建/改名/删除系统之后主列表停在旧数据，而 `npm run verify` 三道门一条都不会红
 * （组件测试里 invalidate 的入参没人断言，列表又是 mock 的）。
 * 收敛成一个函数，是为了让这个"两族"事实只存在一处、可被一条测试钉住。
 */
export function invalidateTargetLists(qc: QueryClient): void {
  void qc.invalidateQueries({ queryKey: queryKeys.targetsAll });
  void qc.invalidateQueries({ queryKey: queryKeys.targetsPagedAll });
}

/** 角色、权限、用户角色或状态变更后统一作废这一族：导航、矩阵、用户徽标、角色下拉都要重取。 */
export function invalidateRbac(qc: QueryClient): void {
  for (const queryKey of [
    queryKeys.myPermissions,
    queryKeys.rolesAdmin,
    queryKeys.permissionsCatalog,
    queryKeys.menuNodes,
    queryKeys.roles,
    queryKeys.users,
  ]) {
    void qc.invalidateQueries({ queryKey });
  }
}

/** 会话类错误（锁定/过期/需重认证/后端不可用）会切换全局会话面板。 */
export function propagateSessionError(raw: unknown): void {
  if (raw instanceof ApiError) {
    const code = raw.code;
    if (code === 'SESSION_LOCKED' || code === 'SESSION_EXPIRED' || code === 'REAUTH_REQUIRED' || code === 'NOT_TAURI') {
      useSession.getState().applyAuthError(raw);
    }
  }
}

export function createQueryClient(): QueryClient {
  return new QueryClient({
    queryCache: new QueryCache({ onError: (error) => propagateSessionError(error) }),
    mutationCache: new MutationCache({ onError: (error) => propagateSessionError(error) }),
    defaultOptions: {
      queries: { retry: false, refetchOnWindowFocus: false, staleTime: 15_000 },
      mutations: { retry: false },
    },
  });
}
