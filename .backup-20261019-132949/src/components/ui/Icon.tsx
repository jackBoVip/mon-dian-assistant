import { forwardRef } from 'react';
import type { CSSProperties } from 'react';
import { MorphIcon } from 'morphicons/react';
import type { MorphHandle } from 'morphicons/react';
import { useTheme } from '../../state/theme';
import { ICONS } from './icons';
import type { IconName } from './icons';

export type { IconName };

export interface IconProps {
  name: IconName;
  /** 像素边长，全站只有 14/16/20 三档，与字号节奏对齐 */
  size?: number;
  /** 给了才有 role="img" + <title>；装饰性图标必须留空，让它 aria-hidden */
  label?: string;
  className?: string;
  style?: CSSProperties;
}

/**
 * 图标唯一入口。`icon` prop 变化时 morphicons 会做形变动画，
 * 因此「同一个位置切换语义」（收藏/取消收藏、显示/隐藏）直接用 name 切换即可。
 */
export const Icon = forwardRef<MorphHandle, IconProps>(function Icon(
  { name, size = 16, label, className, style },
  ref,
) {
  // 应用内的「减少动态效果」优先于系统偏好：开了就直接切换，不再靠 morphicons 自己判 OS。
  const reduced = useTheme((s) => s.reduceMotion);
  return (
    <MorphIcon
      ref={ref}
      icon={ICONS[name]}
      size={size}
      color="currentColor"
      reducedMotion={reduced ? 'always' : 'user'}
      label={label}
      className={className}
      style={style}
    />
  );
});
