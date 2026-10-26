import { useQuery } from '@tanstack/react-query';
import { api } from './api';
import { queryKeys } from './queryClient';

/**
 * 权限键的唯一真源。值与 `src-tauri/src/rbac/mod.rs` 的 `perm` 常量逐字一致，
 * 守卫在 `rbacContract.test.ts` 里从这张表反向检查 Rust 侧。
 */
export const PERM = {
  MENU_ACCOUNTS: 'menu.accounts',
  MENU_SYSTEM: 'menu.system',
  MENU_QUICK_LAUNCHER: 'menu.quick_launcher',
  /** 权限管理页自己的二级入口；其余菜单键由 list_menu_nodes 的 permKey 下发。 */
  MENU_NODE_PERMISSIONS: 'menu.node.system.permissions',
  SYS_USER_READ: 'system.user.read',
  SYS_USER_MANAGE: 'system.user.manage',
  SYS_ROLE_MANAGE: 'system.role.manage',
  SYS_SECURITY_CONFIG: 'system.security.config',
  SYS_AUDIT_READ: 'system.audit.read',
  SYS_BACKUP_MANAGE: 'system.backup.manage',
  SYS_UPDATE_CONFIG: 'system.update.config',
  SYS_UPDATE_INSTALL: 'system.update.install',
  SYS_UPDATE_SERVE: 'system.update.serve',
} as const;

export type PermKey = (typeof PERM)[keyof typeof PERM];

/** 当前使用者全部权限（菜单 + 操作）。导航、按钮显隐都只从这里取，不散落字面量。 */
export function useMyPermissions() {
  return useQuery({ queryKey: queryKeys.myPermissions, queryFn: () => api.myPermissions() });
}

export function permissionSet(keys: readonly string[] | undefined): ReadonlySet<string> {
  return new Set(keys ?? []);
}

export function has(perms: ReadonlySet<string> | null | undefined, key: string): boolean {
  return !!perms && perms.has(key);
}

/** 全部满足才为真：菜单入口与页面内的写按钮都按这个口径裁剪。 */
export function allows(perms: ReadonlySet<string> | null | undefined, requires: readonly string[]): boolean {
  return !!perms && requires.every((key) => perms.has(key));
}
