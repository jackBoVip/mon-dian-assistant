import { create } from 'zustand';
import { api, ApiError } from '../lib/api';
import { applyTheme, customThemeRulePresent, syncCustomThemeStyles, systemPreferences, THEME_STYLES, type ThemeState } from '../lib/theme';
import { customThemeId, customThemeStyle, type CustomTheme, type ThemeStyle } from '../lib/types';
import { notify } from './notify';

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
 * 读取失败只说一次。浮层每次唤起都会 `load()`，后端锁着或一时不可达时，
 * 不做这枚闸门就会每次弹一条"外观没取到"——提示一次是告知，每次都弹是噪音。
 */
let loadFailureNotified = false;

/** 自定义样式注入失败同样只说一次（`apply()` 每次唤起窗口都会走一遍）。 */
let injectFailureNotified = false;

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
    // 单独记这一次列表请求是不是真没成：`catch(()=>[])` 把"取失败"和"确实一档自定义都没有"
    // 洗成同一个值，正是这条静默回退能藏这么久的原因（2026-11-20 Win10 报障复盘）。
    let listFailed = false;
    try {
      // 两件事一起取：没注入 CSS 就切到自定义档，那一屏会先闪一下默认色
      const [t, themes] = await Promise.all([
        api.theme(),
        api.customThemes().catch(() => {
          listFailed = true;
          return [] as CustomTheme[];
        }),
      ]);
      custom = themes;
      const resolved = asThemeStyle(t.style, themes);
      set({ custom, style: resolved, reduceMotion: t.reduceMotion, loaded: true });
      // 回退要说得出是哪种回退：用户看到的是"我选的主题没生效"，
      // 而真相可能是那次列表请求根本没成、或那一档确实已被删除。
      if (resolved !== t.style && customThemeId(t.style)) {
        notify(
          'warning',
          listFailed
            ? '自定义主题列表没取到，本次先用默认外观；重开或稍后再读会恢复。'
            : '原先选用的自定义主题已不存在（可能被删除），已回退默认外观。',
        );
      }
    } catch {
      set({ loaded: true });
      if (!loadFailureNotified) {
        loadFailureNotified = true;
        notify('warning', '外观设置这次没读到，界面按默认外观显示；后端那份没有改变。');
      }
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
    // 注入没成就不能把 data-theme 留在 custom-*：那一档压根没有对应 CSS 块，整套令牌
    // 取不到值 → 底色落 initial（透明）、文字落 inherit。回退默认档并说一声，
    // 比"停在一张读不出颜色的屏上"诚实。只说一次：apply 在每次唤起都会走。
    if (customThemeId(s.style) && !customThemeRulePresent(document, s.style)) {
      set({ style: FALLBACK.style });
      if (!injectFailureNotified) {
        injectFailureNotified = true;
        notify('warning', '自定义主题的样式没能注入（令牌不完整），本次按默认外观显示。');
      }
    }
    const now = get();
    applyTheme(document.documentElement, { style: now.style, reduceMotion: now.reduceMotion }, systemPreferences());
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
