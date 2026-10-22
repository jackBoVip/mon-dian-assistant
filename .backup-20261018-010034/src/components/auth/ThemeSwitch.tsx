import { useRef, type CSSProperties, type KeyboardEvent } from 'react';
import { useTheme } from '../../state/theme';
import { resolveMode, systemPreferences } from '../../lib/theme';
import { notify } from '../../state/notify';
import { toNormalisedError } from '../../lib/errors';
import { Icon } from '../ui/Icon';
import type { IconName } from '../ui/icons';

/**
 * 认证页右上角的三档切换（照原型：绿 / 浅 / 深）。
 *
 * 三档落在本仓库既有的两个维度上，且**每档占一个互斥的落位**（原型也是三个完整主题）：
 * 0 = power-grid-green + 深色；1 = 保持当前主题风格、外观切浅色；2 = 外观切深色，
 * 若当前是绿色那套就换掉风格——否则第 2 档与第 0 档的 (style, mode) 完全相同，
 * 点"深色"会把滑块留在原位、aria-checked 也不动，看着像没响应。
 * 所以反推落位先看明暗（浅色只可能是第 1 档），再看是不是绿色那套。
 * 非原型那三套主题的使用者按浅/深仍是调自己那套主题的明暗。
 */
const SCENES: Array<{ icon: IconName; label: string; title: string }> = [
  { icon: 'zap', label: '内蒙古电力绿色主题', title: '绿色主题' },
  { icon: 'sun', label: '浅色主题', title: '浅色主题' },
  { icon: 'moon', label: '深色主题', title: '深色主题' },
];

export function ThemeSwitch() {
  const style = useTheme((s) => s.style);
  const mode = useTheme((s) => s.mode);
  const setStyle = useTheme((s) => s.setStyle);
  const setMode = useTheme((s) => s.setMode);
  const persistInstall = useTheme((s) => s.persistInstall);
  const groupRef = useRef<HTMLDivElement>(null);

  const resolved = resolveMode(mode, systemPreferences().prefersDark);
  const active = resolved === 'light' ? 1 : style === 'power-grid-green' ? 0 : 2;

  function choose(next: number) {
    if (next === 0) {
      setStyle('power-grid-green');
      setMode('dark');
    } else {
      if (next === 2 && style === 'power-grid-green') setStyle('graphite-dark');
      setMode(next === 1 ? 'light' : 'dark');
    }
    // 即时生效在前，落库在后：后端没答应，界面不会说"已保存"，但这一窗口内的外观确实已经变了。
    void persistInstall().catch((raw) => notify('danger', toNormalisedError(raw).message));
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowDown' && e.key !== 'ArrowLeft' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : -1;
    const next = (active + step + SCENES.length) % SCENES.length;
    choose(next);
    groupRef.current?.querySelectorAll<HTMLButtonElement>('.theme-btn')[next]?.focus();
  }

  return (
    <div
      ref={groupRef}
      className="theme-switch"
      role="radiogroup"
      aria-label="主题切换"
      style={{ '--scene-switch-index': active } as CSSProperties}
      onKeyDown={onKeyDown}
    >
      <span className="theme-switch__slider" aria-hidden />
      {SCENES.map((s, i) => (
        <button
          key={s.title}
          type="button"
          role="radio"
          aria-checked={active === i}
          aria-label={s.label}
          title={s.title}
          tabIndex={active === i ? 0 : -1}
          className="theme-btn"
          onClick={() => choose(i)}
        >
          <Icon name={s.icon} size={15} />
        </button>
      ))}
    </div>
  );
}
