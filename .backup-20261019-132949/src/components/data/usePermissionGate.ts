import { useQuery, type QueryKey } from '@tanstack/react-query';
import { AUTH_PANEL_BY_CODE, toNormalisedError } from '../../lib/errors';

/**
 * 导入/导出权限门：前端不自行判定权限，只以后端命令的真实回包分流呈现。
 * 探针即真实命令调用（后端 rbac::require 先于任何文件/数据操作执行）：
 *  - FORBIDDEN          → 当前使用者缺少 accounts.import / accounts.export，呈现「无权限」；
 *  - 其它业务错误码（如 INVALID_INPUT）→ 说明 RBAC 已通过，判定为有权限；
 *  - 会话类错误码（锁定/过期/需重认证/不可用）照常上抛，由全局 queryClient 分流到会话面板。
 */
export type PermissionGate =
  | { status: 'checking' }
  | { status: 'allowed' }
  | { status: 'denied'; message: string; retry: () => void }
  | { status: 'error'; code: string; message: string; detail?: string; retry: () => void };

export function usePermissionGate(queryKey: QueryKey, probe: () => Promise<unknown>): PermissionGate {
  const q = useQuery({
    queryKey,
    queryFn: async () => {
      try {
        await probe();
        return 'allowed' as const;
      } catch (raw) {
        const err = toNormalisedError(raw);
        if (err.code === 'FORBIDDEN') return 'denied' as const;
        if (err.code === 'NOT_TAURI' || AUTH_PANEL_BY_CODE[err.code]) throw raw;
        return 'allowed' as const;
      }
    },
    staleTime: Infinity,
  });

  if (q.isLoading) return { status: 'checking' };
  if (q.isError) {
    const err = toNormalisedError(q.error);
    return {
      status: 'error',
      code: err.code,
      message: err.message,
      detail: err.detail,
      retry: () => void q.refetch(),
    };
  }
  if (q.data === 'denied') {
    return {
      status: 'denied',
      message: '后端拒绝：当前使用者没有该项权限（FORBIDDEN）。请联系系统管理员为你的角色授予对应权限。',
      retry: () => void q.refetch(),
    };
  }
  return { status: 'allowed' };
}
