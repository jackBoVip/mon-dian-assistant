import { create } from 'zustand';
import { api, ApiError } from '../lib/api';
import { applyTheme, syncCustomThemeStyles, systemPreferences, THEME_STYLES, type ThemeState } from '../lib/theme';
import { customThemeId, customThemeStyle, type CustomTheme, type ThemeStyle } from '../lib/types';

interface ThemeStore extends ThemeState {
  loaded: boolean;
  /** 用户自己新增的主题档（0012 起）。CSS 由这些行运行时注入，不在 tokens.css 里。 */
  custom: CustomTheme[];
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
  /** 新增一档自定义主题。tokens 是**已在前端逐枚校验过**的扁平对象，后端还会再校一遍。 */
  addTheme: (id: string, name: string, tokens: Record<string, string>) => Promise<void>;
  /** 删一档：正选用它时后端会把偏好归回 glass，这里同步归回，不让界面停在取不到 CSS 的档上。 */
  removeTheme: (id: string) => Promise<void>;
  /** 把当前状态写入 DOM；自定义主题的规则先注入，再改 data-theme；系统"减少动态效果"叠加生效。 */
  apply: () => void;
  /** 持久化到后端：style 走 set_theme，reduceMotion 走 set_reduce_motion。 */
  persist: () => Promise<void>;
}

const FALLBACK: ThemeState = { style: 'glass', reduceMotion: false };

/**
 * 后端返回的 style 只有两种可能才算可用：内置四套之一，或表里真的存在的 `custom-<id>`。
 * 其余（旧库残留、主题已被删）一律回退默认档——留一个没有对应 CSS 的名字，
 * 等于整套 var() 取不到值，界面会退回浏览器默认色。
 */
function asThemeStyle(v: string, custom: CustomTheme[]): ThemeStyle {
  if ((THEME_STYLES as string[]).includes(v)) return v as ThemeStyle;
  const id = customThemeId(v);
  return id && custom.some((t) => t.id === id) ? (v as ThemeStyle) : FALLBACK.style;
}

export const useTheme = create<ThemeStore>((set, get) => ({
  ...FALLBACK,
  custom: [],
  loaded: false,

  load: async () => {
    let custom: CustomTheme[] = [];
    try {
      // 两件事一起取：没注入 CSS 就切到自定义档，那一屏会先闪一下默认色
      const [t, themes] = await Promise.all([api.theme(), api.customThemes().catch(() => [] as CustomTheme[])]);
      custom = themes;
      set({ custom, style: asThemeStyle(t.style, themes), reduceMotion: t.reduceMotion, loaded: true });
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

  addTheme: async (id, name, tokens) => {
    await api.addCustomTheme(id, name, JSON.stringify(tokens));
    set({ custom: await api.customThemes() });
  },

  removeTheme: async (id) => {
    await api.deleteCustomTheme(id);
    const custom = await api.customThemes();
    const wasCurrent = get().style === customThemeStyle(id);
    set({ custom, ...(wasCurrent ? { style: 'glass' as ThemeStyle } : {}) });
    get().apply();
  },

  apply: () => {
    if (typeof document === 'undefined') return;
    const s = get();
    syncCustomThemeStyles(document, s.custom);
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
