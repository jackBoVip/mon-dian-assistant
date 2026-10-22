import { create } from 'zustand';

interface GlanceStore {
  /** 常驻面板默认收起：内容区是主角，面板只在需要时展开成一叠最近访问 */
  collapsed: boolean;
  toggle: () => void;
}

/** 「此刻」面板的展开/收起状态。放在 store 而不是组件里，切页时不会重置折叠选择。 */
export const useGlance = create<GlanceStore>((set) => ({
  collapsed: true,
  toggle: () => set((s) => ({ collapsed: !s.collapsed })),
}));
