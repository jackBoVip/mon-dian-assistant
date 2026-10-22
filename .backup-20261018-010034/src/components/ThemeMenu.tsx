import { useEffect, useId, type ReactNode } from 'react';
import { useTheme } from '../state/theme';
import { APPEARANCE_MODES, resolveMode, systemPreferences } from '../lib/theme';
import { THEME_LABELS, type AppearanceMode, type ThemeStyle } from '../lib/types';
import { notify } from '../state/notify';
import { toNormalisedError } from '../lib/errors';
import { Popover } from './ui/Popover';
import { Icon } from './ui/Icon';

const MODE_LABELS: Record<AppearanceMode, string> = { system: '跟随系统', light: '浅色', dark: '深色' };

/**
 * 玻璃强度在顶栏只有三档预设。完整 0–100 滑杆在系统管理 → 外观设置，两处写的是同一个
 * glassIntensity，所以这里只把常用三档做成菜单项；当前值不在档位上时没有一项被打勾，
 * 组标题如实显示"当前 N%"，不假装它等于最近的那档。
 */
const GLASS_PRESETS = [
  { value: 0, label: '关闭' },
  { value: 60, label: '半透明' },
  { value: 100, label: '满' },
] as const;

function Group({ title, children }: { title: string; children: ReactNode }) {
  const id = useId();
  return (
    <div role="group" aria-labelledby={id} className="menu-group">
      <div id={id} className="menu-label">
        {title}
      </div>
      {children}
    </div>
  );
}

function RadioItem({
  checked,
  onPick,
  children,
}: {
  checked: boolean;
  onPick: () => void;
  children: ReactNode;
}) {
  return (
    <button type="button" role="menuitemradio" aria-checked={checked} onClick={onPick} className="menu-item">
      <span className="menu-item-mark" aria-hidden>
        {checked ? <Icon name="check" size={14} /> : null}
      </span>
      <span className="menu-item-text">{children}</span>
    </button>
  );
}

/**
 * 顶栏主题菜单：单列下拉菜单（8 枚风格 + 明暗三档 + 玻璃三档预设 + 保存）。
 *
 * 复用 AppearanceSection 的状态与判定，不复用它那个组件——它自带 `.panel` 外壳与
 * 「保存外观」。改动即时 applyTheme（与那一页一致），落库要人显式点保存：后端 set_theme
 * 需要已解锁会话，锁着时 persist() 抛 SESSION_LOCKED，这里如实转成 notify，不报「已保存」。
 * 「减少动态效果」不在这个菜单里（它要经后端 set_reduce_motion 落库，仍在系统管理页）。
 */
export function ThemeMenu() {
  const t = useTheme();

  useEffect(() => {
    if (!t.loaded) void t.load();
  }, [t]);

  const styles = Object.keys(THEME_LABELS) as ThemeStyle[];
  const resolved = resolveMode(t.mode, systemPreferences().prefersDark);

  function save() {
    void t.persist().then(
      () => notify('success', '外观已保存并即时生效'),
      (raw) => notify('danger', toNormalisedError(raw).message),
    );
  }

  return (
    <Popover label="主题与外观" icon={resolved === 'light' ? 'sun' : 'moon'}>
      <Group title="主题风格">
        {styles.map((s) => (
          <RadioItem key={s} checked={t.style === s} onPick={() => t.setStyle(s)}>
            {THEME_LABELS[s]}
          </RadioItem>
        ))}
      </Group>

      <Group title="外观模式">
        {APPEARANCE_MODES.map((m) => (
          <RadioItem key={m} checked={t.mode === m} onPick={() => t.setMode(m)}>
            {MODE_LABELS[m]}
          </RadioItem>
        ))}
      </Group>

      <Group title={`玻璃效果强度 · 当前 ${t.glassIntensity}%（仅玻璃主题生效）`}>
        {GLASS_PRESETS.map((p) => (
          <RadioItem key={p.value} checked={t.glassIntensity === p.value} onPick={() => t.setGlassIntensity(p.value)}>
            {p.label}
          </RadioItem>
        ))}
      </Group>

      <div className="menu-divider" role="separator" aria-orientation="horizontal" />

      <button type="button" role="menuitem" data-menu-dismiss onClick={save} className="menu-item menu-item--action">
        <span className="menu-item-mark" aria-hidden />
        <span className="menu-item-text">保存外观</span>
      </button>
    </Popover>
  );
}
