import type { CSSProperties, Ref } from 'react';
import { ICONS } from './icons';
import type { IconName } from './icons';

export type { IconName };

export interface IconProps {
  name: IconName;
  /** 像素边长，全站只有 14/16/20 三档，与字号节奏对齐 */
  size?: number;
  /** 给了才有 role="img" + aria-label；装饰性图标必须留空，让它 aria-hidden */
  label?: string;
  className?: string;
  style?: CSSProperties;
  ref?: Ref<SVGSVGElement>;
}

/**
 * 图标唯一入口。`name` 换成另一枚时，画它的组件类型随之改变，React 会重建这枚 `<svg>`，
 * `.icon-swap` 的入场动画因此每次语义切换都播一遍（收藏/取消收藏、显示/隐藏）；
 * 同一枚的重复渲染不重建，也就不会反复闪。时长与位移由 `--motion-duration-press` 与
 * `[data-reduce-motion]` 那档控制，减少动态效果时自然归零。
 */
export function Icon({ name, size = 16, label, className, style, ref }: IconProps) {
  const Cmp = ICONS[name];
  return (
    <Cmp
      ref={ref}
      size={size}
      strokeWidth={2}
      className={className ? `icon-swap ${className}` : 'icon-swap'}
      style={style}
      aria-hidden={label ? undefined : true}
      {...(label ? { role: 'img' as const, 'aria-label': label } : {})}
    />
  );
}
