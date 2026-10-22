import { create } from 'zustand';

interface ShellStore {
  /** 侧栏收起成 64px 图标轨。放在 store 而不是组件里，切页时不会重置这个选择。 */
  collapsed: boolean;
  toggleCollapsed: () => void;
}

/** 壳层偏好（当前只有侧栏折叠）。只在内存，不落后端：后端 update_setting 是管理员白名单。 */
export const useShell = create<ShellStore>((set) => ({
  collapsed: false,
  toggleCollapsed: () => set((s) => ({ collapsed: !s.collapsed })),
}));
