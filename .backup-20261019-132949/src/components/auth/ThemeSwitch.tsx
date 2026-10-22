import { useRef, type CSSProperties, type KeyboardEvent } from 'react';
import { useTheme } from '../../state/theme';
import { THEME_STYLES } from '../../lib/theme';
import { THEME_LABELS } from '../../lib/types';

/**
 * 认证页右上角的四档切换：S 轮起与业务页共用同一套主题字面量（lib/theme::THEME_STYLES）。
 *
 * 每档是一枚色块名片——它是"那一套长什么样"的预告，比日/月图标更准：四套里两套是亮底、
 * 两套是暗底，明暗身份已经由主题自己携带，切换器不再单独调明暗。
 * 滑块位置由 `--scene-switch-index` 驱动，键盘 ←→/↑↓ 在四档间轮转（radiogroup 的常规做法）。
 */
export function ThemeSwitch() {
  const style = useTheme((s) => s.style);
  const pick = useTheme((s) => s.pick);
  const groupRef = useRef<HTMLDivElement>(null);

  const active = Math.max(0, THEME_STYLES.indexOf(style));

  function choose(next: number) {
    pick(THEME_STYLES[next]);
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowDown' && e.key !== 'ArrowLeft' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : -1;
    const next = (active + step + THEME_STYLES.length) % THEME_STYLES.length;
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
      {THEME_STYLES.map((s, i) => (
        <button
          key={s}
          type="button"
          role="radio"
          aria-checked={active === i}
          aria-label={THEME_LABELS[s]}
          title={THEME_LABELS[s]}
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
