import { MutationCache, QueryCache, QueryClient } from '@tanstack/react-query';
import { ApiError } from './api';
import { useSession } from '../state/session';

export const queryKeys = {
  menus: ['menus'] as const,
  stats: ['stats'] as const,
  targets: (filter: unknown) => ['targets', filter] as const,
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
  audit: (limit: number) => ['audit', limit] as const,
  backups: ['backups'] as const,
  update: ['update'] as const,
  users: ['users'] as const,
  launcherPrefs: ['launcherPrefs'] as const,
  channelStatus: ['channelStatus'] as const,
  systemInfo: ['systemInfo'] as const,
};

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
