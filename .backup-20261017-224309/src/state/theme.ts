import { create } from 'zustand';
import { api, ApiError } from '../lib/api';
import { applyTheme, clampIntensity, systemPreferences, THEME_STYLES, APPEARANCE_MODES, type ThemeState } from '../lib/theme';
import type { AppearanceMode, ThemeStyle } from '../lib/types';

interface ThemeStore extends ThemeState {
  loaded: boolean;
  load: () => Promise<void>;
  setStyle: (style: ThemeStyle) => void;
  setMode: (mode: AppearanceMode) => void;
  setGlassIntensity: (value: number) => void;
  setReduceMotion: (value: boolean) => void;
  /** 把当前状态写入 DOM；玻璃主题会依据系统"减少透明度"偏好自动降级。 */
  apply: () => void;
  /** 持久化到后端：style/mode/glassIntensity 走 set_theme，reduceMotion 走 set_reduce_motion。 */
  persist: () => Promise<void>;
  /**
   * 只写安装级外观偏好（style/mode/glassIntensity），不碰需要会话的 reduceMotion。
   * 认证页没有会话，那里的主题切换器要的是这一条：Rust 侧 set_theme 允许无会话写入，
   * 而 persist() 顺带发出的 set_reduce_motion 会被挡成 SESSION_LOCKED。
   */
  persistInstall: () => Promise<void>;
}

const FALLBACK: ThemeState = {
  style: 'enterprise-blue',
  mode: 'system',
  glassIntensity: 60,
  reduceMotion: false,
};

/** ThemeView 的 style/mode 在 Rust 侧是 String；仅当值在后端合法字面量内才采用，否则回退默认（不伪造）。 */
function asThemeStyle(v: string): ThemeStyle {
  return (THEME_STYLES as string[]).includes(v) ? (v as ThemeStyle) : FALLBACK.style;
}
function asAppearanceMode(v: string): AppearanceMode {
  return (APPEARANCE_MODES as string[]).includes(v) ? (v as AppearanceMode) : FALLBACK.mode;
}

export const useTheme = create<ThemeStore>((set, get) => ({
  ...FALLBACK,
  loaded: false,

  load: async () => {
    try {
      const t = await api.theme();
      set({
        style: asThemeStyle(t.style),
        mode: asAppearanceMode(t.mode),
        glassIntensity: clampIntensity(t.glassIntensity),
        reduceMotion: t.reduceMotion,
        loaded: true,
      });
    } catch {
      set({ loaded: true });
    }
    get().apply();
  },

  setStyle: (style) => {
    set({ style });
    get().apply();
  },
  setMode: (mode) => {
    set({ mode });
    get().apply();
  },
  setGlassIntensity: (value) => {
    set({ glassIntensity: clampIntensity(value) });
    get().apply();
  },
  setReduceMotion: (value) => {
    set({ reduceMotion: value });
    get().apply();
  },

  apply: () => {
    if (typeof document === 'undefined') return;
    const s = get();
    applyTheme(document.documentElement, { style: s.style, mode: s.mode, glassIntensity: s.glassIntensity, reduceMotion: s.reduceMotion }, systemPreferences());
  },

  persist: async () => {
    const s = get();
    try {
      await api.setTheme(s.style, s.mode, s.glassIntensity);
      await api.setReduceMotion(s.reduceMotion);
    } catch (raw) {
      // 后端 set_theme/set_reduce_motion 要求已解锁会话：如实说明，不伪造"已保存"
      if (raw instanceof ApiError && raw.code === 'SESSION_LOCKED') {
        throw new ApiError({
          code: raw.code,
          message: '外观需解锁后才能保存到后端：当前更改仅在本窗口即时生效。',
        });
      }
      throw raw;
    }
  },

  persistInstall: async () => {
    const s = get();
    await api.setTheme(s.style, s.mode, s.glassIntensity);
  },
}));
