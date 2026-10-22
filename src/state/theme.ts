import { create } from 'zustand';
import { api, ApiError } from '../lib/api';
import { applyTheme, systemPreferences, THEME_STYLES, type ThemeState } from '../lib/theme';
import type { ThemeStyle } from '../lib/types';

interface ThemeStore extends ThemeState {
  loaded: boolean;
  load: () => Promise<void>;
  /** 只改本窗口状态并 applyTheme，不落库——系统管理页「保存外观」那条显式保存走的是这个。 */
  setStyle: (style: ThemeStyle) => void;
  /**
   * 选中即生效并落库，一声不吭（交付方口径：不要保存成功/失败提示）。
   * 只发 set_theme：后端允许无会话写入安装级偏好，所以这条不会撞上 SESSION_LOCKED，
   * 也就不需要 persist() 那句"仅本窗口生效"的告知。
   */
  pick: (style: ThemeStyle) => void;
  setReduceMotion: (value: boolean) => void;
  /** 把当前状态写入 DOM；系统"减少动态效果"偏好会叠加生效。 */
  apply: () => void;
  /** 持久化到后端：style 走 set_theme，reduceMotion 走 set_reduce_motion。 */
  persist: () => Promise<void>;
}

const FALLBACK: ThemeState = { style: 'glass', reduceMotion: false };

/** ThemeView 的 style 在 Rust 侧是 String；仅当值在后端合法字面量内才采用，否则回退默认（不伪造）。 */
function asThemeStyle(v: string): ThemeStyle {
  return (THEME_STYLES as string[]).includes(v) ? (v as ThemeStyle) : FALLBACK.style;
}

export const useTheme = create<ThemeStore>((set, get) => ({
  ...FALLBACK,
  loaded: false,

  load: async () => {
    try {
      const t = await api.theme();
      set({ style: asThemeStyle(t.style), reduceMotion: t.reduceMotion, loaded: true });
    } catch {
      set({ loaded: true });
    }
    get().apply();
  },

  setStyle: (style) => {
    set({ style });
    get().apply();
  },

  pick: (style) => {
    get().setStyle(style);
    // 交付方点名不要成功/失败提示，所以这里吞掉拒绝：本窗口的外观确实已经变了，重开时以后端那份为准。
    void api.setTheme(style).catch(() => {});
  },
  setReduceMotion: (value) => {
    set({ reduceMotion: value });
    get().apply();
  },

  apply: () => {
    if (typeof document === 'undefined') return;
    const s = get();
    applyTheme(document.documentElement, { style: s.style, reduceMotion: s.reduceMotion }, systemPreferences());
  },

  persist: async () => {
    const s = get();
    try {
      await api.setTheme(s.style);
      await api.setReduceMotion(s.reduceMotion);
    } catch (raw) {
      // 后端 set_reduce_motion 要求已解锁会话：如实说明，不伪造"已保存"
      if (raw instanceof ApiError && raw.code === 'SESSION_LOCKED') {
        throw new ApiError({
          code: raw.code,
          message: '外观需解锁后才能保存到后端：当前更改仅在本窗口即时生效。',
        });
      }
      throw raw;
    }
  },
}));
