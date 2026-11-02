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
  externalTools: ['externalTools'] as const,
  roles: ['roles'] as const,
  rolesAdmin: ['rolesAdmin'] as const,
  permissionsCatalog: ['permissionsCatalog'] as const,
  menuNodes: ['menuNodes'] as const,
  audit: (limit: number) => ['audit', limit] as const,
  backups: ['backups'] as const,
  update: ['update'] as const,
  lan: ['lan'] as const,
  users: ['users'] as const,
  launcherPrefs: ['launcherPrefs'] as const,
  channelStatus: ['channelStatus'] as const,
  systemInfo: ['systemInfo'] as const,
  /** 题库台账整族：发布/重命名/删除后作废。带分页的详情走 quizLibrary(id, …)。 */
  quizLibraries: ['quizLibraries'] as const,
  quizLibrary: (id: string, offset: number, limit: number) => ['quizLibrary', id, offset, limit] as const,
  /** 导入任务整族：复核行编辑、批量操作、发布后都要重取摘要与当前页。 */
  quizImportJob: (id: string, offset: number, limit: number, onlyIssues: boolean) =>
    ['quizImportJob', id, offset, limit, onlyIssues] as const,
  quizAssistantPrefs: ['quizAssistantPrefs'] as const,
  quizAssistantStatus: ['quizAssistantStatus'] as const,
  /** 屏幕录制权限：只在用户点「申请权限」后重取。 */
  quizScreenPermission: ['quizScreenPermission'] as const,
  /** 笔记列表整族：`['notes', q]` 按查询串分键，作废走不带 q 的前缀。 */
  notes: ['notes'] as const,
  notesList: (q: string | null) => ['notes', q] as const,
  /** 单篇正文 + 素材：`['note', id]`；整族作废用前缀 `noteAll`。 */
  note: (id: string) => ['note', id] as const,
  noteAll: ['note'] as const,
  /** 页面库列表：增删改后作废这一族。 */
  htmlPages: ['html-pages'] as const,
  htmlPage: (id: string) => ['html-page', id] as const,
  /** 预览地址按页缓存：端口与令牌随进程变化，重启后自然落空。 */
  htmlPreview: (id: string) => ['html-preview', id] as const,
  /** 任务中心：profile / 绑定 / 会话状态都按「任务 + 环境」分键。 */
  taskProfile: (taskKey: string, env: string) => ['task-profile', taskKey, env] as const,
  taskBinding: (taskKey: string, env: string) => ['task-binding', taskKey, env] as const,
  taskSession: (taskKey: string, env: string) => ['task-session', taskKey, env] as const,
  /** 历史列表一族（按任务+环境分键，作废用不带参数的这条前缀）。 */
  taskRuns: (taskKey: string, env: string) => ['task-runs', taskKey, env] as const,
  taskRunsAll: ['task-runs'] as const,
  /** 一次运行的条目快照与日志：引擎每改一行就广播事件，前端按 runId 作废这两族。 */
  taskRun: (runId: string) => ['task-run', runId] as const,
  taskRunLogs: (runId: string) => ['task-run-logs', runId] as const,
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

/** 题库族：发布、改名、删除、重建索引后统一作废。
 *  助手卡片的「指定题库」多选也吃这份列表，所以连着助手状态一起发。 */
export function invalidateQuizLibraries(qc: QueryClient): void {
  void qc.invalidateQueries({ queryKey: queryKeys.quizLibraries });
  void qc.invalidateQueries({ queryKey: ['quizLibrary'] });
  void qc.invalidateQueries({ queryKey: queryKeys.quizAssistantPrefs });
  void qc.invalidateQueries({ queryKey: queryKeys.quizAssistantStatus });
}

/** 左栏列表：自动保存改了 updatedAt，只要重取摘要，别把正在编辑的那篇正文再拉一遍。 */
export function invalidateNoteList(qc: QueryClient): void {
  void qc.invalidateQueries({ queryKey: queryKeys.notes });
}

/** 笔记族整族：新建、删除、导入后列表与当前详情都要重取。 */
export function invalidateNotes(qc: QueryClient): void {
  invalidateNoteList(qc);
  void qc.invalidateQueries({ queryKey: queryKeys.noteAll });
}

/** 页面库整族：正文改了要重取当前页（`key={updatedAt}` 已换帧，但 DTO 也要新），
 *  删了要让右栏跟着清空。预览地址与内容无关（按 id 定位），不作废。 */
export function invalidateHtmlPages(qc: QueryClient): void {
  void qc.invalidateQueries({ queryKey: queryKeys.htmlPages });
  void qc.invalidateQueries({ queryKey: ['html-page'] });
}

/** 会话类错误（锁定/过期/需重认证/后端不可用）会切换全局会话面板。 */export function propagateSessionError(raw: unknown): void {
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
