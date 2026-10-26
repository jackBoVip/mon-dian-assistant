import { useRef, type CSSProperties, type KeyboardEvent } from 'react';
import { useTheme } from '../../state/theme';
import { THEME_STYLES } from '../../lib/theme';
import { BUILTIN_THEME_LABELS } from '../../lib/types';

/**
 * 认证页右上角的四档切换：S 轮起与业务页共用同一套主题字面量（lib/theme::THEME_STYLES）。
 *
 * 每档是一枚色块名片——它是"那一套长什么样"的预告，比日/月图标更准：四套里两套是亮底、
 * 两套是暗底，明暗身份已经由主题自己携带，切换器不再单独调明暗。
 * 滑块位置由 `--scene-switch-index` 驱动，键盘 ←→/↑↓ 在四档间轮转（radiogroup 的常规做法）。
 *
 * 这一枚**只列内置四套**：它是四格定宽的分段控件，自定义档是变长的、且要在解锁后管理，
 * 塞进登录页会把滑块几何顶坏。当前若停在某一档自定义主题上，四格都不打勾、滑块隐去
 * （不是硬指给 glass——那一屏确实不是 glass，打勾就是撒谎），点任意一格即切回内置档。
 */
export function ThemeSwitch() {
  const style = useTheme((s) => s.style);
  const pick = useTheme((s) => s.pick);
  const groupRef = useRef<HTMLDivElement>(null);

  const active = THEME_STYLES.indexOf(style as (typeof THEME_STYLES)[number]);

  function choose(next: number) {
    pick(THEME_STYLES[next]);
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowDown' && e.key !== 'ArrowLeft' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : -1;
    const base = active < 0 ? 0 : active;
    const next = (base + step + THEME_STYLES.length) % THEME_STYLES.length;
    choose(next);
    groupRef.current?.querySelectorAll<HTMLButtonElement>('.theme-btn')[next]?.focus();
  }

  return (
    <div
      ref={groupRef}
      className="theme-switch"
      role="radiogroup"
      aria-label="主题切换"
      style={{ '--scene-switch-index': Math.max(0, active) } as CSSProperties}
      onKeyDown={onKeyDown}
    >
      <span className="theme-switch__slider" aria-hidden style={active < 0 ? { opacity: 0 } : undefined} />
      {THEME_STYLES.map((s, i) => (
        <button
          key={s}
          type="button"
          role="radio"
          aria-checked={active === i}
          aria-label={BUILTIN_THEME_LABELS[s]}
          title={BUILTIN_THEME_LABELS[s]}
          tabIndex={active === i ? 0 : -1}
          className="theme-btn"
          onClick={() => choose(i)}
        >
          <span className="theme-preview" data-preview={s} aria-hidden />
        </button>
      ))}
    </div>
  );
}
