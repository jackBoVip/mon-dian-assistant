import { create } from 'zustand';

const DEBOUNCE_MS = 250;

let timer: ReturnType<typeof setTimeout> | undefined;

interface ShellSearchStore {
  /** 原始输入：顶栏逐字符更新，AppShell 用它决定「是否跳回账号管理」。 */
  keyword: string;
  /** 防抖并 trim 后的值：台账查询用它，与搜索框还在页面里时同一节奏。 */
  debouncedKeyword: string;
  setKeyword: (value: string) => void;
  clear: () => void;
}

/**
 * 顶栏搜索的共享状态。原本它是 AccountsPage 的两个本地 state，搜索框搬到顶栏后
 * 顶栏与页面是兄弟（中间隔三层），所以收进 store；防抖也一起搬进来，
 * 测试可直接 setState({ debouncedKeyword }) 注入，不必渲染顶栏。
 */
export const useShellSearch = create<ShellSearchStore>((set) => ({
  keyword: '',
  debouncedKeyword: '',
  setKeyword: (value) => {
    set({ keyword: value });
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => set({ debouncedKeyword: value.trim() }), DEBOUNCE_MS);
  },
  clear: () => {
    if (timer !== undefined) clearTimeout(timer);
    set({ keyword: '', debouncedKeyword: '' });
  },
}));
