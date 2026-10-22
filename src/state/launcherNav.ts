import { create } from 'zustand';

/**
 * 浮层「查看详情」交到主窗的那一条。
 *
 * 为什么是一个 store 而不是 props：发起方是 Rust（`commands/launcher.rs::reveal_in_main` 发
 * `launcher://open-detail`），落点在 `AppShell` 那一层，而真正知道"怎么把一个系统变成选中项、
 * 怎么把关键字填进右栏筛选"的是 `AccountsPage`。中间隔着页面切换，用 props 传等于要给每一层
 * 加一根透传管道；这里就一枚待办导航，一个极小的 store 更诚实。
 *
 * 键名是跨窗契约的一半（另一半是 Rust 侧的 `detail_nav_payload`）：
 * 两侧同源由 `src/lib/ipcContract.test.ts` 比字面量钉住。
 */
export interface LauncherNavPayload {
  targetId: string;
  itemId: string;
  /**
   * 落到右栏筛选框里的关键字，值是**那一条凭据的别名**。
   * 不是浮层里那次搜索的原串：原串可能命中的是系统名/地址/标签，而右栏只匹配别名与脱敏用户名，
   * 搬原串过去大概率筛出一张空表。
   */
  keyword: string;
}

interface LauncherNavState {
  /** 等着被某一页消费的那一条；消费完必须清空，否则下次进这一页还会被它拽走。 */
  pending: LauncherNavPayload | null;
  open: (payload: LauncherNavPayload) => void;
  clear: () => void;
}

export const useLauncherNav = create<LauncherNavState>((set) => ({
  pending: null,
  open: (payload) => set({ pending: payload }),
  clear: () => set({ pending: null }),
}));
