import { THEME_STYLES, customThemeTokens } from '../../lib/theme';
import { BUILTIN_THEME_LABELS, type CustomTheme, type ThemeStyle } from '../../lib/types';

/**
 * 一档主题的色块名片：一眼看出那套长什么样。
 *
 * 内置四套走 tokens.css 里那四条 `[data-preview=…]`（色块值是逐套钉死的渐变）；
 * 自定义档没有编译期的那一档，就用**它自己的令牌**画一块两色斜分——背景色 + 主色，
 * 这两个值都是过完白名单与字面校验才到这里的（见 lib/themeTokens.ts）。
 */
export function ThemeSwatch({ style, custom }: { style: ThemeStyle; custom: CustomTheme[] }) {
  if ((THEME_STYLES as string[]).includes(style)) {
    return <span className="theme-preview" data-preview={style} aria-hidden />;
  }
  const tokens = customThemeTokens(custom, style);
  const bg = tokens?.['--t-bg'] ?? 'var(--t-bg)';
  const primary = tokens?.['--t-primary'] ?? 'var(--t-primary)';
  return (
    <span
      className="theme-preview"
      aria-hidden
      style={{ background: `linear-gradient(135deg, ${bg} 0 50%, ${primary} 50% 100%)` }}
    />
  );
}

/** 一档主题在界面上叫什么：内置四套是固定文案，自定义档是用户起的名。 */
export function themeLabel(style: ThemeStyle, custom: CustomTheme[]): string {
  if ((THEME_STYLES as string[]).includes(style)) return BUILTIN_THEME_LABELS[style as keyof typeof BUILTIN_THEME_LABELS];
  return custom.find((t) => `custom-${t.id}` === style)?.name ?? style;
}
