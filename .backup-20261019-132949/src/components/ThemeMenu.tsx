import type { ReactNode } from 'react';
import { useTheme } from '../state/theme';
import { THEME_LABELS, type ThemeStyle } from '../lib/types';
import { Popover } from './ui/Popover';
import { Icon } from './ui/Icon';

/**
 * 顶栏「切换界面风格」下拉：原型那四套主题，每项一枚色块名片 + 当前项打勾。
 *
 * 与 AppearanceSection 共用同一个 store，不复用那个组件——它自带 .panel 外壳与保存按钮，
 * 塞进几行高的下拉菜单里会顶开整块面板。
 * 点一套就走 `store.pick`：即时 applyTheme + 只发 set_theme 落库，没有"保存"这一行，
 * 也不弹成功/失败提示（交付方口径）。菜单点了不收，为的是能连着比几套。
 */
export function ThemeMenu() {
  const t = useTheme();
  const styles = Object.keys(THEME_LABELS) as ThemeStyle[];

  return (
    <Popover label="切换界面风格" icon="palette" panelClassName="theme-panel">
      <div className="theme-panel-label">界面风格</div>
      {styles.map((s) => (
        <ThemeOption key={s} active={t.style === s} onPick={() => t.pick(s)}>
          <span className="theme-preview" data-preview={s} aria-hidden />
          {THEME_LABELS[s]}
        </ThemeOption>
      ))}
    </Popover>
  );
}

function ThemeOption({
  active,
  onPick,
  children,
}: {
  active: boolean;
  onPick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={active}
      onClick={onPick}
      className="dropdown-item theme-option"
    >
      <span className="theme-option-left">{children}</span>
      <span className="check-icon" aria-hidden>
        {active ? <Icon name="check" size={16} /> : null}
      </span>
    </button>
  );
}
