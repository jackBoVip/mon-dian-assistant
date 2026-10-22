import { useId } from 'react';

/**
 * 认证页左栏的输电铁塔（原型的 .visual__scene 逐条照搬：260×190 视窗、两组导线、塔身 16 根杆件、
 * 两侧节点与塔尖灯）。整幅是装饰，aria-hidden，不进任何朗读路径。
 *
 * 颜色一个都不写在这里：结构线取 --scene-tower-*（当前主题文字色的三档），脉冲取 --scene-pulse，
 * 节点与塔尖的芯和光晕取 --scene-node-* / --scene-tip-*。换成任何主题，铁塔都是那个主题的铁塔。
 * 渐变 id 用 useId 生成，同页多个实例（解锁页也摆一座）不会互相抢定义。
 */
const TOWER_LINES: Array<[number, number, number, number]> = [
  [130, 28, 116, 150],
  [130, 28, 144, 150],
  [110, 52, 150, 52],
  [116, 78, 144, 78],
  [113, 104, 147, 104],
  [111, 128, 149, 128],
  [110, 52, 144, 78],
  [150, 52, 116, 78],
  [116, 78, 147, 104],
  [144, 78, 113, 104],
  [113, 104, 149, 128],
  [147, 104, 111, 128],
  [110, 52, 110, 62],
  [150, 52, 150, 62],
];

const WIRE_STRONG = ['M 110 62 Q 68 100, 26 78', 'M 150 62 Q 192 100, 234 78'];
const WIRE_SOFT = ['M 116 78 Q 70 105, 26 92', 'M 144 78 Q 190 105, 234 92'];

export function TowerVisual() {
  const uid = useId().replace(/[^a-zA-Z0-9]/g, '');
  const nodeGlow = `url(#${uid}nd)`;
  const tipGlow = `url(#${uid}tp)`;

  return (
    <div className="auth-tower" aria-hidden>
      <svg className="auth-tower__grid" viewBox="0 0 260 190" fill="none">
        <defs>
          <radialGradient id={`${uid}nd`} cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="var(--scene-node-glow)" stopOpacity="1" />
            <stop offset="100%" stopColor="var(--scene-node-glow)" stopOpacity="0" />
          </radialGradient>
          <radialGradient id={`${uid}tp`} cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="var(--scene-tip-glow)" stopOpacity="1" />
            <stop offset="100%" stopColor="var(--scene-tip-glow)" stopOpacity="0" />
          </radialGradient>
        </defs>

        {WIRE_STRONG.map((d) => (
          <path key={d} d={d} stroke="var(--scene-tower-soft)" strokeWidth="1.2" fill="none" />
        ))}
        {WIRE_SOFT.map((d) => (
          <path key={d} d={d} stroke="var(--scene-tower-tick)" strokeWidth="1" fill="none" />
        ))}

        {WIRE_STRONG.map((d, i) => (
          <path
            key={d}
            className={i === 0 ? 'auth-tower__pulse' : 'auth-tower__pulse auth-tower__pulse--2'}
            d={d}
            stroke="var(--scene-pulse)"
            strokeWidth="1.8"
            strokeLinecap="round"
            fill="none"
          />
        ))}

        <g stroke="var(--scene-tower-strong)" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
          {TOWER_LINES.map(([x1, y1, x2, y2]) => (
            <line key={`${x1}-${y1}-${x2}-${y2}`} x1={x1} y1={y1} x2={x2} y2={y2} />
          ))}
        </g>

        <circle className="auth-tower__node" cx="26" cy="78" r="12" fill={nodeGlow} />
        <circle cx="26" cy="78" r="3.5" fill="var(--scene-node-core)" />
        <circle className="auth-tower__node auth-tower__node--delay" cx="234" cy="78" r="12" fill={nodeGlow} />
        <circle cx="234" cy="78" r="3.5" fill="var(--scene-node-core)" />

        <circle cx="26" cy="92" r="2.4" fill="var(--scene-tower-soft)" />
        <circle cx="234" cy="92" r="2.4" fill="var(--scene-tower-soft)" />

        <circle className="auth-tower__tip" cx="130" cy="28" r="9" fill={tipGlow} />
        <circle cx="130" cy="28" r="2.6" fill="var(--scene-tip-core)" />
      </svg>
    </div>
  );
}
