import { useTheme } from '../state/theme';
import { THEME_LABELS, type ThemeStyle } from '../lib/types';
import { DropdownRadioGroup, DropdownRadioItem, Menu } from './ui/dropdown-menu';

/**
 * 顶栏「切换界面风格」下拉：原型那四套主题，每项一枚色块名片 + 当前项打勾。
 *
 * 与 AppearanceSection 共用同一个 store，不复用那个组件——它自带 .panel 外壳与保存按钮，
 * 塞进几行高的下拉菜单里会顶开整块面板。
 * 点一套就走 `store.pick`：即时 applyTheme + 只发 set_theme 落库，没有"保存"这一行，
 * 也不弹成功/失败提示（交付方口径）。菜单点了不收，为的是能连着比几套——
 * 这一条现在是 Radix RadioItem 的默认行为（单选档不自动关菜单），不再需要手写拦截。
 */
export function ThemeMenu() {
  /** 只订阅 style：顶栏常驻，reduceMotion / loaded 的翻转不该重画这份菜单。 */
  const style = useTheme((s) => s.style);
  const styles = Object.keys(THEME_LABELS) as ThemeStyle[];

  return (
    <Menu label="切换界面风格" icon="palette" panelClassName="theme-panel">
      <div className="theme-panel-label">界面风格</div>
      <DropdownRadioGroup value={style} onValueChange={(v) => useTheme.getState().pick(v as ThemeStyle)}>
        {styles.map((s) => (
          <DropdownRadioItem key={s} value={s}>
            <span className="theme-preview" data-preview={s} aria-hidden />
            {THEME_LABELS[s]}
          </DropdownRadioItem>
        ))}
      </DropdownRadioGroup>
    </Menu>
  );
}
