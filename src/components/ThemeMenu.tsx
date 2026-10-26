import { useTheme } from '../state/theme';
import { THEME_STYLES } from '../lib/theme';
import { customThemeStyle, type ThemeStyle } from '../lib/types';
import { ThemeSwatch, themeLabel } from './ui/ThemeSwatch';
import { DropdownRadioGroup, DropdownRadioItem, Menu } from './ui/dropdown-menu';

/**
 * 顶栏「切换界面风格」下拉：内置四套 + 用户自己新增的那些，每项一枚色块名片 + 当前项打勾。
 *
 * 与 AppearanceSection 共用同一个 store，不复用那个组件——它自带 .panel 外壳与保存按钮，
 * 塞进几行高的下拉菜单里会顶开整块面板。
 * 点一套就走 `store.pick`：即时 applyTheme + 只发 set_theme 落库，没有"保存"这一行，
 * 也不弹成功/失败提示（交付方口径）。菜单点了不收，为的是能连着比几套——
 * 这一条现在是 Radix RadioItem 的默认行为（单选档不自动关菜单），不再需要手写拦截。
 */
export function ThemeMenu() {
  /** 只订阅画这张菜单要用的三样：顶栏常驻，reduceMotion 的翻转不该重画这份菜单。 */
  const style = useTheme((s) => s.style);
  const custom = useTheme((s) => s.custom);
  const styles: ThemeStyle[] = [...THEME_STYLES, ...custom.map((t) => customThemeStyle(t.id))];

  return (
    <Menu label="切换界面风格" icon="palette" panelClassName="theme-panel">
      <div className="theme-panel-label">界面风格</div>
      <DropdownRadioGroup value={style} onValueChange={(v) => useTheme.getState().pick(v as ThemeStyle)}>
        {styles.map((s) => (
          <DropdownRadioItem key={s} value={s}>
            <ThemeSwatch style={s} custom={custom} />
            {themeLabel(s, custom)}
          </DropdownRadioItem>
        ))}
      </DropdownRadioGroup>
    </Menu>
  );
}
